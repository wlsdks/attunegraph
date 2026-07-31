import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openAttuneGraph } from "@attunegraph/core";
import { createAttuneGraphStore } from "@attunegraph/core/backend";
import { InMemoryAttuneGraphStoreBackend } from "@attunegraph/core/testing";

import { captureAgentDecisionReadRepositoryIdentity } from "./benchmark-attunegraph-agent-decision-read.mjs";

const WORKLOAD = "agent-decision-read-scale@1";
const NOW = "2026-08-01T12:00:00.000Z";
const OBSERVED_AT = "2026-08-01T11:59:00.000Z";
const RECORDED_AT = "2026-08-01T10:00:00.000Z";
const TIMEOUT_MS = 300_000;
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SUPPORTED_ARGUMENTS = new Set(["output", "repetitions", "warmups", "workload"]);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function frozen(value) {
  return Object.freeze(value);
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

function projectionManifest(command) {
  const serialized = JSON.stringify(command.observation);
  const outputBytes = Buffer.byteLength(serialized, "utf8");
  if (outputBytes > 15_500) throw new Error("scale projection exceeds the fixed 15,500 byte envelope");
  return frozen({
    outputBytes,
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
    canonicalProjection: projectionManifest(command),
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
    kind: "focused-resumption",
    command,
    scope,
    seeds: frozen([third])
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
    canonicalProjection: projectionManifest(command),
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
    kind: "thread-frontier",
    command,
    scope,
    seeds: frozen(active.slice(0, batchSize).map((entry) => entry.subject))
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
      canonicalProjection: cell.canonicalProjection,
      decoyCount: cell.decoyCount,
      expected: cell.expected,
      id: cell.id,
      seedIds: frozen(cell.seeds.map((seed) => `${seed.kind}:${seed.id}`))
    }))),
    schema: "attunegraph-agent-decision-read-scale-workload@1",
    temporalDecoys: frozen(["expired", "future", "post-recorded-cutoff", "superseded"]),
    workload: WORKLOAD
  });
  return frozen({ ...identity, sha256: sha256(JSON.stringify(identity)), cells });
}

