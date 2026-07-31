import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { openAttuneGraph } from "@attunegraph/core";
import { createAttuneGraphStore } from "@attunegraph/core/backend";
import { InMemoryAttuneGraphStoreBackend } from "@attunegraph/core/testing";
import {
  createBenchmarkCorpusPlan,
  createBenchmarkShard,
  inspectBenchmarkCorpus,
  pnpmVersion,
  summarizeBenchmarkSamples
} from "./benchmark-attunegraph-scale.mjs";

const SUPPORTED_SCALES = new Set([10_000, 100_000, 1_000_000]);
const SUPPORTED_PROFILES = new Set(["local-session-concurrent", "portable"]);
const SUPPORTED_ARGUMENTS = new Set([
  "concurrency",
  "output",
  "profile",
  "repetitions",
  "scale",
  "warmups"
]);

export async function runBoundedPool(items, concurrency, operation) {
  if (!Array.isArray(items) || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("bounded pool concurrency must be between 1 and 32");
  }
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await operation(items[index], index);
      }
    }
  );
  await Promise.all(workers);
  return Object.freeze(results);
}

async function runLocalIngestion(plan, concurrency, databasePath, runtime) {
  const openLocalAttuneGraphSession = runtime.openLocalAttuneGraphSession
    ?? (await import("@attunegraph/core/local")).openLocalAttuneGraphSession;
  const samples = { close: [], open: [], projection: [], verificationHead: [] };
  const rssBaselineBytes = process.memoryUsage().rss;
  let sampledPeakBytes = Math.max(rssBaselineBytes, process.resourceUsage().maxRSS * 1_024);
  let startedAt = performance.now();
  const session = await openLocalAttuneGraphSession({ databasePath });
  const coldOpenMilliseconds = performance.now() - startedAt;
  const shardIndexes = Array.from({ length: plan.shardCount }, (_, index) => index);
  const ingestionStartedAt = performance.now();
  const expected = await runBoundedPool(shardIndexes, concurrency, async (shardIndex) => {
    const shard = createBenchmarkShard(plan, shardIndex);
    let operationStartedAt = performance.now();
    const graph = await session.open({ scope: shard.scope });
    samples.open.push(performance.now() - operationStartedAt);
    try {
      operationStartedAt = performance.now();
      const snapshot = await graph.project(shard.command);
      samples.projection.push(performance.now() - operationStartedAt);
      if (snapshot.generation !== 1) {
        throw new Error("concurrent benchmark projection did not start at generation 1");
      }
      return Object.freeze({ commitId: snapshot.commitId, scope: shard.scope });
    } finally {
      operationStartedAt = performance.now();
      await graph.close();
      samples.close.push(performance.now() - operationStartedAt);
    }
  });
  const ingestionMilliseconds = performance.now() - ingestionStartedAt;
  sampledPeakBytes = Math.max(
    sampledPeakBytes,
    process.memoryUsage().rss,
    process.resourceUsage().maxRSS * 1_024
  );
  await session.close();

  startedAt = performance.now();
  const warmSession = await openLocalAttuneGraphSession({ databasePath });
  const warmOpenMilliseconds = performance.now() - startedAt;
  try {
    await runBoundedPool(expected, concurrency, async ({ commitId, scope }) => {
      const graph = await warmSession.open({ scope });
      try {
        const headStartedAt = performance.now();
        const head = await graph.head();
        samples.verificationHead.push(performance.now() - headStartedAt);
        if (head?.generation !== 1 || head.commitId !== commitId) {
          throw new Error("concurrent benchmark reopen verification did not match the projected head");
        }
      } finally {
        await graph.close();
      }
    });
  } finally {
    await warmSession.close();
  }
  sampledPeakBytes = Math.max(
    sampledPeakBytes,
    process.memoryUsage().rss,
    process.resourceUsage().maxRSS * 1_024
  );
  return Object.freeze({
    assertionsPerSecond: plan.assertionCount / (ingestionMilliseconds / 1_000),
    coldOpenMilliseconds,
    concurrency,
    expected: Object.freeze(expected),
    ingestionMilliseconds,
    rss: Object.freeze({
      baselineBytes: rssBaselineBytes,
      finalBytes: process.memoryUsage().rss,
      method: "process.resourceUsage.maxRSS-kib-plus-phase-boundaries",
      peakBytes: sampledPeakBytes,
      sampledPeakBytes,
      sampling: "process-lifetime-high-watermark"
    }),
    samples: Object.freeze(samples),
    warmOpenMilliseconds
  });
}

