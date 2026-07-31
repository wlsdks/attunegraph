import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectBenchmarkCorpus, createBenchmarkCorpusPlan } from "./benchmark-attunegraph-scale.mjs";

const POLICY_URL = new URL("../performance-thresholds.json", import.meta.url);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

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
  if (policy.schema !== "attunegraph-performance-policy@1") invalid("policy schema is unsupported");
  if (policy.absoluteThresholdScope !== "resource-ceilings-only") invalid("absolute threshold scope must remain resource-ceilings-only");
  timestamp(policy.approvedAt, "policy.approvedAt");
  if (!Array.isArray(policy.requiredReports) || policy.requiredReports.length !== 6) invalid("policy must require six reports");
  const slots = new Set();
  for (const requirement of policy.requiredReports) {
    exactKeys(requirement, ["concurrency", "minimumRepetitions", "minimumWarmups", "profile", "scale"], "policy requirement");
    const slot = `${requirement.profile}:${requirement.scale}`;
    if (slots.has(slot)) invalid("policy contains a duplicate report slot");
    slots.add(slot);
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
  if (!reference.operatingSystems.includes(host.os)) invalid("host operating system is outside the approved reference class");
  if (!reference.architectures.includes(host.arch)) invalid("host architecture is outside the approved reference class");
  if (!Number.isSafeInteger(host.cpuCount) || host.cpuCount < reference.minimumCpuCount) invalid("host CPU count is below the approved reference class");
  if (!Number.isSafeInteger(host.totalMemoryBytes) || host.totalMemoryBytes < reference.minimumMemoryBytes) invalid("host memory is below the approved reference class");
  if (!minimumNodeSatisfied(host.node, reference.minimumNode)) invalid("host Node version is below the approved reference class");
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
}

function peakRss(report) {
  if (report.configuration.profile === "portable") {
    return Math.max(...report.metrics.rssBytes.map((entry) => metric(entry.peakBytes, "portable peak RSS")));
  }
  return Math.max(...report.metrics.rssBytes.map((entry) => metric(entry.candidate.peakBytes, "concurrent peak RSS")));
}

export function qualifyPerformanceReports(input, runtime = {}) {
  validatePolicy(input.policy);
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
    validateArgv(report.configuration);
    if (JSON.stringify(report.repository) !== JSON.stringify(input.currentRepository) || report.repository.clean !== true) {
      invalid("report repository does not match the current clean revision");
    }
    const slot = `${report.configuration.profile}:${report.configuration.scale}`;
    if (reportsBySlot.has(slot)) invalid("duplicate performance report slot");
    reportsBySlot.set(slot, report);
    if (JSON.stringify(report.corpus) !== JSON.stringify(expectedCorpus(report.configuration.scale))) invalid("report corpus does not match the deterministic corpus");
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
    const thresholds = input.policy.relativeThresholds;
    if (requirement.profile === "local-session-concurrent") {
      if (report.correctness.some((item) => item.candidateMatchesBaseline !== true || item.baselineVerifiedHeads !== item.expectedHeads || item.candidateVerifiedHeads !== item.expectedHeads)) invalid(`concurrent correctness failed for ${slot}`);
      if (report.configuration.pairOrdering !== "alternating-baseline-candidate@1") invalid(`pair ordering is unsupported for ${slot}`);
      if (
        !Array.isArray(report.metrics.pairOrders)
        || report.metrics.pairOrders.length !== report.configuration.repetitions
        || !report.metrics.pairOrders.includes("baseline-first")
        || !report.metrics.pairOrders.includes("candidate-first")
        || report.metrics.pairOrders.some((order) => !["baseline-first", "candidate-first"].includes(order))
      ) invalid(`pair order evidence is incomplete for ${slot}`);
      const throughput = validateSummary(report.metrics.concurrentToSequentialThroughput, `${slot} throughput`, report.configuration.repetitions);
      const latency = validateSummary(report.metrics.concurrentToSequentialLatency, `${slot} latency`, report.configuration.repetitions);
      const open = validateSummary(report.metrics.warmToColdOpen, `${slot} open ratio`, report.configuration.repetitions);
      if (throughput.p50 < thresholds.minimumConcurrentToSequentialThroughput) failures.push(`${slot} concurrent throughput ratio is below policy`);
      if (latency.p95 > thresholds.maximumConcurrentToSequentialLatency) failures.push(`${slot} concurrent latency p95 ratio exceeds policy`);
      if (open.p95 > thresholds.maximumWarmToColdOpen) failures.push(`${slot} warm-to-cold open p95 ratio exceeds policy`);
    } else {
      if (report.correctness.some((item) => item.summaryMatches !== true || item.decodedHeads !== item.decodedProjections)) invalid(`portable correctness failed for ${slot}`);
      if (report.configuration.pairOrdering !== "not-applicable") invalid(`portable pair ordering must be not-applicable for ${slot}`);
      const decodeLatency = validateSummary(report.metrics.decodeToEncodeLatency, `${slot} decode latency`, report.configuration.repetitions);
      const decodeThroughput = validateSummary(report.metrics.decodeToEncodeThroughput, `${slot} decode throughput`, report.configuration.repetitions);
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
    qualified: failures.length === 0,
    reports: Object.freeze(reportDigests),
    repository: input.currentRepository,
    schema: "attunegraph-performance-qualification@1"
  });
}

function currentRepository() {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return {
    clean: git("status", "--porcelain=v1", "--untracked-files=all") === "",
    commit: git("rev-parse", "HEAD"),
    lockfileSha256: hash(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url))),
    tree: git("rev-parse", "HEAD^{tree}")
  };
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
  if (!result.qualified) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : "performance qualification failed"}\n`);
    process.exitCode = 1;
  }
}
