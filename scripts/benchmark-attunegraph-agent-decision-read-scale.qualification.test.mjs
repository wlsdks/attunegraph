import { describe, expect, it } from "vitest";

import {
  generateAgentDecisionReadScaleReport,
  validateAgentDecisionReadScaleReportSchema
} from "./benchmark-attunegraph-agent-decision-read-scale.mjs";

describe("AttuneGraph agent decision-read scale measurement qualification", () => {
  it("publishes p50 only from five independent rebuilt-head repetitions", async () => {
    const report = await generateAgentDecisionReadScaleReport({
      repetitions: 5,
      timeoutMs: 300_000,
      warmups: 0,
      workload: "agent-decision-read-scale@1"
    });

    expect(validateAgentDecisionReadScaleReportSchema(report)).toBe(report);
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