export async function runLocalSessionConcurrentComparison(plan, concurrency, runtime = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 32) {
    throw new Error("concurrent comparison concurrency must be between 2 and 32");
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-performance-")));
  await chmod(root, 0o700);
  const baselinePath = join(root, "baseline.sqlite");
  const candidatePath = join(root, "candidate.sqlite");
  try {
    const pairOrder = runtime.pairOrder ?? "baseline-first";
    if (!["baseline-first", "candidate-first"].includes(pairOrder)) {
      throw new Error("concurrent comparison pair order is invalid");
    }
    let baseline;
    let candidate;
    if (pairOrder === "baseline-first") {
      baseline = await runLocalIngestion(plan, 1, baselinePath, runtime);
      candidate = await runLocalIngestion(plan, concurrency, candidatePath, runtime);
    } else {
      candidate = await runLocalIngestion(plan, concurrency, candidatePath, runtime);
      baseline = await runLocalIngestion(plan, 1, baselinePath, runtime);
    }
    const baselineIdentity = baseline.expected.map(({ commitId, scope }) => `${scope.sourceId}\0${scope.threadId}\0${commitId}`);
    const candidateIdentity = candidate.expected.map(({ commitId, scope }) => `${scope.sourceId}\0${scope.threadId}\0${commitId}`);
    const candidateMatchesBaseline = JSON.stringify(candidateIdentity) === JSON.stringify(baselineIdentity);
    if (!candidateMatchesBaseline) {
      throw new Error("concurrent benchmark result diverged from its sequential baseline");
    }
    return Object.freeze({
      baseline,
      candidate,
      correctness: Object.freeze({
        baselineVerifiedHeads: baseline.samples.verificationHead.length,
        candidateMatchesBaseline,
        candidateVerifiedHeads: candidate.samples.verificationHead.length,
        expectedHeads: plan.shardCount
      }),
      pairOrder,
      relative: Object.freeze({
        assertionsPerSecond: candidate.assertionsPerSecond / baseline.assertionsPerSecond,
        ingestionLatency: candidate.ingestionMilliseconds / baseline.ingestionMilliseconds,
        warmVsColdOpen: candidate.warmOpenMilliseconds / candidate.coldOpenMilliseconds
      })
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function concatBytes(chunks) {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function compareScopes(left, right) {
  return left.sourceId.localeCompare(right.sourceId) || left.threadId.localeCompare(right.threadId);
}

async function preparePortableProjections(plan) {
  const backend = new InMemoryAttuneGraphStoreBackend();
  const store = createAttuneGraphStore(backend);
  const projections = [];
  for (let shardIndex = 0; shardIndex < plan.shardCount; shardIndex += 1) {
    const shard = createBenchmarkShard(plan, shardIndex);
    const graph = await openAttuneGraph({ scope: shard.scope, store });
    try {
      await graph.project(shard.command);
      const projection = await backend.read(shard.scope);
      if (projection === undefined) throw new Error("portable benchmark projection was not stored");
      projections.push({ projection, scope: shard.scope });
    } finally {
      await graph.close();
    }
  }
  projections.sort((left, right) => compareScopes(left.scope, right.scope));
  return Object.freeze(projections);
}

export async function runPortableProfile(plan) {
  const preparationStartedAt = performance.now();
  const projections = await preparePortableProjections(plan);
  const preparationMilliseconds = performance.now() - preparationStartedAt;
  const rssBaselineBytes = process.memoryUsage().rss;
  let encodedProjectionCount = 0;
  let encodedHeadCount = 0;
  const identitySink = {
    appendProjection() { encodedProjectionCount += 1; },
    sealProjections() {},
    assertHead() { encodedHeadCount += 1; },
    finish() {},
    abort(cause) { throw cause; }
  };
  const { createAttuneGraphPortableEncoder } = await import("../dist/attunegraph-portable-encoder.js");
  const encodeStartedAt = performance.now();
  const encoder = createAttuneGraphPortableEncoder({ identitySink });
  const chunks = [encoder.start()];
  const identities = [];
  for (const { projection, scope } of projections) {
    const appended = encoder.appendProjection(scope, projection);
    chunks.push(appended.bytes);
    identities.push(appended.identity);
  }
  encoder.sealProjections();
  for (const identity of identities) {
    chunks.push(encoder.appendHead(
      identity.scope,
      identity.generation,
      identity.commitId,
      identity.projectionId
    ));
  }
  const finished = encoder.finish();
  chunks.push(finished.bytes);
  const encodeCoreMilliseconds = performance.now() - encodeStartedAt;
  const materializeStartedAt = performance.now();
  const artifact = concatBytes(chunks);
  const materializeMilliseconds = performance.now() - materializeStartedAt;
  const encodeMilliseconds = performance.now() - encodeStartedAt;
  const rssAfterEncodeBytes = process.memoryUsage().rss;

  let decodedProjectionCount = 0;
  let decodedHeadCount = 0;
  let decoderFinished = false;
  const validationSink = {
    appendProjection() { decodedProjectionCount += 1; },
    sealProjections() {},
    assertHead() { decodedHeadCount += 1; },
    finish(scopeCount, headCount) {
      if (scopeCount !== projections.length || headCount !== projections.length) {
        throw new Error("portable benchmark decoder terminal counts diverged");
      }
      decoderFinished = true;
    },
    abort(cause) { throw cause; }
  };
  const { createAttuneGraphPortableDecoder } = await import("../dist/attunegraph-portable-decoder.js");
  const decodeStartedAt = performance.now();
  const decoder = createAttuneGraphPortableDecoder(validationSink);
  await decoder.write(artifact);
  const decodedSummary = await decoder.finish();
  const decodeMilliseconds = performance.now() - decodeStartedAt;
  const rssAfterDecodeBytes = process.memoryUsage().rss;
  const summaryMatches = JSON.stringify(decodedSummary) === JSON.stringify(finished.report);
  if (
    !summaryMatches
    || !decoderFinished
    || encodedProjectionCount !== projections.length
    || encodedHeadCount !== projections.length
    || decodedProjectionCount !== projections.length
    || decodedHeadCount !== projections.length
  ) {
    throw new Error("portable benchmark encode/decode convergence failed");
  }
  return Object.freeze({
    artifactBytes: artifact.byteLength,
    correctness: Object.freeze({
      decodedHeads: decodedHeadCount,
      decodedProjections: decodedProjectionCount,
      summaryMatches
    }),
    decode: Object.freeze({
      assertionsPerSecond: plan.assertionCount / (decodeMilliseconds / 1_000),
      bytesPerSecond: artifact.byteLength / (decodeMilliseconds / 1_000),
      milliseconds: decodeMilliseconds
    }),
    encode: Object.freeze({
      assertionsPerSecond: plan.assertionCount / (encodeMilliseconds / 1_000),
      bytesPerSecond: artifact.byteLength / (encodeMilliseconds / 1_000),
      coreMilliseconds: encodeCoreMilliseconds,
      materializeMilliseconds,
      milliseconds: encodeMilliseconds,
      timing: "encoder-plus-contiguous-artifact-materialization"
    }),
    preparationMilliseconds,
    relative: Object.freeze({
      decodeToEncodeLatency: decodeMilliseconds / encodeMilliseconds,
      decodeToEncodeThroughput: (artifact.byteLength / (decodeMilliseconds / 1_000))
        / (artifact.byteLength / (encodeMilliseconds / 1_000))
    }),
    rss: Object.freeze({
      afterDecodeBytes: rssAfterDecodeBytes,
      afterEncodeBytes: rssAfterEncodeBytes,
      baselineBytes: rssBaselineBytes,
      method: "process.resourceUsage.maxRSS-kib-plus-phase-boundaries",
      peakBytes: Math.max(
        rssBaselineBytes,
        rssAfterEncodeBytes,
        rssAfterDecodeBytes,
        process.resourceUsage().maxRSS * 1_024
      ),
      sampledPeakBytes: Math.max(
        rssBaselineBytes,
        rssAfterEncodeBytes,
        rssAfterDecodeBytes,
        process.resourceUsage().maxRSS * 1_024
      ),
      sampling: "process-lifetime-high-watermark"
    }),
    summary: finished.report
  });
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function repositoryIdentity() {
  const git = (...args) => execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  return Object.freeze({
    clean: git("status", "--porcelain=v1", "--untracked-files=all") === "",
    commit: git("rev-parse", "HEAD"),
    lockfileSha256: sha256(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url))),
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
    sqlite: process.versions.sqlite ?? null,
    totalMemoryBytes: totalmem()
  });
}

function flatten(runs, select) {
  return runs.flatMap(select);
}

export async function runPerformanceBenchmark(options, runtime = {}) {
  if (
    !SUPPORTED_SCALES.has(options.scale)
    || !SUPPORTED_PROFILES.has(options.profile)
    || !Number.isSafeInteger(options.concurrency)
    || options.concurrency < 1
    || options.concurrency > 32
    || !Number.isSafeInteger(options.warmups)
    || options.warmups < 0
    || options.warmups > 5
    || !Number.isSafeInteger(options.repetitions)
    || options.repetitions < 1
    || options.repetitions > 10
    || (options.profile === "portable" && options.concurrency !== 1)
    || (options.profile === "local-session-concurrent" && options.concurrency < 2)
  ) {
    throw new Error("performance benchmark options are invalid");
  }
  const plan = createBenchmarkCorpusPlan(options.scale);
  const corpus = inspectBenchmarkCorpus(plan);
  const run = options.profile === "portable"
    ? (runtime.runPortable ?? runPortableProfile)
    : (corpusPlan, pairIndex) => runLocalSessionConcurrentComparison(
      corpusPlan,
      options.concurrency,
      {
        ...runtime,
        pairOrder: pairIndex % 2 === 0 ? "baseline-first" : "candidate-first"
      }
    );
  for (let index = 0; index < options.warmups; index += 1) await run(plan, index);
  const runs = [];
  for (let index = 0; index < options.repetitions; index += 1) runs.push(await run(plan, index));
  const metrics = options.profile === "portable"
    ? {
        artifactBytes: summarizeBenchmarkSamples(runs.map((item) => item.artifactBytes)),
        decodeAssertionsPerSecond: summarizeBenchmarkSamples(runs.map((item) => item.decode.assertionsPerSecond)),
        decodeBytesPerSecond: summarizeBenchmarkSamples(runs.map((item) => item.decode.bytesPerSecond)),
        decodeMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.decode.milliseconds)),
        decodeToEncodeLatency: summarizeBenchmarkSamples(runs.map((item) => item.relative.decodeToEncodeLatency)),
        decodeToEncodeThroughput: summarizeBenchmarkSamples(runs.map((item) => item.relative.decodeToEncodeThroughput)),
        encodeAssertionsPerSecond: summarizeBenchmarkSamples(runs.map((item) => item.encode.assertionsPerSecond)),
        encodeBytesPerSecond: summarizeBenchmarkSamples(runs.map((item) => item.encode.bytesPerSecond)),
        encodeCoreMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.encode.coreMilliseconds ?? item.encode.milliseconds)),
        encodeMaterializeMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.encode.materializeMilliseconds ?? 0)),
        encodeMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.encode.milliseconds)),
        preparationMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.preparationMilliseconds)),
        rssBytes: Object.freeze(runs.map((item) => Object.freeze(item.rss)))
      }
    : {
        baselineAssertionsPerSecond: summarizeBenchmarkSamples(runs.map((item) => item.baseline.assertionsPerSecond)),
        baselineColdOpenMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.baseline.coldOpenMilliseconds)),
        baselineIngestionMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.baseline.ingestionMilliseconds)),
        baselineWarmOpenMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.baseline.warmOpenMilliseconds)),
        candidateAssertionsPerSecond: summarizeBenchmarkSamples(runs.map((item) => item.candidate.assertionsPerSecond)),
        candidateColdOpenMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.candidate.coldOpenMilliseconds)),
        candidateIngestionMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.candidate.ingestionMilliseconds)),
        candidateProjectionMilliseconds: summarizeBenchmarkSamples(flatten(runs, (item) => item.candidate.samples.projection)),
        candidateWarmOpenMilliseconds: summarizeBenchmarkSamples(runs.map((item) => item.candidate.warmOpenMilliseconds)),
        concurrentToSequentialThroughput: summarizeBenchmarkSamples(runs.map((item) => item.relative.assertionsPerSecond)),
        concurrentToSequentialLatency: summarizeBenchmarkSamples(runs.map((item) => item.relative.ingestionLatency)),
        pairOrders: Object.freeze(runs.map((item) => item.pairOrder)),
        warmToColdOpen: summarizeBenchmarkSamples(runs.map((item) => item.relative.warmVsColdOpen)),
        rssBytes: Object.freeze(runs.map((item) => Object.freeze({
          baseline: item.baseline.rss,
          candidate: item.candidate.rss
        })))
      };
  return Object.freeze({
    claimEligible: false,
    configuration: Object.freeze({
      argv: Object.freeze([...(runtime.argv ?? [])]),
      concurrency: options.concurrency,
      monotonicClock: "performance.now",
      pairOrdering: options.profile === "local-session-concurrent"
        ? "alternating-baseline-candidate@1"
        : "not-applicable",
      profile: options.profile,
      repetitions: options.repetitions,
      scale: options.scale,
      warmups: options.warmups
    }),
    corpus,
    correctness: Object.freeze(runs.map((item) => Object.freeze(item.correctness))),
    host: hostIdentity(),
    measurementOnly: true,
    metrics: Object.freeze(metrics),
    observedAt: new Date().toISOString(),
    repository: repositoryIdentity(),
    schema: "attunegraph-performance-benchmark@1"
  });
}

