import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  runMixedDurableAgentDecisionTracer,
  runMixedDurableAgentDecisionTracerCommand
} from "./benchmark-attunegraph-agent-decision-mixed-durable.mjs";
import {
  readinessMeasurementContract,
  validateReadinessMeasurementOutput
} from "./readiness-measurement-contracts.mjs";

const temporaryDirectories = [];

function privateDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "attunegraph-mixed-durable-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return realpathSync(directory);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("runs an exact 80-read/20-write schedule through four public SQLite sessions", async () => {
  const databasePath = join(privateDirectory(), "attunegraph.sqlite");

  const report = await runMixedDurableAgentDecisionTracer({ databasePath });

  expect(report).toMatchObject({
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
      process: "same-process-new-verifier-worker",
      sameScopeContention: "not-measured",
      sessionTopology: "four-independent-public-sessions",
      outstandingMeaning: "harness-operation-tasks-not-public-promises-or-database-execution"
    },
    workload: {
      id: "four-session-mixed-80r20w@1",
      activeAssertionCountPerHead: 16,
      inactiveAssertionCountPerHead: 24,
      totalAssertionCountPerHead: 40,
      clients: 4,
      cycles: 5,
      measuredLogicalOperations: 100,
      logicalOperationType: "public-agent-api",
      mixedReadWriteWaves: 16,
      readOperations: 80,
      waves: 25,
      writeOperations: 20,
      initialGeneration: 1,
      finalGeneration: 6,
      excludedDataOperations: {
        preparationWrites: 4,
        precloseVerificationReads: 4,
        reopenVerificationReads: 4,
        total: 12
      },
      totalDataOperations: {
        reads: 88,
        writes: 24,
        total: 112
      }
    },
    concurrency: {
      barrierCount: 25,
      peakOutstandingOperationTasksObserved: 4,
      mixedReadWriteBarrierCount: 16,
      operationsPerClient: 25,
      readOnlyBarrierCount: 8,
      writeOnlyBarrierCount: 1
    },
    correctness: {
      allOperationsSucceeded: true,
      finalHeadsMatchGoldenManifest: true,
      fullResultsStableAcrossReopen: true,
      readSemanticsMatchCurrentHead: true,
      writeSnapshotsMatchProjectionContract: true,
      goldenManifestVersion: "four-session-mixed-80r20w@1",
      reopenExact: true,
      scheduleExact: true
    }
  });
  expect(report.concurrency.clients).toEqual(
    Array.from({ length: 4 }, (_, client) => ({
      clientId: `client:${client.toString()}`,
      reads: 20,
      writes: 5
    }))
  );
  expect(report.correctness.finalHeads).toHaveLength(4);
  const expectedCommitIds = [
    "attunegraph-commit:attunegraph-observation:3161ff4f3c9fe70e4c0340ff1cfa1a601cc4b9b6678c713d1f9b9e59a8f485fd",
    "attunegraph-commit:attunegraph-observation:7d88dc3989e66a928a46e81485eeb905d394cd40a2cc30009119969c0d4c8e37",
    "attunegraph-commit:attunegraph-observation:19f3972b58721f620a986654a5e8b2d6129f8e5c5fcd60af569e32060a7fc88d",
    "attunegraph-commit:attunegraph-observation:c3a8bb800935b71ff8a5f035074630f9aec1fefab4c4c5b81ec3c0f8b51b87c0"
  ];
  for (const [client, head] of report.correctness.finalHeads.entries()) {
    const clientId = client.toString();
    expect(head).toMatchObject({
      clientId: `client:${clientId}`,
      generation: 6,
      assertionIds: expect.arrayContaining([
        `a:c${clientId}:g06:00`,
        `a:c${clientId}:g06:15`
      ]),
      consideredAssertions: 16,
      emittedAssertions: 16,
      headCommitId: expectedCommitIds[client],
      refIds: [
        ...Array.from({ length: 16 }, (_, index) => (
          `artifact:n:c${clientId}:${index.toString().padStart(2, "0")}`
        )),
        `thread:r:c${clientId}`
      ],
      sourceFreshness: {
        state: "fresh",
        observedAt: "2026-08-01T11:59:00.000Z"
      },
      status: "complete",
      visitedRefs: 17
    });
    expect(head.assertionIds).toHaveLength(16);
    expect(head.sourceRefIds).toEqual(
      Array.from(
        { length: 16 },
        (_, index) => `b:s:c${clientId}:g06:a:${index.toString().padStart(2, "0")}`
      )
    );
    expect(head.assertionProvenance).toEqual(
      Array.from({ length: 16 }, (_, index) => {
        const suffix = index.toString().padStart(2, "0");
        return {
          assertionId: `a:c${clientId}:g06:${suffix}`,
          derivation: { kind: "projection", version: "mixed@1" },
          sourceRefs: [{ namespace: "b", id: `s:c${clientId}:g06:a:${suffix}` }]
        };
      })
    );
  }
  expect(report.operationLedger).toHaveLength(100);
  expect(new Set(report.operationLedger.map((entry) => entry.operationId)).size).toBe(100);
  expect(report.operationLedger.map((entry) => entry.ordinal)).toEqual(
    Array.from({ length: 100 }, (_, index) => index)
  );
  for (const entry of report.operationLedger) {
    expect(entry.operationTaskStartedAfterMixedStartMilliseconds).toBeGreaterThanOrEqual(0);
    expect(entry.operationTaskSettledAfterMixedStartMilliseconds).toBeGreaterThanOrEqual(
      entry.operationTaskStartedAfterMixedStartMilliseconds
    );
    expect(
      entry.operationTaskSettledAfterMixedStartMilliseconds
        - entry.operationTaskStartedAfterMixedStartMilliseconds
    ).toBeCloseTo(entry.durationMilliseconds, 8);
    expect(entry.observedCommitId).toMatch(
      /^attunegraph-commit:attunegraph-observation:[0-9a-f]{64}$/u
    );
  }
  for (let wave = 0; wave < 25; wave += 1) {
    const entries = report.operationLedger.slice(wave * 4, wave * 4 + 4);
    expect(entries.map((entry) => entry.wave)).toEqual([wave, wave, wave, wave]);
    expect(entries.map((entry) => entry.clientId)).toEqual([
      "client:0", "client:1", "client:2", "client:3"
    ]);
    expect(entries.map((entry) => entry.scope.threadId)).toEqual([
      "client:0", "client:1", "client:2", "client:3"
    ]);
    if (wave === 0) {
      expect(entries.map((entry) => entry.kind)).toEqual(["write", "write", "write", "write"]);
    } else if (wave <= 16) {
      expect(entries.filter((entry) => entry.kind === "write").map((entry) => entry.clientId)).toEqual([
        `client:${((wave - 1) % 4).toString()}`
      ]);
    } else {
      expect(entries.map((entry) => entry.kind)).toEqual(["read", "read", "read", "read"]);
    }
  }
  expect(report.timing.mixedWallMilliseconds).toBeGreaterThanOrEqual(0);
  expect(report.timing.verifierReopenMilliseconds).toBeGreaterThanOrEqual(0);
  expect(report.timing.contract).toEqual({
    clock: "performance.now-monotonic",
    mixedWallIncludes: "cell-build-clone-public-call-validation-and-wave-bookkeeping",
    operationDurationIncludes: "cell-build-clone-public-call-and-validation",
    verifierReopenIncludes: "session-and-worker-open-only",
    pureDatabaseLatency: false
  });
  expect(report.provenance).toMatchObject({
    authority: "unattested-local-process",
    sqliteVersion: "not-exposed-by-public-api",
    harness: {
      id: "benchmark-attunegraph-agent-decision-mixed-durable@1"
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch
    }
  });
  expect(report.provenance.harness.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(report.provenance.workload.sha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(report.limitations.nonClaims).toContain("latency-throughput-or-tail-qualification");
  expect(report.storage).toMatchObject({
    schema: "attunegraph-sqlite-footprint@1",
    method: "lstat-logical-size-at-settled-phase-boundaries",
    checkpoint: {
      mode: "PASSIVE",
      result: "not-exposed-by-public-api",
      trigger: "each-public-session-close"
    }
  });
  expect(report.storage.phases.map((phase) => phase.phase)).toEqual([
    "after-preparation",
    "after-four-sessions-open",
    "after-mixed-settled",
    "after-session-close",
    "after-session-close",
    "after-session-close",
    "after-session-close",
    "after-verifier-open",
    "after-verifier-verification",
    "after-verifier-close"
  ]);
  for (const phase of report.storage.phases) {
    expect(phase.files.database.present).toBe(true);
    expect(phase.files.database.logicalBytes).toBeGreaterThan(0);
    expect(phase.files.totalPresentLogicalBytes).toBeGreaterThanOrEqual(
      phase.files.database.logicalBytes
    );
  }
  expect(lstatSync(databasePath).isFile()).toBe(true);
  expect(Object.isFrozen(report)).toBe(true);
  const measurementContract = readinessMeasurementContract(
    "mixed-durable-agent-decision-observation"
  );
  expect(validateReadinessMeasurementOutput(JSON.stringify(report), measurementContract))
    .toEqual(report);
  expect(() => validateReadinessMeasurementOutput(JSON.stringify({
    ...report,
    claimEligible: true
  }), measurementContract)).toThrow(/claim-ineligible/u);
  const drifted = structuredClone(report);
  drifted.operationLedger[0].kind = "read";
  expect(() => validateReadinessMeasurementOutput(JSON.stringify(drifted), measurementContract))
    .toThrow(/operation ledger/u);
});

it("rejects pre-existing SQLite sidecars before opening the fresh-store workload", async () => {
  const walDatabasePath = join(privateDirectory(), "wal.sqlite");
  writeFileSync(`${walDatabasePath}-wal`, "orphan");
  await expect(runMixedDurableAgentDecisionTracer({ databasePath: walDatabasePath }))
    .rejects.toThrow("requires a new databasePath without sidecars");

  const shmDatabasePath = join(privateDirectory(), "shm.sqlite");
  symlinkSync("missing-target", `${shmDatabasePath}-shm`);
  await expect(runMixedDurableAgentDecisionTracer({ databasePath: shmDatabasePath }))
    .rejects.toThrow("requires a new databasePath without sidecars");
});

it("keeps the standalone command argument-free", async () => {
  await expect(runMixedDurableAgentDecisionTracerCommand(["--output", "report.json"]))
    .rejects.toThrow("does not accept command-line arguments");
});
