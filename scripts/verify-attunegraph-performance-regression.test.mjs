import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parsePerformanceRegressionArguments,
  runPerformanceRegressionCommand,
  verifyPerformanceRegression
} from "./verify-attunegraph-performance-regression.mjs";
import shippedPolicy from "../performance-regression-policy.json" with { type: "json" };

const CLI_PATH = fileURLToPath(new URL("./verify-attunegraph-performance-regression.mjs", import.meta.url));
const SHIPPED_POLICY_BYTES = readFileSync(new URL("../performance-regression-policy.json", import.meta.url), "utf8");
const SHIPPED_POLICY_ARTIFACT = {
  bytes: SHIPPED_POLICY_BYTES,
  sha256: `sha256:${createHash("sha256").update(SHIPPED_POLICY_BYTES).digest("hex")}`
};

const SHA = (character) => `sha256:${character.repeat(64)}`;
const COMMIT = (character) => character.repeat(40);

function artifact(document) {
  const bytes = `${JSON.stringify(document, null, 2)}\n`;
  return {
    bytes,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  };
}

function policy(overrides = {}) {
  return {
    absoluteMaximumRssBytes: 512 * 1024 ** 2,
    approvedAt: "2026-08-01T00:00:00.000Z",
    percentileMinimumPairs: { p50: 5, p95: 40, p99: 200 },
    policyId: "fixture-performance-regression-v1",
    referenceClasses: [
      {
        hardLatencyThresholds: { p50: null, p95: null, p99: null },
        id: "github-hosted-shared",
        kind: "shared-github"
      }
    ],
    requiredPairCount: 5,
    schema: "attunegraph-performance-regression-policy@1",
    ...overrides
  };
}

function bundle({
  pairId,
  side,
  order,
  latencyMilliseconds,
  peakRssBytes = 256 * 1024 ** 2,
  referenceClassId = "github-hosted-shared"
}) {
  const base = side === "base";
  return {
    packageArtifact: {
      bytes: base ? 1_000 : 1_100,
      kind: "npm-tarball",
      sha256: base ? SHA("a") : SHA("b")
    },
    campaignId: "campaign-001",
    correctness: {
      checksPassed: 3,
      checksTotal: 3,
      status: "pass",
      workloadOutput: { bytes: 42, sha256: SHA("c") }
    },
    corpus: {
      caseCount: 6,
      schema: "attunegraph-agent-decision-read-workload@1",
      sha256: SHA("d")
    },
    harness: {
      command: ["node", "scripts/benchmark-attunegraph-agent-decision-read.mjs"],
      schema: "attunegraph-performance-harness@1",
      sha256: SHA("e")
    },
    host: {
      arch: "x64",
      cpuCount: 4,
      cpuModel: "GitHub Actions fixture",
      kernel: "6.11.0-fixture",
      os: "linux",
      referenceClassId,
      runnerImage: "ubuntu-24.04",
      runnerImageSha256: SHA("7"),
      totalMemoryBytes: 16 * 1024 ** 3
    },
    measurements: { latencyMilliseconds, peakRssBytes },
    observedAt: `2026-08-01T00:00:0${Number(pairId.at(-1))}.000Z`,
    order,
    pairId,
    performanceContract: {
      schema: "attunegraph-agent-decision-read@1",
      sha256: SHA("f")
    },
    repository: {
      clean: true,
      commit: base ? COMMIT("1") : COMMIT("2"),
      lockfileSha256: base ? SHA("1") : SHA("2"),
      tree: base ? COMMIT("3") : COMMIT("4")
    },
    runtime: { node: "24.15.0", nodeExecutableSha256: SHA("8"), pnpm: "10.18.0" },
    schema: "attunegraph-performance-regression-bundle@1",
    side
  };
}

