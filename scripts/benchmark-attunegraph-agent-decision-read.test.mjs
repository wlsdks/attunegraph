import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createAgentDecisionReadWorkload,
  parseAgentDecisionReadArguments,
  runAgentDecisionReadBenchmark,
  runAgentDecisionReadWorkload,
  validateAgentDecisionReadReport
} from "./benchmark-attunegraph-agent-decision-read.mjs";

describe("AttuneGraph agent decision-read benchmark", () => {
  it("accepts only the explicit bounded workload configuration", () => {
    expect(parseAgentDecisionReadArguments([
      "--",
      "--workload=agent-decision-read@1",
      "--warmups=0",
      "--repetitions=1"
    ])).toEqual({
      outputPath: undefined,
      repetitions: 1,
      warmups: 0,
      workload: "agent-decision-read@1"
    });

    for (const args of [
      ["--warmups=0", "--repetitions=1"],
      ["--workload=unknown@1"],
      ["--workload=agent-decision-read@1", "--warmups=6"],
      ["--workload=agent-decision-read@1", "--repetitions=0"],
      ["--workload=agent-decision-read@1", "--extra=value"],
      ["--workload=agent-decision-read@1", "--output=relative.json"],
      [
        "--workload=agent-decision-read@1",
        "--workload=agent-decision-read@1"
      ]
    ]) {
      expect(() => parseAgentDecisionReadArguments(args)).toThrow();
    }
  });

  it("builds the deterministic bounded decision-read workload matrix", () => {
    const first = createAgentDecisionReadWorkload();
    const second = createAgentDecisionReadWorkload();

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schema: "attunegraph-agent-decision-read-workload@1",
      generation: 8,
      now: "2026-08-01T12:00:00.000Z",
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      totalAssertions: 154
    });
    expect(first.cases.map((entry) => ({
      expectedStatus: entry.expected.status,
      name: entry.name,
      scenario: entry.scenario,
      seedCount: entry.seeds.length,
      sourceFreshness: entry.expected.sourceFreshness
    }))).toEqual([
      {
        expectedStatus: "complete",
        name: "wide-hot-complete-1",
        scenario: "wide-hot",
        seedCount: 1,
        sourceFreshness: "fresh"
      },
      {
        expectedStatus: "partial",
        name: "wide-hot-token-partial-4",
        scenario: "wide-hot",
        seedCount: 4,
        sourceFreshness: "fresh"
      },
      {
        expectedStatus: "complete",
        name: "wide-hot-complete-32",
        scenario: "wide-hot",
        seedCount: 32,
        sourceFreshness: "fresh"
      },
      {
        expectedStatus: "complete",
        name: "deep-cold-complete-1",
        scenario: "deep-cold-bitemporal",
        seedCount: 1,
        sourceFreshness: "fresh"
      },
      {
        expectedStatus: "partial",
        name: "deep-cold-traversal-partial-4",
        scenario: "deep-cold-bitemporal",
        seedCount: 4,
        sourceFreshness: "stale"
      },
      {
        expectedStatus: "abstained",
        name: "deep-cold-valid-time-abstain-32",
        scenario: "deep-cold-bitemporal",
        seedCount: 32,
        sourceFreshness: "stale"
      }
    ]);
    expect(first.cases.every((entry) =>
      entry.command.observation.schemaVersion === 2
      && entry.command.observation.threadRoot.id === entry.threadRoot.id
      && entry.seeds.length <= 32
    )).toBe(true);
  });

  it("executes generation-N decision reads with deterministic outcomes and counters", async () => {
    const workload = createAgentDecisionReadWorkload();
    const first = await runAgentDecisionReadWorkload(workload);
    const second = await runAgentDecisionReadWorkload(workload);
    const semantic = (run) => run.cases.map((entry) => ({
      anchorSha256: entry.anchorSha256,
      generation: entry.generation,
      name: entry.name,
      samples: entry.samples.map((sample) => ({
        anchorSha256: sample.anchorSha256,
        consideredAssertions: sample.consideredAssertions,
        emittedAssertions: sample.emittedAssertions,
        outputBytes: sample.outputBytes,
        status: sample.status,
        truncationReasons: sample.truncationReasons,
        visitedRefs: sample.visitedRefs
      }))
    }));

    expect(semantic(first)).toEqual(semantic(second));
    expect(first.cases.map((entry) => ({
      emitted: [...new Set(entry.samples.map((sample) => sample.emittedAssertions))],
      generation: entry.generation,
      name: entry.name,
      statuses: [...new Set(entry.samples.map((sample) => sample.status))]
    }))).toEqual([
      { emitted: [32], generation: 8, name: "wide-hot-complete-1", statuses: ["complete"] },
      { emitted: [2], generation: 8, name: "wide-hot-token-partial-4", statuses: ["partial"] },
      { emitted: [32], generation: 8, name: "wide-hot-complete-32", statuses: ["complete"] },
      { emitted: [2], generation: 8, name: "deep-cold-complete-1", statuses: ["complete"] },
      { emitted: [2], generation: 8, name: "deep-cold-traversal-partial-4", statuses: ["partial"] },
      { emitted: [0], generation: 8, name: "deep-cold-valid-time-abstain-32", statuses: ["abstained"] }
    ]);
    expect(first.cases.at(-1)?.samples.every((sample) =>
      sample.consideredAssertions === 0
      && sample.visitedRefs === 1
      && sample.truncationReasons.length === 0
    )).toBe(true);
  });

  it("emits a strict measurement-only report with honest tail eligibility", async () => {
    const report = await runAgentDecisionReadBenchmark({
      outputPath: undefined,
      repetitions: 1,
      warmups: 0,
      workload: "agent-decision-read@1"
    }, {
      argv: ["--workload=agent-decision-read@1", "--warmups=0", "--repetitions=1"]
    });

    expect(report).toMatchObject({
      claimEligible: false,
      configuration: {
        decisionSemantics: "independent-single-seed-execute-batch",
        profile: "in-memory-semantic-reference",
        repetitions: 1,
        tailEligibility: {
          basis: "independent-fresh-store-repetitions",
          p95MinimumIndependentRuns: 20,
          p99MinimumIndependentRuns: 100
        },
        warmups: 0,
        workload: "agent-decision-read@1"
      },
      measurementOnly: true,
      repository: {
        clean: expect.any(Boolean),
        commit: expect.stringMatching(/^[a-f0-9]{40}$/u),
        tree: expect.stringMatching(/^[a-f0-9]{40}$/u)
      },
      schema: "attunegraph-agent-decision-read-benchmark@1",
      workload: {
        generation: 8,
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        totalAssertions: 154
      }
    });
    expect(Object.keys(report).sort()).toEqual([
      "claimEligible",
      "configuration",
      "correctness",
      "host",
      "measurementOnly",
      "metrics",
      "observedAt",
      "repository",
      "schema",
      "workload"
    ]);
    expect(report.correctness.allAnchorsMatched).toBe(true);
    expect(report.correctness.cases[1]).toMatchObject({
      observedSourceFreshness: ["fresh"],
      observedStatuses: ["partial"],
      observedTruncationReasons: ["token-budget"]
    });
    expect(report.correctness.cases[4]).toMatchObject({
      observedSourceFreshness: ["stale"],
      observedStatuses: ["partial"],
      observedTruncationReasons: ["traversal-budget"]
    });
    expect(report.correctness.cases[5]).toMatchObject({
      observedSourceFreshness: ["stale"],
      observedStatuses: ["abstained"],
      observedTruncationReasons: []
    });
    expect(report.metrics.cases).toHaveLength(6);
    expect(report.metrics.cases[0]).toMatchObject({
      batchExecuteMilliseconds: {
        sampleCount: 1,
        p95: null,
        p99: null
      },
      executeMilliseconds: {
        sampleCount: 1,
        p95: null,
        p99: null
      },
      name: "wide-hot-complete-1"
    });
    expect(report.metrics.cases[2]).toMatchObject({
      executeMilliseconds: {
        sampleCount: 32,
        p95: null,
        p99: null
      },
      name: "wide-hot-complete-32"
    });
    expect(report.metrics.cases[5].emittedAssertions.samples).toEqual(
      Array.from({ length: 32 }, () => 0)
    );
    expect(report.metrics.cases[4].maxDepthReached.samples).toEqual(
      Array.from({ length: 4 }, () => 2)
    );
    expect(report.metrics.cases[4].estimatedTokens.sampleCount).toBe(4);
    expect(validateAgentDecisionReadReport(report)).toBe(report);

    const extraConfiguration = structuredClone(report);
    extraConfiguration.configuration.extra = true;
    expect(() => validateAgentDecisionReadReport(extraConfiguration))
      .toThrow(/configuration/u);

    const inventedTail = structuredClone(report);
    inventedTail.metrics.cases[0].executeMilliseconds.p95 = 1;
    expect(() => validateAgentDecisionReadReport(inventedTail))
      .toThrow(/p95/u);
  });

  it("writes only a new owner-private out-of-repository report", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "attunegraph-agent-decision-read-"))
    );
    const outputPath = join(directory, "report.json");
    const invalidOutputPath = join(directory, "invalid.json");
    try {
      const invalid = spawnSync(process.execPath, [
        fileURLToPath(new URL("./benchmark-attunegraph-agent-decision-read.mjs", import.meta.url)),
        "--workload=unknown@1",
        `--output=${invalidOutputPath}`
      ], { encoding: "utf8", timeout: 10_000 });
      expect(invalid.status).not.toBe(0);
      await expect(access(invalidOutputPath)).rejects.toMatchObject({ code: "ENOENT" });

      const valid = spawnSync(process.execPath, [
        fileURLToPath(new URL("./benchmark-attunegraph-agent-decision-read.mjs", import.meta.url)),
        "--workload=agent-decision-read@1",
        "--warmups=0",
        "--repetitions=1",
        `--output=${outputPath}`
      ], { encoding: "utf8", timeout: 15_000 });
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stdout).toBe("");
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      const report = JSON.parse(await readFile(outputPath, "utf8"));
      expect(validateAgentDecisionReadReport(report)).toBe(report);

      const overwrite = spawnSync(process.execPath, [
        fileURLToPath(new URL("./benchmark-attunegraph-agent-decision-read.mjs", import.meta.url)),
        "--workload=agent-decision-read@1",
        "--warmups=0",
        "--repetitions=1",
        `--output=${outputPath}`
      ], { encoding: "utf8", timeout: 10_000 });
      expect(overwrite.status).not.toBe(0);
      expect(overwrite.stderr).toMatch(/already exists/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
