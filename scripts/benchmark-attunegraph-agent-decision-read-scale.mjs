import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openAttuneGraph } from "@attunegraph/core";
import { createAttuneGraphStore } from "@attunegraph/core/backend";
import { InMemoryAttuneGraphStoreBackend } from "@attunegraph/core/testing";

import {
  captureAgentDecisionReadHostIdentity,
  captureAgentDecisionReadRepositoryIdentity
} from "./benchmark-attunegraph-agent-decision-read.mjs";

const WORKLOAD = "agent-decision-read-scale@1";
const NOW = "2026-08-01T12:00:00.000Z";
const OBSERVED_AT = "2026-08-01T11:59:00.000Z";
const RECORDED_AT = "2026-08-01T10:00:00.000Z";
const TIMEOUT_MS = 300_000;
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SUPPORTED_ARGUMENTS = new Set(["output", "repetitions", "warmups", "workload"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const EXPECTED_WORKLOAD_SHA256 = "sha256:0076fba7303250790efe1c890f7e02febf575b195012e27d3a6b33894f55f926";
const EXPECTED_AUTHORITY_SENTINEL_SHA256 = "sha256:f38080d0b0e4419f4b6a4c73fc14bc527b63927130bf001130f309e5dd6208e3";
const EXPECTED_CELL_ANCHORS = frozen({
  "focused-resumption-16": "sha256:9c8aad8fc930de4ee674756f57bf5ba0d55f2f7f839203e037995d6caaae3e1f",
  "focused-resumption-32": "sha256:bbb45610f1318b48eaf3b404c0400eeeba7c68eedcbafda3f43765d928ff589a",
  "focused-resumption-48": "sha256:00be9cd11077bc7477d4f782b269e5c6d263d00277576ffd5c1089bf738b383e",
  "thread-frontier-16": "sha256:59e646819094518a8d2ffd925c7c0ff07e167f990152db62838db31dfa6dd71d",
  "thread-frontier-32": "sha256:8d13d071a5fd94edf79919b659086f9bf71c05ee0fe75f23fdcb88155310c742",
  "thread-frontier-48": "sha256:e53b06e773a872fed801ef51307283dca4c3b28280b603cb60f62a4a84fb8173",
  "thread-frontier-48-batch-1": "sha256:397b63eacbb2d175412c3b806902be0554a0050bb59adda0a760f2d806a4b52c",
  "thread-frontier-48-batch-4": "sha256:6b9154a79ca66fb962f9cf0777bf2c8cdef0a6e50996beee368b13973bafd77a",
  "thread-frontier-48-batch-32": "sha256:d81a36819a2b7673b1cea7f7ec6211cd575543a1c28b52ed794bffdfc507b701"
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableAnchor(value) {
  return sha256(JSON.stringify(value));
}

function frozen(value) {
  return Object.freeze(value);
}

function invalid(message) {
  throw new Error(`invalid agent decision-read scale report: ${message}`);
}

function exactRecord(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${name} has unknown or missing fields`);
  }
  return value;
}

function finiteNonNegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`${name} must be finite and non-negative`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid(`${name} must be a positive safe integer`);
  }
  return value;
}

function graphRef(kind, id) {
  return frozen({ kind, id });
}

function assertion(id, subject, predicate, object, overrides = {}) {
  return frozen({
    schemaVersion: 1,
    id,
    subject: graphRef(subject.kind, subject.id),
    predicate,
    object: graphRef(object.kind, object.id),
    epistemicClass: "source-observed",
    sourceRefs: frozen([frozen({
      namespace: "b",
      id: `s:${id}`,
    })]),
    recordedAt: overrides.recordedAt ?? RECORDED_AT,
    ...(overrides.validFrom === undefined ? {} : { validFrom: overrides.validFrom }),
    ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo }),
    ...(overrides.supersededAt === undefined ? {} : { supersededAt: overrides.supersededAt }),
    derivation: frozen({ kind: "projection", version: "v" })
  });
}

function temporalDecoys(prefix, root) {
  const values = [
    { validTo: "2026-08-01T11:00:00.000Z" },
    { validFrom: "2026-08-01T13:00:00.000Z" },
    { recordedAt: "2026-08-01T13:00:00.000Z" },
    { supersededAt: "2026-08-01T11:00:00.000Z" }
  ];
  return frozen(values.map((time, index) => assertion(
    `d:${index.toString().padStart(2, "0")}`,
    graphRef("artifact", `d:${index.toString().padStart(2, "0")}`),
    "CONTEXT_FOR",
    root,
    time
  )));
}

function scopeFor(id) {
  return frozen({
    sourceId: "agent-decision-read-scale-benchmark",
    threadId: `scope:${id}`
  });
}

function commandFor(id, scope, threadRoot, assertions, freshness = "fresh", generation = 1) {
  return frozen({
    operator: "canonical-projection@2",
    observation: frozen({
      schemaVersion: 2,
      observationKey: `${id}:generation:${generation.toString()}`,
      scope,
      threadRoot,
      observedAt: OBSERVED_AT,
      sourceFreshness: frozen({ state: freshness, observedAt: OBSERVED_AT }),
      assertions
    })
  });
}

function projectionInputManifest(command) {
  const serialized = JSON.stringify(command.observation);
  const inputBytes = Buffer.byteLength(serialized, "utf8");
  if (inputBytes > 15_500) throw new Error("scale projection input exceeds the fixed 15,500 byte envelope");
  return frozen({
    inputBytes,
    sha256: sha256(serialized),
    threadRoot: command.observation.threadRoot.id,
    version: command.operator
  });
}

function focusedCell(activeCount) {
  const id = `focused-resumption-${activeCount.toString()}`;
  const scope = scopeFor(id);
  const threadRoot = graphRef("thread", "r");
  const first = graphRef("artifact", "r:0");
  const second = graphRef("artifact", "r:1");
  const third = graphRef("artifact", "r:2");
  const assertions = frozen([
    assertion("a:00", third, "PRECEDED", second),
    assertion("a:01", second, "PRECEDED", first),
    assertion("a:boundary", first, "PRECEDED", threadRoot),
    ...Array.from({ length: activeCount - 3 }, (_, index) => assertion(
      `b:${index.toString().padStart(2, "0")}`,
      graphRef("artifact", `b:${index.toString().padStart(2, "0")}`),
      "LINKED_TO",
      threadRoot
    )),
  ]);
  const command = commandFor(id, scope, threadRoot, assertions);
  return frozen({
    activeAssertionCount: activeCount,
    assertionVisitedPairs: activeCount * 3,
    projectionInput: projectionInputManifest(command),
    decoyCount: 0,
    expected: frozen({
      consideredAssertions: 2,
      emittedAssertions: 2,
      maxDepthReached: 2,
      status: "partial",
      truncationReasons: frozen(["traversal-budget"]),
      visitedRefs: 3
    }),
    id,
    inactiveAssertionCount: 0,
    kind: "focused-resumption",
    command,
    scope,
    seeds: frozen([third]),
    totalAssertionCount: assertions.length
  });
}

function frontierCell(activeCount, batchSize = 1, batched = false) {
  const baseId = `thread-frontier-${activeCount.toString()}`;
  const id = batched ? `${baseId}-batch-${batchSize.toString()}` : baseId;
  const scope = scopeFor(id);
  const threadRoot = graphRef("thread", "r");
  const active = Array.from({ length: activeCount }, (_, index) => {
    const item = graphRef("artifact", `n:${index.toString().padStart(2, "0")}`);
    return assertion(`a:${index.toString().padStart(2, "0")}`, item, "LINKED_TO", threadRoot);
  });
  const command = commandFor(id, scope, threadRoot, frozen(active));
  return frozen({
    activeAssertionCount: activeCount,
    assertionVisitedPairs: activeCount * (activeCount + 1),
    projectionInput: projectionInputManifest(command),
    decoyCount: 0,
    expected: frozen({
      consideredAssertions: activeCount,
      emittedAssertions: activeCount,
      maxDepthReached: 2,
      status: "complete",
      truncationReasons: frozen([]),
      visitedRefs: activeCount + 1
    }),
    id,
    inactiveAssertionCount: 0,
    kind: "thread-frontier",
    command,
    scope,
    seeds: frozen(active.slice(0, batchSize).map((entry) => entry.subject)),
    totalAssertionCount: active.length
  });
}

export function createAgentDecisionReadScaleWorkload() {
  const cells = frozen([
    ...[16, 32, 48].map(focusedCell),
    ...[16, 32, 48].map((activeCount) => frontierCell(activeCount)),
    ...[1, 4, 32].map((batchSize) => frontierCell(48, batchSize, true))
  ]);
  const identity = frozen({
    cells: frozen(cells.map((cell) => frozen({
      activeAssertionCount: cell.activeAssertionCount,
      assertionVisitedPairs: cell.assertionVisitedPairs,
      projectionInput: cell.projectionInput,
      decoyCount: cell.decoyCount,
      expected: cell.expected,
      id: cell.id,
      inactiveAssertionCount: cell.inactiveAssertionCount,
      seedIds: frozen(cell.seeds.map((seed) => `${seed.kind}:${seed.id}`)),
      totalAssertionCount: cell.totalAssertionCount
    }))),
    schema: "attunegraph-agent-decision-read-scale-workload@1",
    temporalDecoys: frozen(["expired", "future", "post-recorded-cutoff", "superseded"]),
    workload: WORKLOAD
  });
  return frozen({ ...identity, sha256: sha256(JSON.stringify(identity)), cells });
}

function semantic(result) {
  const orderedAssertionIds = frozen(result.workingGraph.assertions.map((entry) => entry.id));
  const orderedRefs = frozen(result.workingGraph.refs.map((entry) => `${entry.kind}:${entry.id}`));
  const value = frozen({
    consideredAssertions: result.workingGraph.diagnostics.consideredAssertions,
    emittedAssertions: orderedAssertionIds.length,
    estimatedTokens: result.workingGraph.diagnostics.estimatedTokens,
    latestHeadCommitId: result.snapshot.commitId,
    maxDepthReached: result.workingGraph.diagnostics.maxDepthReached,
    orderedAssertionIds,
    orderedRefs,
    outputBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    seedId: `${result.workingGraph.seed.kind}:${result.workingGraph.seed.id}`,
    sourceFreshness: result.sourceFreshness.state,
    status: result.status,
    truncationReasons: frozen([...result.workingGraph.diagnostics.truncationReasons]),
    visitedRefs: result.workingGraph.diagnostics.visitedRefs
  });
  return frozen({ ...value, anchorSha256: sha256(JSON.stringify(value)) });
}

function assertExpected(cell, observed) {
  for (const [key, value] of Object.entries(cell.expected)) {
    if (JSON.stringify(observed[key]) !== JSON.stringify(value)) {
      throw new Error(`scale semantic contract diverged for ${cell.id}.${key}; bump the workload version`);
    }
  }
  if (observed.sourceFreshness !== "fresh") {
    throw new Error(`scale semantic contract diverged for ${cell.id}.sourceFreshness`);
  }
}

function distribution(samples, independentRuns) {
  if (samples.length === 0 || samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)) {
    throw new Error("scale timing samples must be finite non-negative numbers");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const p50 = independentRuns >= 5
    ? sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)]
    : null;
  return frozen({
    max: sorted.at(-1),
    min: sorted[0],
    p50,
    p95: null,
    p99: null,
    sampleCount: samples.length,
    samples: frozen([...samples])
  });
}

function assertBudget(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("agent decision-read scale benchmark timed out");
  }
}

async function executeHead(cell, warm, signal) {
  assertBudget(signal);
  const backend = new InMemoryAttuneGraphStoreBackend();
  const graph = await openAttuneGraph({ scope: cell.scope, store: createAttuneGraphStore(backend) });
  const memory = () => {
    const usage = process.memoryUsage();
    return frozen({
      arrayBuffers: usage.arrayBuffers,
      external: usage.external,
      heapUsed: usage.heapUsed,
      processMaxRssBytes: process.resourceUsage().maxRSS * 1024,
      rss: usage.rss
    });
  };
  const beforeProjection = memory();
  const preparationStartedAt = performance.now();
  let completed;
  let primeMilliseconds = null;
  try {
    assertBudget(signal);
    const snapshot = await graph.projectAgainstHead(JSON.parse(JSON.stringify(cell.command)));
    assertBudget(signal);
    const stored = await backend.read(cell.scope);
    if (stored === undefined || Buffer.byteLength(stored.canonicalProjection, "utf8") > 15_500) {
      throw new Error(`scale stored canonical projection is missing or oversized for ${cell.id}`);
    }
    const preparationMilliseconds = performance.now() - preparationStartedAt;
    const afterProjection = memory();
    if (warm) {
      assertBudget(signal);
      const primeStartedAt = performance.now();
      await graph.execute({ operator: "working-graph@1", seed: cell.seeds[0], now: NOW, maxEstimatedTokens: 32_768 });
      primeMilliseconds = performance.now() - primeStartedAt;
      assertBudget(signal);
    }
    const afterPrime = memory();
    const batchWallStartedAt = performance.now();
    let batchExecuteMilliseconds = 0;
    const samples = [];
    for (const seed of cell.seeds) {
      assertBudget(signal);
      const executeStartedAt = performance.now();
      const result = await graph.execute({ operator: "working-graph@1", seed, now: NOW, maxEstimatedTokens: 32_768 });
      const executeMilliseconds = performance.now() - executeStartedAt;
      batchExecuteMilliseconds += executeMilliseconds;
      assertBudget(signal);
      const observed = semantic(result);
      assertExpected(cell, observed);
      if (result.snapshot.commitId !== snapshot.commitId || result.snapshot.generation !== 1) {
        throw new Error(`scale head changed while executing ${cell.id}`);
      }
      samples.push(frozen({ executeMilliseconds, semantic: observed }));
    }
    completed = frozen({
      batchExecuteMilliseconds,
      batchWallMilliseconds: performance.now() - batchWallStartedAt,
      canonicalProjection: frozen({
        outputBytes: Buffer.byteLength(stored.canonicalProjection, "utf8"),
        sha256: sha256(stored.canonicalProjection),
        threadRoot: cell.command.observation.threadRoot.id,
        version: cell.command.operator
      }),
      preparationMilliseconds,
      primeMilliseconds,
      samples: frozen(samples),
      checkpoints: frozen({ afterBatch: memory(), afterPrime, afterProjection, beforeProjection })
    });
  } finally {
    await graph.close();
  }
  return frozen({ ...completed, checkpoints: frozen({ ...completed.checkpoints, afterClose: memory() }) });
}

async function measureCell(cell, repetitions, signal) {
  const rawMilliseconds = [];
  let expectedSemantics;
  let canonicalProjection;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    assertBudget(signal);
    const cold = await executeHead(cell, false, signal);
    const warm = await executeHead(cell, true, signal);
    if (JSON.stringify(cold.canonicalProjection) !== JSON.stringify(warm.canonicalProjection)) {
      throw new Error(`scale stored canonical projection changed across thermal heads for ${cell.id}`);
    }
    const observed = frozen({
      cold: frozen(cold.samples.map((sample) => sample.semantic)),
      warm: frozen(warm.samples.map((sample) => sample.semantic))
    });
    if (JSON.stringify(observed.cold) !== JSON.stringify(observed.warm)) {
      throw new Error(`scale semantic contract changed across thermal heads for ${cell.id}`);
    }
    if (expectedSemantics === undefined) expectedSemantics = observed;
    else if (JSON.stringify(expectedSemantics) !== JSON.stringify(observed)) {
      throw new Error(`scale deterministic anchor diverged for ${cell.id}`);
    }
    if (canonicalProjection === undefined) canonicalProjection = cold.canonicalProjection;
    else if (JSON.stringify(canonicalProjection) !== JSON.stringify(cold.canonicalProjection)) {
      throw new Error(`scale canonical projection anchor diverged for ${cell.id}`);
    }
    rawMilliseconds.push(frozen({
      cold: frozen({ batchExecuteMilliseconds: cold.batchExecuteMilliseconds, batchWallMilliseconds: cold.batchWallMilliseconds, positions: frozen(cold.samples.map((sample) => sample.executeMilliseconds)) }),
      warm: frozen({ batchExecuteMilliseconds: warm.batchExecuteMilliseconds, batchWallMilliseconds: warm.batchWallMilliseconds, positions: frozen(warm.samples.map((sample) => sample.executeMilliseconds)) }),
      checkpoints: frozen({ cold: cold.checkpoints, warm: warm.checkpoints }),
      preparationMilliseconds: frozen({ cold: cold.preparationMilliseconds, warm: warm.preparationMilliseconds }),
      primeMilliseconds: frozen({ cold: cold.primeMilliseconds, warm: warm.primeMilliseconds })
    }));
  }
  const positionDistribution = (temperature, position) => distribution(
    rawMilliseconds.map((entry) => entry[temperature].positions[position]),
    repetitions
  );
  const timingFor = (temperature) => frozen({
    batchExecuteMilliseconds: distribution(rawMilliseconds.map((entry) => entry[temperature].batchExecuteMilliseconds), repetitions),
    batchWallMilliseconds: distribution(rawMilliseconds.map((entry) => entry[temperature].batchWallMilliseconds), repetitions),
    positions: frozen(cell.seeds.map((_, position) => positionDistribution(temperature, position))),
    preparationMilliseconds: distribution(rawMilliseconds.map((entry) => entry.preparationMilliseconds[temperature]), repetitions),
    primeMilliseconds: temperature === "cold"
      ? null
      : distribution(rawMilliseconds.map((entry) => entry.primeMilliseconds[temperature]), repetitions)
  });
  if (canonicalProjection === undefined || expectedSemantics === undefined) {
    throw new Error(`scale cell ${cell.id} produced no measurements`);
  }
  const stable = frozen({
    canonicalProjection,
    semantic: cell.seeds.length === 1 ? expectedSemantics.cold[0] : frozen({ seedSemantics: expectedSemantics.cold })
  });
  const anchorSha256 = stableAnchor(stable);
  const expectedAnchor = EXPECTED_CELL_ANCHORS[cell.id];
  if (expectedAnchor !== undefined && anchorSha256 !== expectedAnchor) {
    throw new Error(`scale frozen anchor diverged for ${cell.id}; bump the workload version`);
  }
  return frozen({
    activeAssertionCount: cell.activeAssertionCount,
    anchorSha256,
    assertionVisitedPairs: cell.assertionVisitedPairs,
    batchSize: cell.seeds.length,
    canonicalProjection: stable.canonicalProjection,
    decoyCount: cell.decoyCount,
    id: cell.id,
    inactiveAssertionCount: cell.inactiveAssertionCount,
    kind: cell.kind,
    repetitions,
    seedIds: frozen(cell.seeds.map((seed) => `${seed.kind}:${seed.id}`)),
    semantic: stable.semantic,
    scope: cell.scope,
    timing: frozen({ cold: timingFor("cold"), raw: frozen(rawMilliseconds), warm: timingFor("warm") }),
    totalAssertionCount: cell.totalAssertionCount
  });
}

async function authoritySentinel(signal) {
  assertBudget(signal);
  const scope = scopeFor("authority-sentinel");
  const root = graphRef("thread", "thread-root:authority-sentinel");
  const action = graphRef("action", "action:authorized");
  const governedAction = graphRef("action", "action:governed");
  const policy = graphRef("policy", "policy:governed");
  const evidence = graphRef("evidence", "evidence:authorization");
  const authorityId = "authority:authorized-by";
  const sourceRefs = frozen([frozen({
    id: "authority:source:explicit-consent",
    namespace: "attunegraph.benchmark.agent-decision-read-scale",
    version: "agent-decision-read-scale@1"
  })]);
  const sourceAssertion = (expired) => frozen({
    ...assertion(authorityId, action, "AUTHORIZED_BY", evidence, expired ? { validTo: "2026-08-01T11:00:00.000Z" } : {}),
    sourceRefs
  });
  const linkage = (expired) => assertion("authority:evidence-linked", evidence, "OBSERVED_DURING", root, expired ? { validTo: "2026-08-01T11:00:00.000Z" } : {});
  const governedBy = assertion("authority:governed-by", governedAction, "GOVERNED_BY", policy);
  const scopedTo = assertion("authority:scoped-to", policy, "SCOPED_TO", root);
  const backend = new InMemoryAttuneGraphStoreBackend();
  const graph = await openAttuneGraph({ scope, store: createAttuneGraphStore(backend) });
  try {
    assertBudget(signal);
    const one = await graph.projectAgainstHead(JSON.parse(JSON.stringify(commandFor("authority-sentinel", scope, root, frozen([sourceAssertion(false), linkage(false), governedBy, scopedTo, ...temporalDecoys("sentinel", root)]), "fresh", 1))));
    assertBudget(signal);
    const firstResult = await graph.execute({ operator: "working-graph@1", seed: action, now: NOW, maxEstimatedTokens: 32_768 });
    const first = semantic(firstResult);
    const unauthorized = graphRef("action", "action:unauthorized");
    const unauthorizedResult = await graph.execute({ operator: "working-graph@1", seed: unauthorized, now: NOW, maxEstimatedTokens: 32_768 });
    const governedOne = semantic(await graph.execute({ operator: "working-graph@1", seed: governedAction, now: NOW, maxEstimatedTokens: 32_768 }));
    assertBudget(signal);
    const two = await graph.projectAgainstHead(JSON.parse(JSON.stringify(commandFor("authority-sentinel", scope, root, frozen([sourceAssertion(true), linkage(true), governedBy, scopedTo, ...temporalDecoys("sentinel", root)]), "stale", 2))));
    const second = semantic(await graph.execute({ operator: "working-graph@1", seed: action, now: NOW, maxEstimatedTokens: 32_768 }));
    const governedTwo = semantic(await graph.execute({ operator: "working-graph@1", seed: governedAction, now: NOW, maxEstimatedTokens: 32_768 }));
    assertBudget(signal);
    if (!first.orderedAssertionIds.includes(authorityId) || second.status !== "abstained" || one.commitId === two.commitId) {
      throw new Error(`authority sentinel contract diverged: ${JSON.stringify({ first: first.status, firstIds: first.orderedAssertionIds, second: second.status, commitsEqual: one.commitId === two.commitId })}`);
    }
    const collidingScope = frozen({ sourceId: "agent-decision-read-scale-colliding", threadId: "scope:authority-sentinel-colliding" });
    const isolated = await openAttuneGraph({ scope: collidingScope, store: createAttuneGraphStore(backend) });
    let isolationStatus;
    try {
      await isolated.projectAgainstHead(JSON.parse(JSON.stringify(commandFor("authority-sentinel-colliding", collidingScope, root, frozen([]), "fresh"))));
      isolationStatus = (await isolated.execute({ operator: "working-graph@1", seed: action, now: NOW, maxEstimatedTokens: 32_768 })).status;
      assertBudget(signal);
    } finally {
      await isolated.close();
    }
    const observedAuthorization = firstResult.workingGraph.assertions.find((entry) => entry.id === authorityId);
    if (unauthorizedResult.status !== "abstained" || isolationStatus !== "abstained" || observedAuthorization === undefined || JSON.stringify(observedAuthorization.sourceRefs) !== JSON.stringify(sourceRefs)
      || governedTwo.status !== "complete" || governedOne.orderedAssertionIds.includes(authorityId) || governedTwo.orderedAssertionIds.includes(authorityId)) {
      throw new Error("authority sentinel inferred authority or crossed a scope boundary");
    }
    const value = frozen({
      collidingRefIsolation: frozen({ status: isolationStatus, threadId: collidingScope.threadId }),
      governedAction: frozen({ authority: "not-inferred", generationOneStatus: governedOne.status, generationTwoStatus: governedTwo.status, id: governedAction.id }),
      generationOne: frozen({ authorityObserved: true, commitId: one.commitId, explicitAuthorizationAssertionId: authorityId, generation: one.generation, observedAuthorizationSourceRefs: frozen(observedAuthorization.sourceRefs.map((sourceRef) => frozen({ ...sourceRef }))), status: first.status, unauthorizedActionStatus: unauthorizedResult.status }),
      generationTwo: frozen({ authorityObserved: false, commitId: two.commitId, generation: two.generation, sourceFreshness: second.sourceFreshness, status: second.status })
    });
    return frozen({ ...value, anchorSha256: stableAnchor(value) });
  } finally {
    await graph.close();
  }
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(["repetitions", "timeoutMs", "warmups", "workload"])
    || options.workload !== WORKLOAD
    || !Number.isSafeInteger(options.warmups) || options.warmups < 0 || options.warmups > 5
    || !Number.isSafeInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 10
    || options.timeoutMs !== TIMEOUT_MS) {
    throw new Error("agent decision-read scale benchmark options are invalid");
  }
}

export function parseAgentDecisionReadScaleArguments(args) {
  const values = new Map();
  for (const argument of (args[0] === "--" ? args.slice(1) : args)) {
    const match = /^--([a-z]+)=(.*)$/u.exec(argument);
    if (!match || !SUPPORTED_ARGUMENTS.has(match[1]) || values.has(match[1])) throw new Error(`unsupported agent decision-read scale argument: ${argument}`);
    values.set(match[1], match[2]);
  }
  const integer = (value, name, minimum, maximum) => {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(value ?? "")) throw new Error(`${name} must be an integer`);
    const parsed = Number(value);
    if (parsed < minimum || parsed > maximum) throw new Error(`${name} is out of range`);
    return parsed;
  };
  const outputPath = values.get("output");
  if (values.get("workload") !== WORKLOAD || (outputPath !== undefined && (outputPath === "" || !isAbsolute(outputPath) || normalize(outputPath) !== outputPath))) {
    throw new Error(`workload must be ${WORKLOAD} and output must be an absolute normalized path`);
  }
  return frozen({ outputPath, repetitions: integer(values.get("repetitions") ?? "5", "repetitions", 1, 10), timeoutMs: TIMEOUT_MS, warmups: integer(values.get("warmups") ?? "1", "warmups", 0, 5), workload: WORKLOAD });
}

export async function generateAgentDecisionReadScaleReport(options, runtime = {}) {
  validateOptions(options);
  const workload = createAgentDecisionReadScaleWorkload();
  if (EXPECTED_WORKLOAD_SHA256 !== "" && workload.sha256 !== EXPECTED_WORKLOAD_SHA256) {
    throw new Error("scale workload identity diverged; bump the workload version");
  }
  const controller = new AbortController();
  const externalSignal = runtime.signal;
  const forwardExternalAbort = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) forwardExternalAbort();
  else externalSignal?.addEventListener("abort", forwardExternalAbort, { once: true });
  const timeoutError = new Error("agent decision-read scale benchmark timed out");
  const timeoutId = setTimeout(() => controller.abort(timeoutError), options.timeoutMs);
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? timeoutError), { once: true });
  });
  const work = (
    async () => {
      for (let index = 0; index < options.warmups; index += 1) {
        for (const cell of workload.cells) await measureCell(cell, 1, controller.signal);
      }
      const cells = [];
      for (const cell of workload.cells) cells.push(await measureCell(cell, options.repetitions, controller.signal));
      const sentinel = await authoritySentinel(controller.signal);
      if (EXPECTED_AUTHORITY_SENTINEL_SHA256 !== "" && sentinel.anchorSha256 !== EXPECTED_AUTHORITY_SENTINEL_SHA256) {
        throw new Error("scale authority sentinel diverged; bump the workload version");
      }
      const measurementIdentity = frozen({
        authoritySentinelSha256: sentinel.anchorSha256,
        cells: frozen(cells.map((cell) => frozen({ anchorSha256: cell.anchorSha256, id: cell.id }))),
        schema: "attunegraph-agent-decision-read-scale-measurement-identity@1",
        workloadSha256: workload.sha256
      });
      return frozen({
        authoritySentinel: sentinel,
        cells: frozen(cells),
        checkpoints: frozen({ cold: "fresh-head-unprimed", rebuildPerRepetition: true, warm: "separate-fresh-head-one-excluded-prime" }),
        claimEligible: false,
        configuration: frozen({
          decisionSemantics: "public-working-graph-per-seed",
          monotonicClock: "performance.now",
          repetitions: options.repetitions,
          tailEligibility: frozen({ basis: "independent-fresh-head-repetitions", p50MinimumIndependentRuns: 5, p95MinimumIndependentRuns: null, p99MinimumIndependentRuns: null }),
          timeoutMilliseconds: TIMEOUT_MS,
          warmups: options.warmups,
          workload: WORKLOAD
        }),
        measurementIdentity,
        measurementIdentitySha256: stableAnchor(measurementIdentity),
        measurementOnly: true,
        memoryContract: frozen({ deltaQualified: false, gcForced: false, maxRssSource: "process.resourceUsage.maxRSS-kib-normalized", scope: "process-observational", units: "bytes" }),
        resourceAuthoritative: false,
        resourceQualified: false,
        schema: "attunegraph-agent-decision-read-scale-benchmark@1",
        workload: WORKLOAD,
        workloadSha256: workload.sha256
      });
    }
  )();
  let report;
  try {
    report = await Promise.race([work, aborted]);
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", forwardExternalAbort);
  }
  return validateAgentDecisionReadScaleReportSchema(report);
}

function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalid(`${name} must be a string array`);
  }
  return value;
}

function sameValue(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid(`${name} diverged`);
}

function validateDistribution(value, samples, repetitions, name) {
  const observed = exactRecord(value, ["max", "min", "p50", "p95", "p99", "sampleCount", "samples"], name);
  if (!Array.isArray(observed.samples) || observed.samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)) {
    invalid(`${name}.samples must be finite non-negative numbers`);
  }
  sameValue(observed.samples, samples, `${name}.samples`);
  sameValue(observed, distribution(samples, repetitions), name);
}

function validateMemory(value, name) {
  const memory = exactRecord(value, ["arrayBuffers", "external", "heapUsed", "processMaxRssBytes", "rss"], name);
  for (const key of Object.keys(memory)) finiteNonNegative(memory[key], `${name}.${key}`);
}

function validateHeadCheckpoints(value, name) {
  const checkpoints = exactRecord(value, ["afterBatch", "afterClose", "afterPrime", "afterProjection", "beforeProjection"], name);
  for (const key of Object.keys(checkpoints)) validateMemory(checkpoints[key], `${name}.${key}`);
}

function validateSemantic(value, expected, expectedSeedId, name) {
  const observed = exactRecord(value, [
    "anchorSha256",
    "consideredAssertions",
    "emittedAssertions",
    "estimatedTokens",
    "latestHeadCommitId",
    "maxDepthReached",
    "orderedAssertionIds",
    "orderedRefs",
    "outputBytes",
    "seedId",
    "sourceFreshness",
    "status",
    "truncationReasons",
    "visitedRefs"
  ], name);
  if (!SHA256.test(observed.anchorSha256)
    || typeof observed.latestHeadCommitId !== "string" || !observed.latestHeadCommitId.startsWith("attunegraph-commit:")
    || observed.seedId !== expectedSeedId || observed.sourceFreshness !== "fresh") {
    invalid(`${name} identity`);
  }
  for (const key of ["consideredAssertions", "emittedAssertions", "estimatedTokens", "maxDepthReached", "outputBytes", "visitedRefs"]) {
    positiveInteger(observed[key], `${name}.${key}`);
  }
  stringArray(observed.orderedAssertionIds, `${name}.orderedAssertionIds`);
  stringArray(observed.orderedRefs, `${name}.orderedRefs`);
  stringArray(observed.truncationReasons, `${name}.truncationReasons`);
  if (new Set(observed.orderedAssertionIds).size !== observed.orderedAssertionIds.length
    || new Set(observed.orderedRefs).size !== observed.orderedRefs.length
    || observed.emittedAssertions !== observed.orderedAssertionIds.length) {
    invalid(`${name} ordered output`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) sameValue(observed[key], expectedValue, `${name}.${key}`);
  const anchorValue = {
    consideredAssertions: observed.consideredAssertions,
    emittedAssertions: observed.emittedAssertions,
    estimatedTokens: observed.estimatedTokens,
    latestHeadCommitId: observed.latestHeadCommitId,
    maxDepthReached: observed.maxDepthReached,
    orderedAssertionIds: observed.orderedAssertionIds,
    orderedRefs: observed.orderedRefs,
    outputBytes: observed.outputBytes,
    seedId: observed.seedId,
    sourceFreshness: observed.sourceFreshness,
    status: observed.status,
    truncationReasons: observed.truncationReasons,
    visitedRefs: observed.visitedRefs
  };
  if (stableAnchor(anchorValue) !== observed.anchorSha256) invalid(`${name}.anchorSha256`);
}

function validateAuthoritySentinel(value) {
  const sentinel = exactRecord(value, ["anchorSha256", "collidingRefIsolation", "generationOne", "generationTwo", "governedAction"], "authoritySentinel");
  const isolation = exactRecord(sentinel.collidingRefIsolation, ["status", "threadId"], "authoritySentinel.collidingRefIsolation");
  const governed = exactRecord(sentinel.governedAction, ["authority", "generationOneStatus", "generationTwoStatus", "id"], "authoritySentinel.governedAction");
  const one = exactRecord(sentinel.generationOne, ["authorityObserved", "commitId", "explicitAuthorizationAssertionId", "generation", "observedAuthorizationSourceRefs", "status", "unauthorizedActionStatus"], "authoritySentinel.generationOne");
  const two = exactRecord(sentinel.generationTwo, ["authorityObserved", "commitId", "generation", "sourceFreshness", "status"], "authoritySentinel.generationTwo");
  if (isolation.status !== "abstained" || isolation.threadId !== "scope:authority-sentinel-colliding"
    || governed.authority !== "not-inferred" || governed.generationOneStatus !== "partial" || governed.generationTwoStatus !== "complete" || governed.id !== "action:governed"
    || one.authorityObserved !== true || one.explicitAuthorizationAssertionId !== "authority:authorized-by" || one.generation !== 1 || one.status !== "partial" || one.unauthorizedActionStatus !== "abstained"
    || two.authorityObserved !== false || two.generation !== 2 || two.sourceFreshness !== "stale" || two.status !== "abstained"
    || typeof one.commitId !== "string" || typeof two.commitId !== "string" || one.commitId === two.commitId) {
    invalid("authoritySentinel behavior");
  }
  if (!Array.isArray(one.observedAuthorizationSourceRefs) || one.observedAuthorizationSourceRefs.length !== 1) invalid("authoritySentinel source refs");
  const sourceRef = exactRecord(one.observedAuthorizationSourceRefs[0], ["id", "namespace", "version"], "authoritySentinel source ref");
  sameValue(sourceRef, { id: "authority:source:explicit-consent", namespace: "attunegraph.benchmark.agent-decision-read-scale", version: WORKLOAD }, "authoritySentinel source ref");
  const anchorValue = {
    collidingRefIsolation: sentinel.collidingRefIsolation,
    governedAction: sentinel.governedAction,
    generationOne: sentinel.generationOne,
    generationTwo: sentinel.generationTwo
  };
  if (!SHA256.test(sentinel.anchorSha256) || stableAnchor(anchorValue) !== sentinel.anchorSha256
    || (EXPECTED_AUTHORITY_SENTINEL_SHA256 !== "" && sentinel.anchorSha256 !== EXPECTED_AUTHORITY_SENTINEL_SHA256)) {
    invalid("authoritySentinel.anchorSha256");
  }
}

function validateCell(value, expectedCell, repetitions, index) {
  const name = `cells[${index.toString()}]`;
  const cell = exactRecord(value, [
    "activeAssertionCount",
    "anchorSha256",
    "assertionVisitedPairs",
    "batchSize",
    "canonicalProjection",
    "decoyCount",
    "id",
    "inactiveAssertionCount",
    "kind",
    "repetitions",
    "scope",
    "seedIds",
    "semantic",
    "timing",
    "totalAssertionCount"
  ], name);
  const expectedSeedIds = expectedCell.seeds.map((seed) => `${seed.kind}:${seed.id}`);
  if (cell.id !== expectedCell.id || cell.kind !== expectedCell.kind || cell.repetitions !== repetitions
    || cell.activeAssertionCount !== expectedCell.activeAssertionCount || cell.inactiveAssertionCount !== expectedCell.inactiveAssertionCount
    || cell.totalAssertionCount !== expectedCell.totalAssertionCount || cell.assertionVisitedPairs !== expectedCell.assertionVisitedPairs
    || cell.batchSize !== expectedSeedIds.length || cell.decoyCount !== expectedCell.decoyCount) {
    invalid(`${name} workload contract`);
  }
  sameValue(cell.scope, expectedCell.scope, `${name}.scope`);
  sameValue(stringArray(cell.seedIds, `${name}.seedIds`), expectedSeedIds, `${name}.seedIds`);
  exactRecord(cell.scope, ["sourceId", "threadId"], `${name}.scope`);
  const projection = exactRecord(cell.canonicalProjection, ["outputBytes", "sha256", "threadRoot", "version"], `${name}.canonicalProjection`);
  positiveInteger(projection.outputBytes, `${name}.canonicalProjection.outputBytes`);
  if (projection.outputBytes > 15_500 || !SHA256.test(projection.sha256) || projection.threadRoot !== expectedCell.command.observation.threadRoot.id || projection.version !== "canonical-projection@2") {
    invalid(`${name}.canonicalProjection`);
  }
  if (cell.batchSize === 1) validateSemantic(cell.semantic, expectedCell.expected, expectedSeedIds[0], `${name}.semantic`);
  else {
    const semantics = exactRecord(cell.semantic, ["seedSemantics"], `${name}.semantic`).seedSemantics;
    if (!Array.isArray(semantics) || semantics.length !== cell.batchSize) invalid(`${name}.semantic.seedSemantics`);
    semantics.forEach((entry, seedIndex) => validateSemantic(entry, expectedCell.expected, expectedSeedIds[seedIndex], `${name}.semantic.seedSemantics[${seedIndex.toString()}]`));
  }
  if (!SHA256.test(cell.anchorSha256) || stableAnchor({ canonicalProjection: cell.canonicalProjection, semantic: cell.semantic }) !== cell.anchorSha256
    || (EXPECTED_CELL_ANCHORS[cell.id] !== undefined && EXPECTED_CELL_ANCHORS[cell.id] !== cell.anchorSha256)) {
    invalid(`${name}.anchorSha256`);
  }

  const timing = exactRecord(cell.timing, ["cold", "raw", "warm"], `${name}.timing`);
  if (!Array.isArray(timing.raw) || timing.raw.length !== repetitions) invalid(`${name}.timing.raw`);
  for (const [rawIndex, rawValue] of timing.raw.entries()) {
    const raw = exactRecord(rawValue, ["checkpoints", "cold", "preparationMilliseconds", "primeMilliseconds", "warm"], `${name}.timing.raw[${rawIndex.toString()}]`);
    const checkpoints = exactRecord(raw.checkpoints, ["cold", "warm"], `${name}.timing.raw[${rawIndex.toString()}].checkpoints`);
    validateHeadCheckpoints(checkpoints.cold, `${name}.timing.raw[${rawIndex.toString()}].checkpoints.cold`);
    validateHeadCheckpoints(checkpoints.warm, `${name}.timing.raw[${rawIndex.toString()}].checkpoints.warm`);
    const preparation = exactRecord(raw.preparationMilliseconds, ["cold", "warm"], `${name}.timing.raw[${rawIndex.toString()}].preparationMilliseconds`);
    const prime = exactRecord(raw.primeMilliseconds, ["cold", "warm"], `${name}.timing.raw[${rawIndex.toString()}].primeMilliseconds`);
    finiteNonNegative(preparation.cold, `${name} preparation cold`);
    finiteNonNegative(preparation.warm, `${name} preparation warm`);
    if (prime.cold !== null) invalid(`${name} cold prime must be null`);
    finiteNonNegative(prime.warm, `${name} prime warm`);
    for (const temperature of ["cold", "warm"]) {
      const sample = exactRecord(raw[temperature], ["batchExecuteMilliseconds", "batchWallMilliseconds", "positions"], `${name}.timing.raw[${rawIndex.toString()}].${temperature}`);
      if (!Array.isArray(sample.positions) || sample.positions.length !== cell.batchSize) invalid(`${name} ${temperature} positions`);
      sample.positions.forEach((entry, position) => finiteNonNegative(entry, `${name} ${temperature} position ${position.toString()}`));
      finiteNonNegative(sample.batchExecuteMilliseconds, `${name} ${temperature} batch execute`);
      finiteNonNegative(sample.batchWallMilliseconds, `${name} ${temperature} batch wall`);
      if (sample.batchExecuteMilliseconds !== sample.positions.reduce((sum, entry) => sum + entry, 0)
        || sample.batchWallMilliseconds < sample.batchExecuteMilliseconds) invalid(`${name} ${temperature} batch timing`);
    }
  }
  for (const temperature of ["cold", "warm"]) {
    const summary = exactRecord(timing[temperature], ["batchExecuteMilliseconds", "batchWallMilliseconds", "positions", "preparationMilliseconds", "primeMilliseconds"], `${name}.timing.${temperature}`);
    validateDistribution(summary.batchExecuteMilliseconds, timing.raw.map((entry) => entry[temperature].batchExecuteMilliseconds), repetitions, `${name}.timing.${temperature}.batchExecuteMilliseconds`);
    validateDistribution(summary.batchWallMilliseconds, timing.raw.map((entry) => entry[temperature].batchWallMilliseconds), repetitions, `${name}.timing.${temperature}.batchWallMilliseconds`);
    validateDistribution(summary.preparationMilliseconds, timing.raw.map((entry) => entry.preparationMilliseconds[temperature]), repetitions, `${name}.timing.${temperature}.preparationMilliseconds`);
    if (!Array.isArray(summary.positions) || summary.positions.length !== cell.batchSize) invalid(`${name}.timing.${temperature}.positions`);
    summary.positions.forEach((entry, position) => validateDistribution(entry, timing.raw.map((raw) => raw[temperature].positions[position]), repetitions, `${name}.timing.${temperature}.positions[${position.toString()}]`));
    if (temperature === "cold") {
      if (summary.primeMilliseconds !== null) invalid(`${name}.timing.cold.primeMilliseconds`);
    } else validateDistribution(summary.primeMilliseconds, timing.raw.map((entry) => entry.primeMilliseconds.warm), repetitions, `${name}.timing.warm.primeMilliseconds`);
  }
}

export function validateAgentDecisionReadScaleReportSchema(value) {
  const report = exactRecord(value, [
    "authoritySentinel",
    "cells",
    "checkpoints",
    "claimEligible",
    "configuration",
    "measurementIdentity",
    "measurementIdentitySha256",
    "measurementOnly",
    "memoryContract",
    "resourceAuthoritative",
    "resourceQualified",
    "schema",
    "workload",
    "workloadSha256"
  ], "root");
  if (report.schema !== "attunegraph-agent-decision-read-scale-benchmark@1" || report.workload !== WORKLOAD
    || report.measurementOnly !== true || report.claimEligible !== false || report.resourceAuthoritative !== false || report.resourceQualified !== false) {
    invalid("claim boundary");
  }
  const configuration = exactRecord(report.configuration, ["decisionSemantics", "monotonicClock", "repetitions", "tailEligibility", "timeoutMilliseconds", "warmups", "workload"], "configuration");
  positiveInteger(configuration.repetitions, "configuration.repetitions");
  if (configuration.repetitions > 10 || !Number.isSafeInteger(configuration.warmups) || configuration.warmups < 0 || configuration.warmups > 5
    || configuration.decisionSemantics !== "public-working-graph-per-seed" || configuration.monotonicClock !== "performance.now"
    || configuration.timeoutMilliseconds !== TIMEOUT_MS || configuration.workload !== WORKLOAD) invalid("configuration");
  sameValue(exactRecord(configuration.tailEligibility, ["basis", "p50MinimumIndependentRuns", "p95MinimumIndependentRuns", "p99MinimumIndependentRuns"], "configuration.tailEligibility"), {
    basis: "independent-fresh-head-repetitions",
    p50MinimumIndependentRuns: 5,
    p95MinimumIndependentRuns: null,
    p99MinimumIndependentRuns: null
  }, "configuration.tailEligibility");
  sameValue(exactRecord(report.checkpoints, ["cold", "rebuildPerRepetition", "warm"], "checkpoints"), { cold: "fresh-head-unprimed", rebuildPerRepetition: true, warm: "separate-fresh-head-one-excluded-prime" }, "checkpoints");
  sameValue(exactRecord(report.memoryContract, ["deltaQualified", "gcForced", "maxRssSource", "scope", "units"], "memoryContract"), { deltaQualified: false, gcForced: false, maxRssSource: "process.resourceUsage.maxRSS-kib-normalized", scope: "process-observational", units: "bytes" }, "memoryContract");
  const workload = createAgentDecisionReadScaleWorkload();
  if (!SHA256.test(report.workloadSha256) || report.workloadSha256 !== workload.sha256
    || (EXPECTED_WORKLOAD_SHA256 !== "" && report.workloadSha256 !== EXPECTED_WORKLOAD_SHA256)) invalid("workloadSha256");
  if (!Array.isArray(report.cells) || report.cells.length !== workload.cells.length) invalid("cells");
  report.cells.forEach((cell, index) => validateCell(cell, workload.cells[index], configuration.repetitions, index));
  validateAuthoritySentinel(report.authoritySentinel);
  const identity = exactRecord(report.measurementIdentity, ["authoritySentinelSha256", "cells", "schema", "workloadSha256"], "measurementIdentity");
  if (identity.schema !== "attunegraph-agent-decision-read-scale-measurement-identity@1" || identity.workloadSha256 !== report.workloadSha256 || identity.authoritySentinelSha256 !== report.authoritySentinel.anchorSha256
    || !Array.isArray(identity.cells)) invalid("measurementIdentity");
  sameValue(identity.cells, report.cells.map((cell) => ({ anchorSha256: cell.anchorSha256, id: cell.id })), "measurementIdentity.cells");
  if (!SHA256.test(report.measurementIdentitySha256) || stableAnchor(identity) !== report.measurementIdentitySha256) invalid("measurementIdentitySha256");
  return value;
}

async function validateOutputPath(outputPath) {
  const parent = dirname(outputPath);
  if (await realpath(parent) !== parent || (!relative(PACKAGE_ROOT, outputPath).startsWith("..") && relative(PACKAGE_ROOT, outputPath) !== "")) throw new Error("agent decision-read scale output must be outside the repository under a non-symlink directory");
  try { await lstat(outputPath); throw new Error("agent decision-read scale output already exists"); } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
}

function validateHost(value, name) {
  const host = exactRecord(value, ["arch", "cpuCount", "cpuModel", "node", "os", "pnpm", "totalMemoryBytes"], name);
  for (const key of ["arch", "cpuModel", "node", "os", "pnpm"]) if (typeof host[key] !== "string" || host[key].length === 0) invalid(`${name}.${key}`);
  positiveInteger(host.cpuCount, `${name}.cpuCount`);
  positiveInteger(host.totalMemoryBytes, `${name}.totalMemoryBytes`);
  return host;
}

function validateRepository(value, name) {
  const repository = exactRecord(value, ["clean", "commit", "lockfileSha256", "tree"], name);
  if (repository.clean !== true || !GIT_OBJECT_ID.test(repository.commit) || !GIT_OBJECT_ID.test(repository.tree) || !SHA256.test(repository.lockfileSha256)) invalid(name);
  return repository;
}

export function validateAgentDecisionReadScaleEvidenceSchema(value) {
  const evidence = exactRecord(value, ["argv", "host", "observedAt", "report", "repository", "schema"], "evidence");
  if (evidence.schema !== "attunegraph-agent-decision-read-scale-evidence@1") invalid("evidence.schema");
  stringArray(evidence.argv, "evidence.argv");
  const options = parseAgentDecisionReadScaleArguments(evidence.argv);
  validateHost(evidence.host, "evidence.host");
  validateRepository(evidence.repository, "evidence.repository");
  if (typeof evidence.observedAt !== "string" || new Date(evidence.observedAt).toISOString() !== evidence.observedAt) invalid("evidence.observedAt");
  validateAgentDecisionReadScaleReportSchema(evidence.report);
  if (evidence.report.configuration.repetitions !== options.repetitions || evidence.report.configuration.warmups !== options.warmups || evidence.report.workload !== options.workload) invalid("evidence argv report binding");
  return value;
}

export function verifyAgentDecisionReadScaleEvidenceAuthority(value, expected) {
  const evidence = validateAgentDecisionReadScaleEvidenceSchema(value);
  const authority = exactRecord(expected, ["argv", "host", "repository"], "evidence authority");
  stringArray(authority.argv, "evidence authority argv");
  validateHost(authority.host, "evidence authority host");
  validateRepository(authority.repository, "evidence authority repository");
  sameValue(evidence.argv, authority.argv, "evidence argv authority");
  sameValue(evidence.host, authority.host, "evidence host authority");
  sameValue(evidence.repository, authority.repository, "evidence repository authority");
  return value;
}

export async function runAgentDecisionReadScaleCommand(argv, runtime = {}) {
  const options = parseAgentDecisionReadScaleArguments(argv);
  if (options.outputPath !== undefined) await validateOutputPath(options.outputPath);
  const captureRepositoryIdentity = runtime.captureRepositoryIdentity ?? captureAgentDecisionReadRepositoryIdentity;
  const before = captureRepositoryIdentity();
  if (!before.clean) throw new Error("agent decision-read scale evidence requires a clean source checkout");
  const host = runtime.host ?? captureAgentDecisionReadHostIdentity();
  const report = await generateAgentDecisionReadScaleReport({ repetitions: options.repetitions, timeoutMs: options.timeoutMs, warmups: options.warmups, workload: options.workload }, runtime.reportRuntime);
  const after = captureRepositoryIdentity();
  if (!after.clean || JSON.stringify(before) !== JSON.stringify(after)) throw new Error("agent decision-read scale evidence requires an unchanged clean source checkout");
  const evidence = frozen({
    argv: frozen([...argv]),
    host,
    observedAt: (runtime.now ?? new Date()).toISOString(),
    report,
    repository: after,
    schema: "attunegraph-agent-decision-read-scale-evidence@1"
  });
  verifyAgentDecisionReadScaleEvidenceAuthority(evidence, { argv, host, repository: after });
  const document = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.outputPath === undefined) process.stdout.write(document);
  else {
    try {
      await writeFile(options.outputPath, document, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (cause) {
      if (cause?.code === "EEXIST") throw new Error("agent decision-read scale output already exists");
      throw cause;
    }
  }
  return evidence;
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) runAgentDecisionReadScaleCommand(process.argv.slice(2)).catch((cause) => { process.stderr.write(`${cause instanceof Error ? cause.message : "agent decision-read scale benchmark failed"}\n`); process.exitCode = 1; });
