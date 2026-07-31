import { describe, expect, it } from "vitest";

import { runScaleBenchmark } from "./benchmark-attunegraph-scale.mjs";

describe("AttuneGraph scale benchmark qualification", () => {
  it("measures a real 10K core corpus without converting measurements into a verdict", async () => {
    const report = await runScaleBenchmark({
      outputPath: undefined,
      profile: "core",
      repetitions: 1,
      scale: 10_000,
      warmups: 0
    });

    expect(report).toMatchObject({
      schema: "attunegraph-scale-benchmark@1",
      claimEligible: false,
      configuration: {
        profile: "core",
        repetitions: 1,
        scale: 10_000,
        warmups: 0
      },
      corpus: {
        assertionCount: 10_000,
        shardCount: 313
      },
      operations: {
        projectedAssertions: 10_000,
        projections: 313,
        workingGraphStatuses: {
          abstained: 0,
          complete: 0,
          partial: 313
        }
      }
    });
    expect(report.metrics.projectionMilliseconds.samples).toHaveLength(313);
    expect(report.metrics.workingGraphMilliseconds.samples).toHaveLength(313);
    expect(report.metrics.assertionsPerSecond.samples[0]).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(/90\/100|\bready\b|\bPASS\b/u);
  });

  it("measures the 313-shard local-session corpus without converting measurements into a verdict", async () => {
    const report = await runScaleBenchmark({
      outputPath: undefined,
      profile: "local-session",
      repetitions: 1,
      scale: 10_000,
      warmups: 0
    });

    expect(report).toMatchObject({
      schema: "attunegraph-scale-benchmark@1",
      claimEligible: false,
      measurementOnly: true,
      configuration: {
        profile: "local-session",
        repetitions: 1,
        scale: 10_000,
        warmups: 0
      },
      corpus: {
        assertionCount: 10_000,
        shardCount: 313
      },
      operations: {
        projectedAssertions: 10_000,
        projections: 313,
        workingGraphStatuses: {
          abstained: 0,
          complete: 0,
          partial: 313
        }
      }
    });
    expect(report.metrics.openMilliseconds.samples).toHaveLength(313);
    expect(report.metrics.sessionOpenMilliseconds.samples).toHaveLength(1);
    expect(report.metrics.sessionCloseMilliseconds.samples).toHaveLength(1);
    expect(JSON.stringify(report)).not.toMatch(/90\/100|\bready\b|\bPASS\b/u);
  });
});
