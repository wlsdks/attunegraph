import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { inspectBenchmarkCorpus, createBenchmarkCorpusPlan } from "./benchmark-attunegraph-scale.mjs";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import { captureSourceCheckoutProvenance } from "./source-checkout-provenance.mjs";

const POLICY_URL = new URL("../performance-thresholds.json", import.meta.url);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const CONCURRENT_METRIC_KEYS = [
  "baselineAssertionsPerSecond",
  "baselineColdOpenMilliseconds",
  "baselineIngestionMilliseconds",
  "baselineWarmOpenMilliseconds",
  "candidateAssertionsPerSecond",
  "candidateColdOpenMilliseconds",
  "candidateIngestionMilliseconds",
  "candidateProjectionMilliseconds",
  "candidateWarmOpenMilliseconds",
  "concurrentToSequentialLatency",
  "concurrentToSequentialThroughput",
  "pairOrders",
  "rssBytes",
  "warmToColdOpen"
];
const PORTABLE_METRIC_KEYS = [
  "artifactBytes",
  "decodeAssertionsPerSecond",
  "decodeBytesPerSecond",
  "decodeMilliseconds",
  "decodeToEncodeLatency",
  "decodeToEncodeThroughput",
  "encodeAssertionsPerSecond",
  "encodeBytesPerSecond",
  "encodeCoreMilliseconds",
  "encodeMaterializeMilliseconds",
  "encodeMilliseconds",
  "preparationMilliseconds",
  "rssBytes"
];

function hash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function invalid(message) {
  throw new Error(`invalid performance qualification evidence: ${message}`);
}

function exactKeys(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${name} has unknown or missing fields`);
  }
}

function timestamp(value, name) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) invalid(`${name} must be an exact UTC timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid(`${name} is invalid`);
  return milliseconds;
}

function metric(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(`${name} must be finite and non-negative`);
  return value;
}

function validateSummary(summary, name, expectedSamples) {
  exactKeys(summary, ["max", "min", "p50", "p95", "p99", "samples"], name);
  if (!Array.isArray(summary.samples) || summary.samples.length !== expectedSamples) {
    invalid(`${name}.samples must match repetitions`);
  }
  const samples = summary.samples.map((value) => metric(value, `${name}.samples`));
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
  const expected = {
    max: sorted.at(-1),
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99)
  };
  for (const key of Object.keys(expected)) {
    if (metric(summary[key], `${name}.${key}`) !== expected[key]) invalid(`${name}.${key} does not match raw samples`);
  }
  return summary;
}

function validatePositiveSummary(summary, name, expectedSamples) {
  const validated = validateSummary(summary, name, expectedSamples);
  if (validated.samples.some((value) => value <= 0)) invalid(`${name}.samples must be positive`);
  return validated;
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.ceil(fraction * sorted.length) - 1];
  return {
    max: sorted.at(-1),
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    samples
  };
}

