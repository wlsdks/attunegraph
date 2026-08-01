import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { openLocalAttuneGraphSession } from "../dist/local.js";
import {
  inspectLocalSessionWorkerHeapStatisticsForMeasurement
} from "../dist/local-session-internal.js";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import { parseNewSqliteMeasurementDatabasePath } from "./sqlite-measurement-path.mjs";

const CYCLES = 4;
const MAX_REPORT_BYTES = 128 * 1_024;
const NOW = "2026-08-01T12:00:00.000Z";
const OBSERVED_AT = "2026-08-01T11:59:00.000Z";
const SCOPE = Object.freeze({
  sourceId: "worker-resource-lifecycle",
  threadId: "controlled-reopen"
});
const THREAD_ROOT = Object.freeze({
  id: "thread:worker-resource-lifecycle",
  kind: "thread"
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function optionsRecord(value) {
  return Object.freeze({
    databasePath: parseNewSqliteMeasurementDatabasePath(
      value,
      "worker resource lifecycle tracer"
    )
  });
}

function processMemorySnapshot() {
  const memory = process.memoryUsage();
  return Object.freeze({
    wholeProcess: Object.freeze({
      peakRssBytes: process.resourceUsage().maxRSS * 1_024,
      rssBytes: memory.rss
    }),
    mainThread: Object.freeze({
      arrayBuffersBytes: memory.arrayBuffers,
      externalBytes: memory.external,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed
    })
  });
}

function assertion(index, temporal = {}) {
  const suffix = index.toString().padStart(2, "0");
  return Object.freeze({
    schemaVersion: 1,
    id: `worker-resource:${temporal.validTo === undefined ? "active" : "expired"}:${suffix}`,
    subject: Object.freeze({
      id: `artifact:worker-resource:${temporal.validTo === undefined ? "active" : "expired"}:${suffix}`,
      kind: "artifact"
    }),
    predicate: "LINKED_TO",
    object: THREAD_ROOT,
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([Object.freeze({
      id: `worker-resource:${suffix}`,
      namespace: "attunegraph.measurement"
    })]),
    recordedAt: OBSERVED_AT,
    ...(temporal.validTo === undefined ? {} : { validTo: temporal.validTo }),
    derivation: Object.freeze({ kind: "projection", version: "worker-resource-lifecycle@1" })
  });
}

function workload() {
  const assertions = Object.freeze([
    ...Array.from({ length: 16 }, (_, index) => assertion(index)),
    ...Array.from(
      { length: 8 },
      (_, index) => assertion(index + 16, { validTo: "2026-08-01T11:00:00.000Z" })
    )
  ]);
  return Object.freeze({
    project: Object.freeze({
      operator: "canonical-projection@2",
      observation: Object.freeze({
        schemaVersion: 2,
        observationKey: "worker-resource-lifecycle@1:fixed-head",
        scope: SCOPE,
        threadRoot: THREAD_ROOT,
        observedAt: OBSERVED_AT,
        sourceFreshness: Object.freeze({ state: "fresh", observedAt: OBSERVED_AT }),
        assertions
      })
    }),
    execute: Object.freeze({
      operator: "working-graph@1",
      seed: THREAD_ROOT,
      now: NOW,
      maxEstimatedTokens: 4_096
    })
  });
}

function resultSummary(result) {
  return Object.freeze({
    assertionIds: Object.freeze(result.workingGraph.assertions.map((entry) => entry.id)),
    emittedAssertions: result.workingGraph.assertions.length,
    estimatedTokens: result.workingGraph.diagnostics.estimatedTokens,
    status: result.status,
    visitedRefs: result.workingGraph.diagnostics.visitedRefs
  });
}

function detached(value) {
  return JSON.parse(JSON.stringify(value));
}

function composeFailure(primary, cleanupFailures) {
  if (cleanupFailures.length === 0) return primary;
  if (primary === undefined && cleanupFailures.length === 1) return cleanupFailures[0];
  return new AggregateError(
    primary === undefined ? cleanupFailures : [primary, ...cleanupFailures],
    "worker resource lifecycle tracer cleanup failed"
  );
}

async function closeResources(graph, session, primaryFailure) {
  const cleanupFailures = [];
  if (graph !== undefined) {
    try { await graph.close(); } catch (cause) { cleanupFailures.push(cause); }
  }
  if (session !== undefined) {
    try { await session.close(); } catch (cause) { cleanupFailures.push(cause); }
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw composeFailure(primaryFailure, cleanupFailures);
  }
}

async function prepareDatabase(databasePath, fixedWorkload) {
  let graph;
  let session;
  let primaryFailure;
  let prepared;
  try {
    session = await openLocalAttuneGraphSession({ databasePath });
    graph = await session.open({ scope: SCOPE });
    const snapshot = await graph.project(detached(fixedWorkload.project));
    const result = await graph.execute(detached(fixedWorkload.execute));
    const semantic = resultSummary(result);
    if (snapshot.generation !== 1 || semantic.status !== "complete" || semantic.emittedAssertions !== 16) {
      throw new Error("worker resource lifecycle preparation changed fixed semantics");
    }
    prepared = Object.freeze({ semantic, snapshot: Object.freeze({ ...snapshot }) });
    await graph.close();
    graph = undefined;
    await session.close();
    session = undefined;
  } catch (cause) {
    primaryFailure = cause;
  }
  await closeResources(graph, session, primaryFailure);
  return prepared;
}

export async function runWorkerResourceLifecycleTracer(options) {
  const input = optionsRecord(options);
  const fixedWorkload = workload();
  const prepared = await prepareDatabase(input.databasePath, fixedWorkload);
  const expectedSnapshot = JSON.stringify(prepared.snapshot);
  const expectedResult = JSON.stringify(prepared.semantic);
  const cycles = [];

  for (let index = 0; index < CYCLES; index += 1) {
    const beforeOpen = processMemorySnapshot();
    let graph;
    let session;
    let primaryFailure;
    let completed;
    try {
      let startedAt = performance.now();
      session = await openLocalAttuneGraphSession({ databasePath: input.databasePath });
      const sessionOpenMilliseconds = performance.now() - startedAt;
      const afterOpenMemory = processMemorySnapshot();
      const afterOpenWorker = await inspectLocalSessionWorkerHeapStatisticsForMeasurement(session);

      startedAt = performance.now();
      graph = await session.open({ scope: SCOPE });
      const handleOpenMilliseconds = performance.now() - startedAt;
      startedAt = performance.now();
      const snapshot = await graph.head();
      const headMilliseconds = performance.now() - startedAt;
      startedAt = performance.now();
      const result = await graph.execute(detached(fixedWorkload.execute));
      const executeMilliseconds = performance.now() - startedAt;
      const afterWorkMemory = processMemorySnapshot();
      const afterWorkWorker = await inspectLocalSessionWorkerHeapStatisticsForMeasurement(session);
      const semantic = resultSummary(result);

      if (
        snapshot === undefined
        || snapshot.generation !== 1
        || JSON.stringify(snapshot) !== expectedSnapshot
        || JSON.stringify(semantic) !== expectedResult
      ) {
        throw new Error("worker resource lifecycle read-only reopen result diverged");
      }

      startedAt = performance.now();
      await graph.close();
      const handleCloseMilliseconds = performance.now() - startedAt;
      graph = undefined;
      const afterHandleCloseMemory = processMemorySnapshot();
      const afterHandleCloseWorker = await inspectLocalSessionWorkerHeapStatisticsForMeasurement(
        session
      );
      startedAt = performance.now();
      await session.close();
      const sessionCloseMilliseconds = performance.now() - startedAt;
      session = undefined;
      const afterSessionClose = processMemorySnapshot();
      completed = deepFreeze({
        index,
        memory: {
          beforeOpen,
          afterOpen: afterOpenMemory,
          afterWork: afterWorkMemory,
          afterHandleClose: afterHandleCloseMemory,
          afterSessionClose,
          wholeProcessRssAfterSessionCloseDeltaFromBeforeOpenBytes:
            afterSessionClose.wholeProcess.rssBytes - beforeOpen.wholeProcess.rssBytes
        },
        result: semantic,
        snapshot: {
          commitId: snapshot.commitId,
          generation: snapshot.generation
        },
        timing: {
          executeMilliseconds,
          handleCloseMilliseconds,
          handleOpenMilliseconds,
          headMilliseconds,
          sessionCloseMilliseconds,
          sessionOpenMilliseconds
        },
        workerHeap: {
          afterOpen: afterOpenWorker,
          afterWork: afterWorkWorker,
          afterHandleClose: afterHandleCloseWorker
        }
      });
    } catch (cause) {
      primaryFailure = cause;
    }
    await closeResources(graph, session, primaryFailure);
    cycles.push(completed);
  }

  const harnessBytes = readFileSync(fileURLToPath(import.meta.url));
  const report = deepFreeze({
    schema: "attunegraph-worker-resource-lifecycle@1",
    measurementOnly: true,
    claimEligible: false,
    observedAt: new Date().toISOString(),
    provenance: {
      authority: "unattested-local-process",
      harness: {
        id: "worker-resource-lifecycle@1",
        sha256: sha256(harnessBytes)
      },
      workload: {
        id: "worker-resource-lifecycle-fixed-head@1",
        sha256: sha256(JSON.stringify(fixedWorkload))
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
      cycles: CYCLES,
      database: "one-prepared-shared-sqlite-file",
      mainThreadMemoryScope: "calling-main-thread-process.memoryUsage-fields-except-rss",
      process: "one-main-process-sequential-workers",
      processRssScope: "whole-process-includes-main-and-active-worker",
      sessionCloseContract: "resolves-after-worker-exit",
      workerHeapScope: "active-worker-isolate-v8-heap-only"
    },
    excludedPreparation: {
      decisionReads: 1,
      sessions: 1,
      writes: 1
    },
    correctness: {
      cyclesCompleted: cycles.length,
      exactHeadStable: true,
      exactResultStable: true,
      generationStable: true,
      handleCloseWorkerSamples: cycles.length,
      sessionCloseResolutions: cycles.length,
      workerHeapSamples: cycles.length * 3
    },
    workload: {
      activeAssertions: 16,
      expiredAssertions: 8,
      id: "worker-resource-lifecycle@1:fixed-head",
      measuredWrites: 0,
      projectedAssertionInputs: 24
    },
    cycles,
    limits: {
      allocatorFragmentation: "not-measured",
      allocatorRelease: "not-inferred",
      coldProcess: "not-measured",
      garbageCollection: "not-forced",
      latencyQualification: "not-measured",
      leakQualification: "not-measured",
      nativeSqliteAllocation: "not-measured",
      osPageCache: "uncontrolled",
      perWorkerRss: "unavailable",
      postCloseWorkerHeap: "unavailable-worker-terminated",
      productionQualification: "not-measured",
      throughputQualification: "not-measured"
    }
  });
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BYTES) {
    throw new Error("worker resource lifecycle report exceeded its fixed 128 KiB output cap");
  }
  return report;
}

export function serializeWorkerResourceLifecycleReport(report) {
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) {
    throw new Error("worker resource lifecycle report exceeded its fixed 128 KiB output cap");
  }
  return output;
}

export async function runWorkerResourceLifecycleTracerCommand(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("worker resource lifecycle tracer accepts no arguments");
  }
  const createdDirectory = mkdtempSync(join(tmpdir(), "attunegraph-worker-resource-lifecycle-"));
  chmodSync(createdDirectory, 0o700);
  const directory = realpathSync(createdDirectory);
  let primaryFailure;
  try {
    const report = await runWorkerResourceLifecycleTracer({
      databasePath: join(directory, "attunegraph.sqlite")
    });
    process.stdout.write(serializeWorkerResourceLifecycleReport(report));
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
  await runWorkerResourceLifecycleTracerCommand().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
