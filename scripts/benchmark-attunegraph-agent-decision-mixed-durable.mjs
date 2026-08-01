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
import { cpus, release, tmpdir, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, types as nodeTypes } from "node:util";

import { openLocalAttuneGraphSession } from "@attunegraph/core/local";

import { composeDurableTracerCleanupFailure } from "./benchmark-attunegraph-agent-decision-durable.mjs";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";

const NOW = "2026-08-01T12:00:00.000Z";
const OBSERVED_AT = "2026-08-01T11:59:00.000Z";
const RECORDED_AT = "2026-08-01T10:00:00.000Z";
const CLIENTS = 4;
const CYCLES = 5;
const MIXED_WAVES = CLIENTS * (CYCLES - 1);
const READ_ONLY_WAVES = 8;
const FINAL_COMMIT_IDS = frozen([
  "attunegraph-commit:attunegraph-observation:3161ff4f3c9fe70e4c0340ff1cfa1a601cc4b9b6678c713d1f9b9e59a8f485fd",
  "attunegraph-commit:attunegraph-observation:7d88dc3989e66a928a46e81485eeb905d394cd40a2cc30009119969c0d4c8e37",
  "attunegraph-commit:attunegraph-observation:19f3972b58721f620a986654a5e8b2d6129f8e5c5fcd60af569e32060a7fc88d",
  "attunegraph-commit:attunegraph-observation:c3a8bb800935b71ff8a5f035074630f9aec1fefab4c4c5b81ec3c0f8b51b87c0"
]);

