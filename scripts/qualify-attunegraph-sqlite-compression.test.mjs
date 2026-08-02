import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";

import {
  evaluateSelectedIntegrationGate,
  summarizeSettledScaleEvidence
} from "./qualify-attunegraph-sqlite-compression.mjs";

function ratios(value) {
  return {
    projection: { p50: value, p95: value, p99: value },
    warmRead: { p50: value, p95: value, p99: value },
    coldReopenedRead: { p50: value, p95: value, p99: value }
  };
}

it("gates selected v2 integration on p50 and p95 while monitoring p99", () => {
  expect(evaluateSelectedIntegrationGate(ratios(1.2))).toMatchObject({
    ceiling: 1.2,
    gatePercentiles: ["p50", "p95"],
    monitoringPercentiles: ["p99"],
    passes: true
  });
  expect(evaluateSelectedIntegrationGate({
    ...ratios(1),
    warmRead: { p50: 1.01, p95: 1.201, p99: 0.5 }
  })).toMatchObject({ passes: false });
  expect(evaluateSelectedIntegrationGate({
    ...ratios(1),
    warmRead: { p50: 1, p95: 1, p99: 99 }
  })).toMatchObject({ passes: true });
});

it("rejects malformed integration gate evidence", () => {
  expect(() => evaluateSelectedIntegrationGate({})).toThrow("invalid");
  expect(() => evaluateSelectedIntegrationGate(ratios(1), 0.9)).toThrow("invalid");
});

function scaleReport() {
  return {
    schema: "attunegraph-scale-benchmark@1",
    claimEligible: false,
    measurementOnly: true,
    observedAt: "2026-08-02T00:00:00.000Z",
    repository: {
      clean: false,
      commit: "a".repeat(40),
      tree: "b".repeat(40),
      lockfileSha256: `sha256:${"c".repeat(64)}`
    },
    host: {
      arch: "arm64",
      cpuCount: 12,
      cpuModel: "Apple M2 Max",
      node: "24.16.0",
      os: "darwin",
      pnpm: "10.18.0",
      sqlite: "3.53.0",
      totalMemoryBytes: 1
    },
    configuration: {
      profile: "local-session",
      repetitions: 1,
      scale: 10_000,
      warmups: 0
    },
    corpus: {
      schema: "attunegraph-benchmark-corpus-manifest@1",
      assertionCount: 10_000,
      maxAssertionsPerShard: 32,
      seed: "thread-rooted-hot-and-cold@1",
      sha256: `sha256:${"d".repeat(64)}`,
      shardCount: 313
    },
    metrics: {
      databaseBytes: [{ database: 1_597_440, sharedMemory: 0, writeAheadLog: 0 }]
    },
    operations: { projectedAssertions: 10_000, projections: 313 }
  };
}

it("produces a deterministic bounded settled-scale summary with exact provenance", () => {
  const report = scaleReport();
  const physical = { journalRows: 313, pageCount: 390, pageSizeBytes: 4096, userVersion: 2 };
  const args = ["--scale-evidence=all", "--json"];
  const first = summarizeSettledScaleEvidence(report, physical, args, "1.3.1");
  const second = summarizeSettledScaleEvidence(
    JSON.parse(JSON.stringify(report)),
    { ...physical },
    [...args],
    "1.3.1"
  );
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  expect(first).toMatchObject({
    scale: 10_000,
    corpus: { seed: "thread-rooted-hot-and-cold@1", shardCount: 313 },
    command: { args },
    storage: {
      journalRows: 313,
      pages: 390,
      databaseBytes: 1_597_440,
      writeAheadLogBytes: 0,
      sharedMemoryBytes: 0
    },
    rawProvenance: {
      schema: "attunegraph-scale-benchmark@1",
      byteLength: expect.any(Number),
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
    }
  });
  expect(first.rawProvenance.byteLength).toBeLessThanOrEqual(
    first.rawProvenance.maximumBytes
  );
});

it("fails closed on missing or malformed scale provenance", () => {
  const report = scaleReport();
  const physical = { journalRows: 313, pageCount: 390, pageSizeBytes: 4096, userVersion: 2 };
  expect(() => summarizeSettledScaleEvidence(
    { ...report, repository: undefined }, physical, ["--json"], "1.3.1"
  )).toThrow("provenance");
  expect(() => summarizeSettledScaleEvidence(
    report, { ...physical, journalRows: 312 }, ["--json"], "1.3.1"
  )).toThrow("physical observation");
  expect(() => summarizeSettledScaleEvidence(
    report, physical, ["--json"], undefined
  )).toThrow("provenance");
});

