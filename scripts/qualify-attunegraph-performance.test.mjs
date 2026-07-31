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
    corpus: { schema: "fixture-corpus", assertionCount: requirement.scale },
    correctness: Array.from({ length: repetitions }, () => concurrent
      ? { baselineVerifiedHeads: 1, candidateMatchesBaseline: true, candidateVerifiedHeads: 1, expectedHeads: 1 }
      : { decodedHeads: 1, decodedProjections: 1, summaryMatches: true }),
    host: HOST,
    measurementOnly: true,
    metrics: concurrent
      ? {
          concurrentToSequentialThroughput: summary(1, repetitions),
          concurrentToSequentialLatency: summary(1, repetitions),
          pairOrders: ["baseline-first", "candidate-first"],
          warmToColdOpen: summary(1, repetitions),
          rssBytes: Array.from({ length: repetitions }, () => ({ candidate: { peakBytes: 256 * 1024 ** 2 } }))
        }
      : {
          decodeToEncodeLatency: summary(2, repetitions),
          decodeToEncodeThroughput: summary(0.5, repetitions),
          rssBytes: Array.from({ length: repetitions }, () => ({ peakBytes: 256 * 1024 ** 2 }))
        },
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
    }, { expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale }) }))
      .toMatchObject({ qualified: true, failures: [], schema: "attunegraph-performance-qualification@1" });
  });

  it("fails closed on thresholds, report bytes, revision drift, and duplicate matrix slots", () => {
    const slow = reports();
    slow[0].report.metrics.concurrentToSequentialThroughput = summary(0.1, 2);
    slow[0].bytes = `${JSON.stringify(slow[0].report)}\n`;
    slow[0].sha256 = digest(slow[0].bytes);
    expect(qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: slow }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale })
    })).toMatchObject({ qualified: false, failures: [expect.stringMatching(/throughput/u)] });

    const tampered = reports();
    tampered[0].bytes += " ";
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: tampered }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale })
    })).toThrow(/hash/u);

    const drifted = reports();
    drifted[0].report.repository = { ...REPOSITORY, commit: "d".repeat(40) };
    drifted[0].bytes = `${JSON.stringify(drifted[0].report)}\n`;
    drifted[0].sha256 = digest(drifted[0].bytes);
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: drifted }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale })
    })).toThrow(/repository/u);

    const duplicate = reports();
    duplicate[1] = report(policy.requiredReports[0]);
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: duplicate }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale })
    })).toThrow(/duplicate/u);

    const oneSided = reports();
    oneSided[0].report.metrics.pairOrders = ["baseline-first", "baseline-first"];
    oneSided[0].bytes = `${JSON.stringify(oneSided[0].report)}\n`;
    oneSided[0].sha256 = digest(oneSided[0].bytes);
    expect(() => qualifyPerformanceReports({ asOf: AS_OF, currentRepository: REPOSITORY, policy, reports: oneSided }, {
      expectedCorpus: (scale) => ({ schema: "fixture-corpus", assertionCount: scale })
    })).toThrow(/pair order/u);
  });
});