function frozen(value) {
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function graphRef(kind, id) {
  return frozen({ kind, id });
}

function assertion(id, subject, object, sourceId, temporal = {}) {
  return frozen({
    schemaVersion: 1,
    id,
    subject,
    predicate: "LINKED_TO",
    object,
    epistemicClass: "source-observed",
    sourceRefs: frozen([frozen({ namespace: "b", id: sourceId })]),
    recordedAt: temporal.recordedAt ?? RECORDED_AT,
    ...(temporal.validFrom === undefined ? {} : { validFrom: temporal.validFrom }),
    ...(temporal.validTo === undefined ? {} : { validTo: temporal.validTo }),
    ...(temporal.supersededAt === undefined ? {} : { supersededAt: temporal.supersededAt }),
    derivation: frozen({ kind: "projection", version: "mixed@1" })
  });
}

function clientCell(client, generation) {
  const clientSuffix = client.toString();
  const generationSuffix = `g${generation.toString().padStart(2, "0")}`;
  const clientKey = `c${clientSuffix}`;
  const scope = frozen({
    sourceId: "mixed-durable-benchmark",
    threadId: `client:${clientSuffix}`
  });
  const threadRoot = graphRef("thread", `r:${clientKey}`);
  const active = Array.from({ length: 16 }, (_, index) => {
    const suffix = index.toString().padStart(2, "0");
    return assertion(
      `a:${clientKey}:${generationSuffix}:${suffix}`,
      graphRef("artifact", `n:${clientKey}:${suffix}`),
      threadRoot,
      `s:${clientKey}:${generationSuffix}:a:${suffix}`
    );
  });
  const temporalProfiles = [
    { id: "x", time: { validTo: "2026-08-01T11:00:00.000Z" } },
    { id: "f", time: { validFrom: "2026-08-01T13:00:00.000Z" } },
    { id: "r", time: { recordedAt: "2026-08-01T13:00:00.000Z" } },
    { id: "s", time: { supersededAt: "2026-08-01T11:00:00.000Z" } }
  ];
  const inactive = temporalProfiles.flatMap((profile) => Array.from(
    { length: 6 },
    (_, index) => {
      const suffix = index.toString().padStart(2, "0");
      return assertion(
        `d:${clientKey}:${generationSuffix}:${profile.id}:${suffix}`,
        graphRef("artifact", `d:${clientKey}:${profile.id}:${suffix}`),
        threadRoot,
        `s:${clientKey}:${generationSuffix}:d:${profile.id}:${suffix}`,
        profile.time
      );
    }
  ));
  return frozen({
    clientId: `client:${clientSuffix}`,
    scope,
    seed: graphRef("artifact", `n:${clientKey}:00`),
    command: frozen({
      operator: "canonical-projection@2",
      observation: frozen({
        schemaVersion: 2,
        observationKey: `mixed:${clientKey}:${generationSuffix}`,
        scope,
        threadRoot,
        observedAt: OBSERVED_AT,
        sourceFreshness: frozen({ state: "fresh", observedAt: OBSERVED_AT }),
        assertions: frozen([...active, ...inactive])
      })
    })
  });
}

function semantic(result) {
  return frozen({
    assertionIds: frozen(result.workingGraph.assertions.map((entry) => entry.id)),
    assertionProvenance: frozen(result.workingGraph.assertions.map((entry) => frozen({
      assertionId: entry.id,
      derivation: frozen({ ...entry.derivation }),
      sourceRefs: frozen(entry.sourceRefs.map((sourceRef) => frozen({ ...sourceRef })))
    }))),
    consideredAssertions: result.workingGraph.diagnostics.consideredAssertions,
    emittedAssertions: result.workingGraph.assertions.length,
    generation: result.snapshot.generation,
    headCommitId: result.snapshot.commitId,
    maxDepthReached: result.workingGraph.diagnostics.maxDepthReached,
    refIds: frozen(result.workingGraph.refs.map((entry) => `${entry.kind}:${entry.id}`)),
    sourceFreshness: frozen({ ...result.sourceFreshness }),
    sourceRefIds: frozen(result.workingGraph.assertions.flatMap(
      (entry) => entry.sourceRefs.map((sourceRef) => `${sourceRef.namespace}:${sourceRef.id}`)
    )),
    status: result.status,
    truncationReasons: frozen([...result.workingGraph.diagnostics.truncationReasons]),
    visitedRefs: result.workingGraph.diagnostics.visitedRefs
  });
}

function expectedAssertionIds(client, generation) {
  const clientKey = `c${client.toString()}`;
  const generationSuffix = `g${generation.toString().padStart(2, "0")}`;
  return Array.from(
    { length: 16 },
    (_, index) => `a:${clientKey}:${generationSuffix}:${index.toString().padStart(2, "0")}`
  );
}

function expectedResult(client, generation, commitId) {
  const cell = clientCell(client, generation);
  const activeAssertions = cell.command.observation.assertions.slice(0, 16);
  return {
    operator: "working-graph@1",
    status: "complete",
    snapshot: {
      schemaVersion: 1,
      scope: { ...cell.scope },
      generation,
      commitId
    },
    sourceFreshness: { state: "fresh", observedAt: OBSERVED_AT },
    workingGraph: {
      assertions: activeAssertions,
      refs: [
        ...activeAssertions.map((entry) => entry.subject),
        cell.command.observation.threadRoot
      ],
      seed: cell.seed,
      diagnostics: {
        consideredAssertions: 16,
        estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify({
          assertions: activeAssertions,
          seed: cell.seed
        }), "utf8") / 4),
        visitedRefs: 17,
        maxDepthReached: 2,
        truncationReasons: []
      }
    }
  };
}

function firstDivergence(expected, actual, path = "result") {
  if (isDeepStrictEqual(expected, actual)) return "none";
  if (
    expected === null
    || actual === null
    || typeof expected !== "object"
    || typeof actual !== "object"
  ) {
    return path;
  }
  const keys = new Set([...Reflect.ownKeys(expected), ...Reflect.ownKeys(actual)]);
  for (const key of keys) {
    const nextPath = `${path}.${String(key)}`;
    if (!Reflect.has(expected, key) || !Reflect.has(actual, key)) return nextPath;
    const difference = firstDivergence(expected[key], actual[key], nextPath);
    if (difference !== "none") return difference;
  }
  return path;
}

