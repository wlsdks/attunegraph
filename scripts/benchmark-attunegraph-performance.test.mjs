import { describe, expect, it } from "vitest";

import {
  parsePerformanceBenchmarkArguments,
  runBoundedPool,
  runLocalSessionConcurrentComparison,
  runPerformanceBenchmark,
  runPortableProfile
} from "./benchmark-attunegraph-performance.mjs";
import { createBenchmarkCorpusPlan } from "./benchmark-attunegraph-scale.mjs";

describe("AttuneGraph external-project performance benchmark", () => {
  it("accepts only bounded, explicit performance profiles", () => {
    expect(parsePerformanceBenchmarkArguments([
      "--",
      "--scale=10000",
      "--profile=local-session-concurrent",
      "--concurrency=4",
      "--warmups=0",
      "--repetitions=1"
    ])).toEqual({
      concurrency: 4,
      outputPath: undefined,
      profile: "local-session-concurrent",
      repetitions: 1,
      scale: 10_000,
      warmups: 0
    });

    expect(parsePerformanceBenchmarkArguments([
      "--scale=1000000",
      "--profile=portable",
      "--repetitions=2"
    ])).toMatchObject({
      concurrency: 1,
      profile: "portable",
      repetitions: 2,
      scale: 1_000_000
    });

    expect(() => parsePerformanceBenchmarkArguments([
      "--scale=10000",
      "--profile=local-session-concurrent",
      "--concurrency=0"
    ])).toThrow(/concurrency/u);
    expect(() => parsePerformanceBenchmarkArguments([
      "--scale=10000",
      "--profile=portable",
      "--concurrency=2"
    ])).toThrow(/portable.*concurrency/u);
  });

  it("bounds concurrent work while retaining deterministic result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await runBoundedPool(
      Array.from({ length: 17 }, (_, index) => index),
      4,
      async (value) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        return value * 2;
      }
    );
    expect(peak).toBe(4);
    expect(results).toEqual(Array.from({ length: 17 }, (_, index) => index * 2));
    await expect(runBoundedPool([1], 0, async (value) => value)).rejects.toThrow(/concurrency/u);
  });

  it("compares bounded concurrent ingestion with a same-run sequential baseline and exact reopen verification", async () => {
    const databases = new Map();
    const result = await runLocalSessionConcurrentComparison(
      createBenchmarkCorpusPlan(10_000),
      4,
      {
        openLocalAttuneGraphSession: async ({ databasePath }) => {
          const heads = databases.get(databasePath) ?? new Map();
          databases.set(databasePath, heads);
          return {
            open: async ({ scope }) => ({
              project: async (command) => {
                const snapshot = {
                  schemaVersion: 1,
                  scope,
                  generation: 1,
                  commitId: `commit:${command.observation.observationKey}`
                };
                heads.set(scope.threadId, snapshot);
                return snapshot;
              },
              head: async () => heads.get(scope.threadId),
              close: async () => undefined
            }),
            close: async () => undefined
          };
        }
      }
    );

    expect(result.correctness).toEqual({
      baselineVerifiedHeads: 313,
      candidateMatchesBaseline: true,
      candidateVerifiedHeads: 313,
      expectedHeads: 313
    });
    expect(result.baseline.concurrency).toBe(1);
    expect(result.candidate.concurrency).toBe(4);
    expect(result.candidate.samples.projection).toHaveLength(313);
    expect(result.relative.assertionsPerSecond).toBeGreaterThan(0);
  });

  it("measures production portable encode and decode with exact terminal convergence", async () => {
    const result = await runPortableProfile({
      assertionCount: 32,
      maxAssertionsPerShard: 32,
      schema: "attunegraph-benchmark-corpus@1",
      seed: "thread-rooted-hot-and-cold@1",
      shardAssertionCounts: [32],
      shardCount: 1
    });
    expect(result.correctness).toEqual({
      decodedHeads: 1,
      decodedProjections: 1,
      summaryMatches: true
    });
    expect(result.artifactBytes).toBeGreaterThan(0);
    expect(result.encode.milliseconds).toBeGreaterThan(0);
    expect(result.decode.milliseconds).toBeGreaterThan(0);
    expect(result.encode.bytesPerSecond).toBeGreaterThan(0);
    expect(result.decode.bytesPerSecond).toBeGreaterThan(0);
  });

  it("emits revision-bound measurement-only reports without a qualification claim", async () => {
    const report = await runPerformanceBenchmark({
      concurrency: 1,
      outputPath: undefined,
      profile: "portable",
      repetitions: 1,
      scale: 10_000,
      warmups: 0
    }, {
      runPortable: async (plan) => ({
        artifactBytes: plan.assertionCount * 10,
        correctness: { decodedHeads: plan.shardCount, decodedProjections: plan.shardCount, summaryMatches: true },
        decode: { assertionsPerSecond: 100, bytesPerSecond: 1_000, milliseconds: 10 },
        encode: { assertionsPerSecond: 200, bytesPerSecond: 2_000, milliseconds: 5 },
        preparationMilliseconds: 1,
        relative: { decodeToEncodeLatency: 2, decodeToEncodeThroughput: 0.5 },
        rss: { afterDecodeBytes: 120, afterEncodeBytes: 110, baselineBytes: 100, sampledPeakBytes: 120, sampling: "phase-boundary" },
        summary: { format: "attunegraph-portable" }
      })
    });
    expect(report).toMatchObject({
      schema: "attunegraph-performance-benchmark@1",
      claimEligible: false,
      measurementOnly: true,
      configuration: { profile: "portable", scale: 10_000 },
      corpus: { assertionCount: 10_000 },
      repository: { commit: expect.stringMatching(/^[a-f0-9]{40}$/u), tree: expect.stringMatching(/^[a-f0-9]{40}$/u) }
    });
    expect(report.metrics.encodeMilliseconds.samples).toEqual([5]);
  });
});
