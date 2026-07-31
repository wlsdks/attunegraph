import { describe, expect, it } from "vitest";

import {
  createAgentDecisionReadScaleWorkload,
  generateAgentDecisionReadScaleReport,
  validateAgentDecisionReadScaleReportSchema
} from "./benchmark-attunegraph-agent-decision-read-scale.mjs";

describe("AttuneGraph agent decision-read scale benchmark", () => {
it("pins the bounded active-scale workload, authority sentinel, and observational report", async () => {
    const report = await generateAgentDecisionReadScaleReport({
      outputPath: undefined,
      warmups: 0,
      repetitions: 5,
      timeoutMs: 300_000,
      workload: "agent-decision-read-scale@1",
    });
    expect(report.workload).toBe("agent-decision-read-scale@1");
    expect(report.measurementOnly).toBe(true);
    expect(report.claimEligible).toBe(false);
    expect(report.resourceAuthoritative).toBe(false);
    expect(report.resourceQualified).toBe(false);
    expect(report.cells).toHaveLength(9);
    expect(report.cells.map((cell) => cell.id)).toEqual(
      [
        "focused-resumption-16",
        "focused-resumption-32",
        "focused-resumption-48",
        "thread-frontier-16",
        "thread-frontier-32",
        "thread-frontier-48",
        "thread-frontier-48-batch-1",
        "thread-frontier-48-batch-4",
        "thread-frontier-48-batch-32",
      ]
    );

    for (const cell of report.cells) {
      expect(cell.repetitions).toBe(5);
      expect(cell.timing.cold.batchMilliseconds.p50).not.toBeNull();
      expect(cell.timing.warm.batchMilliseconds.p50).not.toBeNull();
      expect(cell.timing.cold.batchMilliseconds.p95).toBeNull();
      expect(cell.timing.warm.batchMilliseconds.p99).toBeNull();
      expect(cell.timing.rawMilliseconds).toHaveLength(5);
      expect(cell.canonicalProjection.version).toBe("canonical-projection@2");
      expect(cell.canonicalProjection.outputBytes).toBeLessThanOrEqual(15_500);
      expect(cell.canonicalProjection.threadRoot).not.toBe(cell.scope.threadId);
    }
    expect(report.cells.slice(0, 3).map((cell) => cell.semantic)).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({
        consideredAssertions: 2,
        emittedAssertions: 2,
        maxDepthReached: 2,
        status: "partial",
        truncationReasons: ["traversal-budget"],
        visitedRefs: 3
      }))
    );
    expect(report.cells.slice(3, 6).map((cell) => ({
      consideredAssertions: cell.semantic.consideredAssertions,
      emittedAssertions: cell.semantic.emittedAssertions,
      visitedRefs: cell.semantic.visitedRefs
    }))).toEqual([
      { consideredAssertions: 16, emittedAssertions: 16, visitedRefs: 17 },
      { consideredAssertions: 32, emittedAssertions: 32, visitedRefs: 33 },
      { consideredAssertions: 48, emittedAssertions: 48, visitedRefs: 49 }
    ]);
    expect(report.authoritySentinel).toMatchObject({
      governedAction: { authority: "not-inferred", generationTwoStatus: "complete" },
      generationOne: { authorityObserved: true, generation: 1, status: "partial", unauthorizedActionStatus: "abstained" },
      generationTwo: { authorityObserved: false, generation: 2, status: "abstained" }
    });
    expect(report.authoritySentinel.generationOne.commitId)
      .not.toBe(report.authoritySentinel.generationTwo.commitId);
    expect(validateAgentDecisionReadScaleReportSchema(report)).toBe(report);
    expect(createAgentDecisionReadScaleWorkload()).toEqual(
      createAgentDecisionReadScaleWorkload()
    );
});
});
