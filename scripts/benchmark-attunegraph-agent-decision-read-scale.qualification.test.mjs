import { describe, expect, it } from "vitest";

import {
  generateAgentDecisionReadScaleReport,
  validateAgentDecisionReadScaleReportSchema
} from "./benchmark-attunegraph-agent-decision-read-scale.mjs";

describe("AttuneGraph agent decision-read scale measurement qualification", () => {
  it("publishes p50 only at the adjacent five-repetition boundary", async () => {
    const options = {
      repetitions: 5,
      timeoutMs: 300_000,
      warmups: 0,
      workload: "agent-decision-read-scale@1"
    };
    const report = await generateAgentDecisionReadScaleReport(options);
    const belowBoundary = await generateAgentDecisionReadScaleReport({
      ...options,
      repetitions: 4
    });

    expect(validateAgentDecisionReadScaleReportSchema(report)).toBe(report);
    expect(validateAgentDecisionReadScaleReportSchema(belowBoundary)).toBe(belowBoundary);
    expect(belowBoundary.measurementIdentitySha256).toBe(report.measurementIdentitySha256);
    for (const cell of belowBoundary.cells) {
      expect(cell.timing.raw).toHaveLength(4);
      expect(cell.timing.cold.batchExecuteMilliseconds.p50).toBeNull();
      expect(cell.timing.warm.batchWallMilliseconds.p50).toBeNull();
      expect(cell.timing.cold.positions.every((entry) => entry.p50 === null)).toBe(true);
      expect(cell.timing.warm.positions.every((entry) => entry.p50 === null)).toBe(true);
    }
    for (const cell of report.cells) {
      expect(cell.timing.raw).toHaveLength(5);
      expect(cell.timing.cold.batchExecuteMilliseconds.p50).not.toBeNull();
      expect(cell.timing.warm.batchWallMilliseconds.p50).not.toBeNull();
      expect(cell.timing.cold.positions.every((entry) => entry.p50 !== null)).toBe(true);
      expect(cell.timing.warm.positions.every((entry) => entry.p50 !== null)).toBe(true);
      expect(cell.timing.cold.batchExecuteMilliseconds.p95).toBeNull();
      expect(cell.timing.warm.batchWallMilliseconds.p99).toBeNull();
    }
  });
});
