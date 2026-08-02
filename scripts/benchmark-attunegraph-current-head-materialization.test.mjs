import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  pairCurrentHeadMaterializationProfiles,
  runCurrentHeadMaterializationProfile
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
    const admission = {
      scale: 64,
      runtime: structuredClone(v2.runtime),
      semanticAggregateSha256: v2.correctness.semanticAggregateSha256
    };
    const pair = (left, right, expected = admission) =>
      pairCurrentHeadMaterializationProfiles(left, right, expected);
    const paired = pair(v2, v3);

    expect(paired.schema).toBe("attunegraph-current-head-materialization-paired@2");
    expect(v2.schema).toBe("attunegraph-current-head-materialization-profile@2");
    expect(paired.provenance).toEqual(v2.provenance);
    expect(paired.provenance).toEqual(v3.provenance);
    expect(v2.runtime.runtimeArtifact).toEqual(v3.runtime.runtimeArtifact);
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
