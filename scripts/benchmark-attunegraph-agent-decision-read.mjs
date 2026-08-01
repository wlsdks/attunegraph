import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { arch, cpus, platform, totalmem } from "node:os";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { openAttuneGraph } from "@attunegraph/core";
import { createInMemoryAttuneGraphStore } from "@attunegraph/core/testing";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";

const WORKLOAD = "agent-decision-read@1";
const NOW = "2026-08-01T12:00:00.000Z";
const OBSERVED_AT = "2026-08-01T11:59:00.000Z";
const RECORDED_AT = "2026-08-01T10:00:00.000Z";
const GENERATION = 8;
const PACKAGE_ROOT = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const SUPPORTED_ARGUMENTS = new Set([
  "output",
  "repetitions",
  "warmups",
  "workload"
]);
const EXPECTED_CASE_SEMANTICS = Object.freeze({
  "deep-cold-complete-1": Object.freeze({
    anchorSha256: "sha256:95831f25a66a7fe2c0f1f15942d2656db97c2a214f778b182b075ada22bc2117",
    consideredAssertions: 2,
    emittedAssertions: 2,
    estimatedTokens: 204,
    latestHeadCommitId: "attunegraph-commit:attunegraph-observation:ca42f591dab167f5505a588210dfaa8ddf66744644b8a4ae537531443772f4fa",
    maxDepthReached: 2,
    outputBytes: 1_442,
    visitedRefs: 3
  }),
  "deep-cold-traversal-partial-4": Object.freeze({
    anchorSha256: "sha256:b271c1f84385f49e2ebbb167f381711ce8c81a880596af8147e775a6ae9e4711",
    consideredAssertions: 2,
    emittedAssertions: 2,
    estimatedTokens: 206,
    latestHeadCommitId: "attunegraph-commit:attunegraph-observation:3807006ace371c716d69202578070c829802d79141edf42b9e9e9885c77678b0",
    maxDepthReached: 2,
    outputBytes: 1_480,
    visitedRefs: 3
  }),
  "deep-cold-valid-time-abstain-32": Object.freeze({
    anchorSha256: "sha256:fb3435136b631c3ee4583b352f319e81f511d56cae702d3dafddf1ba8ed72c74",
    consideredAssertions: 0,
    emittedAssertions: 0,
    estimatedTokens: 15,
    latestHeadCommitId: "attunegraph-commit:attunegraph-observation:66b59efb0911af7e4b621862b9924bcc86da70efeeaeb5a55611d517471e1bb3",
    maxDepthReached: 0,
    outputBytes: 634,
    visitedRefs: 1
  }),
  "wide-hot-complete-1": Object.freeze({
    anchorSha256: "sha256:52fcd01322e77218e772794bbc5caf50d1c61b7f7adce70f4800a5a1e368e8f3",
    consideredAssertions: 32,
    emittedAssertions: 32,
    estimatedTokens: 3_015,
    latestHeadCommitId: "attunegraph-commit:attunegraph-observation:51f7ed899516bf7e021bb3e15f6e73b8b17899e9488149116d5c200ae4816e97",
    maxDepthReached: 2,
    outputBytes: 13_737,
    visitedRefs: 33
  }),
  "wide-hot-complete-32": Object.freeze({
    anchorSha256: "sha256:b1b842cfca395afde617bd6a99a55b317e66232c22504a148f901c8222cb08f5",
    consideredAssertions: 32,
    emittedAssertions: 32,
    estimatedTokens: 3_047,
    latestHeadCommitId: "attunegraph-commit:attunegraph-observation:5b706e56257a539a42c312f82c7433f748ec6c88c9565b9aeb0bcf06907e66fa",
    maxDepthReached: 2,
    outputBytes: 13_900,
    visitedRefs: 33
  }),
  "wide-hot-token-partial-4": Object.freeze({
    anchorSha256: "sha256:f390a3c014b1b48c85e97a33e4ae28c92ad3f1f3982d06890888d8e48d2ce9da",
    consideredAssertions: 32,
    emittedAssertions: 2,
    estimatedTokens: 202,
    latestHeadCommitId: "attunegraph-commit:attunegraph-observation:4dbbc90c9b4c28d37563f6afc87f7b2d1bdb8cd3729337c3be2291815ddd4e8d",
    maxDepthReached: 2,
    outputBytes: 1_453,
    visitedRefs: 3
  })
});

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function caseKey(name) {
  return ({
    "deep-cold-complete-1": "d1",
    "deep-cold-traversal-partial-4": "d4",
    "deep-cold-valid-time-abstain-32": "d32",
    "wide-hot-complete-1": "w1",
    "wide-hot-complete-32": "w32",
    "wide-hot-token-partial-4": "w4"
  })[name];
}

function threadRootFor(name) {
  return Object.freeze({ kind: "thread", id: `t:${caseKey(name)}` });
}

