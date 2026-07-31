import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAgentDecisionReadScaleWorkload,
  generateAgentDecisionReadScaleReport,
  runAgentDecisionReadScaleCommand,
  validateAgentDecisionReadScaleEvidenceSchema,
  validateAgentDecisionReadScaleReportSchema,
  verifyAgentDecisionReadScaleEvidenceAuthority
} from "./benchmark-attunegraph-agent-decision-read-scale.mjs";

const OPTIONS = Object.freeze({
  repetitions: 1,
  timeoutMs: 300_000,
  warmups: 0,
  workload: "agent-decision-read-scale@1"
});

const CELL_IDS = Object.freeze([
  "focused-resumption-16",
  "focused-resumption-32",
  "focused-resumption-48",
  "thread-frontier-16",
  "thread-frontier-32",
  "thread-frontier-48",
  "thread-frontier-48-batch-1",
  "thread-frontier-48-batch-4",
  "thread-frontier-48-batch-32"
]);

const REPOSITORY = Object.freeze({
  clean: true,
  commit: "1".repeat(40),
  lockfileSha256: `sha256:${"2".repeat(64)}`,
  tree: "3".repeat(40)
});

const HOST = Object.freeze({
  arch: "test-arch",
  cpuCount: 8,
  cpuModel: "test-cpu",
  node: "22.22.0",
  os: "test-os",
  pnpm: "10.0.0",
  totalMemoryBytes: 16_000_000_000
});

let report;
let temporaryDirectory;

beforeAll(async () => {
  report = await generateAgentDecisionReadScaleReport(OPTIONS);
  temporaryDirectory = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-agent-scale-test-")));
});

