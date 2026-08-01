import { Buffer } from "node:buffer";
import {
  chmodSync,
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
  runSqliteGenerationGrowthTracer,
  runSqliteGenerationGrowthTracerCommand,
  serializeSqliteGenerationGrowthReport
} from "./benchmark-attunegraph-sqlite-generation-growth.mjs";

const temporaryDirectories = [];

function privateDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "attunegraph-generation-growth-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return join(realpathSync(directory), "attunegraph.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("observes bounded generation growth without turning logical bytes into a compaction claim", async () => {
  const report = await runSqliteGenerationGrowthTracer({ databasePath: privateDatabasePath() });

  expect(report).toMatchObject({
    schema: "attunegraph-sqlite-generation-growth@1",
    measurementOnly: true,
    claimEligible: false,
    provenance: { authority: "unattested-local-process" },
    measurementBoundary: {
      database: "one-fresh-caller-owned-sqlite-file",
      osCache: "uncontrolled",
      sessionTopology: "one-writer-then-one-verifier",
      storageMethod: "lstat-logical-size-at-settled-public-api-boundaries"
    },
    correctness: {
      exactFinalHeadStable: true,
      exactFinalResultStable: true,
      finalCommitId: "attunegraph-commit:attunegraph-observation:83354c472f12f02c08c28470a3cac874f5ef6d396210898d9b522af34e954cae",
      finalGeneration: 32,
      generationsCommitted: 32,
      reopenVerified: true
    },
    storage: {
      schema: "attunegraph-sqlite-generation-files@1",
      method: "lstat-logical-size-at-settled-phase-boundaries",
      checkpoint: {
        counters: "not-exposed-by-public-api",
        fileDeltaAttribution: "passive-attempt-and-final-connection-close-cannot-be-separated",
        mode: "PASSIVE",
        result: "not-exposed-by-public-api",
        successfulCloseResolutions: 2,
        trigger: "each-public-session-close"
      }
    },
    workload: {
      activeAssertionsPerGeneration: 16,
      generationMilestones: [1, 2, 4, 8, 16, 32],
      inactiveAssertionsPerGeneration: 24,
      projectedAssertionInputs: 1_280
    }
  });
  expect(report.provenance.workload.sha256).toBe(
    "sha256:32fb537f1aa9e22f83893083db473e6a992356ee368d699155fe079900cb80fd"
  );
  expect(report.storage.phases.map((phase) => phase.phase)).toEqual([
    "before-open",
    "after-writer-session-open",
    "after-generation-1",
    "after-generation-2",
    "after-generation-4",
    "after-generation-8",
    "after-generation-16",
    "after-generation-32",
    "after-preclose-verification",
    "after-writer-handle-close",
    "after-writer-session-close",
    "after-verifier-session-open",
    "after-reopen-verification",
    "after-verifier-handle-close",
    "after-verifier-session-close"
  ]);
  expect(report.storage.phases.map((phase) => phase.ordinal)).toEqual(
    Array.from({ length: 15 }, (_, index) => index)
  );
  expect(report.storage.phases[0].files.database).toEqual({ present: false, logicalBytes: null });
  for (const phase of report.storage.phases.slice(1)) {
    expect(phase.files.database.present).toBe(true);
    expect(phase.files.database.logicalBytes).toBeGreaterThan(0);
    expect(phase.files.totalPresentLogicalBytes).toBeGreaterThan(0);
  }
  expect(report.storage.phases.at(-1).completedPublicOperations).toEqual({
    decisionReads: 2,
    headReads: 2,
    writes: 32
  });
  expect(report.limits).toMatchObject({
    allocatedBytes: "not-measured",
    checkpointEffectiveness: "not-measured",
    compactionQualification: "not-measured",
    growthSlopeQualification: "not-measured",
    retentionPolicy: "not-evaluated"
  });
  expect(Buffer.byteLength(serializeSqliteGenerationGrowthReport(report), "utf8"))
    .toBeLessThanOrEqual(128 * 1_024);
  expect(Object.isFrozen(report)).toBe(true);
});

it("rejects accessor-backed options without evaluating them", async () => {
  let reads = 0;
  const options = Object.defineProperty({}, "databasePath", {
    enumerable: true,
    get() {
      reads += 1;
      return privateDatabasePath();
    }
  });

  await expect(runSqliteGenerationGrowthTracer(options)).rejects.toThrow(
    "requires one new canonical absolute databasePath"
  );
  expect(reads).toBe(0);
});

it("rejects an existing database or sidecar before opening SQLite", async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const databasePath = privateDatabasePath();
    writeFileSync(`${databasePath}${suffix}`, "occupied", { mode: 0o600 });
    await expect(runSqliteGenerationGrowthTracer({ databasePath })).rejects.toThrow(
      "requires a new databasePath and sidecars"
    );
  }
});

it("rejects extra fields, symlink parents, and command arguments", async () => {
  const databasePath = privateDatabasePath();
  await expect(runSqliteGenerationGrowthTracer({ databasePath, extra: true })).rejects.toThrow(
    "requires one new canonical absolute databasePath"
  );

  const realParent = realpathSync(join(databasePath, ".."));
  const alias = `${realParent}-alias`;
  temporaryDirectories.push(alias);
  symlinkSync(realParent, alias, "dir");
  await expect(runSqliteGenerationGrowthTracer({
    databasePath: join(alias, "attunegraph.sqlite")
  })).rejects.toThrow("database parent must be an existing canonical directory");

  await expect(runSqliteGenerationGrowthTracerCommand(["unexpected"])).rejects.toThrow(
    "accepts no arguments"
  );
});

it("fails closed before emitting more than the fixed 128 KiB report cap", () => {
  expect(() => serializeSqliteGenerationGrowthReport({
    schema: "attunegraph-sqlite-generation-growth@1",
    oversized: "x".repeat(128 * 1_024)
  })).toThrow("exceeded its fixed 128 KiB output cap");
});