function graphAssertion(name, index, subject, object, overrides = {}) {
  const key = caseKey(name);
  return Object.freeze({
    schemaVersion: 1,
    id: `${key}:a:${index.toString().padStart(2, "0")}`,
    subject: Object.freeze({ ...subject }),
    predicate: overrides.predicate ?? "LINKED_TO",
    object: Object.freeze({ ...object }),
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([Object.freeze({
      id: `${key}:s:${index.toString().padStart(2, "0")}`,
      namespace: "attunegraph.benchmark.agent-decision-read"
    })]),
    recordedAt: overrides.recordedAt ?? RECORDED_AT,
    ...(overrides.validFrom === undefined ? {} : { validFrom: overrides.validFrom }),
    ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo }),
    ...(overrides.supersededAt === undefined
      ? {}
      : { supersededAt: overrides.supersededAt }),
    derivation: Object.freeze({
      kind: "projection",
      version: "agent-decision-read@1"
    })
  });
}

function wideAssertions(name, threadRoot) {
  const key = caseKey(name);
  return Object.freeze(Array.from({ length: 32 }, (_, index) => graphAssertion(
    name,
    index,
    { kind: "artifact", id: `${key}:n:${index.toString().padStart(2, "0")}` },
    threadRoot
  )));
}

function deepAssertions(name, threadRoot, seedCount, depth) {
  const key = caseKey(name);
  const assertions = [];
  const seeds = [];
  for (let seedIndex = 0; seedIndex < seedCount; seedIndex += 1) {
    let previous = threadRoot;
    for (let edgeIndex = 0; edgeIndex < depth; edgeIndex += 1) {
      const next = Object.freeze({
        kind: "artifact",
        id: `${key}:${seedIndex.toString().padStart(2, "0")}:${edgeIndex.toString()}`
      });
      assertions.push(graphAssertion(
        name,
        seedIndex * depth + edgeIndex,
        next,
        previous,
        { predicate: edgeIndex === 0 ? "LINKED_TO" : "REVISION_OF" }
      ));
      previous = next;
    }
    seeds.push(previous);
  }
  return Object.freeze({
    assertions: Object.freeze(assertions),
    seeds: Object.freeze(seeds)
  });
}

function inactiveAssertions(name, threadRoot) {
  const key = caseKey(name);
  const seeds = [];
  const assertions = Array.from({ length: 32 }, (_, index) => {
    const seed = Object.freeze({
      kind: "artifact",
      id: `${key}:x:${index.toString().padStart(2, "0")}`
    });
    seeds.push(seed);
    const mode = index % 4;
    return graphAssertion(name, index, seed, threadRoot, mode === 0
      ? { validTo: "2026-08-01T11:00:00.000Z" }
      : mode === 1
        ? { validFrom: "2026-08-01T13:00:00.000Z" }
        : mode === 2
          ? { recordedAt: "2026-08-01T13:00:00.000Z" }
          : { supersededAt: "2026-08-01T11:00:00.000Z" });
  });
  return Object.freeze({
    assertions: Object.freeze(assertions),
    seeds: Object.freeze(seeds)
  });
}

function workloadCase({
  assertions,
  expectedStatus,
  maxEstimatedTokens,
  name,
  scenario,
  seeds,
  sourceFreshness
}) {
  const scope = Object.freeze({
    sourceId: "agent-decision-read-benchmark",
    threadId: name
  });
  const threadRoot = threadRootFor(name);
  const command = Object.freeze({
    operator: "canonical-projection@2",
    observation: Object.freeze({
      schemaVersion: 2,
      observationKey: `${name}:generation:${GENERATION.toString()}`,
      scope,
      threadRoot,
      observedAt: OBSERVED_AT,
      sourceFreshness: Object.freeze({
        state: sourceFreshness,
        observedAt: OBSERVED_AT
      }),
      assertions
    })
  });
  return Object.freeze({
    command,
    expected: Object.freeze({
      sourceFreshness,
      status: expectedStatus
    }),
    maxEstimatedTokens,
    name,
    scenario,
    scope,
    seeds,
    threadRoot
  });
}

export function createAgentDecisionReadWorkload() {
  const cases = [];
  for (const [name, seedCount, expectedStatus, maxEstimatedTokens] of [
    ["wide-hot-complete-1", 1, "complete", 32_768],
    ["wide-hot-token-partial-4", 4, "partial", 256],
    ["wide-hot-complete-32", 32, "complete", 32_768]
  ]) {
    const threadRoot = threadRootFor(name);
    const assertions = wideAssertions(name, threadRoot);
    cases.push(workloadCase({
      assertions,
      expectedStatus,
      maxEstimatedTokens,
      name,
      scenario: "wide-hot",
      seeds: Object.freeze(assertions.slice(0, seedCount).map((entry) => entry.subject)),
      sourceFreshness: "fresh"
    }));
  }

  const completeName = "deep-cold-complete-1";
  const completeRoot = threadRootFor(completeName);
  const complete = deepAssertions(completeName, completeRoot, 1, 2);
  cases.push(workloadCase({
    assertions: complete.assertions,
    expectedStatus: "complete",
    maxEstimatedTokens: 32_768,
    name: completeName,
    scenario: "deep-cold-bitemporal",
    seeds: complete.seeds,
    sourceFreshness: "fresh"
  }));

  const partialName = "deep-cold-traversal-partial-4";
  const partialRoot = threadRootFor(partialName);
  const partial = deepAssertions(partialName, partialRoot, 4, 6);
  cases.push(workloadCase({
    assertions: partial.assertions,
    expectedStatus: "partial",
    maxEstimatedTokens: 32_768,
    name: partialName,
    scenario: "deep-cold-bitemporal",
    seeds: partial.seeds,
    sourceFreshness: "stale"
  }));

  const abstainName = "deep-cold-valid-time-abstain-32";
  const abstainRoot = threadRootFor(abstainName);
  const abstain = inactiveAssertions(abstainName, abstainRoot);
  cases.push(workloadCase({
    assertions: abstain.assertions,
    expectedStatus: "abstained",
    maxEstimatedTokens: 32_768,
    name: abstainName,
    scenario: "deep-cold-bitemporal",
    seeds: abstain.seeds,
    sourceFreshness: "stale"
  }));

  const uniqueAssertionsAtHead = cases.reduce(
    (sum, entry) => sum + entry.command.observation.assertions.length,
    0
  );
  const identity = Object.freeze({
    cases: Object.freeze(cases),
    generation: GENERATION,
    now: NOW,
    projectedAssertionInputs: uniqueAssertionsAtHead * GENERATION,
    schema: "attunegraph-agent-decision-read-workload@1",
    uniqueAssertionsAtHead
  });
  return Object.freeze({
    ...identity,
    sha256: sha256(JSON.stringify(identity))
  });
}

