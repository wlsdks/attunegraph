import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  READINESS_MEASUREMENT_PROVENANCE_SCHEMA,
  READINESS_MEASUREMENT_RESULT_SCHEMA,
  readinessMeasurementContract,
  readinessMeasurementContractSnapshot
} from "./readiness-measurement-contracts.mjs";
import {
  createReadinessToolchain,
  parseReadinessArguments,
  READINESS_CHECK_SCHEMA,
  READINESS_EVIDENCE_SCHEMA,
  READINESS_GATES,
  readReadinessRepositoryRegularFile,
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

function mixedMeasurementReport() {
  const commits = [
    "3161ff4f3c9fe70e4c0340ff1cfa1a601cc4b9b6678c713d1f9b9e59a8f485fd",
    "7d88dc3989e66a928a46e81485eeb905d394cd40a2cc30009119969c0d4c8e37",
    "19f3972b58721f620a986654a5e8b2d6129f8e5c5fcd60af569e32060a7fc88d",
    "c3a8bb800935b71ff8a5f035074630f9aec1fefab4c4c5b81ec3c0f8b51b87c0"
  ];
  const generations = [1, 1, 1, 1];
  const operationLedger = Array.from({ length: 100 }, (_, ordinal) => {
    const wave = Math.floor(ordinal / 4);
    const client = ordinal % 4;
    const kind = wave === 0
      ? "write"
      : wave <= 16
        ? client === (wave - 1) % 4 ? "write" : "read"
        : "read";
    const before = generations[client];
    const after = kind === "write" ? before + 1 : before;
    if (kind === "write") generations[client] = after;
    return {
      clientId: `client:${client.toString()}`,
      durationMilliseconds: 1,
      expectedGenerationAfter: after,
      generationBefore: before,
      kind,
      observedCommitId: `attunegraph-commit:attunegraph-observation:${after === 6
        ? commits[client]
        : (client + 1).toString(16).repeat(64)}`,
      observedGeneration: after,
      operationId: `wave:${wave.toString().padStart(2, "0")}:client:${client.toString()}:${kind}`,
      operationTaskSettledAfterMixedStartMilliseconds: ordinal + 1,
      operationTaskStartedAfterMixedStartMilliseconds: ordinal,
      ordinal,
      scope: { sourceId: "mixed-durable-benchmark", threadId: `client:${client.toString()}` },
      status: kind === "write" ? "committed" : "complete",
      wave
    };
  });
  const finalHeads = commits.map((commit, client) => ({
    assertionIds: Array.from(
      { length: 16 },
      (_, index) => `a:c${client.toString()}:g06:${index.toString().padStart(2, "0")}`
    ),
    assertionProvenance: Array.from({ length: 16 }, (_, index) => {
      const suffix = index.toString().padStart(2, "0");
      return {
        assertionId: `a:c${client.toString()}:g06:${suffix}`,
        derivation: { kind: "projection", version: "mixed@1" },
        sourceRefs: [{
          namespace: "b",
          id: `s:c${client.toString()}:g06:a:${suffix}`
        }]
      };
    }),
    clientId: `client:${client.toString()}`,
    consideredAssertions: 16,
    emittedAssertions: 16,
    generation: 6,
    headCommitId: `attunegraph-commit:attunegraph-observation:${commit}`,
    maxDepthReached: 2,
    refIds: [
      ...Array.from(
        { length: 16 },
        (_, index) => `artifact:n:c${client.toString()}:${index.toString().padStart(2, "0")}`
      ),
      `thread:r:c${client.toString()}`
    ],
    sourceFreshness: { state: "fresh", observedAt: "2026-08-01T11:59:00.000Z" },
    sourceRefIds: Array.from(
      { length: 16 },
      (_, index) => `b:s:c${client.toString()}:g06:a:${index.toString().padStart(2, "0")}`
    ),
    status: "complete",
    truncationReasons: [],
    visitedRefs: 17
  }));
  const storagePhaseSpecs = [
    ["after-preparation", 0, 4, 0, null, false],
    ["after-four-sessions-open", 4, 4, 0, null, true],
    ["after-mixed-settled", 4, 24, 80, null, true],
    ["after-session-close", 3, 24, 84, 1, true],
    ["after-session-close", 2, 24, 84, 2, true],
    ["after-session-close", 1, 24, 84, 3, true],
    ["after-session-close", 0, 24, 84, 4, false],
    ["after-verifier-open", 1, 24, 84, null, true],
    ["after-verifier-verification", 1, 24, 88, null, true],
    ["after-verifier-close", 0, 24, 88, null, false]
  ];
  const storagePhases = storagePhaseSpecs.map(([
    phase,
    openSessions,
    projections,
    decisionReads,
    closeOrdinal,
    sidecarsPresent
  ]) => ({
    phase,
    openSessions,
    completedOperations: { projections, decisionReads },
    files: {
      database: { present: true, logicalBytes: 1 },
      writeAheadLog: {
        present: sidecarsPresent,
        logicalBytes: sidecarsPresent ? 0 : null
      },
      sharedMemory: {
        present: sidecarsPresent,
        logicalBytes: sidecarsPresent ? 1 : null
      },
      totalPresentLogicalBytes: sidecarsPresent ? 2 : 1
    },
    ...(closeOrdinal === null ? {} : {
      closeOrdinal,
      closedClientId: `client:${(closeOrdinal - 1).toString()}`,
      remainingOpenSessions: openSessions
    })
  }));
  return {
    schema: "attunegraph-agent-decision-mixed-durable-tracer@1",
    measurementOnly: true,
    claimEligible: false,
    measurementBoundary: {
      clientCount: 4,
      closeMode: "graceful",
      database: "one-shared-sqlite-file",
      databasePathOwnership: "caller",
      databaseOverlap: "not-directly-observed",
      barrier: "all-settled-before-next-wave",
      launch: "main-thread-wave",
      osCache: "uncontrolled",
      outstandingMeaning: "harness-operation-tasks-not-public-promises-or-database-execution",
      process: "same-process-new-verifier-worker",
      sameScopeContention: "not-measured",
      sessionTopology: "four-independent-public-sessions"
    },
    workload: {
      clients: 4,
      activeAssertionCountPerHead: 16,
      inactiveAssertionCountPerHead: 24,
      totalAssertionCountPerHead: 40,
      cycles: 5,
      id: "four-session-mixed-80r20w@1",
      excludedDataOperations: {
        preparationWrites: 4,
        precloseVerificationReads: 4,
        reopenVerificationReads: 4,
        total: 12
      },
      finalGeneration: 6,
      initialGeneration: 1,
      logicalOperationType: "public-agent-api",
      measuredLogicalOperations: 100,
      mixedReadWriteWaves: 16,
      readOperations: 80,
      writeOperations: 20,
      totalDataOperations: { reads: 88, writes: 24, total: 112 },
      waves: 25
    },
    concurrency: {
      barrierCount: 25,
      clients: Array.from({ length: 4 }, (_, client) => ({
        clientId: `client:${client.toString()}`,
        reads: 20,
        writes: 5
      })),
      mixedReadWriteBarrierCount: 16,
      operationsPerClient: 25,
      peakOutstandingOperationTasksObserved: 4,
      readOnlyBarrierCount: 8,
      writeOnlyBarrierCount: 1
    },
    correctness: {
      allOperationsSucceeded: true,
      finalHeadsMatchGoldenManifest: true,
      fullResultsStableAcrossReopen: true,
      goldenManifestVersion: "four-session-mixed-80r20w@1",
      readSemanticsMatchCurrentHead: true,
      reopenExact: true,
      scheduleExact: true,
      writeSnapshotsMatchProjectionContract: true,
      finalHeads
    },
    operationLedger,
    timing: {
      contract: {
        clock: "performance.now-monotonic",
        mixedWallIncludes: "cell-build-clone-public-call-validation-and-wave-bookkeeping",
        operationDurationIncludes: "cell-build-clone-public-call-and-validation",
        pureDatabaseLatency: false,
        verifierReopenIncludes: "session-and-worker-open-only"
      },
      mixedWallMilliseconds: 100,
      verifierReopenMilliseconds: 10
    },
    provenance: {
      authority: "unattested-local-process",
      capturedAt: "2026-07-30T00:00:00.000Z",
      harness: {
        id: "benchmark-attunegraph-agent-decision-mixed-durable@1",
        sha256: digest("fixture tracer\n")
      },
      repository: {
        commit: "not-recorded",
        tree: "not-recorded",
        lockfileSha256: "not-recorded"
      },
      runtime: {
        node: repositoryFixture.toolchain.node,
        platform: repositoryFixture.toolchain.platform,
        arch: repositoryFixture.toolchain.arch,
        osRelease: "fixture-release",
        cpuModel: "fixture-cpu",
        logicalCpuCount: 4,
        totalMemoryBytes: 1_073_741_824
      },
      sqliteVersion: "not-exposed-by-public-api",
      workload: {
        id: "four-session-mixed-80r20w@1",
        sha256: "sha256:4a7ceac49cdd5dd8d18efe60b43b99edee8f71afa0cb2bef1bf409b18d53621f"
      }
    },
    limitations: {
      nonClaims: [
        "latency-throughput-or-tail-qualification",
        "production-or-cross-host-generalization",
        "database-execution-overlap-or-lock-contention",
        "same-scope-contention",
        "cold-disk-process-restart-or-crash-recovery",
        "allocated-bytes-checkpoint-effectiveness-compaction-or-leak-slope",
        "process-tree-rss-cpu-or-gc-cost"
      ]
    },
    storage: {
      schema: "attunegraph-sqlite-footprint@1",
      method: "lstat-logical-size-at-settled-phase-boundaries",
      checkpoint: {
        mode: "PASSIVE",
        result: "not-exposed-by-public-api",
        trigger: "each-public-session-close"
      },
      interpretation: {
        allocatedBytes: "not-measured",
        checkpointEffectiveness: "not-measured",
        monotonicGrowthExpected: false,
        peakMeaning: "largest-observed-phase-boundary-only"
      },
      peakObservedTotalLogicalBytes: 2,
      phases: storagePhases
    }
  };
}

async function createRepositoryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-readiness-protocol-"));
  const attunegraph = join(directory, "attunegraph");
  const muse = join(directory, "muse");
  await Promise.all([mkdir(attunegraph), mkdir(muse)]);
  await initializeRepository(attunegraph, "attunegraph.txt");
  await mkdir(join(attunegraph, "scripts"));
  await writeFile(
    join(attunegraph, "scripts", "benchmark-attunegraph-agent-decision-mixed-durable.mjs"),
    "fixture tracer\n"
  );
  git(attunegraph, ["add", "scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs"]);
  git(attunegraph, ["commit", "-qm", "add fixture tracer"]);
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
          producer: "capture-attunegraph-readiness@1",
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
  const fixture = {
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
  await addMixedMeasurement(fixture);
  return fixture;
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

async function addMixedMeasurement(fixture, overrides = {}) {
  const name = "mixed-durable-agent-decision-observation";
  const contract = readinessMeasurementContract(name);
  const measurementDirectory = join(fixture.evidenceDirectory, "measurements", name);
  const stdoutPath = `measurements/${name}/stdout.bin`;
  const stderrPath = `measurements/${name}/stderr.bin`;
  const resultPath = `measurements/${name}/result.json`;
  const report = overrides.report ?? mixedMeasurementReport();
  const stdout = Buffer.from(`${JSON.stringify(report)}\n`);
  const stderr = Buffer.alloc(0);
  const result = {
    command: structuredClone(readinessMeasurementContractSnapshot(contract)),
    cwd: realpathSync(repositoryFixture.attunegraph),
    endedAt: overrides.endedAt ?? OBSERVED_AT,
    executable: {
      path: process.execPath,
      sha256: `sha256:${"d".repeat(64)}`,
      version: repositoryFixture.toolchain.node
    },
    exitCode: overrides.state === "failed" ? 1 : 0,
    limits: {
      environment: "sanitized-minimal",
      maxStderrBytes: 65_536,
      maxStdoutBytes: 2_097_152,
      timeoutMilliseconds: 30_000
    },
    measurement: name,
    provenance: {
      captureScriptSha256: `sha256:${"e".repeat(64)}`,
      kind: "local-unattested",
      producer: "capture-attunegraph-measurement@1",
      schema: READINESS_MEASUREMENT_PROVENANCE_SCHEMA
    },
    schema: READINESS_MEASUREMENT_RESULT_SCHEMA,
    signal: null,
    spawnError: overrides.state === "failed" ? "EXIT: fixture failure" : null,
    startedAt: overrides.endedAt ?? OBSERVED_AT,
    state: overrides.state ?? "observed",
    stderr: { path: stderrPath, sha256: digest(stderr) },
    stdout: { path: stdoutPath, sha256: digest(stdout) },
    subject: structuredClone(repositoryFixture.subject),
    toolchain: structuredClone(repositoryFixture.toolchain)
  };
  const body = `${JSON.stringify(result, null, 2)}\n`;
  await mkdir(measurementDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(fixture.evidenceDirectory, stdoutPath), stdout),
    writeFile(join(fixture.evidenceDirectory, stderrPath), stderr),
    writeFile(join(fixture.evidenceDirectory, resultPath), body)
  ]);
  fixture.evidence = {
    checks: fixture.evidence.checks,
    measurements: [{ name, result: { path: resultPath, sha256: digest(body) } }],
    schema: READINESS_EVIDENCE_SCHEMA,
    subject: fixture.evidence.subject
  };
  fixture.measurement = { report, result };
  return fixture.measurement;
}

