export const READINESS_MEASUREMENT_CONTRACT_SCHEMA = "attunegraph-readiness-measurement-contract@1";
export const READINESS_MEASUREMENT_CAPTURE_SCHEMA = "attunegraph-readiness-measurement-capture@1";
export const READINESS_MEASUREMENT_RESULT_SCHEMA = "attunegraph-readiness-measurement@1";
export const READINESS_MEASUREMENT_PROVENANCE_SCHEMA = "attunegraph-readiness-measurement-provenance@1";
export const READINESS_MEASUREMENT_CAPTURE_SCHEMA_V2 = "attunegraph-readiness-measurement-capture@2";
export const READINESS_MEASUREMENT_RESULT_SCHEMA_V2 = "attunegraph-readiness-measurement@2";
export const READINESS_MEASUREMENT_PROVENANCE_SCHEMA_V2 = "attunegraph-readiness-measurement-provenance@2";

const NAME = "mixed-durable-agent-decision-observation";
const COMMIT_PATTERN = /^attunegraph-commit:attunegraph-observation:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const WORKLOAD_SHA256 = "sha256:4a7ceac49cdd5dd8d18efe60b43b99edee8f71afa0cb2bef1bf409b18d53621f";
const FINAL_COMMIT_IDS = Object.freeze([
  "attunegraph-commit:attunegraph-observation:3161ff4f3c9fe70e4c0340ff1cfa1a601cc4b9b6678c713d1f9b9e59a8f485fd",
  "attunegraph-commit:attunegraph-observation:7d88dc3989e66a928a46e81485eeb905d394cd40a2cc30009119969c0d4c8e37",
  "attunegraph-commit:attunegraph-observation:19f3972b58721f620a986654a5e8b2d6129f8e5c5fcd60af569e32060a7fc88d",
  "attunegraph-commit:attunegraph-observation:c3a8bb800935b71ff8a5f035074630f9aec1fefab4c4c5b81ec3c0f8b51b87c0"
]);
const REQUIRED_NON_CLAIMS = Object.freeze([
  "latency-throughput-or-tail-qualification",
  "production-or-cross-host-generalization",
  "database-execution-overlap-or-lock-contention",
  "same-scope-contention",
  "cold-disk-process-restart-or-crash-recovery",
  "allocated-bytes-checkpoint-effectiveness-compaction-or-leak-slope",
  "process-tree-rss-cpu-or-gc-cost"
]);

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const READINESS_MEASUREMENT_CONTRACTS = deepFreeze({
  [NAME]: {
    argv: ["node", "scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs"],
    authority: "local-unattested",
    cwdRole: "attunegraph",
    id: `${READINESS_MEASUREMENT_CONTRACT_SCHEMA}:${NAME}`,
    output: {
      schema: "attunegraph-agent-decision-mixed-durable-tracer@1",
      semantics: NAME
    },
    parameters: {
      clients: 4,
      measuredLogicalOperations: 100,
      profile: "local",
      readOperations: 80,
      repetitions: 1,
      totalDataOperations: 112,
      warmups: 0,
      workloadId: "four-session-mixed-80r20w@1",
      writeOperations: 20
    },
    scoring: "excluded"
  }
});

export function readinessMeasurementContract(name) {
  return READINESS_MEASUREMENT_CONTRACTS[name] ?? null;
}