function generationCommand(entry, generation) {
  const finalObservation = JSON.parse(JSON.stringify(entry.command.observation));
  const observedAt = generation === GENERATION
    ? finalObservation.observedAt
    : `2026-08-01T11:${generation.toString().padStart(2, "0")}:00.000Z`;
  return {
    operator: "canonical-projection@2",
    observation: {
      ...finalObservation,
      observationKey: `${entry.name}:generation:${generation.toString()}`,
      observedAt,
      sourceFreshness: {
        ...finalObservation.sourceFreshness,
        observedAt
      }
    }
  };
}

function semanticAnchor(result) {
  return Object.freeze({
    assertionIds: Object.freeze(result.workingGraph.assertions.map((entry) => entry.id)),
    consideredAssertions: result.workingGraph.diagnostics.consideredAssertions,
    estimatedTokens: result.workingGraph.diagnostics.estimatedTokens,
    maxDepthReached: result.workingGraph.diagnostics.maxDepthReached,
    refs: Object.freeze(result.workingGraph.refs.map((entry) => `${entry.kind}:${entry.id}`)),
    snapshotGeneration: result.snapshot.generation,
    sourceFreshness: result.sourceFreshness.state,
    status: result.status,
    truncationReasons: Object.freeze([
      ...result.workingGraph.diagnostics.truncationReasons
    ]),
    visitedRefs: result.workingGraph.diagnostics.visitedRefs
  });
}

async function runWorkloadCase(entry) {
  const graph = await openAttuneGraph({
    scope: entry.scope,
    store: createInMemoryAttuneGraphStore()
  });
  let snapshot;
  const preparationStartedAt = performance.now();
  try {
    for (let generation = 1; generation <= GENERATION; generation += 1) {
      snapshot = await graph.projectAgainstHead(generationCommand(entry, generation));
    }
    const preparationMilliseconds = performance.now() - preparationStartedAt;
    if (snapshot?.generation !== GENERATION) {
      throw new Error(`decision-read case ${entry.name} did not reach generation ${GENERATION.toString()}`);
    }
    const samples = [];
    const batchWallStartedAt = performance.now();
    for (let seedIndex = 0; seedIndex < entry.seeds.length; seedIndex += 1) {
      const startedAt = performance.now();
      const result = await graph.execute({
        operator: "working-graph@1",
        seed: entry.seeds[seedIndex],
        now: NOW,
        maxEstimatedTokens: entry.maxEstimatedTokens
      });
      const executeMilliseconds = performance.now() - startedAt;
      if (
        result.status !== entry.expected.status
        || result.sourceFreshness.state !== entry.expected.sourceFreshness
        || result.snapshot.generation !== GENERATION
        || result.snapshot.commitId !== snapshot.commitId
      ) {
        throw new Error(
          `decision-read correctness anchor diverged for ${entry.name}: ${JSON.stringify({
            actual: {
              commitId: result.snapshot.commitId,
              generation: result.snapshot.generation,
              sourceFreshness: result.sourceFreshness.state,
              status: result.status
            },
            expected: {
              commitId: snapshot.commitId,
              generation: GENERATION,
              sourceFreshness: entry.expected.sourceFreshness,
              status: entry.expected.status
            }
          })}`
        );
      }
      const anchor = semanticAnchor(result);
      samples.push(Object.freeze({
        anchorSha256: sha256(JSON.stringify(anchor)),
        consideredAssertions: anchor.consideredAssertions,
        emittedAssertions: anchor.assertionIds.length,
        estimatedTokens: anchor.estimatedTokens,
        executeMilliseconds,
        maxDepthReached: anchor.maxDepthReached,
        outputBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
        seedIndex,
        sourceFreshness: anchor.sourceFreshness,
        status: anchor.status,
        truncationReasons: anchor.truncationReasons,
        visitedRefs: anchor.visitedRefs
      }));
    }
    const batchWallMilliseconds = performance.now() - batchWallStartedAt;
    const batchExecuteMilliseconds = samples.reduce(
      (sum, sample) => sum + sample.executeMilliseconds,
      0
    );
    const anchorSha256 = sha256(JSON.stringify(
      samples.map((sample) => sample.anchorSha256)
    ));
    const expectedSemantics = EXPECTED_CASE_SEMANTICS[entry.name];
    if (
      expectedSemantics === undefined
      || anchorSha256 !== expectedSemantics.anchorSha256
      || snapshot.commitId !== expectedSemantics.latestHeadCommitId
      || samples.some((sample) => [
        "consideredAssertions",
        "emittedAssertions",
        "estimatedTokens",
        "maxDepthReached",
        "outputBytes",
        "visitedRefs"
      ].some((key) => sample[key] !== expectedSemantics[key]))
    ) {
      throw new Error(
        `decision-read semantic contract diverged for ${entry.name}; bump the workload version`
      );
    }
    return Object.freeze({
      anchorSha256,
      batchExecuteMilliseconds,
      batchWallMilliseconds,
      commitId: snapshot.commitId,
      generation: snapshot.generation,
      name: entry.name,
      preparationMilliseconds,
      samples: Object.freeze(samples)
    });
  } finally {
    await graph.close();
  }
}