function sameMeasurement(left, right) {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

function recomputeRatioSummary(numerator, denominator, claimed, name) {
  const samples = numerator.samples.map((value, index) => value / denominator.samples[index]);
  if (samples.some((value, index) => !sameMeasurement(value, claimed.samples[index]))) {
    invalid(`${name} ratio does not match recomputed raw measurements`);
  }
  const recomputed = summarize(samples);
  for (const key of ["min", "max", "p50", "p95", "p99"]) {
    if (!sameMeasurement(recomputed[key], claimed[key])) {
      invalid(`${name} ratio summary does not match recomputed raw measurements`);
    }
  }
  return recomputed;
}

function requireComputedSamples(actual, compute, name) {
  actual.samples.forEach((value, index) => {
    const expected = compute(index);
    if (!Number.isFinite(expected) || !sameMeasurement(value, expected)) {
      invalid(`${name} does not match recomputed raw measurements`);
    }
  });
}

function minimumNodeSatisfied(actual, minimum) {
  const parse = (value) => value.replace(/^v/u, "").split(".").map(Number);
  const left = parse(actual);
  const right = parse(minimum);
  if (left.some((part) => !Number.isSafeInteger(part)) || right.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

function validatePolicy(policy) {
  exactKeys(policy, [
    "absolutePerformanceThresholds",
    "absoluteThresholdScope",
    "approvedAt",
    "maximumEvidenceAgeHours",
    "policyId",
    "referenceEnvironment",
    "relativeThresholds",
    "requiredReports",
    "resourceCeilingsByScale",
    "schema"
  ], "policy");
  if (policy.schema !== "attunegraph-performance-policy@2") invalid("policy schema is unsupported");
  if (policy.absoluteThresholdScope !== "resource-ceilings-only") invalid("absolute threshold scope must remain resource-ceilings-only");
  if (typeof policy.policyId !== "string" || policy.policyId.length === 0) invalid("policy id must be a non-empty string");
  timestamp(policy.approvedAt, "policy.approvedAt");
  if (!Number.isSafeInteger(policy.maximumEvidenceAgeHours) || policy.maximumEvidenceAgeHours < 1) invalid("policy evidence age must be a positive integer");
  exactKeys(policy.referenceEnvironment, ["architectures", "minimumCpuCount", "minimumMemoryBytes", "minimumNode", "operatingSystems"], "policy.referenceEnvironment");
  for (const key of ["architectures", "operatingSystems"]) {
    const values = policy.referenceEnvironment[key];
    if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length || values.some((value) => typeof value !== "string" || value.length === 0)) {
      invalid(`policy.referenceEnvironment.${key} must be a unique non-empty string array`);
    }
  }
  positiveSafeInteger(policy.referenceEnvironment.minimumCpuCount, "policy.referenceEnvironment.minimumCpuCount");
  positiveSafeInteger(policy.referenceEnvironment.minimumMemoryBytes, "policy.referenceEnvironment.minimumMemoryBytes");
  if (typeof policy.referenceEnvironment.minimumNode !== "string" || !minimumNodeSatisfied(policy.referenceEnvironment.minimumNode, "0.0.0")) invalid("policy minimum Node version is invalid");
  exactKeys(policy.relativeThresholds, [
    "maximumConcurrentToSequentialLatency",
    "maximumDecodeToEncodeLatency",
    "maximumWarmToColdOpen",
    "minimumConcurrentToSequentialThroughput",
    "minimumDecodeToEncodeThroughput"
  ], "policy.relativeThresholds");
  for (const [key, value] of Object.entries(policy.relativeThresholds)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(`policy.relativeThresholds.${key} must be positive`);
  }
  exactKeys(policy.absolutePerformanceThresholds, ["requiredSummaryFields", "status"], "policy.absolutePerformanceThresholds");
  if (policy.absolutePerformanceThresholds.status !== "pending-independent-calibration") {
    invalid("absolute performance thresholds require a newer approved policy schema");
  }
  const requiredSummaryFields = policy.absolutePerformanceThresholds.requiredSummaryFields;
  if (!Array.isArray(requiredSummaryFields) || requiredSummaryFields.length === 0 || new Set(requiredSummaryFields).size !== requiredSummaryFields.length || requiredSummaryFields.some((value) => typeof value !== "string" || value.length === 0)) {
    invalid("absolute performance required summary fields must be a unique non-empty string array");
  }
  if (!Array.isArray(policy.requiredReports) || policy.requiredReports.length !== 6) invalid("policy must require six reports");
  const slots = new Set();
  for (const requirement of policy.requiredReports) {
    exactKeys(requirement, ["concurrency", "minimumRepetitions", "minimumWarmups", "profile", "scale"], "policy requirement");
    if (!["local-session-concurrent", "portable"].includes(requirement.profile)) invalid("policy requirement profile is unsupported");
    positiveSafeInteger(requirement.scale, "policy requirement scale");
    positiveSafeInteger(requirement.concurrency, "policy requirement concurrency");
    positiveSafeInteger(requirement.minimumRepetitions, "policy requirement repetitions");
    if (!Number.isSafeInteger(requirement.minimumWarmups) || requirement.minimumWarmups < 0) invalid("policy requirement warmups are invalid");
    const slot = `${requirement.profile}:${requirement.scale}`;
    if (slots.has(slot)) invalid("policy contains a duplicate report slot");
    slots.add(slot);
  }
  const scaleKeys = [...new Set(policy.requiredReports.map(({ scale }) => String(scale)))].sort();
  exactKeys(policy.resourceCeilingsByScale, scaleKeys, "policy.resourceCeilingsByScale");
  for (const scale of scaleKeys) {
    const ceiling = policy.resourceCeilingsByScale[scale];
    exactKeys(ceiling, ["maximumSampledPeakRssBytes"], `policy.resourceCeilingsByScale.${scale}`);
    positiveSafeInteger(ceiling.maximumSampledPeakRssBytes, `policy.resourceCeilingsByScale.${scale}.maximumSampledPeakRssBytes`);
  }
}

export function parsePerformanceQualificationArguments(args) {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  let asOf;
  const reportPaths = [];
  for (const argument of normalized) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || !["as-of", "report"].includes(match[1])) throw new Error(`unsupported performance qualifier argument: ${argument}`);
    if (match[1] === "as-of") {
      if (asOf !== undefined) throw new Error("duplicate --as-of");
      asOf = match[2];
    } else reportPaths.push(match[2]);
  }
  if (asOf === undefined) throw new Error("--as-of is required");
  timestamp(asOf, "--as-of");
  if (reportPaths.length !== 6) throw new Error("exactly six --report paths are required");
  if (new Set(reportPaths).size !== reportPaths.length) throw new Error("--report paths must be unique");
  if (reportPaths.some((path) => !isAbsolute(path))) throw new Error("--report paths must be absolute");
  return Object.freeze({ asOf, reportPaths: Object.freeze(reportPaths) });
}