function semantic(result) {
  const orderedAssertionIds = frozen(result.workingGraph.assertions.map((entry) => entry.id));
  const value = frozen({
    consideredAssertions: result.workingGraph.diagnostics.consideredAssertions,
    emittedAssertions: orderedAssertionIds.length,
    estimatedTokens: result.workingGraph.diagnostics.estimatedTokens,
    latestHeadCommitId: result.snapshot.commitId,
    maxDepthReached: result.workingGraph.diagnostics.maxDepthReached,
    orderedAssertionIds,
    outputBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
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

async function executeHead(cell, warm) {
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
    const snapshot = await graph.projectAgainstHead(JSON.parse(JSON.stringify(cell.command)));
    const stored = await backend.read(cell.scope);
    if (stored === undefined || Buffer.byteLength(stored.canonicalProjection, "utf8") > 15_500) {
      throw new Error(`scale stored canonical projection is missing or oversized for ${cell.id}`);
    }
    const preparationMilliseconds = performance.now() - preparationStartedAt;
    const afterProjection = memory();
    if (warm) {
      const primeStartedAt = performance.now();
      await graph.execute({ operator: "working-graph@1", seed: cell.seeds[0], now: NOW, maxEstimatedTokens: 32_768 });
      primeMilliseconds = performance.now() - primeStartedAt;
    }
    const afterPrime = memory();
    const startedAt = performance.now();
    const samples = [];
    for (const seed of cell.seeds) {
      const positionStartedAt = performance.now();
      const result = await graph.execute({ operator: "working-graph@1", seed, now: NOW, maxEstimatedTokens: 32_768 });
      const observed = semantic(result);
      assertExpected(cell, observed);
      if (result.snapshot.commitId !== snapshot.commitId || result.snapshot.generation !== 1) {
        throw new Error(`scale head changed while executing ${cell.id}`);
      }
      samples.push(frozen({ milliseconds: performance.now() - positionStartedAt, semantic: observed }));
    }
    completed = frozen({
      batchMilliseconds: performance.now() - startedAt,
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

async function measureCell(cell, repetitions) {
  const rawMilliseconds = [];
  let expectedSemantics;
  let canonicalProjection;
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const cold = await executeHead(cell, false);
    const warm = await executeHead(cell, true);
    if (JSON.stringify(cold.canonicalProjection) !== JSON.stringify(warm.canonicalProjection)) {
      throw new Error(`scale stored canonical projection changed across thermal heads for ${cell.id}`);
    }
    const observed = frozen({
      cold: frozen(cold.samples.map((sample) => sample.semantic)),
      warm: frozen(warm.samples.map((sample) => sample.semantic))
    });
    if (expectedSemantics === undefined) expectedSemantics = observed;
    else if (JSON.stringify(expectedSemantics) !== JSON.stringify(observed)) {
      throw new Error(`scale deterministic anchor diverged for ${cell.id}`);
    }
    if (canonicalProjection === undefined) canonicalProjection = cold.canonicalProjection;
    else if (JSON.stringify(canonicalProjection) !== JSON.stringify(cold.canonicalProjection)) {
      throw new Error(`scale canonical projection anchor diverged for ${cell.id}`);
    }
    rawMilliseconds.push(frozen({
      cold: frozen({ batchMilliseconds: cold.batchMilliseconds, positions: frozen(cold.samples.map((sample) => sample.milliseconds)) }),
      warm: frozen({ batchMilliseconds: warm.batchMilliseconds, positions: frozen(warm.samples.map((sample) => sample.milliseconds)) }),
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
    batchMilliseconds: distribution(rawMilliseconds.map((entry) => entry[temperature].batchMilliseconds), repetitions),
    positions: frozen(cell.seeds.map((_, position) => positionDistribution(temperature, position))),
    preparationMilliseconds: distribution(rawMilliseconds.map((entry) => entry.preparationMilliseconds[temperature]), repetitions),
    primeMilliseconds: temperature === "cold"
      ? null
      : distribution(rawMilliseconds.map((entry) => entry.primeMilliseconds[temperature]), repetitions)
  });
  return frozen({
    batchSize: cell.seeds.length,
    canonicalProjection: canonicalProjection ?? cell.canonicalProjection,
    decoyCount: cell.decoyCount,
    id: cell.id,
    kind: cell.kind,
    repetitions,
    semantic: cell.seeds.length === 1 ? expectedSemantics.cold[0] : frozen({ seedSemantics: expectedSemantics.cold }),
    scope: cell.scope,
    timing: frozen({ cold: timingFor("cold"), rawMilliseconds: frozen(rawMilliseconds), warm: timingFor("warm") })
  });
}

async function authoritySentinel() {
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
    const one = await graph.projectAgainstHead(JSON.parse(JSON.stringify(commandFor("authority-sentinel", scope, root, frozen([sourceAssertion(false), linkage(false), governedBy, scopedTo, ...temporalDecoys("sentinel", root)]), "fresh", 1))));
    const firstResult = await graph.execute({ operator: "working-graph@1", seed: action, now: NOW, maxEstimatedTokens: 32_768 });
    const first = semantic(firstResult);
    const unauthorized = graphRef("action", "action:unauthorized");
    const unauthorizedResult = await graph.execute({ operator: "working-graph@1", seed: unauthorized, now: NOW, maxEstimatedTokens: 32_768 });
    const governedOne = semantic(await graph.execute({ operator: "working-graph@1", seed: governedAction, now: NOW, maxEstimatedTokens: 32_768 }));
    const two = await graph.projectAgainstHead(JSON.parse(JSON.stringify(commandFor("authority-sentinel", scope, root, frozen([sourceAssertion(true), linkage(true), governedBy, scopedTo, ...temporalDecoys("sentinel", root)]), "stale", 2))));
    const second = semantic(await graph.execute({ operator: "working-graph@1", seed: action, now: NOW, maxEstimatedTokens: 32_768 }));
    const governedTwo = semantic(await graph.execute({ operator: "working-graph@1", seed: governedAction, now: NOW, maxEstimatedTokens: 32_768 }));
    if (!first.orderedAssertionIds.includes(authorityId) || second.status !== "abstained" || one.commitId === two.commitId) {
      throw new Error(`authority sentinel contract diverged: ${JSON.stringify({ first: first.status, firstIds: first.orderedAssertionIds, second: second.status, commitsEqual: one.commitId === two.commitId })}`);
    }
    const collidingScope = frozen({ sourceId: "agent-decision-read-scale-colliding", threadId: "scope:authority-sentinel-colliding" });
    const isolated = await openAttuneGraph({ scope: collidingScope, store: createAttuneGraphStore(backend) });
    let isolationStatus;
    try {
      await isolated.projectAgainstHead(JSON.parse(JSON.stringify(commandFor("authority-sentinel-colliding", collidingScope, root, frozen([]), "fresh"))));
      isolationStatus = (await isolated.execute({ operator: "working-graph@1", seed: action, now: NOW, maxEstimatedTokens: 32_768 })).status;
    } finally {
      await isolated.close();
    }
    const observedAuthorization = firstResult.workingGraph.assertions.find((entry) => entry.id === authorityId);
    if (unauthorizedResult.status !== "abstained" || isolationStatus !== "abstained" || observedAuthorization === undefined || JSON.stringify(observedAuthorization.sourceRefs) !== JSON.stringify(sourceRefs)
      || governedTwo.status !== "complete" || governedOne.orderedAssertionIds.includes(authorityId) || governedTwo.orderedAssertionIds.includes(authorityId)) {
      throw new Error("authority sentinel inferred authority or crossed a scope boundary");
    }
    return frozen({
      collidingRefIsolation: frozen({ status: isolationStatus, threadId: collidingScope.threadId }),
      governedAction: frozen({ authority: "not-inferred", generationOneStatus: governedOne.status, generationTwoStatus: governedTwo.status, id: governedAction.id }),
      generationOne: frozen({ authorityObserved: true, commitId: one.commitId, explicitAuthorizationAssertionId: authorityId, generation: one.generation, observedAuthorizationSourceRefs: sourceRefs, status: first.status, unauthorizedActionStatus: unauthorizedResult.status }),
      generationTwo: frozen({ authorityObserved: false, commitId: two.commitId, generation: two.generation, sourceFreshness: second.sourceFreshness, status: second.status })
    });
  } finally {
    await graph.close();
  }
}

function validateOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)
    || options.workload !== WORKLOAD
    || !Number.isSafeInteger(options.warmups) || options.warmups < 0 || options.warmups > 5
    || !Number.isSafeInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 10
    || options.timeoutMs !== TIMEOUT_MS
    || (options.outputPath !== undefined && typeof options.outputPath !== "string")) {
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

export async function generateAgentDecisionReadScaleReport(options) {
  validateOptions(options);
  const workload = createAgentDecisionReadScaleWorkload();
  for (let index = 0; index < options.warmups; index += 1) {
    for (const cell of workload.cells) await measureCell(cell, 1);
  }
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("agent decision-read scale benchmark timed out")), options.timeoutMs);
    timeoutId.unref?.();
  });
  const work = (
    async () => {
      const cells = [];
      for (const cell of workload.cells) cells.push(await measureCell(cell, options.repetitions));
      return frozen({
        authoritySentinel: await authoritySentinel(),
        cells: frozen(cells),
        checkpoints: frozen({ cold: "fresh-head-unprimed", rebuildPerRepetition: true, warm: "separate-fresh-head-one-excluded-prime" }),
        claimEligible: false,
        configuration: frozen({ repetitions: options.repetitions, timeoutMilliseconds: TIMEOUT_MS, warmups: options.warmups, workload: WORKLOAD }),
        measurementOnly: true,
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
    report = await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
  const validated = validateAgentDecisionReadScaleReportSchema(report);
  if (options.outputPath !== undefined) {
    await validateOutputPath(options.outputPath);
    await writeFile(options.outputPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  }
  return validated;
}

export function validateAgentDecisionReadScaleReportSchema(report) {
  const keys = ["authoritySentinel", "cells", "checkpoints", "claimEligible", "configuration", "measurementOnly", "resourceAuthoritative", "resourceQualified", "schema", "workload", "workloadSha256"];
  if (report === null || typeof report !== "object" || JSON.stringify(Object.keys(report).sort()) !== JSON.stringify([...keys].sort())
    || report.schema !== "attunegraph-agent-decision-read-scale-benchmark@1" || report.workload !== WORKLOAD
    || report.measurementOnly !== true || report.claimEligible !== false || report.resourceAuthoritative !== false || report.resourceQualified !== false
    || !Array.isArray(report.cells) || report.cells.length !== 9
    || report.cells.some((cell) => JSON.stringify(Object.keys(cell).sort()) !== JSON.stringify(["batchSize", "canonicalProjection", "decoyCount", "id", "kind", "repetitions", "scope", "semantic", "timing"].sort())
      || cell.canonicalProjection.version !== "canonical-projection@2" || cell.canonicalProjection.outputBytes > 15_500 || cell.canonicalProjection.threadRoot === cell.scope.threadId || cell.timing.cold.batchMilliseconds.p95 !== null || cell.timing.warm.batchMilliseconds.p99 !== null
      || cell.timing.rawMilliseconds.length !== cell.repetitions || cell.repetitions > 10)
    || report.authoritySentinel.generationOne.authorityObserved !== true || report.authoritySentinel.generationTwo.authorityObserved !== false || report.authoritySentinel.generationTwo.status !== "abstained" || report.authoritySentinel.generationOne.commitId === report.authoritySentinel.generationTwo.commitId) {
    throw new Error("agent decision-read scale report is invalid");
  }
  return report;
}

async function validateOutputPath(outputPath) {
  const parent = dirname(outputPath);
  if (await realpath(parent) !== parent || (!relative(PACKAGE_ROOT, outputPath).startsWith("..") && relative(PACKAGE_ROOT, outputPath) !== "")) throw new Error("agent decision-read scale output must be outside the repository under a non-symlink directory");
  try { await lstat(outputPath); throw new Error("agent decision-read scale output already exists"); } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
}

export async function runAgentDecisionReadScaleCommand(argv) {
  const options = parseAgentDecisionReadScaleArguments(argv);
  if (options.outputPath !== undefined) await validateOutputPath(options.outputPath);
  const before = captureAgentDecisionReadRepositoryIdentity();
  if (!before.clean) throw new Error("agent decision-read scale evidence requires a clean source checkout");
  const report = await generateAgentDecisionReadScaleReport({ ...options, outputPath: undefined });
  const after = captureAgentDecisionReadRepositoryIdentity();
  if (!after.clean || JSON.stringify(before) !== JSON.stringify(after)) throw new Error("agent decision-read scale evidence requires an unchanged clean source checkout");
  const document = `${JSON.stringify(frozen({ ...report, repository: after }), null, 2)}\n`;
  if (options.outputPath === undefined) process.stdout.write(document);
  else await writeFile(options.outputPath, document, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return report;
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) runAgentDecisionReadScaleCommand(process.argv.slice(2)).catch((cause) => { process.stderr.write(`${cause instanceof Error ? cause.message : "agent decision-read scale benchmark failed"}\n`); process.exitCode = 1; });