export async function runAgentDecisionReadWorkload(workload) {
  const expected = createAgentDecisionReadWorkload();
  if (JSON.stringify(workload) !== JSON.stringify(expected)) {
    throw new Error("agent decision-read workload configuration is invalid");
  }
  const cases = [];
  for (const entry of workload.cases) {
    cases.push(await runWorkloadCase(entry));
  }
  return Object.freeze({
    cases: Object.freeze(cases),
    workloadSha256: workload.sha256
  });
}

function summarizeDistribution(samples, independentRuns) {
  if (
    !Array.isArray(samples)
    || samples.length === 0
    || samples.some((sample) =>
      typeof sample !== "number" || !Number.isFinite(sample) || sample < 0
    )
  ) {
    throw new Error("agent decision-read samples must be finite non-negative numbers");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const nearestRank = (percentile) =>
    sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
  return Object.freeze({
    max: sorted.at(-1),
    min: sorted[0],
    p50: nearestRank(0.5),
    p95: independentRuns >= 20 ? nearestRank(0.95) : null,
    p99: independentRuns >= 100 ? nearestRank(0.99) : null,
    sampleCount: samples.length,
    samples: Object.freeze([...samples])
  });
}

export function captureAgentDecisionReadRepositoryIdentity() {
  const git = (...args) => execFileSync("git", ["-C", PACKAGE_ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const repositoryRoot = realpathSync(git("rev-parse", "--show-toplevel"));
  if (repositoryRoot !== PACKAGE_ROOT) {
    throw new Error("agent decision-read script must be inside the package repository root");
  }
  return Object.freeze({
    clean: git("status", "--porcelain=v1", "--untracked-files=all") === "",
    commit: git("rev-parse", "HEAD"),
    lockfileSha256: sha256(
      readFileSync(resolve(PACKAGE_ROOT, "pnpm-lock.yaml"))
    ),
    tree: git("rev-parse", "HEAD^{tree}")
  });
}

function hostIdentity() {
  const processors = cpus();
  return Object.freeze({
    arch: arch(),
    cpuCount: processors.length,
    cpuModel: processors[0]?.model ?? "unknown",
    node: process.versions.node,
    os: platform(),
    pnpm: pnpmVersion(),
    totalMemoryBytes: totalmem()
  });
}

export function captureAgentDecisionReadHostIdentity() {
  return hostIdentity();
}

function pnpmVersion(userAgent = process.env.npm_config_user_agent) {
  const userAgentVersion = /(?:^|\s)pnpm\/([^\s]+)/u.exec(userAgent ?? "")?.[1];
  if (userAgentVersion !== undefined) return userAgentVersion;
  const command = platform() === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm --version"]]
    : ["pnpm", ["--version"]];
  return execFileSync(command[0], command[1], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function validateBenchmarkOptions(options) {
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || JSON.stringify(Object.keys(options).sort())
      !== JSON.stringify(["outputPath", "repetitions", "warmups", "workload"])
    || options.workload !== WORKLOAD
    || !Number.isSafeInteger(options.warmups)
    || options.warmups < 0
    || options.warmups > 5
    || !Number.isSafeInteger(options.repetitions)
    || options.repetitions < 1
    || options.repetitions > 10
    || (options.outputPath !== undefined && typeof options.outputPath !== "string")
  ) {
    throw new Error("agent decision-read benchmark options are invalid");
  }
}

function reportWorkload(workload) {
  return Object.freeze({
    cases: Object.freeze(workload.cases.map((entry) => Object.freeze({
      assertionCount: entry.command.observation.assertions.length,
      expected: entry.expected,
      maxEstimatedTokens: entry.maxEstimatedTokens,
      name: entry.name,
      scenario: entry.scenario,
      seedCount: entry.seeds.length
    }))),
    generation: workload.generation,
    now: workload.now,
    projectedAssertionInputs: workload.projectedAssertionInputs,
    schema: workload.schema,
    sha256: workload.sha256,
    uniqueAssertionsAtHead: workload.uniqueAssertionsAtHead
  });
}

function reportCorrectness(workload, runs) {
  const cases = workload.cases.map((entry, caseIndex) => {
    const observed = runs.map((run) => run.cases[caseIndex]);
    const first = observed[0];
    const expectedSemantics = EXPECTED_CASE_SEMANTICS[entry.name];
    const anchorsMatch = observed.every((item) =>
      item.anchorSha256 === first.anchorSha256
      && item.commitId === first.commitId
      && item.generation === GENERATION
    )
      && first.anchorSha256 === expectedSemantics.anchorSha256
      && first.commitId === expectedSemantics.latestHeadCommitId;
    return Object.freeze({
      anchorSha256: first.anchorSha256,
      anchorsMatch,
      executions: observed.reduce((sum, item) => sum + item.samples.length, 0),
      expectedSourceFreshness: entry.expected.sourceFreshness,
      expectedStatus: entry.expected.status,
      generation: first.generation,
      latestHeadCommitId: first.commitId,
      name: entry.name,
      observedSourceFreshness: Object.freeze([
        ...new Set(observed.flatMap((item) =>
          item.samples.map((sample) => sample.sourceFreshness)
        ))
      ]),
      observedStatuses: Object.freeze([
        ...new Set(observed.flatMap((item) => item.samples.map((sample) => sample.status)))
      ]),
      observedTruncationReasons: Object.freeze([
        ...new Set(observed.flatMap((item) =>
          item.samples.flatMap((sample) => sample.truncationReasons)
        ))
      ])
    });
  });
  return Object.freeze({
    allAnchorsMatched: cases.every((entry) => entry.anchorsMatch),
    cases: Object.freeze(cases)
  });
}

function reportMetrics(workload, runs, independentRuns) {
  return Object.freeze({
    cases: Object.freeze(workload.cases.map((entry, caseIndex) => {
      const observed = runs.map((run) => run.cases[caseIndex]);
      const samples = observed.flatMap((item) => item.samples);
      return Object.freeze({
        batchExecuteMilliseconds: summarizeDistribution(
          observed.map((item) => item.batchExecuteMilliseconds),
          independentRuns
        ),
        batchWallMilliseconds: summarizeDistribution(
          observed.map((item) => item.batchWallMilliseconds),
          independentRuns
        ),
        consideredAssertions: summarizeDistribution(
          samples.map((sample) => sample.consideredAssertions),
          independentRuns
        ),
        emittedAssertions: summarizeDistribution(
          samples.map((sample) => sample.emittedAssertions),
          independentRuns
        ),
        estimatedTokens: summarizeDistribution(
          samples.map((sample) => sample.estimatedTokens),
          independentRuns
        ),
        executeMilliseconds: summarizeDistribution(
          samples.map((sample) => sample.executeMilliseconds),
          independentRuns
        ),
        name: entry.name,
        maxDepthReached: summarizeDistribution(
          samples.map((sample) => sample.maxDepthReached),
          independentRuns
        ),
        outputBytes: summarizeDistribution(
          samples.map((sample) => sample.outputBytes),
          independentRuns
        ),
        preparationMilliseconds: summarizeDistribution(
          observed.map((item) => item.preparationMilliseconds),
          independentRuns
        ),
        visitedRefs: summarizeDistribution(
          samples.map((sample) => sample.visitedRefs),
          independentRuns
        )
      });
    }))
  });
}

export async function runAgentDecisionReadBenchmark(options, runtime = {}) {
  validateBenchmarkOptions(options);
  const workload = createAgentDecisionReadWorkload();
  const runWorkload = runtime.runWorkload ?? runAgentDecisionReadWorkload;
  for (let index = 0; index < options.warmups; index += 1) {
    await runWorkload(workload);
  }
  const runs = [];
  for (let index = 0; index < options.repetitions; index += 1) {
    runs.push(await runWorkload(workload));
  }
  const correctness = reportCorrectness(workload, runs);
  if (!correctness.allAnchorsMatched) {
    throw new Error("agent decision-read correctness anchors diverged across repetitions");
  }
  const report = Object.freeze({
    claimEligible: false,
    configuration: Object.freeze({
      argv: Object.freeze([...(runtime.argv ?? [])]),
      decisionSemantics: "independent-single-seed-execute-batch",
      monotonicClock: "performance.now",
      profile: "in-memory-semantic-reference",
      repetitions: options.repetitions,
      tailEligibility: Object.freeze({
        basis: "independent-fresh-store-repetitions",
        p95MinimumIndependentRuns: 20,
        p99MinimumIndependentRuns: 100
      }),
      warmups: options.warmups,
      workload: options.workload
    }),
    correctness,
    host: runtime.host ?? hostIdentity(),
    measurementOnly: true,
    metrics: reportMetrics(workload, runs, options.repetitions),
    observedAt: (runtime.now ?? new Date()).toISOString(),
    repository: runtime.repository ?? captureAgentDecisionReadRepositoryIdentity(),
    schema: "attunegraph-agent-decision-read-benchmark@1",
    workload: reportWorkload(workload)
  });
  return validateAgentDecisionReadReportSchema(report);
}

function invalidReport(label) {
  throw new Error(`agent decision-read report ${label} is invalid`);
}

function exactRecord(value, label, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidReport(label);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    invalidReport(label);
  }
  return value;
}

function exactString(value, label) {
  if (typeof value !== "string" || value.length === 0) invalidReport(label);
  return value;
}

function exactInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) invalidReport(label);
  return value;
}

function exactStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    invalidReport(label);
  }
  return value;
}

