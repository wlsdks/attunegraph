import { describe, expect, it } from "vitest";

import { runAgentContextBenchmark } from "./benchmark-attunegraph-agent-context.mjs";

describe("agent context payload qualification", () => {
  it("keeps every compact context proof-bound while reducing prompt bytes by at least 70%", async () => {
    const report = await runAgentContextBenchmark();

    expect(report.schemaVersion).toBe(1);
    expect(report.scenarios.map((scenario) => scenario.name)).toEqual([
      "small-complete",
      "evidence-token-cut",
      "byte-heavy-floor",
      "authority-work-cut"
    ]);
    for (const scenario of report.scenarios) {
      expect(scenario.admissionVerified).toBe(true);
      expect(typeof scenario.decisionReady).toBe("boolean");
      expect(scenario.agentEstimatedTokens).toBe(
        Math.ceil(scenario.agentBytes / 4)
      );
      expect(scenario.agentBytes).toBeLessThan(scenario.fullProofBytes);
      expect(scenario.promptByteReductionPercent).toBeGreaterThanOrEqual(70);
      expect(scenario.totalBundleBytes).toBeLessThan(scenario.fullProofBytes);
      expect(scenario.totalByteReductionPercent).toBeGreaterThanOrEqual(35);
    }
  });
});
