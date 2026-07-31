import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parsePerformanceQualificationArguments,
  qualifyPerformanceReports
} from "./qualify-attunegraph-performance.mjs";
import policy from "../performance-thresholds.json" with { type: "json" };

const AS_OF = "2026-08-02T00:00:00.000Z";
const REPOSITORY = {
  clean: true,
  commit: "a".repeat(40),
  lockfileSha256: `sha256:${"b".repeat(64)}`,
  tree: "c".repeat(40)
};
const HOST = {
  arch: "arm64",
  cpuCount: 8,
  cpuModel: "test-reference-cpu",
  node: "24.15.0",
  os: "darwin",
  pnpm: "10.18.0",
  sqlite: "3.50.4",
  totalMemoryBytes: 16 * 1024 ** 3
};

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function summary(value, repetitions = 1) {
  const samples = Array.from({ length: repetitions }, () => value);
  return { max: value, min: value, p50: value, p95: value, p99: value, samples };
}

function summaryOf(samples) {
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

function localRss() {
  return {
    baselineBytes: 128 * 1024 ** 2,
    finalBytes: 192 * 1024 ** 2,
    method: "process.resourceUsage.maxRSS-kib-plus-phase-boundaries",
    peakBytes: 256 * 1024 ** 2,
    sampledPeakBytes: 256 * 1024 ** 2,
    sampling: "process-lifetime-high-watermark"
  };
}

function portableRss() {
  return {
    afterDecodeBytes: 224 * 1024 ** 2,
    afterEncodeBytes: 192 * 1024 ** 2,
    baselineBytes: 128 * 1024 ** 2,
    method: "process.resourceUsage.maxRSS-kib-plus-phase-boundaries",
    peakBytes: 256 * 1024 ** 2,
    sampledPeakBytes: 256 * 1024 ** 2,
    sampling: "process-lifetime-high-watermark"
  };
}

function report(requirement) {
  const concurrent = requirement.profile === "local-session-concurrent";
  const repetitions = requirement.minimumRepetitions;
  const argv = [
    "--",
    `--scale=${requirement.scale}`,
    `--profile=${requirement.profile}`,
    `--concurrency=${requirement.concurrency}`,
    `--warmups=${requirement.minimumWarmups}`,
    `--repetitions=${repetitions}`,
    `--output=/tmp/${requirement.profile}-${requirement.scale}.json`
  ];
  const document = {
    claimEligible: false,
    configuration: {
      argv,
      concurrency: requirement.concurrency,
      monotonicClock: "performance.now",
      pairOrdering: concurrent ? "alternating-baseline-candidate@1" : "not-applicable",
      profile: requirement.profile,
      repetitions,
      scale: requirement.scale,
      warmups: requirement.minimumWarmups
    },
    corpus: { schema: "fixture-corpus", assertionCount: requirement.scale, shardCount: 1 },
    correctness: Array.from({ length: repetitions }, () => concurrent
      ? { baselineVerifiedHeads: 1, candidateMatchesBaseline: true, candidateVerifiedHeads: 1, expectedHeads: 1 }
      : { decodedHeads: 1, decodedProjections: 1, summaryMatches: true }),
    host: { ...HOST },
    measurementOnly: true,
    metrics: concurrent
      ? (() => {
          const baselineIngestion = Array.from({ length: repetitions }, (_, index) => 10 + index);
          const candidateIngestion = baselineIngestion.map((value) => value);
          const baselineAssertions = baselineIngestion.map((value) => requirement.scale / (value / 1_000));
          const candidateAssertions = candidateIngestion.map((value) => requirement.scale / (value / 1_000));
          const coldOpen = Array.from({ length: repetitions }, () => 2);
          const warmOpen = coldOpen.map((value) => value);
          return {
            baselineAssertionsPerSecond: summaryOf(baselineAssertions),
            baselineColdOpenMilliseconds: summaryOf(coldOpen),
            baselineIngestionMilliseconds: summaryOf(baselineIngestion),
            baselineWarmOpenMilliseconds: summaryOf(warmOpen),
            candidateAssertionsPerSecond: summaryOf(candidateAssertions),
            candidateColdOpenMilliseconds: summaryOf(coldOpen),
            candidateIngestionMilliseconds: summaryOf(candidateIngestion),
            candidateProjectionMilliseconds: summaryOf(Array.from({ length: repetitions }, () => 1)),
            candidateWarmOpenMilliseconds: summaryOf(warmOpen),
            concurrentToSequentialThroughput: summaryOf(candidateAssertions.map((value, index) => value / baselineAssertions[index])),
            concurrentToSequentialLatency: summaryOf(candidateIngestion.map((value, index) => value / baselineIngestion[index])),
            pairOrders: Array.from({ length: repetitions }, (_, index) => index % 2 === 0 ? "baseline-first" : "candidate-first"),
            warmToColdOpen: summaryOf(warmOpen.map((value, index) => value / coldOpen[index])),
            rssBytes: Array.from({ length: repetitions }, () => ({ baseline: localRss(), candidate: localRss() }))
          };
        })()
      : (() => {
          const artifactBytes = Array.from({ length: repetitions }, () => 1_000);
          const encodeMilliseconds = Array.from({ length: repetitions }, () => 10);
          const decodeMilliseconds = Array.from({ length: repetitions }, () => 20);
          const encodeBytesPerSecond = artifactBytes.map((value, index) => value / (encodeMilliseconds[index] / 1_000));
          const decodeBytesPerSecond = artifactBytes.map((value, index) => value / (decodeMilliseconds[index] / 1_000));
          return {
            artifactBytes: summaryOf(artifactBytes),
            decodeAssertionsPerSecond: summaryOf(decodeMilliseconds.map((value) => requirement.scale / (value / 1_000))),
            decodeBytesPerSecond: summaryOf(decodeBytesPerSecond),
            decodeMilliseconds: summaryOf(decodeMilliseconds),
            decodeToEncodeLatency: summaryOf(decodeMilliseconds.map((value, index) => value / encodeMilliseconds[index])),
            decodeToEncodeThroughput: summaryOf(decodeBytesPerSecond.map((value, index) => value / encodeBytesPerSecond[index])),
            encodeAssertionsPerSecond: summaryOf(encodeMilliseconds.map((value) => requirement.scale / (value / 1_000))),
            encodeBytesPerSecond: summaryOf(encodeBytesPerSecond),
            encodeCoreMilliseconds: summaryOf(Array.from({ length: repetitions }, () => 9)),
            encodeMaterializeMilliseconds: summaryOf(Array.from({ length: repetitions }, () => 1)),
            encodeMilliseconds: summaryOf(encodeMilliseconds),
            preparationMilliseconds: summaryOf(Array.from({ length: repetitions }, () => 5)),
            rssBytes: Array.from({ length: repetitions }, () => portableRss())
          };
        })(),
    observedAt: "2026-08-01T00:00:00.000Z",
    repository: REPOSITORY,
    schema: "attunegraph-performance-benchmark@1"
  };
  const bytes = `${JSON.stringify(document)}\n`;
  return { bytes, report: document, sha256: digest(bytes) };
}

function reports() {
  return policy.requiredReports.map((requirement) => report(requirement));
}

describe("AttuneGraph performance qualification", () => {
  it("requires an explicit time and six unique report paths", () => {
    const parsed = parsePerformanceQualificationArguments([
      `--as-of=${AS_OF}`,
      ...policy.requiredReports.map((_, index) => `--report=/tmp/report-${index}.json`)
    ]);
    expect(parsed.asOf).toBe(AS_OF);
    expect(parsed.reportPaths).toHaveLength(6);
    expect(() => parsePerformanceQualificationArguments([`--as-of=${AS_OF}`])).toThrow(/six/u);
    expect(() => parsePerformanceQualificationArguments([
      `--as-of=${AS_OF}`,
      ...Array.from({ length: 6 }, () => "--report=/tmp/same.json")
    ])).toThrow(/unique/u);
  });

  it("qualifies only the complete revision-bound matrix against the approved policy", () => {
    expect(qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: reports()
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toMatchObject({
        integrityQualified: true,
        relativePolicyQualified: true,
        performanceQualified: false,
        failures: [],
        performanceBlockers: ["absolute-throughput-latency-thresholds-not-independently-calibrated"],
        schema: "attunegraph-performance-qualification@2"
      });
  });

  it("rejects the evaluator's self-authored minimal report reproduction", () => {
    const forged = reports();
    forged[0].report.metrics = {
      concurrentToSequentialThroughput: summary(1, 2),
      concurrentToSequentialLatency: summary(1, 2),
      pairOrders: ["baseline-first", "candidate-first"],
      warmToColdOpen: summary(1, 2),
      rssBytes: [{ candidate: { peakBytes: 256 * 1024 ** 2 } }, { candidate: { peakBytes: 256 * 1024 ** 2 } }]
    };
    forged[0].bytes = `${JSON.stringify(forged[0].report)}\n`;
    forged[0].sha256 = digest(forged[0].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: forged
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/unknown or missing/iu);
  });

  it("requires the producer's exact alternating pair order for every repetition", () => {
    const reordered = reports();
    reordered[0].report.metrics.pairOrders = ["candidate-first", "baseline-first"];
    reordered[0].bytes = `${JSON.stringify(reordered[0].report)}\n`;
    reordered[0].sha256 = digest(reordered[0].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: reordered
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/pair order/iu);
  });

  it("binds concurrent correctness counts to the deterministic corpus shard count", () => {
    const inconsistent = reports();
    inconsistent[0].report.correctness = inconsistent[0].report.correctness.map(() => ({
      baselineVerifiedHeads: 2,
      candidateMatchesBaseline: true,
      candidateVerifiedHeads: 2,
      expectedHeads: 2
    }));
    inconsistent[0].bytes = `${JSON.stringify(inconsistent[0].report)}\n`;
    inconsistent[0].sha256 = digest(inconsistent[0].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: inconsistent
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/correctness/iu);
  });

  it("rejects zero portable convergence counts even when the claimed counts agree", () => {
    const inconsistent = reports();
    const portableIndex = policy.requiredReports.findIndex(({ profile }) => profile === "portable");
    inconsistent[portableIndex].report.correctness = [{
      decodedHeads: 0,
      decodedProjections: 0,
      summaryMatches: true
    }];
    inconsistent[portableIndex].bytes = `${JSON.stringify(inconsistent[portableIndex].report)}\n`;
    inconsistent[portableIndex].sha256 = digest(inconsistent[portableIndex].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: inconsistent
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/correctness/iu);
  });

  it("recomputes concurrent ratios from raw baseline, candidate, and open measurements", () => {
    const inconsistent = reports();
    inconsistent[0].report.metrics.candidateIngestionMilliseconds = summaryOf([100, 110]);
    inconsistent[0].report.metrics.candidateAssertionsPerSecond = summaryOf([100_000, 10_000 / 0.11]);
    inconsistent[0].report.metrics.candidateWarmOpenMilliseconds = summary(10, 2);
    inconsistent[0].bytes = `${JSON.stringify(inconsistent[0].report)}\n`;
    inconsistent[0].sha256 = digest(inconsistent[0].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: inconsistent
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/recomputed.*ratio|ratio.*raw/iu);
  });

  it("recomputes portable ratios from raw encode and decode measurements", () => {
    const inconsistent = reports();
    const portableIndex = policy.requiredReports.findIndex(({ profile }) => profile === "portable");
    inconsistent[portableIndex].report.metrics.decodeMilliseconds = summary(100);
    inconsistent[portableIndex].report.metrics.decodeAssertionsPerSecond = summary(100_000);
    inconsistent[portableIndex].report.metrics.decodeBytesPerSecond = summary(10_000);
    inconsistent[portableIndex].bytes = `${JSON.stringify(inconsistent[portableIndex].report)}\n`;
    inconsistent[portableIndex].sha256 = digest(inconsistent[portableIndex].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: inconsistent
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/recomputed.*ratio|ratio.*raw/iu);
  });

  it("rejects unknown fields in trusted host and nested RSS evidence", () => {
    const hostExtra = reports();
    hostExtra[0].report.host.untrusted = "accepted-before-fix";
    hostExtra[0].bytes = `${JSON.stringify(hostExtra[0].report)}\n`;
    hostExtra[0].sha256 = digest(hostExtra[0].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: hostExtra
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/host.*unknown or missing/iu);

    const rssExtra = reports();
    rssExtra[0].report.metrics.rssBytes[0].candidate.untrusted = 1;
    rssExtra[0].bytes = `${JSON.stringify(rssExtra[0].report)}\n`;
    rssExtra[0].sha256 = digest(rssExtra[0].bytes);
    expect(() => qualifyPerformanceReports({
      asOf: AS_OF,
      currentRepository: REPOSITORY,
      policy,
      reports: rssExtra
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 }) }))
      .toThrow(/RSS.*unknown or missing/iu);
  });

  it("fails closed on thresholds, report bytes, revision drift, and duplicate matrix slots", () => {
    const slow = reports();
    slow[0].report.metrics.candidateIngestionMilliseconds = summaryOf([100, 110]);
    slow[0].report.metrics.candidateAssertionsPerSecond = summaryOf([100_000, 10_000 / 0.11]);
    slow[0].report.metrics.concurrentToSequentialThroughput = summary(0.1, 2);
    slow[0].report.metrics.concurrentToSequentialLatency = summary(10, 2);
    slow[0].bytes = `${JSON.stringify(slow[0].report)}\n`;
    slow[0].sha256 = digest(slow[0].bytes);
    expect(qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: slow }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 })
    })).toMatchObject({
      integrityQualified: true,
      relativePolicyQualified: false,
      performanceQualified: false,
      failures: expect.arrayContaining([expect.stringMatching(/throughput/u)])
    });

    const tampered = reports();
    tampered[0].bytes += " ";
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: tampered }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 })
    })).toThrow(/hash/u);

    const drifted = reports();
    drifted[0].report.repository = { ...REPOSITORY, commit: "d".repeat(40) };
    drifted[0].bytes = `${JSON.stringify(drifted[0].report)}\n`;
    drifted[0].sha256 = digest(drifted[0].bytes);
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: drifted }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 })
    })).toThrow(/repository/u);

    const duplicate = reports();
    duplicate[1] = report(policy.requiredReports[0]);
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: duplicate }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 })
    })).toThrow(/duplicate/u);

    const oneSided = reports();
    oneSided[0].report.metrics.pairOrders = ["baseline-first", "baseline-first"];
    oneSided[0].bytes = `${JSON.stringify(oneSided[0].report)}\n`;
    oneSided[0].sha256 = digest(oneSided[0].bytes);
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: oneSided }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale, shardCount: 1 })
    })).toThrow(/pair order/u);
  });
});
