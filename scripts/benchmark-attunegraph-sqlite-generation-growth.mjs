import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { openLocalAttuneGraphSession } from "../dist/local.js";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import { parseNewSqliteMeasurementDatabasePath } from "./sqlite-measurement-path.mjs";

const FINAL_GENERATION = 32;
const GENERATION_MILESTONES = Object.freeze([1, 2, 4, 8, 16, 32]);
const MAX_REPORT_BYTES = 128 * 1_024;
const EXPECTED_FINAL_COMMIT_ID =
  "attunegraph-commit:attunegraph-observation:83354c472f12f02c08c28470a3cac874f5ef6d396210898d9b522af34e954cae";
const EXPECTED_WORKLOAD_SHA256 =
  "sha256:32fb537f1aa9e22f83893083db473e6a992356ee368d699155fe079900cb80fd";
const NOW = "2026-08-01T12:00:00.000Z";
const OBSERVED_AT = "2026-08-01T11:59:00.000Z";
const SCOPE = Object.freeze({
  sourceId: "growth",
  threadId: "scope"
});
const THREAD_ROOT = Object.freeze({ id: "r", kind: "thread" });

function frozen(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function databasePathFrom(value) {
  return parseNewSqliteMeasurementDatabasePath(value, "SQLite generation-growth tracer");
}

function fileProfile(path) {
  try {
    const metadata = lstatSync(path, { bigint: true });
    const expectedOwner = process.geteuid?.();
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || expectedOwner === undefined
      || metadata.uid !== BigInt(expectedOwner)
      || (Number(metadata.mode) & 0o077) !== 0
      || metadata.size < 0n
      || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("SQLite generation-growth storage observation requires safe owner-only regular files");
    }
    return Object.freeze({ logicalBytes: Number(metadata.size), present: true });
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      return Object.freeze({ logicalBytes: null, present: false });
    }
    throw cause;
  }
}

function storageProfile(databasePath) {
  const database = fileProfile(databasePath);
  const writeAheadLog = fileProfile(`${databasePath}-wal`);
  const sharedMemory = fileProfile(`${databasePath}-shm`);
  return Object.freeze({
    database,
    writeAheadLog,
    sharedMemory,
    totalPresentLogicalBytes: [database, writeAheadLog, sharedMemory].reduce(
      (total, entry) => total + (entry.logicalBytes ?? 0),
      0
    )
  });
}

function assertion(generation, index, temporal = {}) {
  const generationId = generation.toString().padStart(3, "0");
  const suffix = index.toString().padStart(2, "0");
  const active = temporal.validTo === undefined;
  return Object.freeze({
    schemaVersion: 1,
    id: `${active ? "a" : "d"}:${generationId}:${suffix}`,
    subject: Object.freeze({ id: `${active ? "n" : "d"}:${suffix}`, kind: "artifact" }),
    predicate: "LINKED_TO",
    object: THREAD_ROOT,
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([Object.freeze({
      id: `s:${generationId}:${active ? "a" : "d"}:${suffix}`,
      namespace: "b"
    })]),
    recordedAt: OBSERVED_AT,
    ...(temporal.validTo === undefined ? {} : { validTo: temporal.validTo }),
    derivation: Object.freeze({ kind: "projection", version: "growth@1" })
  });
}

function generationCommand(generation) {
  const assertions = Object.freeze([
    ...Array.from({ length: 16 }, (_, index) => assertion(generation, index)),
    ...Array.from(
      { length: 24 },
      (_, index) => assertion(generation, index + 16, { validTo: "2026-08-01T11:00:00.000Z" })
    )
  ]);
  return Object.freeze({
    operator: "canonical-projection@2",
    observation: Object.freeze({
      schemaVersion: 2,
      observationKey: `growth:${generation.toString().padStart(3, "0")}`,
      scope: SCOPE,
      threadRoot: THREAD_ROOT,
      observedAt: OBSERVED_AT,
      sourceFreshness: Object.freeze({ observedAt: OBSERVED_AT, state: "fresh" }),
      assertions
    })
  });
}

const EXECUTE_COMMAND = Object.freeze({
  operator: "working-graph@1",
  seed: THREAD_ROOT,
  now: NOW,
  maxEstimatedTokens: 4_096
});

function semantic(result) {
  return Object.freeze({
    assertionIds: Object.freeze(result.workingGraph.assertions.map((entry) => entry.id)),
    emittedAssertions: result.workingGraph.assertions.length,
    estimatedTokens: result.workingGraph.diagnostics.estimatedTokens,
    status: result.status,
    visitedRefs: result.workingGraph.diagnostics.visitedRefs
  });
}

function verifyMilestone(generation, snapshot, result) {
  const observed = semantic(result);
  if (
    snapshot.generation !== generation
    || observed.status !== "complete"
    || observed.emittedAssertions !== 16
    || observed.assertionIds.some((id) => !id.startsWith(
      `a:${generation.toString().padStart(3, "0")}:`
    ))
  ) {
    throw new Error("SQLite generation-growth tracer observed semantic divergence");
  }
  return observed;
}