export function readinessMeasurementContractSnapshot(contract) {
  return {
    argv: contract.argv,
    authority: contract.authority,
    cwdRole: contract.cwdRole,
    id: contract.id,
    output: contract.output,
    parameters: contract.parameters,
    scoring: contract.scoring
  };
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new Error(`${label} must be a plain object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function validateOperationLedger(report) {
  if (!Array.isArray(report.operationLedger) || report.operationLedger.length !== 100) {
    throw new Error("mixed durable measurement operation ledger must contain 100 entries");
  }
  const generations = [1, 1, 1, 1];
  const observedCommits = Array.from({ length: 4 }, () => new Map());
  let reads = 0;
  let writes = 0;
  for (let ordinal = 0; ordinal < report.operationLedger.length; ordinal += 1) {
    const entry = report.operationLedger[ordinal];
    exactKeys(entry, [
      "clientId",
      "durationMilliseconds",
      "expectedGenerationAfter",
      "generationBefore",
      "kind",
      "observedCommitId",
      "observedGeneration",
      "operationId",
      "operationTaskSettledAfterMixedStartMilliseconds",
      "operationTaskStartedAfterMixedStartMilliseconds",
      "ordinal",
      "scope",
      "status",
      "wave"
    ], `mixed durable operation ${ordinal.toString()}`);
    exactKeys(entry.scope, ["sourceId", "threadId"], `mixed durable operation ${ordinal.toString()} scope`);
    const wave = Math.floor(ordinal / 4);
    const client = ordinal % 4;
    const kind = wave === 0
      ? "write"
      : wave <= 16
        ? client === (wave - 1) % 4 ? "write" : "read"
        : "read";
    const expectedGenerationAfter = kind === "write"
      ? generations[client] + 1
      : generations[client];
    if (
      !plainObject(entry)
      || entry.ordinal !== ordinal
      || entry.wave !== wave
      || entry.clientId !== `client:${client.toString()}`
      || entry.kind !== kind
      || entry.operationId !== `wave:${wave.toString().padStart(2, "0")}:client:${client.toString()}:${kind}`
      || entry.scope?.sourceId !== "mixed-durable-benchmark"
      || entry.scope?.threadId !== `client:${client.toString()}`
      || entry.generationBefore !== generations[client]
      || entry.expectedGenerationAfter !== expectedGenerationAfter
      || entry.observedGeneration !== expectedGenerationAfter
      || !COMMIT_PATTERN.test(entry.observedCommitId)
      || entry.status !== (kind === "write" ? "committed" : "complete")
    ) {
      throw new Error(`mixed durable measurement operation ledger diverged at ordinal ${ordinal.toString()}`);
    }
    finiteNonNegative(entry.durationMilliseconds, `operation ${ordinal.toString()} duration`);
    finiteNonNegative(
      entry.operationTaskStartedAfterMixedStartMilliseconds,
      `operation ${ordinal.toString()} start`
    );
    finiteNonNegative(
      entry.operationTaskSettledAfterMixedStartMilliseconds,
      `operation ${ordinal.toString()} settlement`
    );
    if (
      entry.operationTaskSettledAfterMixedStartMilliseconds
      < entry.operationTaskStartedAfterMixedStartMilliseconds
    ) {
      throw new Error(`mixed durable measurement operation ledger chronology diverged at ordinal ${ordinal.toString()}`);
    }
    const generationCommits = observedCommits[client];
    const knownCommit = generationCommits.get(expectedGenerationAfter);
    if (knownCommit && knownCommit !== entry.observedCommitId) {
      throw new Error(`mixed durable measurement commit identity diverged at ordinal ${ordinal.toString()}`);
    }
    generationCommits.set(expectedGenerationAfter, entry.observedCommitId);
    if (
      expectedGenerationAfter === 6
      && entry.observedCommitId !== FINAL_COMMIT_IDS[client]
    ) {
      throw new Error(`mixed durable measurement final commit diverged at ordinal ${ordinal.toString()}`);
    }
    if (kind === "write") {
      generations[client] = expectedGenerationAfter;
      writes += 1;
    } else {
      reads += 1;
    }
  }
  if (reads !== 80 || writes !== 20 || generations.some((generation) => generation !== 6)) {
    throw new Error("mixed durable measurement operation ledger totals diverged");
  }
}

function validateFinalHeads(report) {
  const heads = report.correctness?.finalHeads;
  if (!Array.isArray(heads) || heads.length !== 4) {
    throw new Error("mixed durable measurement final heads are missing");
  }
  for (let client = 0; client < 4; client += 1) {
    const head = heads[client];
    exactKeys(head, [
      "assertionIds",
      "assertionProvenance",
      "clientId",
      "consideredAssertions",
      "emittedAssertions",
      "generation",
      "headCommitId",
      "maxDepthReached",
      "refIds",
      "sourceFreshness",
      "sourceRefIds",
      "status",
      "truncationReasons",
      "visitedRefs"
    ], `mixed durable final head ${client.toString()}`);
    exactKeys(
      head.sourceFreshness,
      ["observedAt", "state"],
      `mixed durable final head ${client.toString()} freshness`
    );
    const assertionIds = Array.from(
      { length: 16 },
      (_, index) => `a:c${client.toString()}:g06:${index.toString().padStart(2, "0")}`
    );
    const sourceRefIds = Array.from(
      { length: 16 },
      (_, index) => `b:s:c${client.toString()}:g06:a:${index.toString().padStart(2, "0")}`
    );
    const refIds = [
      ...Array.from(
        { length: 16 },
        (_, index) => `artifact:n:c${client.toString()}:${index.toString().padStart(2, "0")}`
      ),
      `thread:r:c${client.toString()}`
    ];
    if (
      head?.clientId !== `client:${client.toString()}`
      || head.generation !== 6
      || head.headCommitId !== FINAL_COMMIT_IDS[client]
      || JSON.stringify(head.assertionIds) !== JSON.stringify(assertionIds)
      || head.maxDepthReached !== 2
      || JSON.stringify(head.refIds) !== JSON.stringify(refIds)
      || head.sourceFreshness?.state !== "fresh"
      || head.sourceFreshness?.observedAt !== "2026-08-01T11:59:00.000Z"
      || head.status !== "complete"
      || JSON.stringify(head.truncationReasons) !== "[]"
      || head.consideredAssertions !== 16
      || head.emittedAssertions !== 16
      || head.visitedRefs !== 17
      || JSON.stringify(head.sourceRefIds) !== JSON.stringify(sourceRefIds)
      || !Array.isArray(head.assertionProvenance)
      || head.assertionProvenance.length !== 16
    ) {
      throw new Error(`mixed durable measurement final head ${client.toString()} diverged`);
    }
    for (let index = 0; index < 16; index += 1) {
      const suffix = index.toString().padStart(2, "0");
      const provenance = head.assertionProvenance[index];
      exactKeys(
        provenance,
        ["assertionId", "derivation", "sourceRefs"],
        `mixed durable final head provenance ${client.toString()}:${suffix}`
      );
      exactKeys(
        provenance.derivation,
        ["kind", "version"],
        `mixed durable final head derivation ${client.toString()}:${suffix}`
      );
      if (
        provenance?.assertionId !== `a:c${client.toString()}:g06:${suffix}`
        || provenance.derivation?.kind !== "projection"
        || provenance.derivation?.version !== "mixed@1"
        || !Array.isArray(provenance.sourceRefs)
        || provenance.sourceRefs.length !== 1
        || !plainObject(provenance.sourceRefs[0])
        || Object.keys(provenance.sourceRefs[0]).length !== 2
        || !("namespace" in provenance.sourceRefs[0])
        || !("id" in provenance.sourceRefs[0])
        || provenance.sourceRefs[0]?.namespace !== "b"
        || provenance.sourceRefs[0]?.id !== `s:c${client.toString()}:g06:a:${suffix}`
      ) {
        throw new Error(`mixed durable measurement final head provenance ${client.toString()}:${suffix} diverged`);
      }
    }
  }
}

function validateStorageFile(file, label) {
  exactKeys(file, ["logicalBytes", "present"], label);
  if (file.present === true) {
    finiteNonNegative(file.logicalBytes, `${label} logical bytes`);
    return file.logicalBytes;
  }
  if (file.present !== false || file.logicalBytes !== null) {
    throw new Error(`${label} absence contract diverged`);
  }
  return 0;
}

function validateStorage(report) {
  const storage = report.storage;
  exactKeys(storage, [
    "checkpoint",
    "interpretation",
    "method",
    "peakObservedTotalLogicalBytes",
    "phases",
    "schema"
  ], "mixed durable storage");
  exactKeys(storage.checkpoint, ["mode", "result", "trigger"], "mixed durable storage checkpoint");
  exactKeys(storage.interpretation, [
    "allocatedBytes",
    "checkpointEffectiveness",
    "monotonicGrowthExpected",
    "peakMeaning"
  ], "mixed durable storage interpretation");
  if (
    storage.schema !== "attunegraph-sqlite-footprint@1"
    || storage.method !== "lstat-logical-size-at-settled-phase-boundaries"
    || storage.checkpoint.mode !== "PASSIVE"
    || storage.checkpoint.result !== "not-exposed-by-public-api"
    || storage.checkpoint.trigger !== "each-public-session-close"
    || storage.interpretation.allocatedBytes !== "not-measured"
    || storage.interpretation.checkpointEffectiveness !== "not-measured"
    || storage.interpretation.monotonicGrowthExpected !== false
    || storage.interpretation.peakMeaning !== "largest-observed-phase-boundary-only"
    || !Array.isArray(storage.phases)
    || storage.phases.length !== 10
  ) {
    throw new Error("mixed durable tracer report storage evidence diverged");
  }
  const expectedPhases = [
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
  let observedPeak = 0;
  for (const [index, phase] of storage.phases.entries()) {
    const [
      name,
      openSessions,
      projections,
      decisionReads,
      closeOrdinal,
      sidecarsPresent
    ] = expectedPhases[index];
    const phaseKeys = closeOrdinal === null
      ? ["completedOperations", "files", "openSessions", "phase"]
      : [
          "closeOrdinal",
          "closedClientId",
          "completedOperations",
          "files",
          "openSessions",
          "phase",
          "remainingOpenSessions"
        ];
    exactKeys(phase, phaseKeys, `mixed durable storage phase ${index.toString()}`);
    exactKeys(
      phase.completedOperations,
      ["decisionReads", "projections"],
      `mixed durable storage phase ${index.toString()} completed operations`
    );
    exactKeys(
      phase.files,
      ["database", "sharedMemory", "totalPresentLogicalBytes", "writeAheadLog"],
      `mixed durable storage phase ${index.toString()} files`
    );
    if (
      phase.phase !== name
      || phase.openSessions !== openSessions
      || phase.completedOperations.projections !== projections
      || phase.completedOperations.decisionReads !== decisionReads
      || (closeOrdinal !== null && (
        phase.closeOrdinal !== closeOrdinal
        || phase.closedClientId !== `client:${(closeOrdinal - 1).toString()}`
        || phase.remainingOpenSessions !== openSessions
      ))
    ) {
      throw new Error(`mixed durable storage phase ${index.toString()} semantics diverged`);
    }
    const databaseBytes = validateStorageFile(
      phase.files.database,
      `mixed durable storage phase ${index.toString()} database`
    );
    const walBytes = validateStorageFile(
      phase.files.writeAheadLog,
      `mixed durable storage phase ${index.toString()} WAL`
    );
    const shmBytes = validateStorageFile(
      phase.files.sharedMemory,
      `mixed durable storage phase ${index.toString()} SHM`
    );
    if (phase.files.database.present !== true || databaseBytes === 0) {
      throw new Error(`mixed durable storage phase ${index.toString()} database must be present and non-empty`);
    }
    if (
      phase.files.writeAheadLog.present !== sidecarsPresent
      || phase.files.sharedMemory.present !== sidecarsPresent
      || (sidecarsPresent && shmBytes === 0)
    ) {
      throw new Error(`mixed durable storage phase ${index.toString()} sidecar presence diverged`);
    }
    const total = databaseBytes + walBytes + shmBytes;
    if (phase.files.totalPresentLogicalBytes !== total) {
      throw new Error(`mixed durable storage phase ${index.toString()} logical-byte total diverged`);
    }
    observedPeak = Math.max(observedPeak, total);
  }
  finiteNonNegative(storage.peakObservedTotalLogicalBytes, "mixed durable storage peak");
  if (storage.peakObservedTotalLogicalBytes !== observedPeak) {
    throw new Error("mixed durable storage observed peak diverged");
  }
}

function validateTracerReport(report) {
  exactKeys(report, [
    "schema",
    "measurementOnly",
    "claimEligible",
    "measurementBoundary",
    "workload",
    "concurrency",
    "correctness",
    "operationLedger",
    "timing",
    "provenance",
    "limitations",
    "storage"
  ], "mixed durable tracer report");
  if (
    report.schema !== "attunegraph-agent-decision-mixed-durable-tracer@1"
    || report.measurementOnly !== true
    || report.claimEligible !== false
  ) {
    throw new Error("mixed durable tracer report must remain measurement-only and claim-ineligible");
  }
  exactKeys(report.measurementBoundary, [
    "barrier",
    "clientCount",
    "closeMode",
    "database",
    "databaseOverlap",
    "databasePathOwnership",
    "launch",
    "osCache",
    "outstandingMeaning",
    "process",
    "sameScopeContention",
    "sessionTopology"
  ], "mixed durable measurement boundary");
  if (
    report.measurementBoundary?.clientCount !== 4
    || report.measurementBoundary?.closeMode !== "graceful"
    || report.measurementBoundary?.database !== "one-shared-sqlite-file"
    || report.measurementBoundary?.databasePathOwnership !== "caller"
    || report.measurementBoundary?.databaseOverlap !== "not-directly-observed"
    || report.measurementBoundary?.barrier !== "all-settled-before-next-wave"
    || report.measurementBoundary?.launch !== "main-thread-wave"
    || report.measurementBoundary?.osCache !== "uncontrolled"
    || report.measurementBoundary?.process !== "same-process-new-verifier-worker"
    || report.measurementBoundary?.sameScopeContention !== "not-measured"
    || report.measurementBoundary?.sessionTopology !== "four-independent-public-sessions"
    || report.measurementBoundary?.outstandingMeaning
      !== "harness-operation-tasks-not-public-promises-or-database-execution"
  ) {
    throw new Error("mixed durable tracer report measurement boundary diverged");
  }
  exactKeys(report.workload, [
    "activeAssertionCountPerHead",
    "clients",
    "cycles",
    "excludedDataOperations",
    "finalGeneration",
    "id",
    "inactiveAssertionCountPerHead",
    "initialGeneration",
    "logicalOperationType",
    "measuredLogicalOperations",
    "mixedReadWriteWaves",
    "readOperations",
    "totalAssertionCountPerHead",
    "totalDataOperations",
    "waves",
    "writeOperations"
  ], "mixed durable workload");
  exactKeys(
    report.workload.excludedDataOperations,
    ["precloseVerificationReads", "preparationWrites", "reopenVerificationReads", "total"],
    "mixed durable excluded operations"
  );
  exactKeys(
    report.workload.totalDataOperations,
    ["reads", "total", "writes"],
    "mixed durable total operations"
  );
  exactKeys(report.concurrency, [
    "barrierCount",
    "clients",
    "mixedReadWriteBarrierCount",
    "operationsPerClient",
    "peakOutstandingOperationTasksObserved",
    "readOnlyBarrierCount",
    "writeOnlyBarrierCount"
  ], "mixed durable concurrency");
  if (
    report.workload?.id !== "four-session-mixed-80r20w@1"
    || report.workload.activeAssertionCountPerHead !== 16
    || report.workload.inactiveAssertionCountPerHead !== 24
    || report.workload.totalAssertionCountPerHead !== 40
    || report.workload.clients !== 4
    || report.workload.cycles !== 5
    || report.workload.measuredLogicalOperations !== 100
    || report.workload.logicalOperationType !== "public-agent-api"
    || report.workload.mixedReadWriteWaves !== 16
    || report.workload.waves !== 25
    || report.workload.readOperations !== 80
    || report.workload.writeOperations !== 20
    || report.workload.initialGeneration !== 1
    || report.workload.finalGeneration !== 6
    || JSON.stringify(report.workload.excludedDataOperations) !== JSON.stringify({
      preparationWrites: 4,
      precloseVerificationReads: 4,
      reopenVerificationReads: 4,
      total: 12
    })
    || JSON.stringify(report.workload.totalDataOperations) !== JSON.stringify({
      reads: 88,
      writes: 24,
      total: 112
    })
    || report.concurrency?.peakOutstandingOperationTasksObserved !== 4
    || report.concurrency?.barrierCount !== 25
    || report.concurrency?.mixedReadWriteBarrierCount !== 16
    || report.concurrency?.readOnlyBarrierCount !== 8
    || report.concurrency?.writeOnlyBarrierCount !== 1
    || report.concurrency?.operationsPerClient !== 25
    || !Array.isArray(report.concurrency?.clients)
    || report.concurrency.clients.length !== 4
    || report.concurrency.clients.some((client, index) => (
      !plainObject(client)
      || Object.keys(client).length !== 3
      || client.clientId !== `client:${index.toString()}`
      || client.reads !== 20
      || client.writes !== 5
    ))
  ) {
    throw new Error("mixed durable tracer report does not match its fixed workload");
  }
  const correctnessFields = [
    "allOperationsSucceeded",
    "finalHeadsMatchGoldenManifest",
    "fullResultsStableAcrossReopen",
    "readSemanticsMatchCurrentHead",
    "reopenExact",
    "scheduleExact",
    "writeSnapshotsMatchProjectionContract"
  ];
  exactKeys(report.correctness, [
    ...correctnessFields,
    "finalHeads",
    "goldenManifestVersion"
  ], "mixed durable correctness");
  if (correctnessFields.some((field) => report.correctness?.[field] !== true)) {
    throw new Error("mixed durable tracer report correctness boundary diverged");
  }
  if (report.correctness.goldenManifestVersion !== "four-session-mixed-80r20w@1") {
    throw new Error("mixed durable tracer report golden manifest version diverged");
  }
  exactKeys(report.timing, [
    "contract",
    "mixedWallMilliseconds",
    "verifierReopenMilliseconds"
  ], "mixed durable timing");
  exactKeys(report.timing.contract, [
    "clock",
    "mixedWallIncludes",
    "operationDurationIncludes",
    "pureDatabaseLatency",
    "verifierReopenIncludes"
  ], "mixed durable timing contract");
  if (
    report.timing.contract.clock !== "performance.now-monotonic"
    || report.timing.contract.mixedWallIncludes
      !== "cell-build-clone-public-call-validation-and-wave-bookkeeping"
    || report.timing.contract.operationDurationIncludes
      !== "cell-build-clone-public-call-and-validation"
    || report.timing.contract.verifierReopenIncludes !== "session-and-worker-open-only"
  ) {
    throw new Error("mixed durable tracer report timing contract diverged");
  }
  exactKeys(report.provenance, [
    "authority",
    "capturedAt",
    "harness",
    "repository",
    "runtime",
    "sqliteVersion",
    "workload"
  ], "mixed durable provenance");
  exactKeys(report.provenance.harness, ["id", "sha256"], "mixed durable harness provenance");
  exactKeys(
    report.provenance.repository,
    ["commit", "lockfileSha256", "tree"],
    "mixed durable repository provenance"
  );
  exactKeys(report.provenance.runtime, [
    "arch",
    "cpuModel",
    "logicalCpuCount",
    "node",
    "osRelease",
    "platform",
    "totalMemoryBytes"
  ], "mixed durable runtime provenance");
  exactKeys(report.provenance.workload, ["id", "sha256"], "mixed durable workload provenance");
  if (
    report.provenance?.authority !== "unattested-local-process"
    || typeof report.provenance.capturedAt !== "string"
    || !Number.isFinite(Date.parse(report.provenance.capturedAt))
    || new Date(Date.parse(report.provenance.capturedAt)).toISOString()
      !== report.provenance.capturedAt
    || report.provenance.harness.id !== "benchmark-attunegraph-agent-decision-mixed-durable@1"
    || !SHA256_PATTERN.test(report.provenance?.harness?.sha256 ?? "")
    || typeof report.provenance.runtime.node !== "string"
    || report.provenance.runtime.node.length === 0
    || typeof report.provenance.runtime.platform !== "string"
    || report.provenance.runtime.platform.length === 0
    || typeof report.provenance.runtime.arch !== "string"
    || report.provenance.runtime.arch.length === 0
    || typeof report.provenance.runtime.osRelease !== "string"
    || report.provenance.runtime.osRelease.length === 0
    || typeof report.provenance.runtime.cpuModel !== "string"
    || report.provenance.runtime.cpuModel.length === 0
    || !Number.isSafeInteger(report.provenance.runtime.logicalCpuCount)
    || report.provenance.runtime.logicalCpuCount < 1
    || !Number.isSafeInteger(report.provenance.runtime.totalMemoryBytes)
    || report.provenance.runtime.totalMemoryBytes < 1
    || report.provenance.sqliteVersion !== "not-exposed-by-public-api"
    || report.provenance.workload.id !== "four-session-mixed-80r20w@1"
    || report.provenance?.workload?.sha256 !== WORKLOAD_SHA256
    || report.provenance?.repository?.commit !== "not-recorded"
    || report.provenance?.repository?.tree !== "not-recorded"
    || report.provenance?.repository?.lockfileSha256 !== "not-recorded"
  ) {
    throw new Error("mixed durable tracer report provenance boundary diverged");
  }
  if (report.timing?.contract?.pureDatabaseLatency !== false) {
    throw new Error("mixed durable tracer report timing boundary diverged");
  }
  exactKeys(report.limitations, ["nonClaims"], "mixed durable limitations");
  if (JSON.stringify(report.limitations?.nonClaims) !== JSON.stringify(REQUIRED_NON_CLAIMS)) {
    throw new Error("mixed durable tracer report non-claims diverged");
  }
  validateStorage(report);
  finiteNonNegative(report.timing?.mixedWallMilliseconds, "mixed durable wall time");
  finiteNonNegative(report.timing?.verifierReopenMilliseconds, "mixed durable verifier reopen");
  validateOperationLedger(report);
  validateFinalHeads(report);
  return report;
}

export function validateReadinessMeasurementOutput(bytes, contract) {
  let report;
  try {
    report = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("readiness measurement output must be one valid JSON report");
  }
  if (
    !contract
    || contract.id !== `${READINESS_MEASUREMENT_CONTRACT_SCHEMA}:${NAME}`
    || contract.output.schema !== "attunegraph-agent-decision-mixed-durable-tracer@1"
    || contract.output.semantics !== NAME
    || contract.authority !== "local-unattested"
    || contract.scoring !== "excluded"
  ) {
    throw new Error("readiness measurement contract is unsupported");
  }
  return validateTracerReport(report);
}
