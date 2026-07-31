import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseReadinessArguments,
  READINESS_EVIDENCE_SCHEMA,
  READINESS_GATES,
  scoreReadinessEvidence
} from "./score-attunegraph-readiness.mjs";

const AS_OF = "2026-07-31T00:00:00.000Z";
const OBSERVED_AT = "2026-07-30T00:00:00.000Z";
const SCORER_ENTRYPOINT = fileURLToPath(new URL("./score-attunegraph-readiness.mjs", import.meta.url));
const REQUIRED_CHECKS = [
  "install", "build", "test", "example", "pack", "consumer-install",
  "submodule-pinned", "narrow-public-port", "no-duplicate-engine-source", "v2-durable-path",
  "conformance", "adversarial", "property", "fault", "authority-fail-closed",
  "sqlite-crash-cas", "atgx-streaming-round-trip",
  "working-graph-golden-corpus", "abstention",
  "corpus-10k", "corpus-100k", "corpus-1m", "projection-latency", "working-graph-latency",
  "throughput", "peak-rss", "sqlite-cold-open", "sqlite-warm-open", "concurrency",
  "portable-encode-decode",
  "inspect", "verify", "diagnose", "zero-hidden-mutation",
  "api-reference", "migration-notes", "independent-example"
].sort();

function artifactContent(entry) {
  return {
    command: entry.command,
    exitCode: entry.exitCode,
    gate: entry.gate,
    name: entry.name,
    observedAt: entry.observedAt,
    schema: "attunegraph-readiness-check@1",
    state: entry.state,
    subject: structuredClone(entry.subject),
    toolchain: structuredClone(entry.toolchain)
  };
}

function artifactBody(entry, overrides = {}) {
  return `${JSON.stringify({ ...artifactContent(entry), ...overrides }, null, 2)}\n`;
}

function git(repository, arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" }).trim();
}

async function initializeRepository(path, filename) {
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "readiness@example.test"]);
  git(path, ["config", "user.name", "Readiness Test"]);
  await writeFile(join(path, filename), `${filename}\n`);
  git(path, ["add", filename]);
  git(path, ["commit", "-qm", `add ${filename}`]);
}