function storagePhase(databasePath, ordinal, phase, latestCommittedGeneration, openSessions, operations) {
  return Object.freeze({
    completedPublicOperations: Object.freeze({ ...operations }),
    files: storageProfile(databasePath),
    latestCommittedGeneration,
    openSessions,
    ordinal,
    phase
  });
}

function composeFailure(primary, cleanupFailures) {
  if (cleanupFailures.length === 0) return primary;
  if (primary === undefined && cleanupFailures.length === 1) return cleanupFailures[0];
  return new AggregateError(
    primary === undefined ? cleanupFailures : [primary, ...cleanupFailures],
    "SQLite generation-growth tracer cleanup failed"
  );
}

async function closeResources(handle, session, primaryFailure) {
  const cleanupFailures = [];
  if (handle !== undefined) {
    try { await handle.close(); } catch (cause) { cleanupFailures.push(cause); }
  }
  if (session !== undefined) {
    try { await session.close(); } catch (cause) { cleanupFailures.push(cause); }
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw composeFailure(primaryFailure, cleanupFailures);
  }
}

export async function runSqliteGenerationGrowthTracer(options) {
  const databasePath = databasePathFrom(options);
  const phases = [];
  const milestoneProjectionBytes = [];
  const commitIds = [];
  const operations = { decisionReads: 0, headReads: 0, writes: 0 };
  const recordPhase = (phase, latestCommittedGeneration, openSessions) => {
    phases.push(storagePhase(
      databasePath,
      phases.length,
      phase,
      latestCommittedGeneration,
      openSessions,
      operations
    ));
  };
  let session;
  let handle;
  let primaryFailure;
  let finalSnapshot;
  let finalSemantic;
  let sessionCloseResolutions = 0;
  try {
    recordPhase("before-open", null, 0);
    session = await openLocalAttuneGraphSession({ databasePath });
    recordPhase("after-writer-session-open", null, 1);
    handle = await session.open({ scope: SCOPE });
    for (let generation = 1; generation <= FINAL_GENERATION; generation += 1) {
      const command = generationCommand(generation);
      const snapshot = await handle.projectAgainstHead(clone(command));
      operations.writes += 1;
      if (snapshot.generation !== generation) {
        throw new Error("SQLite generation-growth tracer generation diverged");
      }
      commitIds.push(snapshot.commitId);
      finalSnapshot = Object.freeze({ ...snapshot });
      if (!GENERATION_MILESTONES.includes(generation)) continue;
      milestoneProjectionBytes.push(Object.freeze({
        generation,
        observationJsonBytes: Buffer.byteLength(JSON.stringify(command.observation), "utf8")
      }));
      recordPhase(`after-generation-${generation.toString()}`, generation, 1);
    }
    const precloseSnapshot = await handle.head();
    operations.headReads += 1;
    const precloseResult = await handle.execute(clone(EXECUTE_COMMAND));
    operations.decisionReads += 1;
    finalSemantic = verifyMilestone(FINAL_GENERATION, precloseSnapshot, precloseResult);
    if (!isDeepStrictEqual(precloseSnapshot, finalSnapshot)) {
      throw new Error("SQLite generation-growth tracer preclose head diverged");
    }
    recordPhase("after-preclose-verification", FINAL_GENERATION, 1);
    await handle.close();
    handle = undefined;
    recordPhase("after-writer-handle-close", FINAL_GENERATION, 1);
    await session.close();
    session = undefined;
    sessionCloseResolutions += 1;
    recordPhase("after-writer-session-close", FINAL_GENERATION, 0);

    session = await openLocalAttuneGraphSession({ databasePath });
    recordPhase("after-verifier-session-open", FINAL_GENERATION, 1);
    handle = await session.open({ scope: SCOPE });
    const reopenedSnapshot = await handle.head();
    operations.headReads += 1;
    const reopenedResult = await handle.execute(clone(EXECUTE_COMMAND));
    operations.decisionReads += 1;
    const reopenedSemantic = verifyMilestone(FINAL_GENERATION, reopenedSnapshot, reopenedResult);
    if (
      !isDeepStrictEqual(reopenedSnapshot, finalSnapshot)
      || !isDeepStrictEqual(reopenedSemantic, finalSemantic)
    ) {
      throw new Error("SQLite generation-growth tracer reopen result diverged");
    }
    recordPhase("after-reopen-verification", FINAL_GENERATION, 1);
    await handle.close();
    handle = undefined;
    recordPhase("after-verifier-handle-close", FINAL_GENERATION, 1);
    await session.close();
    session = undefined;
    sessionCloseResolutions += 1;
    recordPhase("after-verifier-session-close", FINAL_GENERATION, 0);
    if (new Set(commitIds).size !== FINAL_GENERATION) {
      throw new Error("SQLite generation-growth tracer commit identity sequence diverged");
    }
  } catch (cause) {
    primaryFailure = cause;
  }
  await closeResources(handle, session, primaryFailure);

  const firstGeneration = phases.find((phase) => phase.phase === "after-generation-1");
  const finalGeneration = phases.find((phase) => phase.phase === "after-generation-32");
  if (firstGeneration === undefined || finalGeneration === undefined) {
    throw new Error("SQLite generation-growth tracer did not record its fixed milestones");
  }
  const fixedWorkload = Object.freeze({
    execute: EXECUTE_COMMAND,
    generationMilestones: GENERATION_MILESTONES,
    generationOne: generationCommand(1),
    generationFinal: generationCommand(FINAL_GENERATION)
  });
  const workloadSha256 = sha256(JSON.stringify(fixedWorkload));
  if (
    finalSnapshot.commitId !== EXPECTED_FINAL_COMMIT_ID
    || workloadSha256 !== EXPECTED_WORKLOAD_SHA256
  ) {
    throw new Error("SQLite generation-growth tracer fixed workload identity diverged");
  }
  const report = frozen({
    schema: "attunegraph-sqlite-generation-growth@1",
    measurementOnly: true,
    claimEligible: false,
    observedAt: new Date().toISOString(),
    provenance: {
      authority: "unattested-local-process",
      harness: {
        id: "sqlite-generation-growth@1",
        sha256: sha256(readFileSync(fileURLToPath(import.meta.url)))
      },
      workload: {
        id: "single-thread-32-generation-journal@1",
        sha256: workloadSha256
      },
      runtime: {
        arch: arch(),
        node: process.version,
        os: platform(),
        sqlite: process.versions.sqlite ?? "unknown",
        v8: process.versions.v8
      }
    },
    measurementBoundary: {
      database: "one-fresh-caller-owned-sqlite-file",
      osCache: "uncontrolled",
      sessionTopology: "one-writer-then-one-verifier",
      storageMethod: "lstat-logical-size-at-settled-public-api-boundaries"
    },
    correctness: {
      commitIdsUnique: true,
      exactFinalHeadStable: true,
      exactFinalResultStable: true,
      finalCommitId: EXPECTED_FINAL_COMMIT_ID,
      finalGeneration: FINAL_GENERATION,
      generationSequenceExact: true,
      generationsCommitted: FINAL_GENERATION,
      precloseHeadExact: true,
      reopenVerified: true,
      successfulSessionCloseResolutions: sessionCloseResolutions
    },
    workload: {
      activeAssertionsPerGeneration: 16,
      generationMilestones: GENERATION_MILESTONES,
      inactiveAssertionsPerGeneration: 24,
      projectedAssertionInputs: FINAL_GENERATION * 40,
      milestoneProjectionBytes
    },
    storage: {
      schema: "attunegraph-sqlite-generation-files@1",
      method: "lstat-logical-size-at-settled-phase-boundaries",
      checkpoint: {
        counters: "not-exposed-by-public-api",
        fileDeltaAttribution: "passive-attempt-and-final-connection-close-cannot-be-separated",
        mode: "PASSIVE",
        result: "not-exposed-by-public-api",
        successfulCloseResolutions: sessionCloseResolutions,
        trigger: "each-public-session-close"
      },
      logicalSizeOnly: true,
      observedTotalLogicalBytesDeltaGeneration1To32:
        finalGeneration.files.totalPresentLogicalBytes
        - firstGeneration.files.totalPresentLogicalBytes,
      peakObservedTotalLogicalBytes: Math.max(
        ...phases.map((phase) => phase.files.totalPresentLogicalBytes)
      ),
      phases
    },
    limits: {
      allocatedBytes: "not-measured",
      checkpointEffectiveness: "not-measured",
      compactionQualification: "not-measured",
      databasePageReuse: "not-measured",
      growthSlopeQualification: "not-measured",
      monotonicGrowthExpected: false,
      osPageCache: "uncontrolled",
      retentionPolicy: "not-evaluated",
      sustainedOperation: "not-measured",
      walFrameCounts: "not-exposed"
    }
  });
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BYTES) {
    throw new Error("SQLite generation-growth report exceeded its fixed 128 KiB output cap");
  }
  return report;
}

export function serializeSqliteGenerationGrowthReport(report) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("SQLite generation-growth report exceeded its fixed 128 KiB output cap");
  }
  return output;
}

export async function runSqliteGenerationGrowthTracerCommand(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("SQLite generation-growth tracer accepts no arguments");
  }
  const createdDirectory = mkdtempSync(join(tmpdir(), "attunegraph-sqlite-generation-growth-"));
  chmodSync(createdDirectory, 0o700);
  const directory = realpathSync(createdDirectory);
  let primaryFailure;
  try {
    const report = await runSqliteGenerationGrowthTracer({
      databasePath: join(directory, "attunegraph.sqlite")
    });
    process.stdout.write(serializeSqliteGenerationGrowthReport(report));
    return report;
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    try {
      rmSync(createdDirectory, { force: true, recursive: true });
    } catch (cause) {
      throw composeFailure(primaryFailure, [cause]);
    }
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  await runSqliteGenerationGrowthTracerCommand().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
