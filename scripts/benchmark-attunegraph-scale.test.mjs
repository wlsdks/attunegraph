import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createBenchmarkCorpusPlan,
  createBenchmarkShard,
  inspectBenchmarkCorpus,
  parseBenchmarkArguments,
  pnpmVersion,
  summarizeBenchmarkSamples
} from "./benchmark-attunegraph-scale.mjs";
import { openAttuneGraph } from "@attunegraph/core";
import { createInMemoryAttuneGraphStore } from "@attunegraph/core/testing";

describe("AttuneGraph scale benchmark CLI", () => {
  it("reads the pnpm version from the cross-platform package-manager user agent", () => {
    expect(pnpmVersion("pnpm/10.18.0 npm/? node/v24.15.0 win32 x64")).toBe("10.18.0");
  });

  it("accepts only an explicit supported corpus scale and runtime profile", () => {
    expect(parseBenchmarkArguments([
      "--",
      "--scale=10000",
      "--profile=core",
      "--warmups=0",
      "--repetitions=1"
    ])).toEqual({
      outputPath: undefined,
      profile: "core",
      repetitions: 1,
      scale: 10_000,
      warmups: 0
    });

    expect(() => parseBenchmarkArguments(["--scale=9999", "--profile=core"]))
      .toThrow(/scale/u);
    expect(() => parseBenchmarkArguments(["--scale=10000", "--profile=remote"]))
      .toThrow(/profile/u);
    expect(() => parseBenchmarkArguments(["--scale=10000"]))
      .toThrow(/profile/u);
  });

  it("generates exact, bounded, thread-rooted v2 shards through public engine APIs", async () => {
    const plan = createBenchmarkCorpusPlan(100_000);
    expect(plan).toMatchObject({
      schema: "attunegraph-benchmark-corpus@1",
      assertionCount: 100_000,
      maxAssertionsPerShard: 32,
      shardCount: 3_125
    });
    expect(plan.shardAssertionCounts[0]).toBe(32);
    expect(plan.shardAssertionCounts.at(-1)).toBe(32);

    const smokePlan = createBenchmarkCorpusPlan(10_000);
    const shard = createBenchmarkShard(smokePlan, 0);
    expect(shard.command).toMatchObject({
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        threadRoot: shard.threadRoot
      }
    });
    expect(shard.command.observation.assertions).toHaveLength(32);
    expect(smokePlan.shardAssertionCounts.reduce((sum, count) => sum + count, 0))
      .toBe(10_000);

    const graph = await openAttuneGraph({
      scope: shard.scope,
      store: createInMemoryAttuneGraphStore()
    });
    await expect(graph.project(shard.command)).resolves.toMatchObject({ generation: 1 });
    await expect(graph.execute({
      operator: "working-graph@1",
      seed: shard.threadRoot,
      now: shard.command.observation.observedAt,
      maxEstimatedTokens: 32_768
    })).resolves.toMatchObject({
      status: "partial",
      workingGraph: {
        diagnostics: { truncationReasons: expect.any(Array) }
      }
    });
    await graph.close();
  });

  it("binds corpus bytes independently of shard generation order", () => {
    const plan = createBenchmarkCorpusPlan(10_000);
    const naturalOrder = Array.from({ length: plan.shardCount }, (_, index) => index);
    const reverseOrder = [...naturalOrder].reverse();
    const first = inspectBenchmarkCorpus(plan, naturalOrder);
    const reordered = inspectBenchmarkCorpus(plan, reverseOrder);

    expect(reordered).toEqual(first);
    expect(first).toMatchObject({
      schema: "attunegraph-benchmark-corpus-manifest@1",
      assertionCount: 10_000,
      predicateMix: {
        LINKED_TO: 2_504,
        REVISION_OF: 7_496
      },
      shardCount: 313
    });
    expect(first.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.shards.every((shard) => shard.serializedBytes < 16_384)).toBe(true);
    expect(createBenchmarkCorpusPlan(1_000_000)).toMatchObject({
      assertionCount: 1_000_000,
      shardCount: 31_250
    });
  });

  it("retains raw samples and computes deterministic nearest-rank percentiles", () => {
    expect(summarizeBenchmarkSamples([1, 2, 3, 4, 100])).toEqual({
      max: 100,
      min: 1,
      p50: 3,
      p95: 100,
      p99: 100,
      samples: [1, 2, 3, 4, 100]
    });
    expect(() => summarizeBenchmarkSamples([])).toThrow(/sample/u);
  });

  it("fails invalid black-box CLI input without creating evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attunegraph-benchmark-cli-"));
    const outputPath = join(directory, "should-not-exist.json");
    try {
      const child = spawnSync(process.execPath, [
        fileURLToPath(new URL("./benchmark-attunegraph-scale.mjs", import.meta.url)),
        "--scale=9999",
        "--profile=core",
        `--output=${outputPath}`
      ], { encoding: "utf8", timeout: 5_000 });
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/scale/u);
      await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