function repositorySubject(path) {
  return {
    clean: true,
    sha: git(path, ["rev-parse", "HEAD"]),
    tree: git(path, ["rev-parse", "HEAD^{tree}"])
  };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-readiness-"));
  const attunegraph = join(directory, "attunegraph");
  const muse = join(directory, "muse");
  const evidenceDirectory = join(directory, "evidence");
  const artifactDirectory = join(evidenceDirectory, "artifacts");
  await Promise.all([
    mkdir(attunegraph),
    mkdir(muse),
    mkdir(artifactDirectory, { recursive: true })
  ]);
  await initializeRepository(attunegraph, "attunegraph.txt");
  await initializeRepository(muse, "muse.txt");
  const attunegraphSubject = repositorySubject(attunegraph);
  git(muse, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", attunegraph, "packages/attunegraph"]);
  git(muse, ["add", ".gitmodules", "packages/attunegraph"]);
  git(muse, ["commit", "-qm", "bind AttuneGraph gitlink"]);
  const museSubject = repositorySubject(muse);
  const subject = {
    attunegraph: attunegraphSubject,
    muse: {
      ...museSubject,
      attunegraphGitlink: {
        path: "packages/attunegraph",
        sha: attunegraphSubject.sha
      }
    }
  };
  const toolchain = { digest: sha256("node=24;pnpm=10;fixture=1") };
  const checks = [];
  for (const gate of READINESS_GATES) {
    for (const name of gate.checks) {
      const path = `artifacts/${name}.json`;
      const entry = {
        artifact: { path, sha256: "" },
        command: `fixture --check=${name}`,
        exitCode: 0,
        gate: gate.name,
        name,
        observedAt: OBSERVED_AT,
        state: "pass",
        subject: structuredClone(subject),
        toolchain: structuredClone(toolchain)
      };
      const body = artifactBody(entry);
      await writeFile(join(evidenceDirectory, path), body);
      entry.artifact.sha256 = sha256(body);
      checks.push(entry);
    }
  }
  return {
    attunegraph,
    directory,
    evidenceDirectory,
    evidence: {
      checks,
      schema: READINESS_EVIDENCE_SCHEMA,
      subject,
      toolchain
    },
    muse
  };
}

function score(fixture) {
  return scoreReadinessEvidence({
    asOf: AS_OF,
    attunegraphRepository: fixture.attunegraph,
    evidence: fixture.evidence,
    evidenceDirectory: fixture.evidenceDirectory,
    museRepository: fixture.muse
  });
}

function check(fixture, name) {
  return fixture.evidence.checks.find((candidate) => candidate.name === name);
}

async function syncArtifact(fixture, entry, overrides = {}) {
  const body = artifactBody(entry, overrides);
  await writeFile(join(fixture.evidenceDirectory, entry.artifact.path), body);
  entry.artifact.sha256 = sha256(body);
}

async function syncAllArtifacts(fixture) {
  await Promise.all(fixture.evidence.checks.map((entry) => syncArtifact(fixture, entry)));
}

async function writeEvidence(fixture, filename = "readiness-evidence.json") {
  const path = join(fixture.evidenceDirectory, filename);
  await writeFile(path, `${JSON.stringify(fixture.evidence, null, 2)}\n`);
  return path;
}

function runCli(fixture, evidencePath, extraArguments = []) {
  return spawnSync(process.execPath, [
    SCORER_ENTRYPOINT,
    `--as-of=${AS_OF}`,
    `--evidence=${evidencePath}`,
    `--attunegraph-repository=${fixture.attunegraph}`,
    `--muse-repository=${fixture.muse}`,
    ...extraArguments
  ], { encoding: "utf8", timeout: 10_000 });
}

async function withFixture(callback) {
  const fixture = await createFixture();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
}

describe("AttuneGraph readiness evidence scorer", () => {
  it("exposes the documented runtime script", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(packageJson.scripts["readiness:score"]).toBe("node scripts/score-attunegraph-readiness.mjs");
  });

  it("runs the process entrypoint and fails closed without misleading output", async () => {
    await withFixture(async (fixture) => {
      const evidencePath = await writeEvidence(fixture);
      const valid = runCli(fixture, evidencePath);
      expect(valid.status).toBe(0);
      expect(valid.stderr).toBe("");
      expect(JSON.parse(valid.stdout)).toMatchObject({
        schema: "attunegraph-readiness-score@1",
        score: 100,
        eligible: true
      });

      const missingAsOf = spawnSync(process.execPath, [
        SCORER_ENTRYPOINT,
        `--evidence=${evidencePath}`,
        `--attunegraph-repository=${fixture.attunegraph}`,
        `--muse-repository=${fixture.muse}`
      ], { encoding: "utf8", timeout: 10_000 });
      expect(missingAsOf.status).toBe(1);
      expect(missingAsOf.stderr).toMatch(/--as-of is required/u);
      expect(missingAsOf.stdout).toBe("");

      check(fixture, "inspect").artifact.sha256 = sha256("invalid");
      const invalidEvidencePath = await writeEvidence(fixture, "invalid-evidence.json");
      const invalidEvidence = runCli(fixture, invalidEvidencePath);
      expect(invalidEvidence.status).toBe(1);
      expect(invalidEvidence.stderr).toMatch(/sha256 does not match/u);
      expect(invalidEvidence.stdout).toBe("");
      await expect(access(join(fixture.evidenceDirectory, "score-output.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("requires explicit scorer inputs, including --as-of", () => {
    expect(() => parseReadinessArguments([
      "--evidence=evidence.json",
      "--attunegraph-repository=.",
      "--muse-repository=../muse"
    ])).toThrow(/--as-of/u);
    expect(() => parseReadinessArguments([
      "--as-of=2026-07-31T00:00:00.000Z",
      "--evidence=evidence.json",
      "--attunegraph-repository=.",
      "--muse-repository=../muse",
      "--unknown=value"
    ])).toThrow(/unsupported/u);
  });

  it("returns 100 and eligible only when every exact required check is present", async () => {
    await withFixture(async (fixture) => {
      const result = score(fixture);
      expect(result).toMatchObject({
        schema: "attunegraph-readiness-score@1",
        score: 100,
        eligible: true,
        note: expect.stringContaining("evidence coverage")
      });
      expect(READINESS_GATES.flatMap((gate) => gate.checks).sort()).toEqual(REQUIRED_CHECKS);
      expect(fixture.evidence.checks.map((entry) => entry.name).sort()).toEqual(REQUIRED_CHECKS);
      expect(score(fixture)).toEqual(result);
    });
  });

  it("keeps a 90 score eligible when only retrieval quality is not run", async () => {
    await withFixture(async (fixture) => {
      const entry = check(fixture, "working-graph-golden-corpus");
      entry.state = "not-run";
      await syncArtifact(fixture, entry);
      expect(score(fixture)).toMatchObject({ score: 90, eligible: true });
    });
  });

  it("makes semantic safety or portable persistence failure ineligible", async () => {
    await withFixture(async (fixture) => {
      const entry = check(fixture, "authority-fail-closed");
      entry.state = "fail";
      await syncArtifact(fixture, entry);
      expect(score(fixture)).toMatchObject({ score: 80, eligible: false });
    });
    await withFixture(async (fixture) => {
      const entry = check(fixture, "sqlite-crash-cas");
      entry.state = "fail";
      await syncArtifact(fixture, entry);
      expect(score(fixture)).toMatchObject({ score: 90, eligible: false });
    });
  });

  it("accepts the exact 168-hour boundary and stales evidence one millisecond older", async () => {
    await withFixture(async (fixture) => {
      const entry = check(fixture, "working-graph-golden-corpus");
      entry.observedAt = "2026-07-24T00:00:00.000Z";
      await syncArtifact(fixture, entry);
      expect(score(fixture)).toMatchObject({ score: 100, eligible: true });

      entry.observedAt = "2026-07-23T23:59:59.999Z";
      await syncArtifact(fixture, entry);
      expect(score(fixture)).toMatchObject({ score: 90, eligible: true });
    });
  });

  it("hard-fails a Muse gitlink that is not the AttuneGraph SHA", async () => {
    await withFixture(async (fixture) => {
      fixture.evidence.subject.muse.attunegraphGitlink.sha = "a".repeat(40);
      for (const entry of fixture.evidence.checks) {
        entry.subject.muse.attunegraphGitlink.sha = "a".repeat(40);
      }
      await syncAllArtifacts(fixture);
      expect(() => score(fixture)).toThrow(/gitlink/u);
    });
  });

  it("hard-fails generic umbrella names and a missing performance check", async () => {
    await withFixture(async (fixture) => {
      check(fixture, "corpus-10k").name = "performance-resources";
      expect(() => score(fixture)).toThrow(/required check/u);
    });
    await withFixture(async (fixture) => {
      fixture.evidence.checks = fixture.evidence.checks.filter(
        (entry) => entry.name !== "portable-encode-decode"
      );
      expect(() => score(fixture)).toThrow(/every required check/u);
    });
  });

  it("requires unique, strict check-bound artifact JSON", async () => {
    await withFixture(async (fixture) => {
      check(fixture, "verify").artifact = structuredClone(check(fixture, "inspect").artifact);
      expect(() => score(fixture)).toThrow(/duplicate artifact path/u);
    });
    await withFixture(async (fixture) => {
      const entry = check(fixture, "inspect");
      await syncArtifact(fixture, entry, { name: "diagnose" });
      expect(() => score(fixture)).toThrow(/content.name does not match/u);
    });
    await withFixture(async (fixture) => {
      const entry = check(fixture, "inspect");
      await syncArtifact(fixture, entry, { unexpected: true });
      expect(() => score(fixture)).toThrow(/unknown/u);
    });
    await withFixture(async (fixture) => {
      const source = check(fixture, "inspect");
      const target = check(fixture, "verify");
      const genericBytes = await readFile(join(fixture.evidenceDirectory, source.artifact.path));
      await writeFile(join(fixture.evidenceDirectory, target.artifact.path), genericBytes);
      target.artifact.sha256 = sha256(genericBytes);
      expect(() => score(fixture)).toThrow(/content.name does not match/u);
    });
  });

  it("rejects an artifact that escapes through a symlinked parent", async () => {
    await withFixture(async (fixture) => {
      const outside = join(fixture.directory, "outside");
      await mkdir(outside);
      await symlink(outside, join(fixture.evidenceDirectory, "linked"));
      const entry = check(fixture, "inspect");
      entry.artifact.path = "linked/inspect.json";
      const body = artifactBody(entry);
      await writeFile(join(outside, "inspect.json"), body);
      entry.artifact.sha256 = sha256(body);
      expect(() => score(fixture)).toThrow(/symlink/u);
    });
  });

  it("hard-fails future time, command/toolchain mismatch, dirty sources, missing/duplicate checks, traversal, and bad hashes", async () => {
    const mutations = [
      ["future time", async (fixture) => {
        const entry = check(fixture, "inspect");
        entry.observedAt = "2026-08-01T00:00:00.000Z";
        await syncArtifact(fixture, entry);
      }, /after --as-of/u],
      ["command", (fixture) => { check(fixture, "inspect").command = " \t "; }, /command/u],
      ["toolchain", (fixture) => { check(fixture, "inspect").toolchain.digest = sha256("different"); }, /toolchain/u],
      ["dirty", async (fixture) => { await writeFile(join(fixture.attunegraph, "dirty.txt"), "dirty\n"); }, /dirty/u],
      ["missing check", (fixture) => { fixture.evidence.checks.pop(); }, /every required check/u],
      ["duplicate check", (fixture) => { fixture.evidence.checks[1].name = fixture.evidence.checks[0].name; }, /duplicate/u],
      ["traversal", (fixture) => { check(fixture, "inspect").artifact.path = "../escape.txt"; }, /relative|traversal/u],
      ["hash", (fixture) => { check(fixture, "inspect").artifact.sha256 = sha256("wrong"); }, /does not match/u]
    ];
    for (const [, mutate, message] of mutations) {
      await withFixture(async (fixture) => {
        await mutate(fixture);
        expect(() => score(fixture)).toThrow(message);
      });
    }
  });
});