function fixture({
  baseLatencyMilliseconds = 10,
  policyDocument = policy(),
  policyArtifact: policyArtifactOverride,
  ratios = [1.1, 0.9, 1.2, 1, 1.05]
} = {}) {
  const policyArtifact = policyArtifactOverride ?? artifact(policyDocument);
  const referenceClassId = policyDocument.referenceClasses[0].id;
  const bundles = [];
  const pairs = ratios.map((ratio, index) => {
    const pairNumber = index + 1;
    const pairId = `pair-${String(pairNumber).padStart(2, "0")}`;
    const order = index % 2 === 0 ? "AB" : "BA";
    const basePath = `${pairId}-base.json`;
    const candidatePath = `${pairId}-candidate.json`;
    const baseArtifact = artifact(bundle({
      pairId,
      side: "base",
      order,
      latencyMilliseconds: baseLatencyMilliseconds,
      referenceClassId
    }));
    const candidateArtifact = artifact(bundle({
      pairId,
      side: "candidate",
      order,
      latencyMilliseconds: baseLatencyMilliseconds * ratio,
      referenceClassId
    }));
    bundles.push({ path: basePath, ...baseArtifact }, { path: candidatePath, ...candidateArtifact });
    return {
      attemptId: `attempt-${String(pairNumber).padStart(2, "0")}`,
      base: { path: basePath, sha256: baseArtifact.sha256 },
      candidate: { path: candidatePath, sha256: candidateArtifact.sha256 },
      order,
      pairId
    };
  });
  const firstBase = JSON.parse(bundles[0].bytes);
  const firstCandidate = JSON.parse(bundles[1].bytes);
  const expectedIdentity = (document) => ({
    packageArtifact: document.packageArtifact,
    repository: {
      commit: document.repository.commit,
      lockfileSha256: document.repository.lockfileSha256,
      tree: document.repository.tree
    }
  });
  const manifest = {
    campaignId: "campaign-001",
    createdAt: "2026-08-01T00:00:00.000Z",
    expectedIdentities: {
      base: expectedIdentity(firstBase),
      candidate: expectedIdentity(firstCandidate)
    },
    pairs,
    plannedAttempts: pairs.map(({ attemptId, order, pairId }) => ({
      attemptId,
      order,
      pairId,
      status: "completed"
    })),
    policySha256: policyArtifact.sha256,
    referenceClassId,
    schema: "attunegraph-performance-regression-manifest@1"
  };
  return {
    bundles,
    manifest: artifact(manifest),
    policy: policyArtifact
  };
}

function replaceBundle(input, path, mutate) {
  const target = input.bundles.find((item) => item.path === path);
  const document = JSON.parse(target.bytes);
  mutate(document);
  Object.assign(target, artifact(document));
  const manifest = JSON.parse(input.manifest.bytes);
  const pair = manifest.pairs.find((item) => item.base.path === path || item.candidate.path === path);
  const side = pair.base.path === path ? "base" : "candidate";
  pair[side].sha256 = target.sha256;
  input.manifest = artifact(manifest);
  return input;
}

function replaceManifest(input, mutate) {
  const manifest = JSON.parse(input.manifest.bytes);
  mutate(manifest);
  input.manifest = artifact(manifest);
  return input;
}