function validateReferenceEnvironment(host, reference) {
  exactKeys(host, ["arch", "cpuCount", "cpuModel", "node", "os", "pnpm", "sqlite", "totalMemoryBytes"], "report.host");
  for (const key of ["arch", "cpuModel", "node", "os", "pnpm"]) {
    if (typeof host[key] !== "string" || host[key].length === 0 || host[key].includes("\0")) invalid(`report.host.${key} must be a non-empty string`);
  }
  if (host.sqlite !== null && (typeof host.sqlite !== "string" || host.sqlite.length === 0 || host.sqlite.includes("\0"))) {
    invalid("report.host.sqlite must be null or a non-empty string");
  }
  if (!reference.operatingSystems.includes(host.os)) invalid("host operating system is outside the approved reference class");
  if (!reference.architectures.includes(host.arch)) invalid("host architecture is outside the approved reference class");
  if (!Number.isSafeInteger(host.cpuCount) || host.cpuCount < reference.minimumCpuCount) invalid("host CPU count is below the approved reference class");
  if (!Number.isSafeInteger(host.totalMemoryBytes) || host.totalMemoryBytes < reference.minimumMemoryBytes) invalid("host memory is below the approved reference class");
  if (!minimumNodeSatisfied(host.node, reference.minimumNode)) invalid("host Node version is below the approved reference class");
}

