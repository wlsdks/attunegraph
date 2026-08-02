import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  captureAgentDecisionReadRepositoryIdentity,
  createAgentDecisionReadWorkload,
  parseAgentDecisionReadArguments,
  runAgentDecisionReadBenchmark,
  runAgentDecisionReadCommand,
  runAgentDecisionReadWorkload,
  validateAgentDecisionReadReportSchema,
  verifyAgentDecisionReadReportAuthority
} from "./benchmark-attunegraph-agent-decision-read.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

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
      projectedAssertionInputs: 1_232,
      sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      uniqueAssertionsAtHead: 154
    });
    expect(first).not.toHaveProperty("totalAssertions");
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
      decisionQueryAnchorSha256: entry.decisionQueryAnchorSha256,
      decisionQuerySamples: entry.decisionQuerySamples.map((sample) => ({
        abstentionReasons: sample.abstentionReasons,
        admissionExact: sample.admissionExact,
        anchorSha256: sample.anchorSha256,
        assertionWitnesses: sample.assertionWitnesses,
        outputBytes: sample.outputBytes,
        receiptBytes: sample.receiptBytes,
        sourceWitnesses: sample.sourceWitnesses,
        status: sample.status
      })),
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
    expect(first.cases.map((entry) => ({
      abstentionReasons: [...new Set(entry.decisionQuerySamples.flatMap(
        (sample) => sample.abstentionReasons
      ))],
      admissionsExact: entry.decisionQuerySamples.every((sample) => sample.admissionExact),
      name: entry.name,
      statuses: [...new Set(entry.decisionQuerySamples.map((sample) => sample.status))],
      witnesses: [...new Set(entry.decisionQuerySamples.map(
        (sample) => sample.assertionWitnesses
      ))]
    }))).toEqual([
      { abstentionReasons: [], admissionsExact: true, name: "wide-hot-complete-1", statuses: ["complete"], witnesses: [32] },
      { abstentionReasons: [], admissionsExact: true, name: "wide-hot-token-partial-4", statuses: ["partial"], witnesses: [2] },
      { abstentionReasons: [], admissionsExact: true, name: "wide-hot-complete-32", statuses: ["complete"], witnesses: [32] },
      { abstentionReasons: [], admissionsExact: true, name: "deep-cold-complete-1", statuses: ["complete"], witnesses: [2] },
      { abstentionReasons: ["source-not-fresh"], admissionsExact: true, name: "deep-cold-traversal-partial-4", statuses: ["abstained"], witnesses: [0] },
      { abstentionReasons: ["source-not-fresh"], admissionsExact: true, name: "deep-cold-valid-time-abstain-32", statuses: ["abstained"], witnesses: [0] }
    ]);
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
        decisionSemantics: "independent-single-seed-execute-and-decision-query@1",
        measurementBoundary: {
          admission: "admitDecisionQueryResult(JSON.parse(JSON.stringify(producerResult)))",
          decisionQueryEndToEnd: "graph.query plus JSON encode/parse plus admission",
          excluded: [
            "agent-model-token-use",
            "source-truth-or-permission-or-action-authority",
            "competitor-comparison"
          ],
          producer: "graph.query(decision-query@1)",
          transport: "JSON.stringify plus JSON.parse",
          workingGraphExecute: "graph.execute(working-graph@1)"
        },
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
      schema: "attunegraph-agent-decision-read-benchmark@2",
      workload: {
        generation: 8,
        projectedAssertionInputs: 1_232,
        sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        uniqueAssertionsAtHead: 154
      }
    });
    expect(Object.keys(report).sort()).toEqual([
      "claimEligible",
      "configuration",
      "correctness",
      "decisionQueryCorrectness",
      "decisionQueryMetrics",
      "host",
      "measurementOnly",
      "metrics",
      "observedAt",
      "repository",
      "schema",
      "workload"
    ]);
    expect(report.correctness.allAnchorsMatched).toBe(true);
    expect(report.decisionQueryCorrectness).toMatchObject({
      allAdmissionsExact: true,
      allAnchorsMatched: true
    });
    expect(report.decisionQueryCorrectness.cases[4]).toMatchObject({
      abstentionReasons: ["source-not-fresh"],
      allAdmissionsExact: true,
      expectedStatus: "abstained",
      observedStatuses: ["abstained"]
    });
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
      batchWallMilliseconds: {
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
    expect(report.metrics.cases.every((entry) =>
      entry.batchWallMilliseconds.samples.every((wall, index) =>
        wall >= entry.batchExecuteMilliseconds.samples[index]
      )
    )).toBe(true);
    expect(report.metrics.cases[5].emittedAssertions.samples).toEqual(
      Array.from({ length: 32 }, () => 0)
    );
    expect(report.metrics.cases[4].maxDepthReached.samples).toEqual(
      Array.from({ length: 4 }, () => 2)
    );
    expect(report.metrics.cases[4].estimatedTokens.sampleCount).toBe(4);
    expect(report.decisionQueryMetrics.cases).toHaveLength(6);
    expect(report.decisionQueryMetrics.cases[2]).toMatchObject({
      admissionMilliseconds: { sampleCount: 32, p95: null, p99: null },
      endToEndMilliseconds: { sampleCount: 32, p95: null, p99: null },
      name: "wide-hot-complete-32",
      producerMilliseconds: { sampleCount: 32, p95: null, p99: null },
      transportMilliseconds: { sampleCount: 32, p95: null, p99: null }
    });
    expect(report.decisionQueryMetrics.cases[4].assertionWitnesses.samples).toEqual(
      Array.from({ length: 4 }, () => 0)
    );
    expect(validateAgentDecisionReadReportSchema(report)).toBe(report);

    const extraConfiguration = structuredClone(report);
    extraConfiguration.configuration.extra = true;
    expect(() => validateAgentDecisionReadReportSchema(extraConfiguration))
      .toThrow(/configuration/u);

    const inventedTail = structuredClone(report);
    inventedTail.metrics.cases[0].executeMilliseconds.p95 = 1;
    expect(() => validateAgentDecisionReadReportSchema(inventedTail))
      .toThrow(/p95/u);

    const droppedCounterSample = structuredClone(report);
    droppedCounterSample.metrics.cases[2].consideredAssertions.samples.pop();
    droppedCounterSample.metrics.cases[2].consideredAssertions.sampleCount -= 1;
    expect(() => validateAgentDecisionReadReportSchema(droppedCounterSample))
      .toThrow(/sampleCount/u);

    const contradictoryBatchExecute = structuredClone(report);
    const batchExecute = contradictoryBatchExecute.metrics.cases[0]
      .batchExecuteMilliseconds;
    batchExecute.samples[0] += 1;
    batchExecute.min = batchExecute.samples[0];
    batchExecute.max = batchExecute.samples[0];
    batchExecute.p50 = batchExecute.samples[0];
    expect(() => validateAgentDecisionReadReportSchema(contradictoryBatchExecute))
      .toThrow(/batchExecuteMilliseconds/u);

    const impossibleBatchWall = structuredClone(report);
    const batchWall = impossibleBatchWall.metrics.cases[0].batchWallMilliseconds;
    batchWall.samples[0] = 0;
    batchWall.min = 0;
    batchWall.max = 0;
    batchWall.p50 = 0;
    expect(() => validateAgentDecisionReadReportSchema(impossibleBatchWall))
      .toThrow(/batchWallMilliseconds/u);

    const gamedCounter = structuredClone(report);
    const considered = gamedCounter.metrics.cases[0].consideredAssertions;
    considered.samples[0] = 999_999;
    considered.min = 999_999;
    considered.max = 999_999;
    considered.p50 = 999_999;
    expect(() => validateAgentDecisionReadReportSchema(gamedCounter))
      .toThrow(/consideredAssertions/u);

    const arbitraryAnchor = structuredClone(report);
    arbitraryAnchor.correctness.cases[0].anchorSha256 = `sha256:${"0".repeat(64)}`;
    expect(() => validateAgentDecisionReadReportSchema(arbitraryAnchor))
      .toThrow(/correctness.cases\[0\]/u);

    const arbitraryHead = structuredClone(report);
    arbitraryHead.correctness.cases[0].latestHeadCommitId =
      `attunegraph-commit:attunegraph-observation:${"0".repeat(64)}`;
    expect(() => validateAgentDecisionReadReportSchema(arbitraryHead))
      .toThrow(/correctness.cases\[0\]/u);

    const inexactAdmission = structuredClone(report);
    inexactAdmission.decisionQueryCorrectness.cases[0].allAdmissionsExact = false;
    expect(() => validateAgentDecisionReadReportSchema(inexactAdmission))
      .toThrow(/decisionQueryCorrectness/u);

    const gamedReceiptBytes = structuredClone(report);
    const receiptBytes = gamedReceiptBytes.decisionQueryMetrics.cases[0].receiptBytes;
    receiptBytes.samples[0] += 1;
    receiptBytes.min = receiptBytes.samples[0];
    receiptBytes.max = receiptBytes.samples[0];
    receiptBytes.p50 = receiptBytes.samples[0];
    expect(() => validateAgentDecisionReadReportSchema(gamedReceiptBytes))
      .toThrow(/receiptBytes/u);

    const contradictoryArgv = structuredClone(report);
    contradictoryArgv.configuration.argv = [
      "--workload=agent-decision-read@1",
      "--warmups=1",
      "--repetitions=1"
    ];
    expect(() => validateAgentDecisionReadReportSchema(contradictoryArgv))
      .toThrow(/configuration.argv/u);

    const programmatic = structuredClone(report);
    programmatic.configuration.argv = [];
    expect(validateAgentDecisionReadReportSchema(programmatic)).toBe(programmatic);

    const expectedAuthority = {
      configuration: {
        argv: [...report.configuration.argv],
        repetitions: report.configuration.repetitions,
        warmups: report.configuration.warmups,
        workload: report.configuration.workload
      },
      host: structuredClone(report.host),
      repository: structuredClone(report.repository)
    };
    expect(verifyAgentDecisionReadReportAuthority(report, expectedAuthority)).toBe(report);
    const contradictoryRepository = structuredClone(report);
    contradictoryRepository.repository.commit = "0".repeat(40);
    expect(validateAgentDecisionReadReportSchema(contradictoryRepository))
      .toBe(contradictoryRepository);
    expect(() => verifyAgentDecisionReadReportAuthority(
      contradictoryRepository,
      expectedAuthority
    )).toThrow(/repository authority/u);
  });

  it("imports the decision-read entry from the packed package", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "attunegraph-agent-decision-read-pack-"))
    );
    const consumer = join(directory, "consumer");
    try {
      const packed = spawnSync(npmCommand, [
        "pack",
        "--json",
        "--pack-destination",
        directory
      ], {
        cwd: packageRoot,
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 120_000
      });
      expect(packed.status, packed.error?.stack ?? packed.stderr).toBe(0);
      const artifacts = JSON.parse(packed.stdout);
      expect(artifacts).toHaveLength(1);

      await mkdir(consumer, { mode: 0o700 });
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({ name: "attunegraph-benchmark-pack-smoke", private: true }),
        { mode: 0o600 }
      );
      const installed = spawnSync(npmCommand, [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(directory, artifacts[0].filename)
      ], {
        cwd: consumer,
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 120_000
      });
      expect(installed.status, installed.error?.stack ?? installed.stderr).toBe(0);

      const installedEntry = join(
        consumer,
        "node_modules",
        "@attunegraph",
        "core",
        "scripts",
        "benchmark-attunegraph-agent-decision-read.mjs"
      );
      const imported = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(installedEntry).href)})`
      ], {
        cwd: consumer,
        encoding: "utf8",
        timeout: 30_000
      });
      expect(imported.status, imported.stderr).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 30_000);

  it("captures repository provenance from the package root, not caller cwd", async () => {
    const foreignRepository = await realpath(
      await mkdtemp(join(tmpdir(), "attunegraph-agent-decision-read-foreign-git-"))
    );
    try {
      expect(spawnSync("git", ["init"], {
        cwd: foreignRepository,
        encoding: "utf8"
      }).status).toBe(0);
      await writeFile(join(foreignRepository, "foreign.txt"), "foreign\n", { mode: 0o600 });
      expect(spawnSync("git", ["add", "foreign.txt"], {
        cwd: foreignRepository,
        encoding: "utf8"
      }).status).toBe(0);
      expect(spawnSync("git", [
        "-c",
        "user.name=AttuneGraph Test",
        "-c",
        "user.email=attunegraph-test@example.invalid",
        "commit",
        "-m",
        "foreign"
      ], {
        cwd: foreignRepository,
        encoding: "utf8"
      }).status).toBe(0);

      const captured = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        [
          `import { captureAgentDecisionReadRepositoryIdentity as capture } from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL("./benchmark-attunegraph-agent-decision-read.mjs", import.meta.url))).href)};`,
          "process.stdout.write(JSON.stringify(capture()));"
        ].join("\n")
      ], {
        cwd: foreignRepository,
        encoding: "utf8",
        timeout: 10_000
      });
      expect(captured.status, captured.stderr).toBe(0);
      const identity = JSON.parse(captured.stdout);
      const expectedCommit = spawnSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
        encoding: "utf8"
      }).stdout.trim();
      const foreignCommit = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: foreignRepository,
        encoding: "utf8"
      }).stdout.trim();
      expect(identity.commit).toBe(expectedCommit);
      expect(identity.commit).not.toBe(foreignCommit);
      expect(identity).toEqual(captureAgentDecisionReadRepositoryIdentity());
    } finally {
      await rm(foreignRepository, { force: true, recursive: true });
    }
  });

  it("writes only a new owner-private out-of-repository report", async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "attunegraph-agent-decision-read-"))
    );
    const outputPath = join(directory, "report.json");
    const invalidOutputPath = join(directory, "invalid.json");
    const dirtyOutputPath = join(directory, "dirty.json");
    const driftOutputPath = join(directory, "drift.json");
    const cleanRepository = {
      clean: true,
      commit: "a".repeat(40),
      lockfileSha256: `sha256:${"b".repeat(64)}`,
      tree: "c".repeat(40)
    };
    const host = {
      arch: "test",
      cpuCount: 1,
      cpuModel: "test",
      node: "24.15.0",
      os: "test",
      pnpm: "10.18.0",
      totalMemoryBytes: 1
    };
    try {
      const invalid = spawnSync(process.execPath, [
        fileURLToPath(new URL("./benchmark-attunegraph-agent-decision-read.mjs", import.meta.url)),
        "--workload=unknown@1",
        `--output=${invalidOutputPath}`
      ], { encoding: "utf8", timeout: 10_000 });
      expect(invalid.status).not.toBe(0);
      await expect(access(invalidOutputPath)).rejects.toMatchObject({ code: "ENOENT" });

      await expect(runAgentDecisionReadCommand([
        "--workload=agent-decision-read@1",
        "--warmups=0",
        "--repetitions=1",
        `--output=${dirtyOutputPath}`
      ], {
        captureRepositoryIdentity: () => ({ ...cleanRepository, clean: false }),
        host
      })).rejects.toThrow(/clean source checkout/u);
      await expect(access(dirtyOutputPath)).rejects.toMatchObject({ code: "ENOENT" });

      const driftIdentities = [
        cleanRepository,
        { ...cleanRepository, clean: false }
      ];
      await expect(runAgentDecisionReadCommand([
        "--workload=agent-decision-read@1",
        "--warmups=0",
        "--repetitions=1",
        `--output=${driftOutputPath}`
      ], {
        captureRepositoryIdentity: () => driftIdentities.shift(),
        host
      })).rejects.toThrow(/clean source checkout/u);
      await expect(access(driftOutputPath)).rejects.toMatchObject({ code: "ENOENT" });

      const stableIdentities = [cleanRepository, cleanRepository];
      const writtenReport = await runAgentDecisionReadCommand([
        "--workload=agent-decision-read@1",
        "--warmups=0",
        "--repetitions=1",
        `--output=${outputPath}`
      ], {
        captureRepositoryIdentity: () => stableIdentities.shift(),
        host
      });
      if (process.platform !== "win32") {
        expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      }
      const report = JSON.parse(await readFile(outputPath, "utf8"));
      expect(report).toEqual(writtenReport);
      expect(validateAgentDecisionReadReportSchema(report)).toBe(report);

      await expect(runAgentDecisionReadCommand([
        "--workload=agent-decision-read@1",
        "--warmups=0",
        "--repetitions=1",
        `--output=${outputPath}`
      ], {
        captureRepositoryIdentity: () => cleanRepository,
        host
      })).rejects.toThrow(/already exists/u);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
