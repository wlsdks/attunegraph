import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  pairCurrentHeadMaterializationProfiles,
  pairV4StorageCostProfiles,
  runCurrentHeadMaterializationProfile,
  runV4StorageCostBenchmark,
  runV4StorageCostProfile
} from "./benchmark-attunegraph-current-head-materialization.mjs";

it("pairs v2 and v3 materialization with exact semantic bytes and explicit non-query limits", async () => {
  const created = mkdtempSync(join(tmpdir(), "attunegraph-materialization-test-"));
  const directory = realpathSync(created);
  try {
    const v2 = await runCurrentHeadMaterializationProfile({
      profile: "v2",
      scale: 64,
      databasePath: join(directory, "v2.sqlite")
    });
    const v3 = await runCurrentHeadMaterializationProfile({
      profile: "v3",
      scale: 64,
      databasePath: join(directory, "v3.sqlite")
    });
    const v3Storage = await runV4StorageCostProfile({
      profile: "v3",
      scale: 64,
      databasePath: join(directory, "v3-storage.sqlite")
    });
    const v4 = await runV4StorageCostProfile({
      profile: "v4",
      scale: 64,
      databasePath: join(directory, "v4.sqlite")
    });
    const admission = {
      scale: 64,
      runtime: structuredClone(v2.runtime),
      semanticAggregateSha256: v2.correctness.semanticAggregateSha256
    };
    const pair = (left, right, expected = admission) =>
      pairCurrentHeadMaterializationProfiles(left, right, expected);
    const paired = pair(v2, v3);
    const pairedV3V4 = pairV4StorageCostProfiles(v3Storage, v4, admission);

    await expect(runCurrentHeadMaterializationProfile({
      profile: "v4",
      scale: 64,
      databasePath: join(directory, "legacy-v4.sqlite")
    })).rejects.toThrow(/options are invalid/u);

    expect(paired.schema).toBe("attunegraph-current-head-materialization-paired@2");
    expect(v2.schema).toBe("attunegraph-current-head-materialization-profile@2");
    expect(v3Storage.schema).toBe("attunegraph-current-head-v4-storage-profile@1");
    expect(v4.schema).toBe("attunegraph-current-head-v4-storage-profile@1");
    expect(paired.provenance).toEqual(v2.provenance);
    expect(paired.provenance).toEqual(v3.provenance);
    expect(pairedV3V4.provenance).toEqual(v4.provenance);
    expect(v2.runtime.runtimeArtifact).toEqual(v3.runtime.runtimeArtifact);
    expect(v3Storage.runtime.runtimeArtifact).toEqual(v4.runtime.runtimeArtifact);
    expect(v3.runtime.runtimeArtifact).toMatchObject({
      schema: "attunegraph-runtime-artifact@1",
      roots: expect.arrayContaining([
        "dist/attunegraph-engine.js",
        "dist/attunegraph-sqlite-store.js"
      ]),
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "dist/attunegraph-local-worker.mjs",
          bytes: expect.any(Number),
          sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
        })
      ]),
      aggregateSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
    });
    expect(paired.provenance.repository).toMatchObject({
      commit: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
      tree: expect.stringMatching(/^[0-9a-f]{40,64}$/u),
      lockfileSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      sourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      sourceState: {
        schema: "attunegraph-source-state@1",
        aggregateSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
      }
    });
    const { artifactIdentity, ...reportBody } = paired;
    expect(artifactIdentity).toEqual({
      schema: "attunegraph-json-report-content@1",
      canonicalization: "UTF-8 JSON.stringify(report without artifactIdentity)",
      sha256: `sha256:${createHash("sha256").update(JSON.stringify(reportBody)).digest("hex")}`
    });
    expect(paired.correctness).toEqual({
      semanticAggregateSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      v2V3SemanticByteIdentity: true
    });
    expect(v2.storage.database).toMatchObject({
      userVersion: 2,
      journalRows: 2,
      headRows: 2,
      finalPhysicalRows: 4
    });
    expect(v3.storage.database).toMatchObject({
      userVersion: 3,
      journalRows: 2,
      headRows: 2,
      manifestRows: 2,
      assertionRows: 64,
      sourceRefRows: 64,
      adjacencyLookupIndexes: 2,
      finalPhysicalRows: 134
    });
    expect(v3Storage.storage.database).toMatchObject({
      userVersion: 3,
      endpointDegreeRows: 0,
      finalPhysicalRows: 134
    });
    expect(v4.storage.database).toMatchObject({
      userVersion: 4,
      journalRows: 2,
      headRows: 2,
      manifestRows: 2,
      assertionRows: 64,
      sourceRefRows: 64,
      endpointDegreeRows: 66,
      adjacencyLookupIndexes: 2,
      finalPhysicalRows: 200
    });
    expect(pairedV3V4).toMatchObject({
      schema: "attunegraph-current-head-v4-storage-paired@1",
      measurementOnly: true,
      claimEligible: false,
      correctness: {
        semanticAggregateSha256: v3Storage.correctness.semanticAggregateSha256,
        v3V4SemanticByteIdentity: true
      },
      profiles: { v3: v3Storage, v4 },
      amplification: {
        materializationWriteDurationRatioV4OverV3: expect.any(Number),
        settledDatabaseBytesRatioV4OverV3: expect.any(Number),
        settledPageCountRatioV4OverV3: expect.any(Number),
        finalPhysicalRowsRatioV4OverV3: 200 / 134,
        reopenValidationDurationRatioV4OverV3: expect.any(Number),
        adminFullIntegrityDurationRatioV4OverV3: expect.any(Number)
      },
      qualification: {
        competitorComparisonMeasured: false,
        resourceRatiosMeasured: false
      }
    });
    expect(v3.materialization.reopenValidationDurationMs).toBeGreaterThan(0);
    expect(v2.materialization.reopenValidationDurationMs).toBeGreaterThan(0);
    expect(v3.materialization.adminFullIntegrityDurationMs).toBeGreaterThan(0);
    expect(v2.materialization.adminFullIntegrityDurationMs).toBeGreaterThan(0);
    expect(paired.qualification).toEqual({
      threshold: null,
      status: "measurement-only-no-threshold",
      queryLatencyMeasured: false,
      cumulativeWalWriteAmplificationMeasured: false
    });
    expect(v3.storage.productionWalSnapshotIsCumulativeWriteEvidence).toBe(false);
    expect(v3.resources.processMaxRssBytes).toBeGreaterThan(0);
    expect(v3.resources.checkpointMaxHeapUsedBytes).toBeGreaterThan(0);

    const divergent = structuredClone(v2);
    divergent.provenance.packageRoot = `${divergent.provenance.packageRoot}-different`;
    expect(() => pair(divergent, v3))
      .toThrow(/source provenance diverged/u);

    const forged = structuredClone(v2);
    forged.provenance.repository.sourceState.unstaged.patchSha256 = `sha256:${"0".repeat(64)}`;
    expect(() => pair(forged, v3))
      .toThrow(/source provenance identity is invalid/u);

    const adversarial = [
      ["forged child schema", (child) => { child.schema = "attunegraph-forged@999"; }],
      ["unknown child key", (child) => { child.forged = true; }],
      ["claim eligibility escalation", (child) => { child.claimEligible = true; }],
      ["v2 child profile substitution", (child) => { child.profile = "v3"; }],
      ["v2 scale forgery", (child) => { child.scale = 1; }],
      ["v3 scale forgery", (child) => { child.scale = 999; }],
      ["corpus hash forgery", (child) => { child.corpus.sha256 = "0".repeat(64); }],
      ["runtime substitution", (child) => { child.runtime.node = "v999.0.0"; }],
      ["correctness escalation", (child) => {
        child.correctness.exactCurrentProjectionReadAfterEveryCas = false;
      }],
      ["nested unknown key", (child) => { child.storage.database.forged = 1; }]
    ];
    for (const [label, mutate] of adversarial) {
      const child = structuredClone(label.includes("v3") ? v3 : v2);
      mutate(child);
      expect(() => pair(
        child.profile === "v3" && label !== "v2 child profile substitution" ? v2 : child,
        child.profile === "v3" && label !== "v2 child profile substitution" ? child : v3
      ), label).toThrow(/materialization/u);
    }

    const forgedRuntimePair = [structuredClone(v2), structuredClone(v3)];
    forgedRuntimePair[0].runtime.node = "v999.0.0";
    forgedRuntimePair[1].runtime.node = "v999.0.0";
    expect(() => pair(forgedRuntimePair[0], forgedRuntimePair[1]))
      .toThrow(/parent runtime/u);

    const forgedSemanticPair = [structuredClone(v2), structuredClone(v3)];
    forgedSemanticPair[0].correctness.semanticAggregateSha256 = "0".repeat(64);
    forgedSemanticPair[1].correctness.semanticAggregateSha256 = "0".repeat(64);
    expect(() => pair(forgedSemanticPair[0], forgedSemanticPair[1]))
      .toThrow(/workload anchor/u);

    const forgedScalePair = [structuredClone(v2), structuredClone(v3)];
    forgedScalePair[0].scale = 32;
    forgedScalePair[1].scale = 32;
    forgedScalePair[0].correctness.expectedAssertions = 32;
    forgedScalePair[0].correctness.observedAssertionRows = 32;
    forgedScalePair[1].correctness.expectedAssertions = 32;
    forgedScalePair[1].correctness.observedAssertionRows = 32;
    forgedScalePair[0].materialization.committedAssertions = 32;
    forgedScalePair[1].materialization.committedAssertions = 32;
    expect(() => pair(forgedScalePair[0], forgedScalePair[1]))
      .toThrow(/requested scale|invariants/u);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it("rejects unknown v4 storage cost CLI options before starting a benchmark", () => {
  expect(() => runV4StorageCostBenchmark(["--scale=10000", "--bogus=true"]))
    .toThrow(/arguments are invalid/u);
});
