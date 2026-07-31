import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createReadinessToolchain,
  parseReadinessArguments,
  READINESS_CHECK_SCHEMA,
  READINESS_EVIDENCE_SCHEMA,
  READINESS_GATES,
  scoreReadinessEvidence
} from "./score-attunegraph-readiness.mjs";

const AS_OF = "2026-07-31T00:00:00.000Z";
const OBSERVED_AT = "2026-07-30T00:00:00.000Z";
const SCORER_ENTRYPOINT = fileURLToPath(new URL("./score-attunegraph-readiness.mjs", import.meta.url));
const REQUIRED_CHECKS = READINESS_GATES.flatMap((gate) => gate.checks).sort();

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

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-readiness-v2-"));
  const attunegraph = join(directory, "attunegraph");
  const muse = join(directory, "muse");
  const evidenceDirectory = join(directory, "evidence");
  await Promise.all([mkdir(attunegraph), mkdir(muse), mkdir(evidenceDirectory)]);
  await initializeRepository(attunegraph, "attunegraph.txt");
  await initializeRepository(muse, "muse.txt");
  const attunegraphSubject = repositorySubject(attunegraph);
  git(muse, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", attunegraph, "packages/attunegraph"]);
  git(muse, ["add", ".gitmodules", "packages/attunegraph"]);
  git(muse, ["commit", "-qm", "bind AttuneGraph gitlink"]);
  const subject = {
    attunegraph: attunegraphSubject,
    muse: {
      ...repositorySubject(muse),
      attunegraphGitlink: { path: "packages/attunegraph", sha: attunegraphSubject.sha }
    }
  };
  const toolchain = createReadinessToolchain({
    arch: "fixture-arch",
    node: "v24.15.0",
    packageManager: "pnpm/10.18.0",
    platform: "fixture-platform"
  });
  const checks = [];
  const results = new Map();
  for (const gate of READINESS_GATES) {
    for (const name of gate.checks) {
      const checkDirectory = join(evidenceDirectory, "checks", name);
      await mkdir(checkDirectory, { recursive: true });
      const stdoutPath = `checks/${name}/stdout.bin`;
      const stderrPath = `checks/${name}/stderr.bin`;
      const resultPath = `checks/${name}/result.json`;
      const stdout = Buffer.from(`synthetic-test-output:${name}\n`);
      const stderr = Buffer.alloc(0);
      await Promise.all([
        writeFile(join(evidenceDirectory, stdoutPath), stdout),
        writeFile(join(evidenceDirectory, stderrPath), stderr)
      ]);
      const result = {
        argv: [process.execPath, "--version", name],
        cwd: attunegraph,
        endedAt: OBSERVED_AT,
        exitCode: 0,
        gate: gate.name,
        name,
        schema: READINESS_CHECK_SCHEMA,
        signal: null,
        spawnError: null,
        startedAt: OBSERVED_AT,
        state: "pass",
        stderr: { path: stderrPath, sha256: digest(stderr) },
        stdout: { path: stdoutPath, sha256: digest(stdout) },
        subject: structuredClone(subject),
        toolchain: structuredClone(toolchain)
      };
      const body = `${JSON.stringify(result, null, 2)}\n`;
      await writeFile(join(evidenceDirectory, resultPath), body);
      checks.push({
        gate: gate.name,
        name,
        result: { path: resultPath, sha256: digest(body) }
      });
      results.set(name, result);
    }
  }
  return {
    attunegraph,
    directory,
    evidence: { checks, schema: READINESS_EVIDENCE_SCHEMA, subject },
    evidenceDirectory,
    muse,
    results
  };
}

function check(fixture, name) {
  return fixture.evidence.checks.find((candidate) => candidate.name === name);
}

async function syncResult(fixture, name) {
  const entry = check(fixture, name);
  const body = `${JSON.stringify(fixture.results.get(name), null, 2)}\n`;
  await writeFile(join(fixture.evidenceDirectory, entry.result.path), body);
  entry.result.sha256 = digest(body);
}

async function setState(fixture, name, state) {
  const result = fixture.results.get(name);
  result.state = state;
  result.exitCode = state === "pass" ? 0 : state === "fail" ? 1 : null;
  if (state === "not-run") {
    await Promise.all([
      writeFile(join(fixture.evidenceDirectory, result.stdout.path), Buffer.alloc(0)),
      writeFile(join(fixture.evidenceDirectory, result.stderr.path), Buffer.alloc(0))
    ]);
    result.stdout.sha256 = digest(Buffer.alloc(0));
    result.stderr.sha256 = digest(Buffer.alloc(0));
  }
  await syncResult(fixture, name);
}

function score(fixture, asOf = AS_OF) {
  return scoreReadinessEvidence({
    asOf,
    attunegraphRepository: fixture.attunegraph,
    evidence: fixture.evidence,
    evidenceDirectory: fixture.evidenceDirectory,
    museRepository: fixture.muse
  });
}

async function writeEvidence(fixture, filename = "readiness-evidence.json") {
  const path = join(fixture.evidenceDirectory, filename);
  await writeFile(path, `${JSON.stringify(fixture.evidence, null, 2)}\n`);
  return path;
}

async function withFixture(callback) {
  const fixture = await createFixture();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
}