it.each([
  ["missing observed time", (report) => ({ ...report, observedAt: undefined })],
  ["missing corpus schema", (report) => ({
    ...report,
    corpus: { ...report.corpus, schema: undefined }
  })],
  ["missing corpus identity", (report) => ({
    ...report,
    corpus: { ...report.corpus, seed: undefined }
  })],
  ["missing corpus hash", (report) => ({
    ...report,
    corpus: { ...report.corpus, sha256: undefined }
  })],
  ["missing corpus assertion count", (report) => ({
    ...report,
    corpus: { ...report.corpus, assertionCount: undefined }
  })],
  ["missing corpus shard count", (report) => ({
    ...report,
    corpus: { ...report.corpus, shardCount: undefined }
  })],
  ["missing corpus shard ceiling", (report) => ({
    ...report,
    corpus: { ...report.corpus, maxAssertionsPerShard: undefined }
  })],
  ["missing commit", (report) => ({
    ...report,
    repository: { ...report.repository, commit: undefined }
  })],
  ["missing tree", (report) => ({
    ...report,
    repository: { ...report.repository, tree: undefined }
  })],
  ["missing lock hash", (report) => ({
    ...report,
    repository: { ...report.repository, lockfileSha256: undefined }
  })],
  ["missing host identity", (report) => ({
    ...report,
    host: { ...report.host, node: undefined }
  })]
])("fails closed on %s", (_label, mutate) => {
  const physical = { journalRows: 313, pageCount: 390, pageSizeBytes: 4096, userVersion: 2 };
  expect(() => summarizeSettledScaleEvidence(
    mutate(scaleReport()), physical, ["--json"], "1.3.1"
  )).toThrow("provenance");
});

it.each([
  ["empty observed time", (report) => ({ ...report, observedAt: "" })],
  ["empty corpus schema", (report) => ({
    ...report,
    corpus: { ...report.corpus, schema: "" }
  })],
  ["empty corpus seed", (report) => ({
    ...report,
    corpus: { ...report.corpus, seed: "" }
  })],
  ["empty corpus hash", (report) => ({
    ...report,
    corpus: { ...report.corpus, sha256: "" }
  })],
  ["empty corpus assertion count", (report) => ({
    ...report,
    corpus: { ...report.corpus, assertionCount: "" }
  })],
  ["empty corpus shard count", (report) => ({
    ...report,
    corpus: { ...report.corpus, shardCount: "" }
  })],
  ["empty corpus shard ceiling", (report) => ({
    ...report,
    corpus: { ...report.corpus, maxAssertionsPerShard: "" }
  })],
  ["empty commit", (report) => ({
    ...report,
    repository: { ...report.repository, commit: "" }
  })],
  ["empty tree", (report) => ({
    ...report,
    repository: { ...report.repository, tree: "" }
  })],
  ["empty runtime identity", (report) => ({
    ...report,
    host: { ...report.host, sqlite: "" }
  })]
])("fails closed on %s", (_label, mutate) => {
  const physical = { journalRows: 313, pageCount: 390, pageSizeBytes: 4096, userVersion: 2 };
  expect(() => summarizeSettledScaleEvidence(
    mutate(scaleReport()), physical, ["--json"], "1.3.1"
  )).toThrow("provenance");
});

it.each([
  ["non-roundtripping UTC timestamp", (report) => ({
    ...report,
    observedAt: "2026-02-30T00:00:00.000Z"
  })],
  ["uppercase commit", (report) => ({
    ...report,
    repository: { ...report.repository, commit: "A".repeat(40) }
  })],
  ["short tree", (report) => ({
    ...report,
    repository: { ...report.repository, tree: "b".repeat(39) }
  })],
  ["malformed lock hash", (report) => ({
    ...report,
    repository: { ...report.repository, lockfileSha256: `sha256:${"G".repeat(64)}` }
  })],
  ["malformed corpus hash", (report) => ({
    ...report,
    corpus: { ...report.corpus, sha256: "d".repeat(64) }
  })],
  ["inconsistent shard count", (report) => ({
    ...report,
    corpus: { ...report.corpus, shardCount: 312 },
    operations: { ...report.operations, projections: 312 }
  })],
  ["unsafe corpus count", (report) => ({
    ...report,
    corpus: { ...report.corpus, maxAssertionsPerShard: Number.MAX_SAFE_INTEGER + 1 }
  })],
  ["unexpected host field", (report) => ({
    ...report,
    host: { ...report.host, unexpected: "identity" }
  })]
])("fails closed on %s", (_label, mutate) => {
  const physical = { journalRows: 313, pageCount: 390, pageSizeBytes: 4096, userVersion: 2 };
  expect(() => summarizeSettledScaleEvidence(
    mutate(scaleReport()), physical, ["--json"], "1.3.1"
  )).toThrow("provenance");
});

it.each([
  ["empty command arguments", []],
  ["empty command argument", [""]],
  ["untrimmed command argument", [" --json"]],
  ["sparse command arguments", Object.assign(new Array(2), { 1: "--json" })]
])("fails closed on %s", (_label, args) => {
  const physical = { journalRows: 313, pageCount: 390, pageSizeBytes: 4096, userVersion: 2 };
  expect(() => summarizeSettledScaleEvidence(
    scaleReport(), physical, args, "1.3.1"
  )).toThrow("provenance");
});

it("fails closed on empty executable and malformed zlib identity", () => {
  const report = scaleReport();
  const physical = { journalRows: 313, pageCount: 390, pageSizeBytes: 4096, userVersion: 2 };
  expect(() => summarizeSettledScaleEvidence(
    report, physical, ["--json"], "1.3.1", ""
  )).toThrow("provenance");
  expect(() => summarizeSettledScaleEvidence(
    report, physical, ["--json"], " 1.3.1"
  )).toThrow("provenance");
});

it("captures pure JSON through the documented silent pnpm subprocess", () => {
  const stdout = execFileSync("corepack", [
    "pnpm",
    "--silent",
    "benchmark:sqlite-compression-qualification",
    "--",
    "--json"
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: 16 * 1_024 * 1_024
  });
  expect(JSON.parse(stdout)).toMatchObject({
    schema: "attunegraph-sqlite-compression-qualification@1"
  });
}, 120_000);
