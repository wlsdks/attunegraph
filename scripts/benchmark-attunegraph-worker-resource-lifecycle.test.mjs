import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { Buffer } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  runWorkerResourceLifecycleTracer,
  serializeWorkerResourceLifecycleReport
} from "./benchmark-attunegraph-worker-resource-lifecycle.mjs";

const temporaryDirectories = [];

function privateDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "attunegraph-worker-resource-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return join(realpathSync(directory), "attunegraph.sqlite");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("measures four sequential public-session workers without treating process RSS as per-worker RSS", async () => {
  const report = await runWorkerResourceLifecycleTracer({
    databasePath: privateDatabasePath()
  });

  expect(report).toMatchObject({
    schema: "attunegraph-worker-resource-lifecycle@1",
    measurementOnly: true,
    claimEligible: false,
    measurementBoundary: {
      cycles: 4,
      database: "one-prepared-shared-sqlite-file",
      mainThreadMemoryScope: "calling-main-thread-process.memoryUsage-fields-except-rss",
      process: "one-main-process-sequential-workers",
      processRssScope: "whole-process-includes-main-and-active-worker",
      sessionCloseContract: "resolves-after-worker-exit",
      workerHeapScope: "active-worker-isolate-v8-heap-only"
    },
    excludedPreparation: {
      decisionReads: 1,
      sessions: 1,
      writes: 1
    },
    correctness: {
      cyclesCompleted: 4,
      exactHeadStable: true,
      exactResultStable: true,
      generationStable: true,
      handleCloseWorkerSamples: 4,
      sessionCloseResolutions: 4,
      workerHeapSamples: 12
    },
    limits: {
      allocatorRelease: "not-inferred",
      garbageCollection: "not-forced",
      leakQualification: "not-measured",
      perWorkerRss: "unavailable",
      postCloseWorkerHeap: "unavailable-worker-terminated"
    }
  });
  expect(report.cycles).toHaveLength(4);
  for (const [index, cycle] of report.cycles.entries()) {
    expect(cycle.index).toBe(index);
    expect(cycle.snapshot.generation).toBe(1);
    expect(cycle.result.status).toBe("complete");
    expect(cycle.result.emittedAssertions).toBe(16);
    expect(cycle.workerHeap.afterOpen.usedHeapSizeBytes).toBeGreaterThan(0);
    expect(cycle.workerHeap.afterWork.usedHeapSizeBytes).toBeGreaterThan(0);
    expect(cycle.workerHeap.afterHandleClose.usedHeapSizeBytes).toBeGreaterThan(0);
    for (const phase of [
      "beforeOpen",
      "afterOpen",
      "afterWork",
      "afterHandleClose",
      "afterSessionClose"
    ]) {
      expect(cycle.memory[phase].wholeProcess.rssBytes).toBeGreaterThan(0);
      expect(cycle.memory[phase].wholeProcess.peakRssBytes).toBeGreaterThan(0);
      expect(cycle.memory[phase].mainThread.heapUsedBytes).toBeGreaterThan(0);
      expect(cycle.memory[phase].mainThread.heapTotalBytes).toBeGreaterThan(0);
    }
    expect(cycle.timing.headMilliseconds).toBeGreaterThanOrEqual(0);
    expect(cycle.timing.sessionOpenMilliseconds).toBeGreaterThanOrEqual(0);
    expect(cycle.timing.sessionCloseMilliseconds).toBeGreaterThanOrEqual(0);
  }
  expect(report.workload.measuredWrites).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(report), "utf8")).toBeLessThanOrEqual(128 * 1_024);
  expect(Buffer.byteLength(serializeWorkerResourceLifecycleReport(report), "utf8"))
    .toBeLessThanOrEqual(128 * 1_024);
  expect(Object.isFrozen(report)).toBe(true);
});

it("rejects accessor-backed options without evaluating them", async () => {
  let reads = 0;
  const options = Object.defineProperty({}, "databasePath", {
    enumerable: true,
    get() {
      reads += 1;
      return privateDatabasePath();
    }
  });

  await expect(runWorkerResourceLifecycleTracer(options)).rejects.toThrow(
    "requires one new canonical absolute databasePath"
  );
  expect(reads).toBe(0);
});

it("fails closed before opening when the database or a SQLite sidecar already exists", async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const databasePath = privateDatabasePath();
    writeFileSync(`${databasePath}${suffix}`, "occupied", { mode: 0o600 });
    await expect(runWorkerResourceLifecycleTracer({ databasePath })).rejects.toThrow(
      "requires a new databasePath and sidecars"
    );
  }
});

it("fails closed before emitting a report larger than the fixed stdout cap", () => {
  expect(() => serializeWorkerResourceLifecycleReport({
    schema: "attunegraph-worker-resource-lifecycle@1",
    oversized: "x".repeat(128 * 1_024)
  })).toThrow("exceeded its fixed 128 KiB output cap");
});
