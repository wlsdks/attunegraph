import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  readinessCheckContract,
  readinessContractsMatchInventory,
  readinessContractSnapshot,
  validateReadinessCommandOutput
} from "./readiness-check-contracts.mjs";
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

let repositoryFixture;

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

async function createRepositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-readiness-v2-"));
  const attunegraph = join(directory, "attunegraph");
  const muse = join(directory, "muse");
  await Promise.all([mkdir(attunegraph), mkdir(muse)]);
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
  return { attunegraph, directory, muse, subject, toolchain };
}

async function createFixture() {
  const directory = await mkdtemp(join(repositoryFixture.directory, "case-"));
  const evidenceDirectory = join(directory, "evidence");
  await mkdir(evidenceDirectory);
  const checks = [];
  const results = new Map();
  const writes = [];
  for (const gate of READINESS_GATES) {
    for (const name of gate.checks) {
      const contract = readinessCheckContract(name);
      const checkDirectory = join(evidenceDirectory, "checks", name);
      const stdoutPath = `checks/${name}/stdout.bin`;
      const stderrPath = `checks/${name}/stderr.bin`;
      const resultPath = `checks/${name}/result.json`;
      const empty = Buffer.alloc(0);
      const result = {
        command: structuredClone(readinessContractSnapshot(contract)),
        cwd: realpathSync(
          contract.cwdRole === "muse"
            ? repositoryFixture.muse
            : repositoryFixture.attunegraph
        ),
        endedAt: OBSERVED_AT,
        executable: null,
        exitCode: null,
        gate: gate.name,
        name,
        provenance: {
          captureScriptSha256: `sha256:${"a".repeat(64)}`,
          kind: "local-unattested",
          producer: "capture-attunegraph-readiness@2",
          schema: "attunegraph-readiness-provenance@1"
        },
        schema: READINESS_CHECK_SCHEMA,
        signal: null,
        spawnError: null,
        startedAt: OBSERVED_AT,
        state: "not-run",
        stderr: { path: stderrPath, sha256: digest(empty) },
        stdout: { path: stdoutPath, sha256: digest(empty) },
        subject: structuredClone(repositoryFixture.subject),
        toolchain: structuredClone(repositoryFixture.toolchain)
      };
      const body = `${JSON.stringify(result, null, 2)}\n`;
      writes.push((async () => {
        await mkdir(checkDirectory, { recursive: true });
        await Promise.all([
          writeFile(join(evidenceDirectory, stdoutPath), empty),
          writeFile(join(evidenceDirectory, stderrPath), empty),
          writeFile(join(evidenceDirectory, resultPath), body)
        ]);
      })());
      checks.push({ gate: gate.name, name, result: { path: resultPath, sha256: digest(body) } });
      results.set(name, result);
    }
  }
  await Promise.all(writes);
  return {
    attunegraph: repositoryFixture.attunegraph,
    directory,
    evidence: {
      checks,
      schema: READINESS_EVIDENCE_SCHEMA,
      subject: repositoryFixture.subject
    },
    evidenceDirectory,
    muse: repositoryFixture.muse,
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

function score(fixture, asOf = AS_OF) {
  return scoreReadinessEvidence({
    asOf,
    attunegraphRepository: fixture.attunegraph,
    evidence: fixture.evidence,
    evidenceDirectory: fixture.evidenceDirectory,
    museRepository: fixture.muse
  });
}

async function withFixture(callback) {
  const fixture = await createFixture();
  await callback(fixture);
}

beforeAll(async () => {
  repositoryFixture = await createRepositoryFixture();
});

afterAll(async () => {
  if (repositoryFixture) {
    await rm(repositoryFixture.directory, { force: true, recursive: true });
  }
});

describe("AttuneGraph readiness evidence v2 scorer", () => {
  it("binds the exact 37-check inventory to one fixed contract each", () => {
    expect(READINESS_GATES).toHaveLength(8);
    expect(REQUIRED_CHECKS).toHaveLength(37);
    expect(new Set(REQUIRED_CHECKS).size).toBe(37);
    expect(readinessContractsMatchInventory(READINESS_GATES)).toBe(true);
  });

  it("pins performance parameters instead of accepting caller-selected measurements", () => {
    expect(readinessCheckContract("corpus-1m").parameters).toEqual({
      profile: "core",
      repetitions: 5,
      scale: 1_000_000,
      warmups: 1
    });
    expect(readinessCheckContract("throughput").parameters).toMatchObject({
      metric: "assertionsPerSecond",
      profile: "core",
      scale: 100_000
    });
  });

  it("requires a strict semantic command-output envelope", () => {
    const contract = readinessCheckContract("throughput");
    const output = {
      check: "throughput",
      contractId: contract.id,
      parameters: structuredClone(contract.parameters),
      passed: true,
      result: { samples: [1] },
      schema: "attunegraph-readiness-command-output@1"
    };
    expect(validateReadinessCommandOutput(JSON.stringify(output), contract)).toEqual(output);
    output.parameters.scale = 10_000;
    expect(() => validateReadinessCommandOutput(JSON.stringify(output), contract))
      .toThrow(/fixed semantic contract/u);
  });

  it("runs readiness tests on Node 24.15 for both Ubuntu and Windows and defines attestation issuance", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(packageJson.scripts["test:readiness"]).toBe(
      "vitest run --no-file-parallelism scripts/capture-attunegraph-readiness.test.mjs scripts/score-attunegraph-readiness.test.mjs"
    );
    expect(workflow).toMatch(/readiness-contract:[\s\S]*os: \[ubuntu-latest, windows-latest\][\s\S]*node-version: "24\.15\.0"[\s\S]*pnpm test:readiness/u);
    expect(workflow).toMatch(/readiness-attestation-contract:[\s\S]*actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u);
    expect(workflow).toMatch(/actions\/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373/u);
  });

  it("scores hand-authored local artifacts only as unattested coverage", async () => {
    await withFixture(async (fixture) => {
      expect(score(fixture)).toMatchObject({
        authenticity: "unattested",
        eligible: false,
        integrityThresholdMet: false,
        schema: "attunegraph-readiness-score@2",
        score: 0
      });
    });
  });

  it("rejects a hand-authored pass over an unavailable contract", async () => {
    await withFixture(async (fixture) => {
      const result = fixture.results.get("inspect");
      result.state = "pass";
      result.exitCode = 0;
      result.executable = {
        path: process.execPath,
        sha256: `sha256:${"b".repeat(64)}`,
        version: process.version
      };
      await syncResult(fixture, "inspect");
      expect(() => score(fixture)).toThrow(/executable.*must be null|unavailable.*not-run/u);
    });
  });

  it("rejects node --version and a changed performance scale at the contract boundary", async () => {
    await withFixture(async (fixture) => {
      fixture.results.get("inspect").command.argv = [process.execPath, "--version"];
      await syncResult(fixture, "inspect");
      expect(() => score(fixture)).toThrow(/fixed registry contract/u);
      fixture.results.get("inspect").command = structuredClone(
        readinessContractSnapshot(readinessCheckContract("inspect"))
      );
      await syncResult(fixture, "inspect");
      fixture.results.get("corpus-1m").command.parameters.scale = 10_000;
      await syncResult(fixture, "corpus-1m");
      expect(() => score(fixture)).toThrow(/fixed registry contract/u);
    });
  });

  it("rejects self-authored attested provenance without cryptographic verification", async () => {
    await withFixture(async (fixture) => {
      fixture.results.get("inspect").provenance.kind = "github-actions-attested";
      await syncResult(fixture, "inspect");
      expect(() => score(fixture)).toThrow(/cannot claim attestation/u);
    });
  });

  it("uses an independently observable canonical cwd invariant", async () => {
    await withFixture(async (fixture) => {
      expect(await readFile(join(fixture.results.get("inspect").cwd, "attunegraph.txt"), "utf8"))
        .toBe("attunegraph.txt\n");
      fixture.results.get("inspect").cwd = fixture.muse;
      await syncResult(fixture, "inspect");
      expect(() => score(fixture)).toThrow(/canonical attunegraph repository root/u);
    });
  });

  it("exposes a fail-closed CLI for the zero-claim manifest", async () => {
    await withFixture(async (fixture) => {
      const evidencePath = join(fixture.evidenceDirectory, "readiness-evidence.json");
      await writeFile(evidencePath, `${JSON.stringify(fixture.evidence, null, 2)}\n`);
      const result = spawnSync(process.execPath, [
        SCORER_ENTRYPOINT,
        `--as-of=${AS_OF}`,
        `--evidence=${evidencePath}`,
        `--attunegraph-repository=${fixture.attunegraph}`,
        `--muse-repository=${fixture.muse}`
      ], { encoding: "utf8", timeout: 20_000 });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ eligible: false, score: 0 });
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