const RSS_METHOD = "process.resourceUsage.maxRSS-kib-plus-phase-boundaries";
const RSS_SAMPLING = "process-lifetime-high-watermark";

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${name} must be a positive safe integer`);
  return value;
}

function validateLocalRss(rss, name) {
  exactKeys(rss, ["baselineBytes", "finalBytes", "method", "peakBytes", "sampledPeakBytes", "sampling"], name);
  const baseline = positiveSafeInteger(rss.baselineBytes, `${name}.baselineBytes`);
  const final = positiveSafeInteger(rss.finalBytes, `${name}.finalBytes`);
  const peak = positiveSafeInteger(rss.peakBytes, `${name}.peakBytes`);
  if (rss.sampledPeakBytes !== peak || peak < baseline || peak < final) invalid(`${name} peak bytes are inconsistent`);
  if (rss.method !== RSS_METHOD || rss.sampling !== RSS_SAMPLING) invalid(`${name} method or sampling is unsupported`);
}

function validatePortableRss(rss, name) {
  exactKeys(rss, ["afterDecodeBytes", "afterEncodeBytes", "baselineBytes", "method", "peakBytes", "sampledPeakBytes", "sampling"], name);
  const baseline = positiveSafeInteger(rss.baselineBytes, `${name}.baselineBytes`);
  const afterDecode = positiveSafeInteger(rss.afterDecodeBytes, `${name}.afterDecodeBytes`);
  const afterEncode = positiveSafeInteger(rss.afterEncodeBytes, `${name}.afterEncodeBytes`);
  const peak = positiveSafeInteger(rss.peakBytes, `${name}.peakBytes`);
  if (rss.sampledPeakBytes !== peak || peak < baseline || peak < afterDecode || peak < afterEncode) invalid(`${name} peak bytes are inconsistent`);
  if (rss.method !== RSS_METHOD || rss.sampling !== RSS_SAMPLING) invalid(`${name} method or sampling is unsupported`);
}

function validateRss(report, slot) {
  if (!Array.isArray(report.metrics.rssBytes) || report.metrics.rssBytes.length !== report.configuration.repetitions) {
    invalid(`${slot} RSS evidence must match repetitions`);
  }
  if (report.configuration.profile === "portable") {
    report.metrics.rssBytes.forEach((rss, index) => validatePortableRss(rss, `${slot} RSS[${index}]`));
    return;
  }
  report.metrics.rssBytes.forEach((rss, index) => {
    exactKeys(rss, ["baseline", "candidate"], `${slot} RSS[${index}]`);
    validateLocalRss(rss.baseline, `${slot} RSS[${index}].baseline`);
    validateLocalRss(rss.candidate, `${slot} RSS[${index}].candidate`);
  });
}

function validateArgv(configuration) {
  if (!Array.isArray(configuration.argv) || configuration.argv.length === 0 || configuration.argv.some((value) => typeof value !== "string" || value.includes("\0"))) {
    invalid("report argv must be a non-empty exact string vector");
  }
  const args = configuration.argv[0] === "--" ? configuration.argv.slice(1) : configuration.argv;
  const values = new Map();
  for (const argument of args) {
    const match = /^--([a-z]+)=(.*)$/u.exec(argument);
    if (!match || !["concurrency", "output", "profile", "repetitions", "scale", "warmups"].includes(match[1])) invalid("report argv contains an unsupported argument");
    if (values.has(match[1])) invalid("report argv contains a duplicate argument");
    values.set(match[1], match[2]);
  }
  for (const [name, expected] of [
    ["concurrency", configuration.concurrency],
    ["profile", configuration.profile],
    ["repetitions", configuration.repetitions],
    ["scale", configuration.scale],
    ["warmups", configuration.warmups]
  ]) {
    if (values.get(name) !== String(expected)) invalid(`report argv does not bind ${name}`);
  }
  if (values.has("output") && (!isAbsolute(values.get("output")) || resolve(values.get("output")) !== values.get("output"))) {
    invalid("report argv output must be an absolute normalized path");
  }
}

function validateConfiguration(configuration) {
  if (!["local-session-concurrent", "portable"].includes(configuration.profile)) invalid("report profile is unsupported");
  positiveSafeInteger(configuration.scale, "report scale");
  positiveSafeInteger(configuration.concurrency, "report concurrency");
  positiveSafeInteger(configuration.repetitions, "report repetitions");
  if (!Number.isSafeInteger(configuration.warmups) || configuration.warmups < 0) invalid("report warmups are invalid");
  if (typeof configuration.pairOrdering !== "string") invalid("report pair ordering must be a string");
}

function validateRepository(repository, name) {
  exactKeys(repository, ["clean", "commit", "lockfileSha256", "tree"], name);
  if (repository.clean !== true) invalid(`${name} must be clean`);
  if (typeof repository.commit !== "string" || !GIT_OBJECT_ID.test(repository.commit)) invalid(`${name}.commit is invalid`);
  if (typeof repository.tree !== "string" || !GIT_OBJECT_ID.test(repository.tree)) invalid(`${name}.tree is invalid`);
  if (typeof repository.lockfileSha256 !== "string" || !SHA256.test(repository.lockfileSha256)) invalid(`${name}.lockfileSha256 is invalid`);
}

function peakRss(report) {
  if (report.configuration.profile === "portable") {
    return Math.max(...report.metrics.rssBytes.map((entry) => metric(entry.peakBytes, "portable peak RSS")));
  }
  return Math.max(...report.metrics.rssBytes.map((entry) => metric(entry.candidate.peakBytes, "concurrent peak RSS")));
}

export function qualifyPerformanceReports(input, runtime = {}) {
  validatePolicy(input.policy);
  validateRepository(input.currentRepository, "currentRepository");
  const asOfMilliseconds = timestamp(input.asOf, "asOf");
  if (!Array.isArray(input.reports) || input.reports.length !== input.policy.requiredReports.length) invalid("report matrix is incomplete");
  const expectedCorpus = runtime.expectedCorpus
    ?? ((scale) => inspectBenchmarkCorpus(createBenchmarkCorpusPlan(scale)));
  const reportsBySlot = new Map();
  let sharedHost;
  const reportDigests = [];
  for (const artifact of input.reports) {
    if (typeof artifact.bytes !== "string" && !Buffer.isBuffer(artifact.bytes)) invalid("report bytes are required");
    if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256) || hash(artifact.bytes) !== artifact.sha256) {
      invalid("report hash does not match its bytes");
    }
    let report;
    try { report = JSON.parse(artifact.bytes.toString()); } catch { invalid("report bytes must contain JSON"); }
    exactKeys(report, ["claimEligible", "configuration", "corpus", "correctness", "host", "measurementOnly", "metrics", "observedAt", "repository", "schema"], "report");
    if (report.schema !== "attunegraph-performance-benchmark@1" || report.measurementOnly !== true || report.claimEligible !== false) {
      invalid("report must be an unqualified performance measurement");
    }
    exactKeys(report.configuration, ["argv", "concurrency", "monotonicClock", "pairOrdering", "profile", "repetitions", "scale", "warmups"], "report.configuration");
    if (report.configuration.monotonicClock !== "performance.now") invalid("report monotonic clock is unsupported");
    validateConfiguration(report.configuration);
    validateArgv(report.configuration);
    validateRepository(report.repository, "report.repository");
    if (JSON.stringify(report.repository) !== JSON.stringify(input.currentRepository) || report.repository.clean !== true) {
      invalid("report repository does not match the current clean revision");
    }
    const slot = `${report.configuration.profile}:${report.configuration.scale}`;
    if (reportsBySlot.has(slot)) invalid("duplicate performance report slot");
    reportsBySlot.set(slot, report);
    if (JSON.stringify(report.corpus) !== JSON.stringify(expectedCorpus(report.configuration.scale))) invalid("report corpus does not match the deterministic corpus");
    if (!Number.isSafeInteger(report.corpus.shardCount) || report.corpus.shardCount < 1) {
      invalid("report corpus shard count must be a positive integer");
    }
    const observedAt = timestamp(report.observedAt, "report.observedAt");
    if (observedAt > asOfMilliseconds || asOfMilliseconds - observedAt > input.policy.maximumEvidenceAgeHours * 3_600_000) invalid("report is future or stale");
    validateReferenceEnvironment(report.host, input.policy.referenceEnvironment);
    if (sharedHost === undefined) sharedHost = report.host;
    else if (JSON.stringify(sharedHost) !== JSON.stringify(report.host)) invalid("all reports must use the same reference host");
    reportDigests.push(artifact.sha256);
  }

  const failures = [];
  for (const requirement of input.policy.requiredReports) {
    const slot = `${requirement.profile}:${requirement.scale}`;
    const report = reportsBySlot.get(slot);
    if (report === undefined) invalid(`missing required report ${slot}`);
    if (
      report.configuration.concurrency !== requirement.concurrency
      || report.configuration.repetitions < requirement.minimumRepetitions
      || report.configuration.warmups < requirement.minimumWarmups
    ) {
      invalid(`report configuration does not match policy for ${slot}`);
    }
    if (!Array.isArray(report.correctness) || report.correctness.length !== report.configuration.repetitions) invalid(`correctness evidence is incomplete for ${slot}`);
    validateRss(report, slot);
    const thresholds = input.policy.relativeThresholds;
    if (requirement.profile === "local-session-concurrent") {
      exactKeys(report.metrics, CONCURRENT_METRIC_KEYS, `${slot} metrics`);
      if (report.correctness.some((item) => {
        exactKeys(item, ["baselineVerifiedHeads", "candidateMatchesBaseline", "candidateVerifiedHeads", "expectedHeads"], `${slot} correctness item`);
        return item.candidateMatchesBaseline !== true
          || item.expectedHeads !== report.corpus.shardCount
          || item.baselineVerifiedHeads !== report.corpus.shardCount
          || item.candidateVerifiedHeads !== report.corpus.shardCount;
      })) invalid(`concurrent correctness failed for ${slot}`);
      if (report.configuration.pairOrdering !== "alternating-baseline-candidate@1") invalid(`pair ordering is unsupported for ${slot}`);
      if (
        !Array.isArray(report.metrics.pairOrders)
        || report.metrics.pairOrders.length !== report.configuration.repetitions
        || report.metrics.pairOrders.some((order, index) =>
          order !== (index % 2 === 0 ? "baseline-first" : "candidate-first")
        )
      ) invalid(`pair order evidence is incomplete for ${slot}`);
      const repetitions = report.configuration.repetitions;
      const baselineThroughput = validatePositiveSummary(report.metrics.baselineAssertionsPerSecond, `${slot} baseline throughput`, repetitions);
      const candidateThroughput = validatePositiveSummary(report.metrics.candidateAssertionsPerSecond, `${slot} candidate throughput`, repetitions);
      const baselineIngestion = validatePositiveSummary(report.metrics.baselineIngestionMilliseconds, `${slot} baseline ingestion`, repetitions);
      const candidateIngestion = validatePositiveSummary(report.metrics.candidateIngestionMilliseconds, `${slot} candidate ingestion`, repetitions);
      validatePositiveSummary(report.metrics.baselineColdOpenMilliseconds, `${slot} baseline cold open`, repetitions);
      validatePositiveSummary(report.metrics.baselineWarmOpenMilliseconds, `${slot} baseline warm open`, repetitions);
      const candidateColdOpen = validatePositiveSummary(report.metrics.candidateColdOpenMilliseconds, `${slot} candidate cold open`, repetitions);
      const candidateWarmOpen = validatePositiveSummary(report.metrics.candidateWarmOpenMilliseconds, `${slot} candidate warm open`, repetitions);
      validatePositiveSummary(report.metrics.candidateProjectionMilliseconds, `${slot} candidate projection`, repetitions * report.corpus.shardCount);
      const claimedThroughput = validatePositiveSummary(report.metrics.concurrentToSequentialThroughput, `${slot} throughput`, repetitions);
      const claimedLatency = validatePositiveSummary(report.metrics.concurrentToSequentialLatency, `${slot} latency`, repetitions);
      const claimedOpen = validatePositiveSummary(report.metrics.warmToColdOpen, `${slot} open ratio`, repetitions);
      requireComputedSamples(
        baselineThroughput,
        (index) => report.corpus.assertionCount / (baselineIngestion.samples[index] / 1_000),
        `${slot} baseline assertion throughput`
      );
      requireComputedSamples(
        candidateThroughput,
        (index) => report.corpus.assertionCount / (candidateIngestion.samples[index] / 1_000),
        `${slot} candidate assertion throughput`
      );
      const throughput = recomputeRatioSummary(candidateThroughput, baselineThroughput, claimedThroughput, `${slot} throughput`);
      const latency = recomputeRatioSummary(candidateIngestion, baselineIngestion, claimedLatency, `${slot} latency`);
      const open = recomputeRatioSummary(candidateWarmOpen, candidateColdOpen, claimedOpen, `${slot} open`);
      if (throughput.p50 < thresholds.minimumConcurrentToSequentialThroughput) failures.push(`${slot} concurrent throughput ratio is below policy`);
      if (latency.p95 > thresholds.maximumConcurrentToSequentialLatency) failures.push(`${slot} concurrent latency p95 ratio exceeds policy`);
      if (open.p95 > thresholds.maximumWarmToColdOpen) failures.push(`${slot} warm-to-cold open p95 ratio exceeds policy`);
    } else {
      exactKeys(report.metrics, PORTABLE_METRIC_KEYS, `${slot} metrics`);
      if (report.correctness.some((item) => {
        exactKeys(item, ["decodedHeads", "decodedProjections", "summaryMatches"], `${slot} correctness item`);
        return item.summaryMatches !== true
          || item.decodedHeads !== report.corpus.shardCount
          || item.decodedProjections !== report.corpus.shardCount;
      })) invalid(`portable correctness failed for ${slot}`);
      if (report.configuration.pairOrdering !== "not-applicable") invalid(`portable pair ordering must be not-applicable for ${slot}`);
      const repetitions = report.configuration.repetitions;
      const artifactBytes = validatePositiveSummary(report.metrics.artifactBytes, `${slot} artifact bytes`, repetitions);
      if (artifactBytes.samples.some((value) => !Number.isSafeInteger(value))) invalid(`${slot} artifact byte samples must be positive safe integers`);
      const decodeAssertions = validatePositiveSummary(report.metrics.decodeAssertionsPerSecond, `${slot} decode assertions throughput`, repetitions);
      const decodeBytes = validatePositiveSummary(report.metrics.decodeBytesPerSecond, `${slot} decode byte throughput`, repetitions);
      const decodeMilliseconds = validatePositiveSummary(report.metrics.decodeMilliseconds, `${slot} decode latency`, repetitions);
      const claimedDecodeLatency = validatePositiveSummary(report.metrics.decodeToEncodeLatency, `${slot} decode-to-encode latency`, repetitions);
      const claimedDecodeThroughput = validatePositiveSummary(report.metrics.decodeToEncodeThroughput, `${slot} decode-to-encode throughput`, repetitions);
      const encodeAssertions = validatePositiveSummary(report.metrics.encodeAssertionsPerSecond, `${slot} encode assertions throughput`, repetitions);
      const encodeBytes = validatePositiveSummary(report.metrics.encodeBytesPerSecond, `${slot} encode byte throughput`, repetitions);
      const encodeCore = validatePositiveSummary(report.metrics.encodeCoreMilliseconds, `${slot} encode core latency`, repetitions);
      const encodeMaterialize = validatePositiveSummary(report.metrics.encodeMaterializeMilliseconds, `${slot} encode materialization latency`, repetitions);
      const encodeMilliseconds = validatePositiveSummary(report.metrics.encodeMilliseconds, `${slot} encode latency`, repetitions);
      validatePositiveSummary(report.metrics.preparationMilliseconds, `${slot} preparation latency`, repetitions);
      requireComputedSamples(decodeAssertions, (index) => report.corpus.assertionCount / (decodeMilliseconds.samples[index] / 1_000), `${slot} decode assertion throughput`);
      requireComputedSamples(encodeAssertions, (index) => report.corpus.assertionCount / (encodeMilliseconds.samples[index] / 1_000), `${slot} encode assertion throughput`);
      requireComputedSamples(decodeBytes, (index) => artifactBytes.samples[index] / (decodeMilliseconds.samples[index] / 1_000), `${slot} decode byte throughput`);
      requireComputedSamples(encodeBytes, (index) => artifactBytes.samples[index] / (encodeMilliseconds.samples[index] / 1_000), `${slot} encode byte throughput`);
      if (encodeMilliseconds.samples.some((value, index) =>
        encodeCore.samples[index] > value
        || encodeMaterialize.samples[index] > value
        || encodeCore.samples[index] + encodeMaterialize.samples[index] > value + Number.EPSILON * Math.max(1, value) * 8
      )) invalid(`${slot} encode phase latency is inconsistent with total latency`);
      const decodeLatency = recomputeRatioSummary(decodeMilliseconds, encodeMilliseconds, claimedDecodeLatency, `${slot} decode-to-encode latency`);
      const decodeThroughput = recomputeRatioSummary(decodeBytes, encodeBytes, claimedDecodeThroughput, `${slot} decode-to-encode throughput`);
      if (decodeLatency.p95 > thresholds.maximumDecodeToEncodeLatency) failures.push(`${slot} decode-to-encode latency p95 ratio exceeds policy`);
      if (decodeThroughput.p50 < thresholds.minimumDecodeToEncodeThroughput) failures.push(`${slot} decode-to-encode throughput ratio is below policy`);
    }
    const ceiling = input.policy.resourceCeilingsByScale[String(requirement.scale)]?.maximumSampledPeakRssBytes;
    if (!Number.isSafeInteger(ceiling)) invalid(`resource ceiling is missing for ${slot}`);
    if (peakRss(report) > Math.min(ceiling, report.host.totalMemoryBytes * 0.5)) failures.push(`${slot} peak RSS exceeds policy or half of host memory`);
  }
  return Object.freeze({
    asOf: input.asOf,
    failures: Object.freeze(failures),
    policy: Object.freeze({ id: input.policy.policyId, sha256: hash(`${JSON.stringify(input.policy, null, 2)}\n`) }),
    integrityQualified: true,
    performanceBlockers: Object.freeze([
      ...failures,
      "absolute-throughput-latency-thresholds-not-independently-calibrated"
    ]),
    performanceQualified: false,
    relativePolicyQualified: failures.length === 0,
    reports: Object.freeze(reportDigests),
    repository: input.currentRepository,
    schema: "attunegraph-performance-qualification@2"
  });
}

function currentRepository() {
  return captureSourceCheckoutProvenance().repository;
}

function loadArtifacts(paths) {
  const seen = new Set();
  return paths.map((path) => {
    const lexical = resolve(path);
    const stat = lstatSync(lexical);
    if (!stat.isFile() || stat.isSymbolicLink()) invalid("report path must be a regular non-symlink file");
    const canonical = realpathSync(lexical);
    if (seen.has(canonical)) invalid("report paths must resolve uniquely");
    seen.add(canonical);
    const bytes = readFileSync(canonical);
    return { bytes, sha256: hash(bytes) };
  });
}

function main() {
  const options = parsePerformanceQualificationArguments(process.argv.slice(2));
  const policyBytes = readFileSync(POLICY_URL);
  const policy = JSON.parse(policyBytes.toString("utf8"));
  const result = qualifyPerformanceReports({
    asOf: options.asOf,
    currentRepository: currentRepository(),
    policy,
    reports: loadArtifacts(options.reportPaths)
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.performanceQualified) process.exitCode = 1;
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  try { main(); } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "performance qualification failed"}\n`);
    process.exitCode = 1;
  }
}