afterAll(async () => {
  if (temporaryDirectory !== undefined) await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("AttuneGraph agent decision-read scale benchmark", () => {
  it("pins scale, semantic, authority, timing, and observational-memory contracts", () => {
    expect(validateAgentDecisionReadScaleReportSchema(report)).toBe(report);
    expect(report).toMatchObject({
      claimEligible: false,
      measurementIdentitySha256: "sha256:9dbc7811dbf913280669fc1971dad8443ca577d71653c4f035aa838c0cd03e8f",
      measurementOnly: true,
      memoryContract: {
        deltaQualified: false,
        gcForced: false,
        scope: "process-observational",
        units: "bytes"
      },
      resourceAuthoritative: false,
      resourceQualified: false,
      workloadSha256: "sha256:e23960ac7f70c4e193ff268176f623ec4f77956a698148217d57b92ad4eea9ae"
    });
    expect(report.cells.map((cell) => cell.id)).toEqual(CELL_IDS);
    expect(report.cells.map((cell) => cell.activeAssertionCount)).toEqual([16, 32, 48, 16, 32, 48, 48, 48, 48]);
    expect(report.cells.map((cell) => cell.batchSize)).toEqual([1, 1, 1, 1, 1, 1, 1, 4, 32]);
    expect(report.cells.map((cell) => cell.assertionVisitedPairsPerRead)).toEqual([48, 96, 144, 272, 1056, 2352, 2352, 2352, 2352]);
    expect(report.cells.map((cell) => cell.batchAssertionVisitedPairs)).toEqual([48, 96, 144, 272, 1056, 2352, 2352, 9408, 75264]);
    for (const cell of report.cells) {
      expect(cell.canonicalProjection.outputBytes).toBeLessThanOrEqual(15_500);
      expect(cell.timing.cold.batchExecuteMilliseconds.p50).toBeNull();
      expect(cell.timing.warm.batchWallMilliseconds.p50).toBeNull();
      expect(cell.timing.cold.batchExecuteMilliseconds.p95).toBeNull();
      expect(cell.timing.warm.batchWallMilliseconds.p99).toBeNull();
      expect(cell.timing.raw).toHaveLength(1);
      expect(cell.timing.raw.every((entry) => entry.cold.batchWallMilliseconds >= entry.cold.batchExecuteMilliseconds)).toBe(true);
    }
    expect(report.authoritySentinel).toMatchObject({
      collidingRefIsolation: { status: "abstained" },
      governedAction: { authority: "not-inferred", generationOneStatus: "partial", generationTwoStatus: "complete" },
      generationOne: { authorityObserved: true, generation: 1, status: "partial", unauthorizedActionStatus: "abstained" },
      generationTwo: { authorityObserved: false, generation: 2, sourceFreshness: "stale", status: "abstained" }
    });
    expect(createAgentDecisionReadScaleWorkload()).toEqual(createAgentDecisionReadScaleWorkload());
  });

  it("rejects forged workload, cell, timing, memory, semantic, and authority evidence", () => {
    const mutations = [
      (value) => { value.unknown = true; },
      (value) => { value.workloadSha256 = `sha256:${"f".repeat(64)}`; },
      (value) => { value.cells[1] = structuredClone(value.cells[0]); },
      (value) => { value.cells[8].batchSize = 31; },
      (value) => { value.cells[8].batchAssertionVisitedPairs = value.cells[8].assertionVisitedPairsPerRead; },
      (value) => { value.cells[0].timing.cold.batchExecuteMilliseconds.p50 = 0; },
      (value) => { value.cells[0].timing.cold.batchExecuteMilliseconds.p95 = 1; },
      (value) => { value.cells[0].timing.raw[0].cold.positions[0] = Number.NaN; },
      (value) => { value.cells[0].timing.raw[0].checkpoints.cold.afterClose.rss = -1; },
      (value) => { value.cells[0].semantic.unknown = "forged"; },
      (value) => { value.authoritySentinel.generationOne.observedAuthorizationSourceRefs[0].id = "forged"; },
      (value) => { value.authoritySentinel.collidingRefIsolation.status = "complete"; },
      (value) => { value.measurementIdentity.cells[0].anchorSha256 = `sha256:${"a".repeat(64)}`; }
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(report);
      mutate(forged);
      expect(() => validateAgentDecisionReadScaleReportSchema(forged)).toThrow(/invalid agent decision-read scale report/u);
    }
  });

  it("binds safe CLI evidence to argv, host, and an unchanged clean repository", async () => {
    const outputPath = join(temporaryDirectory, "evidence.json");
    const argv = [
      "--workload=agent-decision-read-scale@1",
      "--repetitions=1",
      "--warmups=0",
      `--output=${outputPath}`
    ];
    const evidence = await runAgentDecisionReadScaleCommand(argv, {
      captureRepositoryIdentity: () => REPOSITORY,
      host: HOST,
      now: new Date("2026-08-01T12:30:00.000Z")
    });
    expect(validateAgentDecisionReadScaleEvidenceSchema(evidence)).toBe(evidence);
    expect(verifyAgentDecisionReadScaleEvidenceAuthority(evidence, { argv, host: HOST, repository: REPOSITORY })).toBe(evidence);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(evidence);
    if (process.platform !== "win32") expect((await stat(outputPath)).mode & 0o777).toBe(0o600);

    const forged = structuredClone(evidence);
    forged.argv[1] = "--repetitions=2";
    expect(() => validateAgentDecisionReadScaleEvidenceSchema(forged)).toThrow(/argv report binding/u);
    await expect(runAgentDecisionReadScaleCommand(argv, {
      captureRepositoryIdentity: () => REPOSITORY,
      host: HOST
    })).rejects.toThrow(/already exists/u);
  });

  it("rejects repository-local and symlink-parent outputs and honors cancellation before warmups", async () => {
    const repositoryOutput = resolve("agent-decision-read-scale-evidence.json");
    await expect(runAgentDecisionReadScaleCommand([
      "--workload=agent-decision-read-scale@1",
      "--repetitions=1",
      "--warmups=0",
      `--output=${repositoryOutput}`
    ], { captureRepositoryIdentity: () => REPOSITORY, host: HOST })).rejects.toThrow(/outside the repository/u);

    if (process.platform !== "win32") {
      const target = join(temporaryDirectory, "real-parent");
      const link = join(temporaryDirectory, "link-parent");
      await chmod(temporaryDirectory, 0o700);
      await mkdir(target);
      await symlink(target, link, "dir");
      await expect(runAgentDecisionReadScaleCommand([
        "--workload=agent-decision-read-scale@1",
        "--repetitions=1",
        "--warmups=0",
        `--output=${join(link, "evidence.json")}`
      ], { captureRepositoryIdentity: () => REPOSITORY, host: HOST })).rejects.toThrow(/non-symlink/u);
    }

    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    await expect(generateAgentDecisionReadScaleReport({ ...OPTIONS, warmups: 1 }, { signal: controller.signal })).rejects.toThrow(/test cancellation/u);
  });
});