describe("AttuneGraph readiness evidence v2 scorer", () => {
  it("keeps the exact 37-check, eight-gate inventory", () => {
    expect(READINESS_GATES).toHaveLength(8);
    expect(REQUIRED_CHECKS).toHaveLength(37);
    expect(new Set(REQUIRED_CHECKS).size).toBe(37);
  });

  it("ships both readiness CLIs and enforces readiness tests in CI", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(packageJson.scripts).toMatchObject({
      "readiness:capture": "node scripts/capture-attunegraph-readiness.mjs",
      "readiness:score": "node scripts/score-attunegraph-readiness.mjs",
      "test:readiness": "vitest run scripts/*attunegraph-readiness.test.mjs"
    });
    expect(packageJson.files).toEqual(expect.arrayContaining([
      "scripts/capture-attunegraph-readiness.mjs",
      "scripts/score-attunegraph-readiness.mjs"
    ]));
    expect(workflow).toMatch(/- run: pnpm test:readiness/u);
  });

  it("scores a complete synthetic v2 fixture and exposes the v2 CLI", async () => {
    await withFixture(async (fixture) => {
      expect(score(fixture)).toMatchObject({
        eligible: true,
        schema: "attunegraph-readiness-score@2",
        score: 100
      });
      const evidencePath = await writeEvidence(fixture);
      const result = spawnSync(process.execPath, [
        SCORER_ENTRYPOINT,
        `--as-of=${AS_OF}`,
        `--evidence=${evidencePath}`,
        `--attunegraph-repository=${fixture.attunegraph}`,
        `--muse-repository=${fixture.muse}`
      ], { encoding: "utf8", timeout: 20_000 });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ score: 100 });
    });
  });

  it("rejects v1 metadata-only manifests", async () => {
    await withFixture(async (fixture) => {
      fixture.evidence.schema = "attunegraph-readiness-evidence@1";
      expect(() => score(fixture)).toThrow(/@2/u);
    });
  });

  it("preserves the 90 threshold and critical-gate eligibility rules", async () => {
    await withFixture(async (fixture) => {
      await setState(fixture, "working-graph-golden-corpus", "not-run");
      expect(score(fixture)).toMatchObject({ eligible: true, score: 90 });
    });
    await withFixture(async (fixture) => {
      await setState(fixture, "sqlite-crash-cas", "fail");
      expect(score(fixture)).toMatchObject({ eligible: false, score: 90 });
    });
  });

  it("uses the command end timestamp for the exact 168-hour boundary", async () => {
    await withFixture(async (fixture) => {
      const result = fixture.results.get("working-graph-golden-corpus");
      result.startedAt = "2026-07-24T00:00:00.000Z";
      result.endedAt = "2026-07-24T00:00:00.000Z";
      await syncResult(fixture, result.name);
      expect(score(fixture)).toMatchObject({ score: 100 });
      result.startedAt = "2026-07-23T23:59:59.999Z";
      result.endedAt = "2026-07-23T23:59:59.999Z";
      await syncResult(fixture, result.name);
      expect(score(fixture)).toMatchObject({ score: 90 });
    });
  });

  it.each([
    ["stdout bytes", async (fixture) => {
      const result = fixture.results.get("inspect");
      await writeFile(join(fixture.evidenceDirectory, result.stdout.path), "tampered\n");
    }, /stdout.*sha256/u],
    ["result bytes", async (fixture) => {
      const entry = check(fixture, "inspect");
      await writeFile(join(fixture.evidenceDirectory, entry.result.path), "{}\n");
    }, /result.*sha256/u],
    ["toolchain identity", async (fixture) => {
      fixture.results.get("inspect").toolchain.node = "v0.0.0";
      await syncResult(fixture, "inspect");
    }, /toolchain.*digest/u],
    ["subject", async (fixture) => {
      fixture.results.get("inspect").subject.attunegraph.sha = "a".repeat(40);
      await syncResult(fixture, "inspect");
    }, /subject does not match/u],
    ["dirty repository", async (fixture) => {
      await writeFile(join(fixture.attunegraph, "dirty.txt"), "dirty\n");
    }, /dirty/u]
  ])("fails closed on tampered %s", async (_name, mutate, message) => {
    await withFixture(async (fixture) => {
      await mutate(fixture);
      expect(() => score(fixture)).toThrow(message);
    });
  });

  it("rejects artifact path reuse across checks and streams", async () => {
    await withFixture(async (fixture) => {
      const inspect = fixture.results.get("inspect");
      const verify = fixture.results.get("verify");
      verify.stdout = structuredClone(inspect.stdout);
      await syncResult(fixture, "verify");
      expect(() => score(fixture)).toThrow(/duplicate artifact path/u);
    });
  });

  it("rejects symlink artifacts and symlinked evidence roots", async () => {
    await withFixture(async (fixture) => {
      const result = fixture.results.get("inspect");
      const stdoutPath = join(fixture.evidenceDirectory, result.stdout.path);
      const outside = join(fixture.directory, "outside.txt");
      await writeFile(outside, "outside\n");
      await unlink(stdoutPath);
      await symlink(outside, stdoutPath);
      expect(() => score(fixture)).toThrow(/non-symlink/u);
    });
  });

  it("rejects impossible process-state claims", async () => {
    await withFixture(async (fixture) => {
      const result = fixture.results.get("inspect");
      result.state = "pass";
      result.exitCode = 1;
      await syncResult(fixture, "inspect");
      expect(() => score(fixture)).toThrow(/pass requires exitCode 0/u);

      result.state = "fail";
      result.exitCode = null;
      await syncResult(fixture, "inspect");
      expect(() => score(fixture)).toThrow(/fail requires a nonzero exit/u);
    });
  });

  it("requires explicit scorer inputs", () => {
    expect(() => parseReadinessArguments([
      "--evidence=evidence.json",
      "--attunegraph-repository=.",
      "--muse-repository=../muse"
    ])).toThrow(/--as-of/u);
  });
});