function assertResult(client, generation, commitId, result) {
  const expected = expectedResult(client, generation, commitId);
  if (!isDeepStrictEqual(result, expected)) {
    throw new Error(`mixed durable public result contract diverged at ${firstDivergence(expected, result)} for client ${client.toString()} generation ${generation.toString()}`);
  }
  const expectedIds = expectedAssertionIds(client, generation);
  const value = semantic(result);
  if (JSON.stringify(value.assertionIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`mixed durable semantic projection diverged for client ${client.toString()} generation ${generation.toString()}`);
  }
  return value;
}

function assertWriteSnapshot(client, generation, snapshot) {
  const expectedScope = clientCell(client, generation).scope;
  if (
    !isDeepStrictEqual(Reflect.ownKeys(snapshot).sort(), ["commitId", "generation", "schemaVersion", "scope"])
    || snapshot.schemaVersion !== 1
    || !isDeepStrictEqual(snapshot.scope, expectedScope)
    || snapshot.generation !== generation
    || !/^attunegraph-commit:attunegraph-observation:[0-9a-f]{64}$/u.test(snapshot.commitId)
  ) {
    throw new Error(`mixed durable write snapshot contract diverged for client ${client.toString()} generation ${generation.toString()}`);
  }
}

function databasePathFrom(options) {
  const keys = options !== null && typeof options === "object" && !nodeTypes.isProxy(options)
    ? Reflect.ownKeys(options)
    : [];
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || nodeTypes.isProxy(options)
    || Object.getPrototypeOf(options) !== Object.prototype
    || keys.length !== 1
    || keys[0] !== "databasePath"
  ) {
    throw new Error("mixed durable agent-decision tracer requires one absolute databasePath");
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, "databasePath");
  if (
    descriptor === undefined
    || !("value" in descriptor)
    || typeof descriptor.value !== "string"
    || !isAbsolute(descriptor.value)
  ) {
    throw new Error("mixed durable agent-decision tracer requires one absolute databasePath");
  }
  for (const path of [descriptor.value, `${descriptor.value}-wal`, `${descriptor.value}-shm`]) {
    try {
      lstatSync(path);
      throw new Error("mixed durable agent-decision tracer requires a new databasePath without sidecars");
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
  }
  return descriptor.value;
}

function fileProfile(path) {
  try {
    const info = lstatSync(path, { bigint: true });
    const expectedOwner = process.geteuid?.();
    if (
      info.isSymbolicLink()
      || !info.isFile()
      || expectedOwner === undefined
      || info.uid !== BigInt(expectedOwner)
      || (Number(info.mode) & 0o077) !== 0
      || info.size < 0n
      || info.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error("mixed durable storage evidence requires safe owner-only regular files");
    }
    return frozen({ present: true, logicalBytes: Number(info.size) });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return frozen({ present: false, logicalBytes: null });
    }
    throw cause;
  }
}

function storageProfile(databasePath) {
  const database = fileProfile(databasePath);
  const writeAheadLog = fileProfile(`${databasePath}-wal`);
  const sharedMemory = fileProfile(`${databasePath}-shm`);
  return frozen({
    database,
    writeAheadLog,
    sharedMemory,
    totalPresentLogicalBytes: [database, writeAheadLog, sharedMemory].reduce(
      (total, file) => total + (file.logicalBytes ?? 0),
      0
    )
  });
}

function storagePhase(databasePath, phase, openSessions, projections, decisionReads, extra = {}) {
  return frozen({
    phase,
    openSessions,
    completedOperations: frozen({ projections, decisionReads }),
    files: storageProfile(databasePath),
    ...extra
  });
}

async function closeTracked(resource, resources) {
  await resource.close();
  const index = resources.lastIndexOf(resource);
  if (index >= 0) resources.splice(index, 1);
}

function executeCommand(seed) {
  return {
    operator: "working-graph@1",
    seed,
    now: NOW,
    maxEstimatedTokens: 32_768
  };
}