function validateDistribution(value, label, independentRuns) {
  const distribution = exactRecord(value, label, [
    "max",
    "min",
    "p50",
    "p95",
    "p99",
    "sampleCount",
    "samples"
  ]);
  if (!Array.isArray(distribution.samples)) invalidReport(`${label}.samples`);
  const expected = summarizeDistribution(distribution.samples, independentRuns);
  if (JSON.stringify(distribution) !== JSON.stringify(expected)) {
    if (independentRuns < 20 && distribution.p95 !== null) {
      invalidReport(`${label}.p95`);
    }
    if (independentRuns < 100 && distribution.p99 !== null) {
      invalidReport(`${label}.p99`);
    }
    invalidReport(label);
  }
  return distribution;
}

export function validateAgentDecisionReadReportSchema(value) {
  const report = exactRecord(value, "root", [
    "claimEligible",
    "configuration",
    "correctness",
    "host",
    "measurementOnly",
    "metrics",
    "observedAt",
    "repository",
    "schema",
    "workload"
  ]);
  if (
    report.schema !== "attunegraph-agent-decision-read-benchmark@1"
    || report.measurementOnly !== true
    || report.claimEligible !== false
  ) {
    invalidReport("claim boundary");
  }

  const configuration = exactRecord(report.configuration, "configuration", [
    "argv",
    "decisionSemantics",
    "monotonicClock",
    "profile",
    "repetitions",
    "tailEligibility",
    "warmups",
    "workload"
  ]);
  const configurationArgv = exactStringArray(
    configuration.argv,
    "configuration.argv"
  );
  if (
    configuration.decisionSemantics !== "independent-single-seed-execute-batch"
    || configuration.monotonicClock !== "performance.now"
    || configuration.profile !== "in-memory-semantic-reference"
    || configuration.workload !== WORKLOAD
  ) {
    invalidReport("configuration");
  }
  exactInteger(configuration.repetitions, "configuration.repetitions", 1);
  exactInteger(configuration.warmups, "configuration.warmups");
  if (configuration.repetitions > 10 || configuration.warmups > 5) {
    invalidReport("configuration bounds");
  }
  if (configurationArgv.length > 0) {
    let parsedArguments;
    try {
      parsedArguments = parseAgentDecisionReadArguments(configurationArgv);
    } catch {
      invalidReport("configuration.argv");
    }
    if (
      parsedArguments.workload !== configuration.workload
      || parsedArguments.warmups !== configuration.warmups
      || parsedArguments.repetitions !== configuration.repetitions
    ) {
      invalidReport("configuration.argv");
    }
  }
  const tailEligibility = exactRecord(
    configuration.tailEligibility,
    "configuration.tailEligibility",
    ["basis", "p95MinimumIndependentRuns", "p99MinimumIndependentRuns"]
  );
  if (
    tailEligibility.basis !== "independent-fresh-store-repetitions"
    || tailEligibility.p95MinimumIndependentRuns !== 20
    || tailEligibility.p99MinimumIndependentRuns !== 100
  ) {
    invalidReport("configuration.tailEligibility");
  }

  const repository = exactRecord(report.repository, "repository", [
    "clean",
    "commit",
    "lockfileSha256",
    "tree"
  ]);
  if (
    typeof repository.clean !== "boolean"
    || !/^[a-f0-9]{40}$/u.test(repository.commit)
    || !/^[a-f0-9]{40}$/u.test(repository.tree)
    || !/^sha256:[a-f0-9]{64}$/u.test(repository.lockfileSha256)
  ) {
    invalidReport("repository");
  }

  const host = exactRecord(report.host, "host", [
    "arch",
    "cpuCount",
    "cpuModel",
    "node",
    "os",
    "pnpm",
    "totalMemoryBytes"
  ]);
  for (const key of ["arch", "cpuModel", "node", "os", "pnpm"]) {
    exactString(host[key], `host.${key}`);
  }
  exactInteger(host.cpuCount, "host.cpuCount", 1);
  exactInteger(host.totalMemoryBytes, "host.totalMemoryBytes", 1);

  const expectedWorkload = reportWorkload(createAgentDecisionReadWorkload());
  const workload = exactRecord(report.workload, "workload", [
    "cases",
    "generation",
    "now",
    "projectedAssertionInputs",
    "schema",
    "sha256",
    "uniqueAssertionsAtHead"
  ]);
  if (JSON.stringify(workload) !== JSON.stringify(expectedWorkload)) {
    invalidReport("workload");
  }

  const correctness = exactRecord(report.correctness, "correctness", [
    "allAnchorsMatched",
    "cases"
  ]);
  if (correctness.allAnchorsMatched !== true || !Array.isArray(correctness.cases)) {
    invalidReport("correctness");
  }
  if (correctness.cases.length !== workload.cases.length) {
    invalidReport("correctness.cases");
  }
  for (let index = 0; index < correctness.cases.length; index += 1) {
    const entry = exactRecord(correctness.cases[index], `correctness.cases[${index}]`, [
      "anchorSha256",
      "anchorsMatch",
      "executions",
      "expectedSourceFreshness",
      "expectedStatus",
      "generation",
      "latestHeadCommitId",
      "name",
      "observedSourceFreshness",
      "observedStatuses",
      "observedTruncationReasons"
    ]);
    const workloadCase = workload.cases[index];
    const expectedSemantics = EXPECTED_CASE_SEMANTICS[entry.name];
    if (
      entry.name !== workloadCase.name
      || entry.expectedSourceFreshness !== workloadCase.expected.sourceFreshness
      || entry.expectedStatus !== workloadCase.expected.status
      || entry.generation !== workload.generation
      || entry.anchorsMatch !== true
      || entry.executions !== workloadCase.seedCount * configuration.repetitions
      || expectedSemantics === undefined
      || entry.anchorSha256 !== expectedSemantics.anchorSha256
      || entry.latestHeadCommitId !== expectedSemantics.latestHeadCommitId
      || JSON.stringify(exactStringArray(
        entry.observedSourceFreshness,
        `correctness.cases[${index}].observedSourceFreshness`
      )) !== JSON.stringify([workloadCase.expected.sourceFreshness])
      || JSON.stringify(exactStringArray(
        entry.observedStatuses,
        `correctness.cases[${index}].observedStatuses`
      )) !== JSON.stringify([workloadCase.expected.status])
    ) {
      invalidReport(`correctness.cases[${index}]`);
    }
    const truncationReasons = exactStringArray(
      entry.observedTruncationReasons,
      `correctness.cases[${index}].observedTruncationReasons`
    );
    const expectedReasons = workloadCase.expected.status === "partial"
      ? [workloadCase.name.includes("token") ? "token-budget" : "traversal-budget"]
      : [];
    if (JSON.stringify(truncationReasons) !== JSON.stringify(expectedReasons)) {
      invalidReport(`correctness.cases[${index}].observedTruncationReasons`);
    }
  }

  const metrics = exactRecord(report.metrics, "metrics", ["cases"]);
  if (!Array.isArray(metrics.cases) || metrics.cases.length !== workload.cases.length) {
    invalidReport("metrics.cases");
  }
  for (let index = 0; index < metrics.cases.length; index += 1) {
    const entry = exactRecord(metrics.cases[index], `metrics.cases[${index}]`, [
      "batchExecuteMilliseconds",
      "batchWallMilliseconds",
      "consideredAssertions",
      "emittedAssertions",
      "estimatedTokens",
      "executeMilliseconds",
      "maxDepthReached",
      "name",
      "outputBytes",
      "preparationMilliseconds",
      "visitedRefs"
    ]);
    if (entry.name !== workload.cases[index].name) {
      invalidReport(`metrics.cases[${index}].name`);
    }
    for (const key of [
      "batchExecuteMilliseconds",
      "batchWallMilliseconds",
      "consideredAssertions",
      "emittedAssertions",
      "estimatedTokens",
      "executeMilliseconds",
      "maxDepthReached",
      "outputBytes",
      "preparationMilliseconds",
      "visitedRefs"
    ]) {
      validateDistribution(
        entry[key],
        `metrics.cases[${index}].${key}`,
        configuration.repetitions
      );
    }
    const expectedSeedSamples = workload.cases[index].seedCount
      * configuration.repetitions;
    if (
      entry.batchExecuteMilliseconds.sampleCount !== configuration.repetitions
      || entry.batchWallMilliseconds.sampleCount !== configuration.repetitions
      || entry.preparationMilliseconds.sampleCount !== configuration.repetitions
      || [
        "consideredAssertions",
        "emittedAssertions",
        "estimatedTokens",
        "executeMilliseconds",
        "maxDepthReached",
        "outputBytes",
        "visitedRefs"
      ].some((key) => entry[key].sampleCount !== expectedSeedSamples)
    ) {
      invalidReport(`metrics.cases[${index}].sampleCount`);
    }
    const expectedSemantics = EXPECTED_CASE_SEMANTICS[entry.name];
    for (const key of [
      "consideredAssertions",
      "emittedAssertions",
      "estimatedTokens",
      "maxDepthReached",
      "outputBytes",
      "visitedRefs"
    ]) {
      if (entry[key].samples.some((sample) => sample !== expectedSemantics[key])) {
        invalidReport(`metrics.cases[${index}].${key}`);
      }
    }
    const expectedBatchExecute = Array.from(
      { length: configuration.repetitions },
      (_, repetition) => entry.executeMilliseconds.samples
        .slice(
          repetition * workload.cases[index].seedCount,
          (repetition + 1) * workload.cases[index].seedCount
        )
        .reduce((sum, sample) => sum + sample, 0)
    );
    if (
      JSON.stringify(entry.batchExecuteMilliseconds.samples)
        !== JSON.stringify(expectedBatchExecute)
    ) {
      invalidReport(`metrics.cases[${index}].batchExecuteMilliseconds`);
    }
    if (entry.batchWallMilliseconds.samples.some(
      (sample, repetition) => sample < expectedBatchExecute[repetition]
    )) {
      invalidReport(`metrics.cases[${index}].batchWallMilliseconds`);
    }
  }

  if (
    typeof report.observedAt !== "string"
    || new Date(report.observedAt).toISOString() !== report.observedAt
  ) {
    invalidReport("observedAt");
  }
  return value;
}