describe("AttuneGraph performance regression verifier", () => {
  it("recomputes five paired ratios and keeps shared GitHub latency advisory", () => {
    const result = verifyPerformanceRegression(fixture());

    expect(result).toMatchObject({
      advisoryGateQualified: true,
      blockers: [
        "evidence-bundle-unattested",
        "latency-advisory-shared-github-reference-class"
      ],
      claimEligible: false,
      evidenceAuthority: "unattested",
      integrityQualified: true,
      latencyAuthoritative: false,
      latencyMeasured: true,
      latencyPolicySatisfied: false,
      measurementOnly: true,
      regressionQualified: false,
      resourceAuthoritative: false,
      resourcePolicySatisfied: true,
      resourceQualified: false,
      schema: "attunegraph-performance-regression@1"
    });
    expect(result.latency).toEqual({
      deltaPercentiles: { p50: 0.5, p95: null, p99: null },
      eligible: { p50: true, p95: false, p99: false },
      medianDeltaMilliseconds: 0.5,
      medianRatio: 1.05,
      pairCount: 5,
      pairDeltasMilliseconds: [1, -1, 2, 0, 0.5],
      pairRatios: [1.1, 0.9, 1.2, 1, 1.05],
      percentiles: { p50: 1.05, p95: null, p99: null }
    });
  });

  it("computes a dedicated approved threshold without treating hand-authored evidence as authority", () => {
    const dedicatedPolicy = policy({
      referenceClasses: [{
        hardLatencyThresholds: {
          p50: {
            approvalId: "owner-approved-dedicated-p50-v1",
            approvedAt: "2026-08-01T00:00:00.000Z",
            maximumRatio: 1.1,
            minimumAbsoluteRegressionMilliseconds: 1
          },
          p95: null,
          p99: null
        },
        id: "dedicated-linux-x64",
        kind: "dedicated"
      }]
    });

    expect(verifyPerformanceRegression(fixture({ policyDocument: dedicatedPolicy }))).toMatchObject({
      blockers: ["evidence-bundle-unattested"],
      claimEligible: false,
      evidenceAuthority: "unattested",
      integrityQualified: true,
      latencyAuthoritative: false,
      latencyMeasured: true,
      latencyPolicySatisfied: true,
      regressionQualified: false,
      resourcePolicySatisfied: true,
      resourceQualified: false
    });
  });

  it("rejects dirty and moving package revision identities", () => {
    expect(() => verifyPerformanceRegression(replaceBundle(
      fixture(),
      "pair-01-base.json",
      (document) => { document.repository.clean = false; }
    ))).toThrow(/clean and immutable/iu);

    expect(() => verifyPerformanceRegression(replaceBundle(
      fixture(),
      "pair-02-base.json",
      (document) => { document.repository.commit = COMMIT("9"); }
    ))).toThrow(/identity moved/iu);

    expect(() => verifyPerformanceRegression(replaceBundle(
      fixture(),
      "pair-02-base.json",
      (document) => { document.packageArtifact.sha256 = SHA("9"); }
    ))).toThrow(/identity moved/iu);

    expect(() => verifyPerformanceRegression(replaceManifest(fixture(), (manifest) => {
      manifest.expectedIdentities.candidate = manifest.expectedIdentities.base;
    }))).toThrow(/base and candidate identities must differ/iu);

    for (const [field, mutate] of [
      ["commit", (manifest) => {
        manifest.expectedIdentities.candidate.repository.commit = manifest.expectedIdentities.base.repository.commit;
      }],
      ["tree", (manifest) => {
        manifest.expectedIdentities.candidate.repository.tree = manifest.expectedIdentities.base.repository.tree;
      }],
      ["package artifact", (manifest) => {
        manifest.expectedIdentities.candidate.packageArtifact.sha256 = manifest.expectedIdentities.base.packageArtifact.sha256;
      }]
    ]) {
      expect(() => verifyPerformanceRegression(replaceManifest(fixture(), mutate)), field)
        .toThrow(new RegExp(`${field} identities must differ`, "iu"));
    }

    expect(() => verifyPerformanceRegression(replaceManifest(fixture(), (manifest) => {
      manifest.expectedIdentities.base.repository.commit = COMMIT("9");
    }))).toThrow(/expected base identity/iu);
  });

  it("rejects deterministic workload-output drift even when checks claim pass", () => {
    expect(() => verifyPerformanceRegression(replaceBundle(
      fixture(),
      "pair-03-candidate.json",
      (document) => { document.correctness.workloadOutput.sha256 = SHA("9"); }
    ))).toThrow(/deterministic workload output/iu);

    const coordinatedDrift = replaceBundle(replaceBundle(
      fixture(),
      "pair-03-base.json",
      (document) => { document.correctness.workloadOutput.sha256 = SHA("9"); }
    ), "pair-03-candidate.json", (document) => {
      document.correctness.workloadOutput.sha256 = SHA("9");
    });
    expect(() => verifyPerformanceRegression(coordinatedDrift)).toThrow(/workload output.*campaign/iu);
  });

  it("rejects host, runtime, harness, corpus, and performance-contract changes", () => {
    for (const [label, mutate] of [
      ["host", (document) => { document.host.cpuModel = "different host"; }],
      ["host", (document) => { document.host.runnerImageSha256 = SHA("9"); }],
      ["runtime", (document) => { document.runtime.node = "24.16.0"; }],
      ["runtime", (document) => { document.runtime.nodeExecutableSha256 = SHA("9"); }],
      ["harness", (document) => { document.harness.sha256 = SHA("9"); }],
      ["corpus", (document) => { document.corpus.sha256 = SHA("9"); }],
      ["performance contract", (document) => { document.performanceContract.sha256 = SHA("9"); }]
    ]) {
      expect(() => verifyPerformanceRegression(replaceBundle(
        fixture(),
        "pair-04-candidate.json",
        mutate
      )), label).toThrow(new RegExp(label.replace(" ", ".*"), "iu"));
    }
  });

  it("rejects incomplete, reordered, or invalid attempt plans instead of cherry-picking samples", () => {
    expect(() => verifyPerformanceRegression(replaceManifest(fixture(), (manifest) => {
      manifest.pairs.pop();
      manifest.plannedAttempts.pop();
    }))).toThrow(/pair count/iu);

    expect(() => verifyPerformanceRegression(replaceManifest(fixture(), (manifest) => {
      manifest.plannedAttempts[2].status = "invalid";
    }))).toThrow(/missing, deleted, reordered, or invalid attempts/iu);

    expect(() => verifyPerformanceRegression(replaceManifest(fixture(), (manifest) => {
      manifest.pairs[1].order = "AB";
      manifest.plannedAttempts[1].order = "AB";
    }))).toThrow(/alternate AB\/BA/iu);
  });

  it("hard-fails the absolute RSS ceiling independently of advisory latency", () => {
    const result = verifyPerformanceRegression(replaceBundle(
      fixture(),
      "pair-05-candidate.json",
      (document) => { document.measurements.peakRssBytes = 513 * 1024 ** 2; }
    ));
    expect(result).toMatchObject({
      blockers: [
        "evidence-bundle-unattested",
        "absolute-rss-ceiling-exceeded",
        "latency-advisory-shared-github-reference-class"
      ],
      integrityQualified: true,
      latencyMeasured: true,
      regressionQualified: false,
      resourcePolicySatisfied: false,
      resourceQualified: false
    });

    const hostRelative = fixture({
      policyDocument: policy({ absoluteMaximumRssBytes: 10 * 1024 ** 3 })
    });
    replaceBundle(hostRelative, "pair-05-candidate.json", (document) => {
      document.measurements.peakRssBytes = 9 * 1024 ** 3;
    });
    expect(verifyPerformanceRegression(hostRelative)).toMatchObject({
      blockers: expect.arrayContaining(["half-host-memory-rss-ceiling-exceeded"]),
      resourcePolicySatisfied: false,
      resourceQualified: false
    });
  });

  it("rejects a shared-runner policy that attempts a hard latency claim", () => {
    const invalidPolicy = policy({
      referenceClasses: [{
        hardLatencyThresholds: {
          p50: {
            approvalId: "not-authoritative",
            approvedAt: "2026-08-01T00:00:00.000Z",
            maximumRatio: 1.1,
            minimumAbsoluteRegressionMilliseconds: 1
          },
          p95: null,
          p99: null
        },
        id: "github-hosted-shared",
        kind: "shared-github"
      }]
    });
    expect(() => verifyPerformanceRegression(fixture({ policyDocument: invalidPolicy })))
      .toThrow(/shared GitHub.*hard latency/iu);
  });

  it("rejects byte tampering and unknown schema fields before qualification", () => {
    const tampered = fixture();
    tampered.bundles[0].bytes += " ";
    expect(() => verifyPerformanceRegression(tampered)).toThrow(/sha256 does not match exact bytes/iu);

    expect(() => verifyPerformanceRegression(replaceBundle(
      fixture(),
      "pair-01-base.json",
      (document) => { document.untrusted = true; }
    ))).toThrow(/unknown or missing fields/iu);
  });

  it("rejects non-finite derived arithmetic", () => {
    const overflow = replaceBundle(replaceBundle(
      fixture(),
      "pair-01-base.json",
      (document) => { document.measurements.latencyMilliseconds = 1e-300; }
    ), "pair-01-candidate.json", (document) => {
      document.measurements.latencyMilliseconds = 1e308;
    });
    expect(() => verifyPerformanceRegression(overflow)).toThrow(/derived latency ratio or delta is invalid/iu);
  });

  it("enforces policy approval, manifest creation, and observation chronology", () => {
    expect(() => verifyPerformanceRegression(replaceManifest(fixture(), (manifest) => {
      manifest.createdAt = "2026-07-31T23:59:59.999Z";
    }))).toThrow(/predate policy approval/iu);

    expect(() => verifyPerformanceRegression(replaceManifest(fixture(), (manifest) => {
      manifest.createdAt = "2026-08-01T00:00:03.000Z";
    }))).toThrow(/observation predates/iu);

    const postdatedThreshold = policy({
      referenceClasses: [{
        hardLatencyThresholds: {
          p50: {
            approvalId: "postdated-threshold",
            approvedAt: "2026-08-01T00:00:01.000Z",
            maximumRatio: 1.1,
            minimumAbsoluteRegressionMilliseconds: 1
          },
          p95: null,
          p99: null
        },
        id: "dedicated-linux-x64",
        kind: "dedicated"
      }]
    });
    expect(() => verifyPerformanceRegression(fixture({ policyDocument: postdatedThreshold })))
      .toThrow(/threshold approval.*postdate manifest/iu);
  });

  it("applies the frozen percentile eligibility minima to paired ratios", () => {
    const fortyRatios = Array.from({ length: 40 }, (_, index) => index < 3 ? 2 : 1);
    const fortyPairPolicy = policy({ requiredPairCount: 40 });
    const result = verifyPerformanceRegression(fixture({
      policyDocument: fortyPairPolicy,
      ratios: fortyRatios
    }));
    expect(result.latency.eligible).toEqual({ p50: true, p95: true, p99: false });
    expect(result.latency.percentiles).toEqual({ p50: 1, p95: 2, p99: null });

    const twoHundredPairPolicy = policy({ requiredPairCount: 200 });
    const twoHundred = verifyPerformanceRegression(fixture({
      policyDocument: twoHundredPairPolicy,
      ratios: Array.from({ length: 200 }, (_, index) => index < 3 ? 3 : 1)
    }));
    expect(twoHundred.latency.eligible).toEqual({ p50: true, p95: true, p99: true });
    expect(twoHundred.latency.percentiles.p99).toBe(3);
  });

  it("requires both an approved ratio and absolute delta before declaring dedicated regression", () => {
    const dedicatedPolicy = policy({
      referenceClasses: [{
        hardLatencyThresholds: {
          p50: {
            approvalId: "owner-approved-dedicated-p50-v1",
            approvedAt: "2026-08-01T00:00:00.000Z",
            maximumRatio: 1.1,
            minimumAbsoluteRegressionMilliseconds: 1
          },
          p95: null,
          p99: null
        },
        id: "dedicated-linux-x64",
        kind: "dedicated"
      }]
    });
    expect(verifyPerformanceRegression(fixture({
      baseLatencyMilliseconds: 0.01,
      policyDocument: dedicatedPolicy,
      ratios: [2, 2, 2, 2, 2]
    }))).toMatchObject({
      blockers: ["evidence-bundle-unattested"],
      latencyAuthoritative: false,
      latencyPolicySatisfied: true,
      regressionQualified: false
    });

    expect(verifyPerformanceRegression(fixture({
      policyDocument: dedicatedPolicy,
      ratios: [1.2, 1.2, 1.2, 1.2, 1.2]
    }))).toMatchObject({
      blockers: [
        "evidence-bundle-unattested",
        "latency-p50-ratio-and-delta-exceed-approved-threshold"
      ],
      latencyAuthoritative: false,
      latencyPolicySatisfied: false,
      regressionQualified: false
    });
  });

  it("keeps a dedicated tail threshold non-authoritative until its pair minimum is met", () => {
    const p95Policy = policy({
      referenceClasses: [{
        hardLatencyThresholds: {
          p50: null,
          p95: {
            approvalId: "owner-approved-dedicated-p95-v1",
            approvedAt: "2026-08-01T00:00:00.000Z",
            maximumRatio: 1.2,
            minimumAbsoluteRegressionMilliseconds: 1
          },
          p99: null
        },
        id: "dedicated-linux-x64",
        kind: "dedicated"
      }]
    });
    expect(verifyPerformanceRegression(fixture({ policyDocument: p95Policy }))).toMatchObject({
      blockers: ["evidence-bundle-unattested", "latency-threshold-p95-ineligible"],
      latencyAuthoritative: false,
      latencyPolicySatisfied: false,
      regressionQualified: false
    });
  });

  it("loads an exact frozen manifest and bundles through the read-only CLI contract", () => {
    const root = mkdtempSync(join(tmpdir(), "attunegraph-performance-regression-"));
    try {
      const input = fixture({
        policyArtifact: SHIPPED_POLICY_ARTIFACT,
        policyDocument: shippedPolicy
      });
      const manifestPath = join(root, "manifest.json");
      writeFileSync(manifestPath, input.manifest.bytes);
      for (const bundleArtifact of input.bundles) {
        writeFileSync(join(root, bundleArtifact.path), bundleArtifact.bytes);
      }

      expect(parsePerformanceRegressionArguments([
        `--manifest=${manifestPath}`
      ])).toEqual({ gate: "qualification", manifestPath });
      expect(parsePerformanceRegressionArguments([
        "--gate=advisory",
        "--",
        `--manifest=${manifestPath}`
      ])).toEqual({ gate: "advisory", manifestPath });
      expect(runPerformanceRegressionCommand([
        `--manifest=${manifestPath}`
      ])).toMatchObject({
        integrityQualified: true,
        latencyMeasured: true,
        regressionQualified: false,
        resourcePolicySatisfied: true,
        resourceQualified: false
      });
      const qualification = spawnSync(process.execPath, [
        CLI_PATH,
        `--manifest=${manifestPath}`
      ], { encoding: "utf8" });
      expect(qualification.status).toBe(1);
      const advisory = spawnSync(process.execPath, [
        CLI_PATH,
        "--gate=advisory",
        `--manifest=${manifestPath}`
      ], { encoding: "utf8" });
      expect(advisory.status).toBe(0);
      expect(JSON.parse(advisory.stdout)).toMatchObject({
        integrityQualified: true,
        latencyAuthoritative: false,
        regressionQualified: false,
        resourcePolicySatisfied: true,
        resourceQualified: false
      });

      replaceBundle(input, "pair-05-candidate.json", (document) => {
        document.measurements.peakRssBytes = 513 * 1024 ** 2;
      });
      writeFileSync(manifestPath, input.manifest.bytes);
      const changed = input.bundles.find((item) => item.path === "pair-05-candidate.json");
      writeFileSync(join(root, changed.path), changed.bytes);
      const resourceFailure = spawnSync(process.execPath, [
        CLI_PATH,
        "--gate=advisory",
        `--manifest=${manifestPath}`
      ], { encoding: "utf8" });
      expect(resourceFailure.status).toBe(1);
      expect(JSON.parse(resourceFailure.stdout)).toMatchObject({
        integrityQualified: true,
        regressionQualified: false,
        resourcePolicySatisfied: false,
        resourceQualified: false
      });
      expect(() => parsePerformanceRegressionArguments(["--manifest=relative.json"]))
        .toThrow(/absolute/iu);
      expect(() => parsePerformanceRegressionArguments([
        `--manifest=${manifestPath}`,
        `--policy=${join(root, "untrusted-policy.json")}`
      ])).toThrow(/unsupported/iu);
      expect(() => parsePerformanceRegressionArguments([
        `--manifest=${manifestPath}`,
        "--network=enabled"
      ])).toThrow(/unsupported/iu);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ships an intentionally non-authoritative policy and always emits rejection statuses", () => {
    expect(verifyPerformanceRegression(fixture({ policyDocument: shippedPolicy }))).toMatchObject({
      integrityQualified: true,
      latencyAuthoritative: false,
      latencyMeasured: true,
      regressionQualified: false,
      resourcePolicySatisfied: true,
      resourceQualified: false
    });

    const missing = join(tmpdir(), "attunegraph-performance-regression-missing.json");
    const spawned = spawnSync(process.execPath, [
      CLI_PATH,
      `--manifest=${missing}`
    ], { encoding: "utf8" });
    expect(spawned.status).toBe(1);
    expect(JSON.parse(spawned.stdout)).toMatchObject({
      integrityQualified: false,
      latencyAuthoritative: false,
      latencyMeasured: false,
      regressionQualified: false,
      resourcePolicySatisfied: false,
      resourceQualified: false,
      schema: "attunegraph-performance-regression@1"
    });
  });
});
