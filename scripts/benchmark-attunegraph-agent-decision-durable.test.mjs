import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  composeDurableTracerCleanupFailure,
  runDurableAgentDecisionTracer
} from "./benchmark-attunegraph-agent-decision-durable.mjs";

const temporaryDirectories = [];

function privateDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "attunegraph-durable-decision-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return realpathSync(directory);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("preserves one exact agent decision after closing and reopening a new SQLite store", async () => {
  const databasePath = join(privateDirectory(), "attunegraph.sqlite");

  const report = await runDurableAgentDecisionTracer({ databasePath });

  expect(report).toMatchObject({
    schema: "attunegraph-agent-decision-durable-tracer@1",
    measurementOnly: true,
    claimEligible: false,
    measurementBoundary: {
      clientCount: 1,
      closeMode: "graceful",
      osCache: "uncontrolled",
      process: "same-process-new-worker"
    },
    workload: {
      id: "generation-churn-8x40@1",
      activeAssertionCount: 16,
      inactiveAssertionCount: 24,
      projectedAssertionInputs: 320,
      projectionEnvelopeLimitBytes: 15_500,
      totalAssertionCountAtHead: 40,
      generation: 8,
      profile: "single-client-worker-isolated-sqlite-graceful-close-reopen",
      temporalDecoys: {
        expired: 6,
        futureValid: 6,
        postRecordedCutoff: 6,
        superseded: 6
      }
    },
    correctness: {
      exactMatch: true,
      fullResultExact: true,
      snapshotStable: true
    },
    limits: {
      crashRecovery: "not-measured",
      multiClientConcurrency: "not-measured",
      osPageCache: "uncontrolled"
    }
  });
  expect(report.correctness.beforeClose).toEqual(report.correctness.afterReopen);
  expect(report.correctness.afterReopen).toMatchObject({
    assertionIds: expect.arrayContaining(["a:g08:00", "a:g08:15"]),
    consideredAssertions: 16,
    emittedAssertions: 16,
    generation: 8,
    headCommitId: "attunegraph-commit:attunegraph-observation:015d178f373e5c0e2112c8de04c093a489f1b7a4ae6dea637fe6a5ce74645983",
    maxDepthReached: 2,
    sourceFreshness: {
      state: "fresh",
      observedAt: "2026-08-01T11:59:00.000Z"
    },
    status: "complete",
    truncationReasons: [],
    visitedRefs: 17
  });
  expect(report.correctness.afterReopen.assertionIds).toEqual(
    Array.from({ length: 16 }, (_, index) => `a:g08:${index.toString().padStart(2, "0")}`)
  );
  expect(report.correctness.afterReopen.refIds).toEqual([
    ...Array.from({ length: 16 }, (_, index) => `artifact:n:g08:${index.toString().padStart(2, "0")}`),
    "thread:root"
  ]);
  expect(report.correctness.afterReopen.sourceRefIds).toEqual(
    Array.from({ length: 16 }, (_, index) => `b:s:g08:a:${index.toString().padStart(2, "0")}`)
  );
  expect(report.correctness.afterReopen.assertionProvenance).toEqual(
    Array.from({ length: 16 }, (_, index) => {
      const suffix = index.toString().padStart(2, "0");
      return {
        assertionId: `a:g08:${suffix}`,
        derivation: { kind: "projection", version: "v" },
        sourceRefs: [{ namespace: "b", id: `s:g08:a:${suffix}` }]
      };
    })
  );
  expect(report.workload.projectionInputBytes).toBeGreaterThan(0);
  expect(report.workload.projectionInputBytes).toBeLessThanOrEqual(
    report.workload.projectionEnvelopeLimitBytes
  );
  expect(report.timing.reopenAfterGracefulCloseMilliseconds).toBeGreaterThanOrEqual(0);
  expect(report.timing.executeAfterReopenMilliseconds).toBeGreaterThanOrEqual(0);
  expect(report.timing).not.toHaveProperty("coldReopenMilliseconds");
  expect(report.timing).not.toHaveProperty("sessionReopenMilliseconds");
  expect(lstatSync(databasePath).isFile()).toBe(true);
  expect(Object.isFrozen(report)).toBe(true);
});

it("rejects accessor-backed options without evaluating the accessor", async () => {
  let reads = 0;
  const options = Object.defineProperty({}, "databasePath", {
    enumerable: true,
    get() {
      reads += 1;
      return join(privateDirectory(), "attunegraph.sqlite");
    }
  });

  await expect(runDurableAgentDecisionTracer(options)).rejects.toThrow(
    "requires one absolute databasePath"
  );
  expect(reads).toBe(0);
});

it("preserves the primary failure when cleanup also fails", () => {
  const primary = new Error("projection failed");
  const close = new Error("worker close failed");
  const remove = new Error("database removal failed");

  const combined = composeDurableTracerCleanupFailure(
    primary,
    [close, remove],
    "durable tracer cleanup failed"
  );

  expect(combined).toBeInstanceOf(AggregateError);
  expect(combined.message).toBe("durable tracer cleanup failed");
  expect(combined.errors).toEqual([primary, close, remove]);
});