export function verifyAgentDecisionReadReportAuthority(value, expected) {
  const report = validateAgentDecisionReadReportSchema(value);
  const authority = exactRecord(expected, "authority", [
    "configuration",
    "host",
    "repository"
  ]);
  const configuration = exactRecord(authority.configuration, "authority.configuration", [
    "argv",
    "repetitions",
    "warmups",
    "workload"
  ]);
  exactStringArray(configuration.argv, "authority.configuration.argv");
  const host = exactRecord(authority.host, "authority.host", [
    "arch",
    "cpuCount",
    "cpuModel",
    "node",
    "os",
    "pnpm",
    "totalMemoryBytes"
  ]);
  const repository = exactRecord(authority.repository, "authority.repository", [
    "clean",
    "commit",
    "lockfileSha256",
    "tree"
  ]);
  if (JSON.stringify(report.repository) !== JSON.stringify(repository)) {
    invalidReport("repository authority");
  }
  if (JSON.stringify(report.host) !== JSON.stringify(host)) {
    invalidReport("host authority");
  }
  if (
    JSON.stringify({
      argv: report.configuration.argv,
      repetitions: report.configuration.repetitions,
      warmups: report.configuration.warmups,
      workload: report.configuration.workload
    }) !== JSON.stringify(configuration)
  ) {
    invalidReport("configuration authority");
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be between ${minimum.toString()} and ${maximum.toString()}`
    );
  }
  return parsed;
}

export function parseAgentDecisionReadArguments(args) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const values = new Map();
  for (const argument of normalizedArgs) {
    const match = /^--([a-z]+)=(.*)$/u.exec(argument);
    if (!match || !SUPPORTED_ARGUMENTS.has(match[1])) {
      throw new Error(`unsupported agent decision-read argument: ${argument}`);
    }
    if (values.has(match[1])) {
      throw new Error(`duplicate agent decision-read argument: --${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  const workload = values.get("workload");
  if (workload !== WORKLOAD) {
    throw new Error(`workload must be ${WORKLOAD}`);
  }
  const outputPath = values.get("output");
  if (
    outputPath === ""
    || (outputPath !== undefined
      && (!isAbsolute(outputPath) || normalize(outputPath) !== outputPath))
  ) {
    throw new Error("output must be an absolute normalized path when supplied");
  }
  return Object.freeze({
    outputPath,
    repetitions: boundedInteger(
      values.get("repetitions") ?? "3",
      "repetitions",
      1,
      10
    ),
    warmups: boundedInteger(values.get("warmups") ?? "1", "warmups", 0, 5),
    workload
  });
}

async function validateOutputPath(outputPath) {
  const parent = dirname(outputPath);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) {
    throw new Error("agent decision-read output parent must not traverse a symlink");
  }
  const fromRepository = relative(PACKAGE_ROOT, outputPath);
  if (
    fromRepository === ""
    || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))
  ) {
    throw new Error("agent decision-read output must be outside the repository");
  }
  try {
    await lstat(outputPath);
    throw new Error("agent decision-read output already exists");
  } catch (cause) {
    if (
      cause instanceof Error
      && cause.message === "agent decision-read output already exists"
    ) {
      throw cause;
    }
    if (!cause || typeof cause !== "object" || cause.code !== "ENOENT") {
      throw cause;
    }
  }
}