async function syncMeasurementResult(fixture) {
  const entry = fixture.evidence.measurements[0];
  const body = `${JSON.stringify(fixture.measurement.result, null, 2)}\n`;
  await writeFile(join(fixture.evidenceDirectory, entry.result.path), body);
  entry.result.sha256 = digest(body);
}

async function syncMeasurementStdout(fixture) {
  const stdout = Buffer.from(`${JSON.stringify(fixture.measurement.report)}\n`);
  await writeFile(
    join(fixture.evidenceDirectory, fixture.measurement.result.stdout.path),
    stdout
  );
  fixture.measurement.result.stdout.sha256 = digest(stdout);
  await syncMeasurementResult(fixture);
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

describe("AttuneGraph readiness evidence protocol", () => {
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
      "vitest run --no-file-parallelism scripts/capture-attunegraph-readiness.test.mjs scripts/capture-attunegraph-measurement.test.mjs scripts/readiness-measurement-contracts.test.mjs scripts/score-attunegraph-readiness.test.mjs"
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
        schema: "attunegraph-readiness-score@1",
        score: 0
      });
    });
  });

  it("rejects pre-release evidence schema and producer identifiers", async () => {
    await withFixture(async (fixture) => {
      fixture.evidence.schema = "attunegraph-readiness-evidence@2";
      expect(() => score(fixture)).toThrow(/schema must be attunegraph-readiness-evidence@1/u);
      fixture.evidence.schema = "attunegraph-readiness-evidence@3";
      expect(() => score(fixture)).toThrow(/schema must be attunegraph-readiness-evidence@1/u);

      fixture.evidence.schema = READINESS_EVIDENCE_SCHEMA;
      fixture.results.get("inspect").provenance.producer = "capture-attunegraph-readiness@2";
      await syncResult(fixture, "inspect");
      expect(() => score(fixture)).toThrow(/provenance.*producer is unsupported/u);
    });
  });

  it("reports one unscored measurement without changing any gate or score", async () => {
    await withFixture(async (fixture) => {
      const checksBaseline = score(fixture);
      await addMixedMeasurement(fixture);
      const observed = score(fixture);
      expect(observed).toMatchObject({
        authenticity: "unattested",
        eligible: false,
        integrityThresholdMet: checksBaseline.integrityThresholdMet,
        measurements: [{
          claimEligible: false,
          name: "mixed-durable-agent-decision-observation",
          state: "observed"
        }],
        schema: "attunegraph-readiness-score@1",
        score: checksBaseline.score
      });
      expect(observed.gates).toEqual(checksBaseline.gates);
      expect(observed.gates.find((gate) => gate.name === "performance-resources")).toMatchObject({
        score: 0,
        state: "not-run"
      });

      fixture.measurement.result.state = "failed";
      fixture.measurement.result.exitCode = 1;
      fixture.measurement.result.spawnError = "EXIT: fixture failure";
      await syncMeasurementResult(fixture);
      const failed = score(fixture);
      expect(failed.measurements[0].state).toBe("failed");
      expect(failed.gates).toEqual(checksBaseline.gates);
      expect(failed.score).toBe(checksBaseline.score);
      expect(failed.integrityThresholdMet).toBe(checksBaseline.integrityThresholdMet);

      fixture.measurement.result.state = "observed";
      fixture.measurement.result.exitCode = 0;
      fixture.measurement.result.spawnError = null;
      fixture.measurement.result.startedAt = "2026-07-23T23:59:59.999Z";
      fixture.measurement.result.endedAt = "2026-07-23T23:59:59.999Z";
      fixture.measurement.report.provenance.capturedAt = "2026-07-23T23:59:59.999Z";
      await syncMeasurementStdout(fixture);
      const stale = score(fixture);
      expect(stale.measurements[0].state).toBe("stale");
      expect(stale.gates).toEqual(checksBaseline.gates);
      expect(stale.score).toBe(checksBaseline.score);
      expect(stale.integrityThresholdMet).toBe(checksBaseline.integrityThresholdMet);
    });
  });

  it("rejects missing, duplicate, extra, relabeled, and artifact-reused measurements", async () => {
    await withFixture(async (fixture) => {
      fixture.evidence = {
        checks: fixture.evidence.checks,
        measurements: [],
        schema: READINESS_EVIDENCE_SCHEMA,
        subject: fixture.evidence.subject
      };
      expect(() => score(fixture)).toThrow(/every required measurement exactly once/u);

      await addMixedMeasurement(fixture);
      const descriptor = structuredClone(fixture.evidence.measurements[0]);
      fixture.evidence.measurements = [descriptor, structuredClone(descriptor)];
      expect(() => score(fixture)).toThrow(/every required measurement exactly once/u);

      fixture.evidence.measurements = [{
        name: "unknown-observation",
        result: descriptor.result
      }];
      expect(() => score(fixture)).toThrow(/name does not match|no fixed measurement contract/u);

      fixture.evidence.measurements = [descriptor];
      fixture.measurement.report.claimEligible = true;
      await syncMeasurementStdout(fixture);
      expect(() => score(fixture)).toThrow(/claim-ineligible/u);

      fixture.measurement.report.claimEligible = false;
      await syncMeasurementStdout(fixture);
      fixture.evidence.measurements[0].result = fixture.evidence.checks[0].result;
      expect(() => score(fixture)).toThrow(/duplicate artifact path|measurement.*schema/u);
    });
  });

  it("rejects mixed measurement runtime and harness provenance tampering", async () => {
    await withFixture(async (fixture) => {
      await addMixedMeasurement(fixture);
      fixture.measurement.report.provenance.runtime.node = "v0.0.0";
      await syncMeasurementStdout(fixture);
      expect(() => score(fixture)).toThrow(/runtime does not match the outer toolchain/u);

      fixture.measurement.report.provenance.runtime.node = repositoryFixture.toolchain.node;
      fixture.measurement.report.provenance.harness.sha256 = `sha256:${"f".repeat(64)}`;
      await syncMeasurementStdout(fixture);
      expect(() => score(fixture)).toThrow(/harness hash does not match/u);
    });
  });

  it("rejects nested performance and storage claim injection", async () => {
    await withFixture(async (fixture) => {
      await addMixedMeasurement(fixture);
      fixture.measurement.report.timing.contract.latencyQualified = true;
      await syncMeasurementStdout(fixture);
      expect(() => score(fixture)).toThrow(/timing contract has unknown or missing fields/u);

      delete fixture.measurement.report.timing.contract.latencyQualified;
      fixture.measurement.report.storage.interpretation.checkpointEffectiveness = "qualified";
      await syncMeasurementStdout(fixture);
      expect(() => score(fixture)).toThrow(/storage evidence diverged/u);

      fixture.measurement.report.storage.interpretation.checkpointEffectiveness = "not-measured";
      fixture.measurement.report.storage.peakObservedTotalLogicalBytes = 0;
      await syncMeasurementStdout(fixture);
      expect(() => score(fixture)).toThrow(/observed peak diverged/u);

      fixture.measurement.report.storage.peakObservedTotalLogicalBytes = 2;
      fixture.measurement.report.storage.phases[1].files.writeAheadLog = {
        present: false,
        logicalBytes: null
      };
      await syncMeasurementStdout(fixture);
      expect(() => score(fixture)).toThrow(/sidecar presence diverged/u);
    });
  });

  it("rejects mixed measurement subject and artifact-byte tampering", async () => {
    await withFixture(async (fixture) => {
      await addMixedMeasurement(fixture);
      fixture.measurement.result.subject.attunegraph.sha = "0".repeat(40);
      await syncMeasurementResult(fixture);
      expect(() => score(fixture)).toThrow(/subject does not match the evidence subject/u);
    });

    await withFixture(async (fixture) => {
      await addMixedMeasurement(fixture);
      await writeFile(
        join(fixture.evidenceDirectory, fixture.measurement.result.stdout.path),
        "tampered\n"
      );
      expect(() => score(fixture)).toThrow(/sha256 does not match artifact bytes/u);
    });
  });

  it("refuses repository harness bytes reached through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attunegraph-readiness-harness-link-"));
    const repository = join(directory, "repository");
    const outside = join(directory, "outside");
    await Promise.all([mkdir(repository), mkdir(outside)]);
    await writeFile(join(repository, "regular.mjs"), "regular\n");
    await writeFile(join(outside, "tracer.mjs"), "outside\n");
    const canonicalRepository = realpathSync(repository);
    expect(readReadinessRepositoryRegularFile(canonicalRepository, ["regular.mjs"]).toString("utf8"))
      .toBe("regular\n");

    if (process.platform === "win32") {
      await symlink(outside, join(repository, "linked"), "junction");
      expect(() => readReadinessRepositoryRegularFile(canonicalRepository, ["linked", "tracer.mjs"]))
        .toThrow(/escapes its repository through a symlink/u);
    } else {
      await symlink(join(outside, "tracer.mjs"), join(repository, "tracer.mjs"));
      expect(() => readReadinessRepositoryRegularFile(canonicalRepository, ["tracer.mjs"]))
        .toThrow(/regular non-symlink/u);
    }
    await rm(directory, { force: true, recursive: true });
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