async function validateOutputPath(outputPath) {
  const parent = dirname(outputPath);
  const canonicalParent = await realpath(parent);
  if (canonicalParent !== parent) throw new Error("performance output parent must not traverse a symlink");
  const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const fromRepository = relative(repositoryRoot, outputPath);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new Error("performance output must be outside the repository");
  }
  try {
    await lstat(outputPath);
    throw new Error("performance output already exists");
  } catch (cause) {
    if (cause instanceof Error && cause.message === "performance output already exists") throw cause;
    if (!cause || typeof cause !== "object" || cause.code !== "ENOENT") throw cause;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parsePerformanceBenchmarkArguments(argv);
  if (options.outputPath !== undefined) await validateOutputPath(options.outputPath);
  const report = await runPerformanceBenchmark(options, { argv });
  const document = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath === undefined) process.stdout.write(document);
  else await writeFile(options.outputPath, document, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : "performance benchmark failed"}\n`);
    process.exitCode = 1;
  });
}

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

export function parsePerformanceBenchmarkArguments(args) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const values = new Map();
  for (const argument of normalizedArgs) {
    const match = /^--([a-z]+)=(.*)$/u.exec(argument);
    if (!match || !SUPPORTED_ARGUMENTS.has(match[1])) {
      throw new Error(`unsupported performance benchmark argument: ${argument}`);
    }
    if (values.has(match[1])) {
      throw new Error(`duplicate performance benchmark argument: --${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  const scale = boundedInteger(values.get("scale") ?? "", "scale", 1, 1_000_000);
  if (!SUPPORTED_SCALES.has(scale)) {
    throw new Error("scale must be one of 10000, 100000, or 1000000");
  }
  const profile = values.get("profile");
  if (!SUPPORTED_PROFILES.has(profile)) throw new Error("profile is not supported");
  const concurrency = boundedInteger(values.get("concurrency") ?? "1", "concurrency", 1, 32);
  if (profile === "portable" && concurrency !== 1) {
    throw new Error("portable profile concurrency must be 1");
  }
  const outputPath = values.get("output");
  if (outputPath === "" || (outputPath !== undefined && (!isAbsolute(outputPath) || normalize(outputPath) !== outputPath))) {
    throw new Error("output must be an absolute normalized path when supplied");
  }
  return Object.freeze({
    concurrency,
    outputPath,
    profile,
    repetitions: boundedInteger(values.get("repetitions") ?? "3", "repetitions", 1, 10),
    scale,
    warmups: boundedInteger(values.get("warmups") ?? "1", "warmups", 0, 5)
  });
}