export async function runAgentDecisionReadCommand(argv, runtime = {}) {
  const options = parseAgentDecisionReadArguments(argv);
  if (options.outputPath !== undefined) {
    await validateOutputPath(options.outputPath);
  }
  const captureRepositoryIdentity = runtime.captureRepositoryIdentity
    ?? captureAgentDecisionReadRepositoryIdentity;
  const repository = captureRepositoryIdentity();
  if (repository.clean !== true) {
    throw new Error("agent decision-read evidence requires a clean source checkout");
  }
  const host = runtime.host ?? hostIdentity();
  const report = await runAgentDecisionReadBenchmark(options, {
    argv,
    host,
    repository,
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
    ...(runtime.runWorkload === undefined ? {} : { runWorkload: runtime.runWorkload })
  });
  const endRepository = captureRepositoryIdentity();
  if (endRepository.clean !== true) {
    throw new Error("agent decision-read evidence requires a clean source checkout");
  }
  verifyAgentDecisionReadReportAuthority(report, {
    configuration: {
      argv,
      repetitions: options.repetitions,
      warmups: options.warmups,
      workload: options.workload
    },
    host,
    repository: endRepository
  });
  const document = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath === undefined) {
    process.stdout.write(document);
    return report;
  }
  try {
    await writeFile(options.outputPath, document, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  } catch (cause) {
    if (cause && typeof cause === "object" && cause.code === "EEXIST") {
      throw new Error("agent decision-read output already exists");
    }
    throw cause;
  }
  return report;
}

async function main() {
  await runAgentDecisionReadCommand(process.argv.slice(2));
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  main().catch((cause) => {
    process.stderr.write(
      `${cause instanceof Error ? cause.message : "agent decision-read benchmark failed"}\n`
    );
    process.exitCode = 1;
  });
}
