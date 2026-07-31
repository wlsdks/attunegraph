import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  MAX_GRAPH_APPEND_BATCH_ASSERTIONS,
  openAttuneGraph
} from "@attunegraph/core";
import {
  createInMemoryAttuneGraphStore
} from "@attunegraph/core/testing";

const SUPPORTED_SCALES = new Set([10_000, 100_000, 1_000_000]);
const SUPPORTED_PROFILES = new Set([
  "core",
  "local",
  "local-session",
  "local-session-update-comparison"
]);
const SUPPORTED_ARGUMENTS = new Set([
  "output",
  "profile",
  "repetitions",
  "scale",
  "warmups"
]);
const BENCHMARK_SOURCE_ID = "attunegraph.scale-benchmark";
const BENCHMARK_OBSERVED_AT = "2026-07-31T00:00:00.000Z";
const HOT_ASSERTIONS_PER_SHARD = 8;
// Fixed by corpus v1. This stays below both the public append ceiling and the
// canonical-envelope descriptor/byte budgets; it is never tuned per machine.
const BENCHMARK_ASSERTIONS_PER_SHARD = 32;

function boundedInteger(value, name, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum.toString()} and ${maximum.toString()}`);
  }
  return parsed;
}

export function parseBenchmarkArguments(args) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const values = new Map();
  for (const argument of normalizedArgs) {
    const match = /^--([a-z]+)=(.*)$/u.exec(argument);
    if (!match || !SUPPORTED_ARGUMENTS.has(match[1])) {
      throw new Error(`unsupported benchmark argument: ${argument}`);
    }
    const [, name, value] = match;
    if (values.has(name)) throw new Error(`duplicate benchmark argument: --${name}`);
    values.set(name, value);
  }

  const scaleValue = values.get("scale");
  if (scaleValue === undefined) throw new Error("--scale is required");
  const scale = boundedInteger(scaleValue, "scale", 1, 1_000_000);
  if (!SUPPORTED_SCALES.has(scale)) {
    throw new Error("scale must be one of 10000, 100000, or 1000000");
  }

  const profile = values.get("profile");
  if (profile === undefined) throw new Error("--profile is required");
  if (!SUPPORTED_PROFILES.has(profile)) {
    throw new Error("profile is not supported");
  }

  const outputPath = values.get("output");
  if (outputPath === "") throw new Error("output path must not be empty");

  return Object.freeze({
    outputPath,
    profile,
    repetitions: boundedInteger(
      values.get("repetitions") ?? "5",
      "repetitions",
      1,
      20
    ),
    scale,
    warmups: boundedInteger(values.get("warmups") ?? "1", "warmups", 0, 10)
  });
}

export function createBenchmarkCorpusPlan(scale) {
  if (!SUPPORTED_SCALES.has(scale)) {
    throw new Error("benchmark corpus scale is not supported");
  }
  const shardAssertionCounts = [];
  let remaining = scale;
  while (remaining > 0) {
    const count = Math.min(remaining, BENCHMARK_ASSERTIONS_PER_SHARD);
    shardAssertionCounts.push(count);
    remaining -= count;
  }
  if (BENCHMARK_ASSERTIONS_PER_SHARD > MAX_GRAPH_APPEND_BATCH_ASSERTIONS) {
    throw new Error("benchmark shard exceeds the public append ceiling");
  }
  return Object.freeze({
    schema: "attunegraph-benchmark-corpus@1",
    assertionCount: scale,
    maxAssertionsPerShard: BENCHMARK_ASSERTIONS_PER_SHARD,
    seed: "thread-rooted-hot-and-cold@1",
    shardCount: shardAssertionCounts.length,
    shardAssertionCounts: Object.freeze(shardAssertionCounts)
  });
}

function benchmarkRef(shardIndex, lane, index) {
  return {
    id: `benchmark:${shardIndex.toString()}:${lane}:${index.toString()}`,
    kind: "artifact"
  };
}

function benchmarkAssertion(plan, shardIndex, localIndex, threadRoot) {
  const hotCount = Math.min(
    HOT_ASSERTIONS_PER_SHARD,
    plan.shardAssertionCounts[shardIndex]
  );
  const isHot = localIndex < hotCount;
  const subject = benchmarkRef(
    shardIndex,
    isHot ? "hot" : "cold",
    localIndex
  );
  const object = isHot
    ? { ...threadRoot }
    : localIndex === hotCount
      ? benchmarkRef(shardIndex, "hot", 0)
      : benchmarkRef(shardIndex, "cold", localIndex - 1);
  return {
    schemaVersion: 1,
    id: `benchmark:${plan.assertionCount.toString()}:${shardIndex.toString()}:assertion:${localIndex.toString()}`,
    subject,
    predicate: isHot ? "LINKED_TO" : "REVISION_OF",
    object,
    epistemicClass: "source-observed",
    sourceRefs: [{
      id: `benchmark:${plan.assertionCount.toString()}:${shardIndex.toString()}:source:${localIndex.toString()}`,
      namespace: "attunegraph.benchmark"
    }],
    recordedAt: BENCHMARK_OBSERVED_AT,
    derivation: {
      kind: "projection",
      version: plan.schema
    }
  };
}

export function createBenchmarkShard(plan, shardIndex) {
  const assertionCount = plan.shardAssertionCounts[shardIndex];
  if (!Number.isSafeInteger(assertionCount)) {
    throw new Error("benchmark shard index is out of range");
  }
  const scope = {
    sourceId: BENCHMARK_SOURCE_ID,
    threadId: `scale-${plan.assertionCount.toString()}-shard-${shardIndex.toString()}`
  };
  const threadRoot = {
    id: `benchmark-thread:${plan.assertionCount.toString()}:${shardIndex.toString()}`,
    kind: "thread"
  };
  const assertions = Array.from(
    { length: assertionCount },
    (_, localIndex) => benchmarkAssertion(plan, shardIndex, localIndex, threadRoot)
  );
  return {
    assertionCount,
    command: {
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        observationKey: `benchmark-corpus@1:${plan.assertionCount.toString()}:${shardIndex.toString()}`,
        scope,
        threadRoot,
        observedAt: BENCHMARK_OBSERVED_AT,
        sourceFreshness: {
          state: "fresh",
          observedAt: BENCHMARK_OBSERVED_AT
        },
        assertions
      }
    },
    scope,
    threadRoot
  };
}

function createUpdateComparisonCommand(shard, lane, phase) {
  const scope = {
    ...shard.scope,
    threadId: `${shard.scope.threadId}-${lane}`
  };
  const observedAt = phase === "seed"
    ? BENCHMARK_OBSERVED_AT
    : "2026-07-31T00:00:01.000Z";
  return {
    operator: shard.command.operator,
    observation: {
      ...shard.command.observation,
      observationKey: `${shard.command.observation.observationKey}:${lane}:${phase}`,
      scope,
      observedAt,
      sourceFreshness: {
        state: "fresh",
        observedAt
      }
    }
  };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function inspectBenchmarkCorpus(
  plan,
  shardIndexes = Array.from({ length: plan.shardCount }, (_, index) => index)
) {
  if (
    shardIndexes.length !== plan.shardCount
    || new Set(shardIndexes).size !== plan.shardCount
    || shardIndexes.some((index) =>
      !Number.isSafeInteger(index) || index < 0 || index >= plan.shardCount
    )
  ) {
    throw new Error("benchmark shard order must contain every shard exactly once");
  }

  const shards = shardIndexes.map((shardIndex) => {
    const shard = createBenchmarkShard(plan, shardIndex);
    const serialized = JSON.stringify(shard.command.observation);
    return {
      assertionCount: shard.assertionCount,
      index: shardIndex,
      serializedBytes: Buffer.byteLength(serialized, "utf8"),
      sha256: sha256(serialized)
    };
  }).sort((left, right) => left.index - right.index);

  const predicateMix = plan.shardAssertionCounts.reduce((mix, count) => {
    const linked = Math.min(count, HOT_ASSERTIONS_PER_SHARD);
    mix.LINKED_TO += linked;
    mix.REVISION_OF += count - linked;
    return mix;
  }, { LINKED_TO: 0, REVISION_OF: 0 });
  const identity = JSON.stringify({
    assertionCount: plan.assertionCount,
    schema: plan.schema,
    seed: plan.seed,
    shardAssertionCounts: plan.shardAssertionCounts,
    shards: shards.map(({ index, sha256: shardHash }) => ({ index, sha256: shardHash }))
  });

  return Object.freeze({
    schema: "attunegraph-benchmark-corpus-manifest@1",
    assertionCount: plan.assertionCount,
    maxAssertionsPerShard: plan.maxAssertionsPerShard,
    predicateMix: Object.freeze(predicateMix),
    seed: plan.seed,
    sha256: sha256(`attunegraph.benchmark-corpus-manifest.v1\n${identity}`),
    shardCount: plan.shardCount,
    shards: Object.freeze(shards.map((shard) => Object.freeze(shard)))
  });
}

export function summarizeBenchmarkSamples(samples) {
  if (
    !Array.isArray(samples)
    || samples.length === 0
    || samples.some((sample) =>
      typeof sample !== "number" || !Number.isFinite(sample) || sample < 0
    )
  ) {
    throw new Error("benchmark samples must be a non-empty array of finite non-negative numbers");
  }
  const retained = [...samples];
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
  return Object.freeze({
    max: sorted.at(-1),
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    samples: Object.freeze(retained)
  });
}

function repositoryIdentity() {
  const git = (...args) => execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const lockfile = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url));
  return Object.freeze({
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    clean: git("status", "--porcelain=v1", "--untracked-files=all") === "",
    lockfileSha256: sha256(lockfile)
  });
}

export function pnpmVersion(userAgent = process.env.npm_config_user_agent) {
  const userAgentVersion = /(?:^|\s)pnpm\/([^\s]+)/u.exec(userAgent ?? "")?.[1];
  if (userAgentVersion !== undefined) {
    return userAgentVersion;
  }
  const command = platform() === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm --version"]]
    : ["pnpm", ["--version"]];
  return execFileSync(command[0], command[1], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
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
    sqlite: process.versions.sqlite ?? null,
    totalMemoryBytes: totalmem()
  });
}

async function runCoreCorpus(plan) {
  const store = createInMemoryAttuneGraphStore();
  const samples = {
    close: [],
    head: [],
    open: [],
    projection: [],
    workingGraph: []
  };
  const statuses = { abstained: 0, complete: 0, partial: 0 };
  const rssBaselineBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = rssBaselineBytes;
  const projectionStartedAt = performance.now();

  for (let shardIndex = 0; shardIndex < plan.shardCount; shardIndex += 1) {
    const shard = createBenchmarkShard(plan, shardIndex);
    let startedAt = performance.now();
    const graph = await openAttuneGraph({ scope: shard.scope, store });
    samples.open.push(performance.now() - startedAt);

    startedAt = performance.now();
    const snapshot = await graph.project(shard.command);
    samples.projection.push(performance.now() - startedAt);

    startedAt = performance.now();
    const result = await graph.execute({
      operator: "working-graph@1",
      seed: shard.threadRoot,
      now: shard.command.observation.observedAt,
      maxEstimatedTokens: 32_768
    });
    samples.workingGraph.push(performance.now() - startedAt);
    statuses[result.status] += 1;

    startedAt = performance.now();
    const head = await graph.head();
    samples.head.push(performance.now() - startedAt);
    if (head?.commitId !== snapshot.commitId || head.generation !== 1) {
      throw new Error("benchmark head did not match the projected shard");
    }

    startedAt = performance.now();
    await graph.close();
    samples.close.push(performance.now() - startedAt);
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
  }

  const projectionElapsedMilliseconds = performance.now() - projectionStartedAt;
  const pureProjectionMilliseconds = samples.projection.reduce(
    (sum, sample) => sum + sample,
    0
  );
  const rssFinalBytes = process.memoryUsage().rss;
  return {
    assertionsPerSecond: plan.assertionCount / (pureProjectionMilliseconds / 1_000),
    lifecycleAssertionsPerSecond: plan.assertionCount / (projectionElapsedMilliseconds / 1_000),
    projectionsPerSecond: plan.shardCount / (pureProjectionMilliseconds / 1_000),
    rss: {
      baselineBytes: rssBaselineBytes,
      deltaBytes: rssFinalBytes - rssBaselineBytes,
      finalBytes: rssFinalBytes,
      sampledPeakBytes: sampledPeakRssBytes,
      sampling: "phase-boundary"
    },
    samples,
    statuses
  };
}

async function optionalFileBytes(path) {
  try {
    return (await stat(path)).size;
  } catch (cause) {
    if (cause && typeof cause === "object" && cause.code === "ENOENT") return 0;
    throw cause;
  }
}

async function runLocalCorpus(plan) {
  const { openLocalAttuneGraph } = await import("@attunegraph/core/local");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-benchmark-")));
  await chmod(directory, 0o700);
  const databasePath = join(directory, "attunegraph.sqlite");
  const samples = {
    close: [],
    head: [],
    open: [],
    projection: [],
    reopen: [],
    workingGraph: []
  };
  const statuses = { abstained: 0, complete: 0, partial: 0 };
  const rssBaselineBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = rssBaselineBytes;
  const lifecycleStartedAt = performance.now();

  try {
    for (let shardIndex = 0; shardIndex < plan.shardCount; shardIndex += 1) {
      const shard = createBenchmarkShard(plan, shardIndex);
      let startedAt = performance.now();
      const writer = await openLocalAttuneGraph({ databasePath, scope: shard.scope });
      samples.open.push(performance.now() - startedAt);

      startedAt = performance.now();
      const snapshot = await writer.project(shard.command);
      samples.projection.push(performance.now() - startedAt);

      startedAt = performance.now();
      await writer.close();
      samples.close.push(performance.now() - startedAt);

      startedAt = performance.now();
      const reader = await openLocalAttuneGraph({ databasePath, scope: shard.scope });
      samples.reopen.push(performance.now() - startedAt);

      startedAt = performance.now();
      const head = await reader.head();
      samples.head.push(performance.now() - startedAt);
      if (head?.commitId !== snapshot.commitId || head.generation !== 1) {
        throw new Error("local benchmark did not recover the projected shard head");
      }

      startedAt = performance.now();
      const result = await reader.execute({
        operator: "working-graph@1",
        seed: shard.threadRoot,
        now: shard.command.observation.observedAt,
        maxEstimatedTokens: 32_768
      });
      samples.workingGraph.push(performance.now() - startedAt);
      statuses[result.status] += 1;

      startedAt = performance.now();
      await reader.close();
      samples.close.push(performance.now() - startedAt);
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    }

    const lifecycleElapsedMilliseconds = performance.now() - lifecycleStartedAt;
    const pureProjectionMilliseconds = samples.projection.reduce(
      (sum, sample) => sum + sample,
      0
    );
    const rssFinalBytes = process.memoryUsage().rss;
    return {
      assertionsPerSecond: plan.assertionCount / (pureProjectionMilliseconds / 1_000),
      databaseBytes: {
        database: await optionalFileBytes(databasePath),
        sharedMemory: await optionalFileBytes(`${databasePath}-shm`),
        writeAheadLog: await optionalFileBytes(`${databasePath}-wal`)
      },
      lifecycleAssertionsPerSecond: plan.assertionCount / (lifecycleElapsedMilliseconds / 1_000),
      projectionsPerSecond: plan.shardCount / (pureProjectionMilliseconds / 1_000),
      rss: {
        baselineBytes: rssBaselineBytes,
        deltaBytes: rssFinalBytes - rssBaselineBytes,
        finalBytes: rssFinalBytes,
        sampledPeakBytes: sampledPeakRssBytes,
        sampling: "phase-boundary"
      },
      samples,
      statuses
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function runLocalSessionCorpus(plan, runtime = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-benchmark-")));
  await chmod(directory, 0o700);
  const databasePath = join(directory, "attunegraph.sqlite");
  const samples = {
    close: [],
    head: [],
    open: [],
    projection: [],
    sessionClose: [],
    sessionOpen: [],
    workingGraph: []
  };
  const statuses = { abstained: 0, complete: 0, partial: 0 };
  const rssBaselineBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = rssBaselineBytes;
  const lifecycleStartedAt = performance.now();
  let session;
  let sessionCloseAttempted = false;
  let primaryFailed = false;
  let primaryFailure;
  let completedRun;

  try {
    const openLocalAttuneGraphSession = runtime.openLocalAttuneGraphSession
      ?? (await import("@attunegraph/core/local")).openLocalAttuneGraphSession;
    let startedAt = performance.now();
    session = await openLocalAttuneGraphSession({ databasePath });
    samples.sessionOpen.push(performance.now() - startedAt);

    for (let shardIndex = 0; shardIndex < plan.shardCount; shardIndex += 1) {
      const shard = createBenchmarkShard(plan, shardIndex);
      startedAt = performance.now();
      const graph = await session.open({ scope: shard.scope });
      samples.open.push(performance.now() - startedAt);

      startedAt = performance.now();
      const snapshot = await graph.project(shard.command);
      samples.projection.push(performance.now() - startedAt);

      startedAt = performance.now();
      const head = await graph.head();
      samples.head.push(performance.now() - startedAt);
      if (head?.commitId !== snapshot.commitId || head.generation !== 1) {
        throw new Error("local-session benchmark head did not match the projected shard");
      }

      startedAt = performance.now();
      const result = await graph.execute({
        operator: "working-graph@1",
        seed: shard.threadRoot,
        now: shard.command.observation.observedAt,
        maxEstimatedTokens: 32_768
      });
      samples.workingGraph.push(performance.now() - startedAt);
      statuses[result.status] += 1;

      startedAt = performance.now();
      await graph.close();
      samples.close.push(performance.now() - startedAt);
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    }

    startedAt = performance.now();
    sessionCloseAttempted = true;
    await session.close();
    samples.sessionClose.push(performance.now() - startedAt);

    const lifecycleElapsedMilliseconds = performance.now() - lifecycleStartedAt;
    const pureProjectionMilliseconds = samples.projection.reduce(
      (sum, sample) => sum + sample,
      0
    );
    const rssFinalBytes = process.memoryUsage().rss;
    completedRun = {
      assertionsPerSecond: plan.assertionCount / (pureProjectionMilliseconds / 1_000),
      databaseBytes: {
        database: await optionalFileBytes(databasePath),
        sharedMemory: await optionalFileBytes(`${databasePath}-shm`),
        writeAheadLog: await optionalFileBytes(`${databasePath}-wal`)
      },
      lifecycleAssertionsPerSecond: plan.assertionCount / (lifecycleElapsedMilliseconds / 1_000),
      projectionsPerSecond: plan.shardCount / (pureProjectionMilliseconds / 1_000),
      rss: {
        baselineBytes: rssBaselineBytes,
        deltaBytes: rssFinalBytes - rssBaselineBytes,
        finalBytes: rssFinalBytes,
        sampledPeakBytes: sampledPeakRssBytes,
        sampling: "phase-boundary"
      },
      samples,
      statuses
    };
  } catch (cause) {
    primaryFailed = true;
    primaryFailure = cause;
  }

  const cleanupFailures = [];
  if (session !== undefined && !sessionCloseAttempted) {
    sessionCloseAttempted = true;
    try {
      await session.close();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  try {
    await rm(directory, { force: true, recursive: true });
  } catch (cause) {
    cleanupFailures.push(cause);
  }

  if (primaryFailed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        "local-session benchmark failed and cleanup did not complete"
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "local-session benchmark cleanup did not complete");
  }
  return completedRun;
}

export async function runLocalSessionUpdateComparison(plan, runtime = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-benchmark-")));
  await chmod(directory, 0o700);
  const databasePath = join(directory, "attunegraph.sqlite");
  const samples = {
    againstHeadProject: [],
    close: [],
    exactHeadThenProject: [],
    exactProjection: [],
    head: [],
    open: [],
    projection: [],
    seedProjection: [],
    sessionClose: [],
    sessionOpen: [],
    verificationHead: []
  };
  const rssBaselineBytes = process.memoryUsage().rss;
  let sampledPeakRssBytes = rssBaselineBytes;
  const lifecycleStartedAt = performance.now();
  let session;
  let sessionCloseAttempted = false;
  let primaryFailure;
  let completedRun;

  try {
    const openLocalAttuneGraphSession = runtime.openLocalAttuneGraphSession
      ?? (await import("@attunegraph/core/local")).openLocalAttuneGraphSession;
    let startedAt = performance.now();
    session = await openLocalAttuneGraphSession({ databasePath });
    samples.sessionOpen.push(performance.now() - startedAt);

    for (let shardIndex = 0; shardIndex < plan.shardCount; shardIndex += 1) {
      const shard = createBenchmarkShard(plan, shardIndex);
      const exactScope = {
        ...shard.scope,
        threadId: `${shard.scope.threadId}-a`
      };
      const againstHeadScope = {
        ...shard.scope,
        threadId: `${shard.scope.threadId}-b`
      };
      startedAt = performance.now();
      const [exactGraph, againstHeadGraph] = await Promise.all([
        session.open({ scope: exactScope }),
        session.open({ scope: againstHeadScope })
      ]);
      samples.open.push(performance.now() - startedAt);

      try {
        const exactSeed = createUpdateComparisonCommand(shard, "a", "seed");
        const againstHeadSeed = createUpdateComparisonCommand(shard, "b", "seed");
        startedAt = performance.now();
        await Promise.all([
          exactGraph.project(exactSeed),
          againstHeadGraph.project(againstHeadSeed)
        ]);
        samples.seedProjection.push(performance.now() - startedAt);

        const exactUpdateStartedAt = performance.now();
        startedAt = performance.now();
        const exactHead = await exactGraph.head();
        samples.head.push(performance.now() - startedAt);
        if (exactHead?.generation !== 1) {
          throw new Error("update comparison exact head did not match its seed");
        }
        startedAt = performance.now();
        const exactSnapshot = await exactGraph.project({
          ...createUpdateComparisonCommand(shard, "a", "update"),
          expectedSnapshot: exactHead
        });
        samples.exactProjection.push(performance.now() - startedAt);
        samples.exactHeadThenProject.push(performance.now() - exactUpdateStartedAt);

        startedAt = performance.now();
        const againstHeadSnapshot = await againstHeadGraph.projectAgainstHead(
          createUpdateComparisonCommand(shard, "b", "update")
        );
        const againstHeadElapsed = performance.now() - startedAt;
        samples.againstHeadProject.push(againstHeadElapsed);
        samples.projection.push(againstHeadElapsed);
        if (
          exactSnapshot.generation !== 2
          || againstHeadSnapshot.generation !== 2
        ) {
          throw new Error("update comparison did not advance both projections");
        }

        startedAt = performance.now();
        const verified = await againstHeadGraph.head();
        samples.verificationHead.push(performance.now() - startedAt);
        if (verified?.commitId !== againstHeadSnapshot.commitId) {
          throw new Error("update comparison latest head did not match its projection");
        }
      } finally {
        startedAt = performance.now();
        await Promise.all([exactGraph.close(), againstHeadGraph.close()]);
        samples.close.push(performance.now() - startedAt);
      }
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
    }

    startedAt = performance.now();
    sessionCloseAttempted = true;
    await session.close();
    samples.sessionClose.push(performance.now() - startedAt);

    const againstHeadProjectionMilliseconds = samples.againstHeadProject.reduce(
      (sum, sample) => sum + sample,
      0
    );
    const exactHeadThenProjectMilliseconds = samples.exactHeadThenProject.reduce(
      (sum, sample) => sum + sample,
      0
    );
    const rssFinalBytes = process.memoryUsage().rss;
    completedRun = {
      assertionsPerSecond: plan.assertionCount
        / (againstHeadProjectionMilliseconds / 1_000),
      databaseBytes: {
        database: await optionalFileBytes(databasePath),
        sharedMemory: await optionalFileBytes(`${databasePath}-shm`),
        writeAheadLog: await optionalFileBytes(`${databasePath}-wal`)
      },
      exactHeadThenProjectAssertionsPerSecond: plan.assertionCount
        / (exactHeadThenProjectMilliseconds / 1_000),
      lifecycleAssertionsPerSecond: plan.assertionCount
        / ((performance.now() - lifecycleStartedAt) / 1_000),
      projectionsPerSecond: plan.shardCount
        / (againstHeadProjectionMilliseconds / 1_000),
      rss: {
        baselineBytes: rssBaselineBytes,
        deltaBytes: rssFinalBytes - rssBaselineBytes,
        finalBytes: rssFinalBytes,
        sampledPeakBytes: sampledPeakRssBytes,
        sampling: "phase-boundary"
      },
      samples,
      speedup: exactHeadThenProjectMilliseconds / againstHeadProjectionMilliseconds,
      statuses: { abstained: 0, complete: 0, partial: 0 }
    };
  } catch (cause) {
    primaryFailure = cause;
  }

  const cleanupFailures = [];
  if (session !== undefined && !sessionCloseAttempted) {
    sessionCloseAttempted = true;
    try {
      await session.close();
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  try {
    await rm(directory, { force: true, recursive: true });
  } catch (cause) {
    cleanupFailures.push(cause);
  }
  if (primaryFailure !== undefined) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupFailures],
        "update comparison failed and cleanup did not complete"
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      "update comparison cleanup did not complete"
    );
  }
  return completedRun;
}

function flatten(runs, key) {
  return runs.flatMap((run) => run.samples[key]);
}

export async function runScaleBenchmark(options, runtime = {}) {
  if (
    !SUPPORTED_SCALES.has(options.scale)
    || !SUPPORTED_PROFILES.has(options.profile)
    || !Number.isSafeInteger(options.warmups)
    || options.warmups < 0
    || options.warmups > 10
    || !Number.isSafeInteger(options.repetitions)
    || options.repetitions < 1
    || options.repetitions > 20
  ) {
    throw new Error("benchmark options are invalid");
  }
  const plan = createBenchmarkCorpusPlan(options.scale);
  const corpusStartedAt = performance.now();
  const corpus = inspectBenchmarkCorpus(plan);
  const corpusGenerationMilliseconds = performance.now() - corpusStartedAt;

  const runCorpus = options.profile === "core"
    ? runCoreCorpus
    : options.profile === "local"
      ? runLocalCorpus
      : options.profile === "local-session"
        ? (corpusPlan) => runLocalSessionCorpus(corpusPlan, runtime)
        : (corpusPlan) => runLocalSessionUpdateComparison(corpusPlan, runtime);
  for (let warmup = 0; warmup < options.warmups; warmup += 1) {
    await runCorpus(plan);
  }
  const runs = [];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    runs.push(await runCorpus(plan));
  }

  const statusTotals = runs.reduce((totals, run) => {
    totals.abstained += run.statuses.abstained;
    totals.complete += run.statuses.complete;
    totals.partial += run.statuses.partial;
    return totals;
  }, { abstained: 0, complete: 0, partial: 0 });

  return Object.freeze({
    schema: "attunegraph-scale-benchmark@1",
    claimEligible: false,
    measurementOnly: true,
    observedAt: new Date().toISOString(),
    repository: repositoryIdentity(),
    host: hostIdentity(),
    configuration: Object.freeze({
      argv: Object.freeze([...(runtime.argv ?? [])]),
      concurrency: 1,
      monotonicClock: "performance.now",
      profile: options.profile,
      repetitions: options.repetitions,
      scale: options.scale,
      warmups: options.warmups
    }),
    corpus,
    metrics: Object.freeze({
      assertionsPerSecond: summarizeBenchmarkSamples(
        runs.map((run) => run.assertionsPerSecond)
      ),
      closeMilliseconds: summarizeBenchmarkSamples(flatten(runs, "close")),
      corpusGenerationMilliseconds,
      headMilliseconds: summarizeBenchmarkSamples(flatten(runs, "head")),
      lifecycleAssertionsPerSecond: summarizeBenchmarkSamples(
        runs.map((run) => run.lifecycleAssertionsPerSecond)
      ),
      openMilliseconds: summarizeBenchmarkSamples(flatten(runs, "open")),
      projectionMilliseconds: summarizeBenchmarkSamples(flatten(runs, "projection")),
      projectionsPerSecond: summarizeBenchmarkSamples(
        runs.map((run) => run.projectionsPerSecond)
      ),
      rssBytes: Object.freeze(runs.map((run) => Object.freeze(run.rss))),
      ...(options.profile === "local" ? {
        databaseBytes: Object.freeze(runs.map((run) => Object.freeze(run.databaseBytes))),
        reopenMilliseconds: summarizeBenchmarkSamples(flatten(runs, "reopen"))
      } : {}),
      ...(options.profile === "local-session" ? {
        databaseBytes: Object.freeze(runs.map((run) => Object.freeze(run.databaseBytes))),
        sessionCloseMilliseconds: summarizeBenchmarkSamples(flatten(runs, "sessionClose")),
        sessionOpenMilliseconds: summarizeBenchmarkSamples(flatten(runs, "sessionOpen"))
      } : {}),
      ...(options.profile === "local-session-update-comparison" ? {
        againstHeadProjectMilliseconds: summarizeBenchmarkSamples(
          flatten(runs, "againstHeadProject")
        ),
        databaseBytes: Object.freeze(runs.map((run) => Object.freeze(run.databaseBytes))),
        exactHeadThenProjectAssertionsPerSecond: summarizeBenchmarkSamples(
          runs.map((run) => run.exactHeadThenProjectAssertionsPerSecond)
        ),
        exactHeadThenProjectMilliseconds: summarizeBenchmarkSamples(
          flatten(runs, "exactHeadThenProject")
        ),
        exactProjectionMilliseconds: summarizeBenchmarkSamples(
          flatten(runs, "exactProjection")
        ),
        seedProjectionMilliseconds: summarizeBenchmarkSamples(
          flatten(runs, "seedProjection")
        ),
        sessionCloseMilliseconds: summarizeBenchmarkSamples(flatten(runs, "sessionClose")),
        sessionOpenMilliseconds: summarizeBenchmarkSamples(flatten(runs, "sessionOpen")),
        speedup: summarizeBenchmarkSamples(runs.map((run) => run.speedup)),
        verificationHeadMilliseconds: summarizeBenchmarkSamples(
          flatten(runs, "verificationHead")
        )
      } : {
        workingGraphMilliseconds: summarizeBenchmarkSamples(
          flatten(runs, "workingGraph")
        )
      })
    }),
    operations: Object.freeze({
      projectedAssertions: plan.assertionCount * options.repetitions
        * (options.profile === "local-session-update-comparison" ? 4 : 1),
      projections: plan.shardCount * options.repetitions
        * (options.profile === "local-session-update-comparison" ? 4 : 1),
      ...(options.profile === "local-session-update-comparison" ? {
        comparison: Object.freeze({
          againstHeadUpdateAssertions: plan.assertionCount * options.repetitions,
          exactUpdateAssertions: plan.assertionCount * options.repetitions,
          seedAssertions: plan.assertionCount * options.repetitions * 2
        })
      } : {}),
      workingGraphStatuses: Object.freeze(statusTotals)
    })
  });
}

async function validateOutputPath(outputPath) {
  if (!isAbsolute(outputPath) || normalize(outputPath) !== outputPath) {
    throw new Error("benchmark output must be an absolute normalized path");
  }
  const parent = dirname(outputPath);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) {
    throw new Error("benchmark output parent must not traverse a symlink");
  }
  const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const fromRepository = relative(repositoryRoot, outputPath);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new Error("benchmark output must be outside the repository");
  }
  try {
    await lstat(outputPath);
    throw new Error("benchmark output already exists");
  } catch (cause) {
    if (cause instanceof Error && cause.message === "benchmark output already exists") throw cause;
    if (!cause || typeof cause !== "object" || cause.code !== "ENOENT") throw cause;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseBenchmarkArguments(argv);
  if (options.outputPath !== undefined) await validateOutputPath(options.outputPath);
  const report = await runScaleBenchmark(options, { argv });
  const document = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath === undefined) {
    process.stdout.write(document);
    return;
  }
  await writeFile(options.outputPath, document, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : "benchmark failed"}\n`);
    process.exitCode = 1;
  });
}