export async function runMixedDurableAgentDecisionTracer(options) {
  const databasePath = databasePathFrom(options);
  const sessions = [];
  const handles = [];
  const storagePhases = [];
  let primaryFailure;
  try {
    const seeder = await openLocalAttuneGraphSession({ databasePath });
    sessions.push(seeder);
    const currentSnapshots = [];
    for (let client = 0; client < CLIENTS; client += 1) {
      const cell = clientCell(client, 1);
      const handle = await seeder.open({ scope: cell.scope });
      handles.push(handle);
      const snapshot = await handle.projectAgainstHead(clone(cell.command));
      assertWriteSnapshot(client, 1, snapshot);
      currentSnapshots.push(snapshot);
    }
    while (handles.length > 0) await closeTracked(handles.at(-1), handles);
    await closeTracked(seeder, sessions);
    storagePhases.push(storagePhase(databasePath, "after-preparation", 0, CLIENTS, 0));

    const measuredSessions = [];
    const measuredHandles = [];
    for (let client = 0; client < CLIENTS; client += 1) {
      const session = await openLocalAttuneGraphSession({ databasePath });
      sessions.push(session);
      measuredSessions.push(session);
      const handle = await session.open({ scope: clientCell(client, 1).scope });
      handles.push(handle);
      measuredHandles.push(handle);
    }
    storagePhases.push(storagePhase(databasePath, "after-four-sessions-open", 4, 4, 0));

    const operationLedger = [];
    const clientCounters = Array.from({ length: CLIENTS }, (_, client) => ({
      clientId: `client:${client.toString()}`,
      reads: 0,
      writes: 0
    }));
    let inFlight = 0;
    let peakOutstandingOperationTasksObserved = 0;
    let barrierCount = 0;
    let mixedReadWriteBarrierCount = 0;
    let readOnlyBarrierCount = 0;
    let writeOnlyBarrierCount = 0;
    const generations = Array.from({ length: CLIENTS }, () => 1);
    const scheduledOperationIds = [];
    const mixedStartedAt = performance.now();

    const barrier = async (wave, kinds) => {
      const expectedIds = kinds.map(
        (kind, client) => `wave:${wave.toString().padStart(2, "0")}:client:${client.toString()}:${kind}`
      );
      scheduledOperationIds.push(...expectedIds);
      const settlements = await Promise.allSettled(measuredHandles.map(async (handle, client) => {
        const kind = kinds[client];
        const operationId = expectedIds[client];
        const generation = generations[client];
        inFlight += 1;
        peakOutstandingOperationTasksObserved = Math.max(
          peakOutstandingOperationTasksObserved,
          inFlight
        );
        const startedAt = performance.now();
        try {
          if (kind === "read") {
            const cell = clientCell(client, generation);
            const result = await handle.execute(executeCommand(cell.seed));
            const observed = assertResult(client, generation, currentSnapshots[client].commitId, result);
            const settledAt = performance.now();
            return frozen({ ledger: frozen({
              operationId,
              ordinal: wave * CLIENTS + client,
              wave,
              clientId: `client:${client.toString()}`,
              durationMilliseconds: settledAt - startedAt,
              generationBefore: generation,
              expectedGenerationAfter: generation,
              kind,
              observedCommitId: observed.headCommitId,
              observedGeneration: observed.generation,
              operationTaskSettledAfterMixedStartMilliseconds: settledAt - mixedStartedAt,
              scope: frozen({ ...cell.scope }),
              operationTaskStartedAfterMixedStartMilliseconds: startedAt - mixedStartedAt,
              status: observed.status
            }), snapshot: null });
          }
          const nextGeneration = generation + 1;
          const cell = clientCell(client, nextGeneration);
          const snapshot = await handle.projectAgainstHead(clone(cell.command));
          assertWriteSnapshot(client, nextGeneration, snapshot);
          const settledAt = performance.now();
          return frozen({ ledger: frozen({
            operationId,
            ordinal: wave * CLIENTS + client,
            wave,
            clientId: `client:${client.toString()}`,
            durationMilliseconds: settledAt - startedAt,
            generationBefore: generation,
            expectedGenerationAfter: nextGeneration,
            kind,
            observedCommitId: snapshot.commitId,
            observedGeneration: snapshot.generation,
            operationTaskSettledAfterMixedStartMilliseconds: settledAt - mixedStartedAt,
            scope: frozen({ ...cell.scope }),
            operationTaskStartedAfterMixedStartMilliseconds: startedAt - mixedStartedAt,
            status: "committed"
          }), snapshot });
        } finally {
          inFlight -= 1;
        }
      }));
      const failures = settlements.filter((entry) => entry.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((entry) => entry.reason),
          `mixed durable wave ${wave.toString()} failed`
        );
      }
      const results = settlements.map((entry) => entry.value);
      for (const [client, result] of results.entries()) {
        operationLedger.push(result.ledger);
        clientCounters[client][result.ledger.kind === "read" ? "reads" : "writes"] += 1;
        if (result.ledger.kind === "write") {
          generations[client] = result.ledger.observedGeneration;
          currentSnapshots[client] = result.snapshot;
        }
      }
      const writes = kinds.filter((kind) => kind === "write").length;
      if (writes === 0) readOnlyBarrierCount += 1;
      else if (writes === CLIENTS) writeOnlyBarrierCount += 1;
      else mixedReadWriteBarrierCount += 1;
      barrierCount += 1;
    };

    await barrier(0, Array.from({ length: CLIENTS }, () => "write"));
    for (let wave = 1; wave <= MIXED_WAVES; wave += 1) {
      const writer = (wave - 1) % CLIENTS;
      await barrier(wave, Array.from(
        { length: CLIENTS },
        (_, client) => client === writer ? "write" : "read"
      ));
    }
    for (
      let wave = MIXED_WAVES + 1;
      wave <= MIXED_WAVES + READ_ONLY_WAVES;
      wave += 1
    ) {
      await barrier(wave, Array.from({ length: CLIENTS }, () => "read"));
    }
    if (generations.some((generation) => generation !== 6)) {
      throw new Error("mixed durable final generations diverged");
    }
    const mixedWallMilliseconds = performance.now() - mixedStartedAt;
    const measuredReadOperations = operationLedger.filter((entry) => entry.kind === "read").length;
    const measuredWriteOperations = operationLedger.filter((entry) => entry.kind === "write").length;
    const measuredLogicalOperations = operationLedger.length;
    const measuredWaves = new Set(operationLedger.map((entry) => entry.wave)).size;
    if (
      measuredReadOperations !== 80
      || measuredWriteOperations !== 20
      || measuredLogicalOperations !== 100
      || measuredWaves !== 25
      || clientCounters.some((entry) => entry.reads !== 20 || entry.writes !== CYCLES)
    ) {
      throw new Error("mixed durable measured operation ledger diverged");
    }
    const totalProjectedHeads = CLIENTS + measuredWriteOperations;
    storagePhases.push(storagePhase(
      databasePath,
      "after-mixed-settled",
      CLIENTS,
      totalProjectedHeads,
      measuredReadOperations
    ));

    const beforeCloseFinalHeads = [];
    const beforeCloseFinalResults = [];
    for (let client = 0; client < CLIENTS; client += 1) {
      const cell = clientCell(client, 6);
      const result = await measuredHandles[client].execute(executeCommand(cell.seed));
      const observed = assertResult(client, 6, FINAL_COMMIT_IDS[client], result);
      beforeCloseFinalHeads.push(frozen({ clientId: `client:${client.toString()}`, ...observed }));
      beforeCloseFinalResults.push(result);
    }

    while (measuredHandles.length > 0) {
      const handle = measuredHandles.pop();
      await closeTracked(handle, handles);
    }
    for (let client = 0; client < CLIENTS; client += 1) {
      const session = measuredSessions[client];
      await closeTracked(session, sessions);
      storagePhases.push(storagePhase(
        databasePath,
        "after-session-close",
        CLIENTS - client - 1,
        totalProjectedHeads,
        measuredReadOperations + CLIENTS,
        frozen({
          closeOrdinal: client + 1,
          closedClientId: `client:${client.toString()}`,
          remainingOpenSessions: CLIENTS - client - 1
        })
      ));
    }
    measuredSessions.splice(0);

    const verifierReopenStartedAt = performance.now();
    const verifier = await openLocalAttuneGraphSession({ databasePath });
    const verifierReopenMilliseconds = performance.now() - verifierReopenStartedAt;
    sessions.push(verifier);
    storagePhases.push(storagePhase(
      databasePath,
      "after-verifier-open",
      1,
      totalProjectedHeads,
      measuredReadOperations + CLIENTS
    ));
    const finalHeads = [];
    for (let client = 0; client < CLIENTS; client += 1) {
      const cell = clientCell(client, 6);
      const handle = await verifier.open({ scope: cell.scope });
      handles.push(handle);
      const result = await handle.execute(executeCommand(cell.seed));
      const observed = assertResult(client, 6, FINAL_COMMIT_IDS[client], result);
      finalHeads.push(frozen({ clientId: `client:${client.toString()}`, ...observed }));
      if (!isDeepStrictEqual(result, beforeCloseFinalResults[client])) {
        throw new Error(`mixed durable full reopen result diverged for client ${client.toString()}`);
      }
    }
    storagePhases.push(storagePhase(
      databasePath,
      "after-verifier-verification",
      1,
      totalProjectedHeads,
      measuredReadOperations + (CLIENTS * 2)
    ));
    const reopenExact = JSON.stringify(beforeCloseFinalHeads) === JSON.stringify(finalHeads);
    if (!reopenExact) throw new Error("mixed durable reopen semantics diverged");
    while (handles.length > 0) await closeTracked(handles.at(-1), handles);
    await closeTracked(verifier, sessions);
    storagePhases.push(storagePhase(
      databasePath,
      "after-verifier-close",
      0,
      totalProjectedHeads,
      measuredReadOperations + (CLIENTS * 2)
    ));

    const scheduleExact = JSON.stringify(operationLedger.map((entry) => entry.operationId))
      === JSON.stringify(scheduledOperationIds);
    if (!scheduleExact || barrierCount !== measuredWaves) {
      throw new Error("mixed durable schedule diverged");
    }

    const harnessSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
    const workloadSha256 = sha256(JSON.stringify({
      clients: CLIENTS,
      cycles: CYCLES,
      activeAssertions: 16,
      inactiveAssertions: 24,
      mixedWaves: MIXED_WAVES,
      readOnlyWaves: READ_ONLY_WAVES,
      now: NOW,
      observedAt: OBSERVED_AT,
      recordedAt: RECORDED_AT
    }));

    return frozen({
      schema: "attunegraph-agent-decision-mixed-durable-tracer@1",
      measurementOnly: true,
      claimEligible: false,
      measurementBoundary: frozen({
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
      }),
      workload: frozen({
        id: "four-session-mixed-80r20w@1",
        activeAssertionCountPerHead: 16,
        inactiveAssertionCountPerHead: 24,
        totalAssertionCountPerHead: 40,
        clients: 4,
        cycles: CYCLES,
        measuredLogicalOperations,
        logicalOperationType: "public-agent-api",
        mixedReadWriteWaves: MIXED_WAVES,
        readOperations: measuredReadOperations,
        waves: measuredWaves,
        writeOperations: measuredWriteOperations,
        initialGeneration: 1,
        finalGeneration: CYCLES + 1,
        excludedDataOperations: frozen({
          preparationWrites: CLIENTS,
          precloseVerificationReads: CLIENTS,
          reopenVerificationReads: CLIENTS,
          total: CLIENTS * 3
        }),
        totalDataOperations: frozen({
          reads: measuredReadOperations + (CLIENTS * 2),
          writes: measuredWriteOperations + CLIENTS,
          total: measuredLogicalOperations + (CLIENTS * 3)
        })
      }),
      concurrency: frozen({
        barrierCount,
        peakOutstandingOperationTasksObserved,
        mixedReadWriteBarrierCount,
        operationsPerClient: 25,
        readOnlyBarrierCount,
        writeOnlyBarrierCount,
        clients: frozen(clientCounters.map((entry) => frozen({ ...entry })))
      }),
      correctness: frozen({
        allOperationsSucceeded: true,
        finalHeadsMatchGoldenManifest: true,
        fullResultsStableAcrossReopen: true,
        goldenManifestVersion: "four-session-mixed-80r20w@1",
        readSemanticsMatchCurrentHead: true,
        reopenExact,
        scheduleExact,
        writeSnapshotsMatchProjectionContract: true,
        finalHeads: frozen(finalHeads)
      }),
      operationLedger: frozen(operationLedger),
      timing: frozen({
        contract: frozen({
          clock: "performance.now-monotonic",
          mixedWallIncludes: "cell-build-clone-public-call-validation-and-wave-bookkeeping",
          operationDurationIncludes: "cell-build-clone-public-call-and-validation",
          verifierReopenIncludes: "session-and-worker-open-only",
          pureDatabaseLatency: false
        }),
        mixedWallMilliseconds,
        verifierReopenMilliseconds
      }),
      provenance: frozen({
        authority: "unattested-local-process",
        capturedAt: new Date().toISOString(),
        harness: frozen({
          id: "benchmark-attunegraph-agent-decision-mixed-durable@1",
          sha256: harnessSha256
        }),
        repository: frozen({
          commit: "not-recorded",
          tree: "not-recorded",
          lockfileSha256: "not-recorded"
        }),
        runtime: frozen({
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          osRelease: release(),
          cpuModel: cpus()[0]?.model ?? "unknown",
          logicalCpuCount: cpus().length,
          totalMemoryBytes: totalmem()
        }),
        sqliteVersion: "not-exposed-by-public-api",
        workload: frozen({
          id: "four-session-mixed-80r20w@1",
          sha256: workloadSha256
        })
      }),
      limitations: frozen({
        nonClaims: frozen([
          "latency-throughput-or-tail-qualification",
          "production-or-cross-host-generalization",
          "database-execution-overlap-or-lock-contention",
          "same-scope-contention",
          "cold-disk-process-restart-or-crash-recovery",
          "allocated-bytes-checkpoint-effectiveness-compaction-or-leak-slope",
          "process-tree-rss-cpu-or-gc-cost"
        ])
      }),
      storage: frozen({
        schema: "attunegraph-sqlite-footprint@1",
        method: "lstat-logical-size-at-settled-phase-boundaries",
        checkpoint: frozen({
          mode: "PASSIVE",
          result: "not-exposed-by-public-api",
          trigger: "each-public-session-close"
        }),
        interpretation: frozen({
          allocatedBytes: "not-measured",
          checkpointEffectiveness: "not-measured",
          monotonicGrowthExpected: false,
          peakMeaning: "largest-observed-phase-boundary-only"
        }),
        peakObservedTotalLogicalBytes: Math.max(
          ...storagePhases.map((phase) => phase.files.totalPresentLogicalBytes)
        ),
        phases: frozen(storagePhases)
      })
    });
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    const cleanupFailures = [];
    for (const handle of handles.reverse()) {
      try {
        await handle.close();
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    for (const session of sessions.reverse()) {
      try {
        await session.close();
      } catch (cause) {
        cleanupFailures.push(cause);
      }
    }
    if (cleanupFailures.length > 0) {
      throw composeDurableTracerCleanupFailure(
        primaryFailure,
        cleanupFailures,
        "mixed durable tracer cleanup failed"
      );
    }
  }
}

export async function runMixedDurableAgentDecisionTracerCommand(argv = process.argv.slice(2)) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw new Error("mixed durable agent-decision tracer does not accept command-line arguments");
  }
  let createdDirectory;
  let primaryFailure;
  try {
    createdDirectory = mkdtempSync(join(tmpdir(), "attunegraph-mixed-durable-decision-"));
    chmodSync(createdDirectory, 0o700);
    const directory = realpathSync(createdDirectory);
    const report = await runMixedDurableAgentDecisionTracer({
      databasePath: join(directory, "attunegraph.sqlite")
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    if (createdDirectory !== undefined) {
      try {
        rmSync(createdDirectory, { force: true, recursive: true });
      } catch (cause) {
        throw composeDurableTracerCleanupFailure(
          primaryFailure,
          [cause],
          "mixed durable tracer database cleanup failed"
        );
      }
    }
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  await runMixedDurableAgentDecisionTracerCommand().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
