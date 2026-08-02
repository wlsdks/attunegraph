import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { parseCompetitorParityChildArguments } from "../benchmarks/competitor-parity/run-engine.mjs";

import {
  admitCompetitorParityChild,
  admitCompetitorParityReport,
  buildCompetitorParityCorpus,
  createCompetitorParityPlan,
  runCompetitorParityBenchmark
} from "./benchmark-attunegraph-competitor-parity.mjs";

const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function summary() {
  const rawMs = Array.from({ length: 200 }, (_, index) => (index + 1) / 100);
  return {
    samples: 200,
    rawMs,
    minMs: 0.01,
    p50Ms: 1,
    p95Ms: 1.9,
    p99Ms: 1.98,
    maxMs: 2,
    meanMs: [...rawMs].sort((left, right) => left - right)
      .reduce((total, sample) => total + sample, 0) / rawMs.length
  };
}

function child(engine = "cozo") {
  return {
    schema: "attunegraph-competitor-parity-child@1",
    engine,
    version: engine === "attunegraph-v4" ? "0.1.0" : engine === "ladybug" ? "0.19.0" : "0.7.6",
    moduleLoadMs: 1,
    openMs: 1,
    ingestMs: 1,
    settledBytes: 1,
    reopenMs: 1,
    firstAfterReopenMs: 1,
    adjacency: summary(),
    degree: summary(),
    ...(engine === "attunegraph-v4" ? {
      witnessedDecisionEndpoint: {
        lane: "attunegraph-v4-proof-assembly-only",
        productRatioEligible: false,
        scanStatus: "complete",
        oracleScopesVerified: 313,
        latency: summary()
      }
    } : {}),
    peakRssBytes: 1,
    oracleScopesVerified: 313
  };
}

function reportBody() {
  const corpus = buildCompetitorParityCorpus();
  const rootLockfileSha256 = digest("root-lock");
  return {
    schema: "attunegraph-competitor-parity@1",
    measurementOnly: true,
    claimEligible: false,
    productBoundaryEquivalent: false,
    lane: "native-storage-only",
    provenance: {
      packageRoot: "/exact/root",
      repository: {
        clean: false,
        commit: "a".repeat(40),
        lockfileSha256: rootLockfileSha256,
        tree: "b".repeat(40),
        sourceIdentity: digest("source"),
        sourceState: {
          schema: "attunegraph-source-state@1",
          claim: "exact-content-addressed-dirty-source-state",
          included: [], excluded: [], staged: {}, unstaged: {}, untracked: {},
          aggregateSha256: digest("state")
        }
      }
    },
    artifacts: {
      rootLockfileSha256,
      privateLockfileSha256: digest("private-lock"),
      privatePackageSha256: digest("private-package"),
      orchestratorSha256: digest("orchestrator"),
      childSha256: digest("child"),
      runtimeClosureSha256: digest("runtime-closure")
    },
    corpus: {
      schema: corpus.schema,
      seed: corpus.seed,
      sha256: corpus.sha256,
      assertionCount: corpus.assertionCount,
      scopeCount: corpus.scopeCount,
      sourceRefCount: corpus.sourceRefCount,
      edgeCount: corpus.edgeCount,
      exactOracleEveryScope: true
    },
    plan: createCompetitorParityPlan(),
    trials: [],
    exclusions: [
      "no-temporal-product-ratio",
      "no-provenance-product-ratio",
      "no-authority-product-ratio",
      "no-receipt-product-ratio"
    ]
  };
}

function sealed(body = reportBody()) {
  return { ...body, artifactIdentity: digest(JSON.stringify(body)) };
}

function admissionOptions(expected) {
  return {
    allowEmptyTrialsForTest: true,
    expectedProvenance: expected.provenance,
    expectedArtifacts: expected.artifacts
  };
}

it("builds the exact official 10K corpus and adjacency-degree oracle", () => {
  const corpus = buildCompetitorParityCorpus();
  expect(corpus).toMatchObject({ assertionCount: 10_000, scopeCount: 313, sourceRefCount: 10_313, edgeCount: 10_000 });
  expect(corpus.scopes).toHaveLength(313);
  for (const scope of corpus.scopes) {
    expect(scope.orderedNeighbors).toHaveLength(scope.degree);
    expect([...scope.orderedNeighbors].sort()).toEqual(scope.orderedNeighbors);
  }
});

it("rotates three isolated engines across five trials", () => {
  const plan = createCompetitorParityPlan();
  expect(plan.trials.map((trial) => trial.order)).toEqual([
    ["attunegraph-v4", "ladybug", "cozo"],
    ["ladybug", "cozo", "attunegraph-v4"],
    ["cozo", "attunegraph-v4", "ladybug"],
    ["attunegraph-v4", "ladybug", "cozo"],
    ["ladybug", "cozo", "attunegraph-v4"]
  ]);
  expect(plan).toMatchObject({ warmupQueries: 20, sampleQueries: 200 });
});

it("admits exact child keys and recomputes every summary from raw samples", () => {
  expect(admitCompetitorParityChild(child(), "cozo").degree.p99Ms).toBe(1.98);
  expect(admitCompetitorParityChild(child("attunegraph-v4"), "attunegraph-v4")
    .witnessedDecisionEndpoint.scanStatus).toBe("complete");
  expect(() => admitCompetitorParityChild({ ...child(), unknown: true }, "cozo")).toThrow(/keys/u);
  const changed = child();
  changed.degree.p50Ms = 0;
  expect(() => admitCompetitorParityChild(changed, "cozo")).toThrow(/derived values/u);
  const badMean = child();
  badMean.adjacency.meanMs = badMean.adjacency.maxMs + 1;
  expect(() => admitCompetitorParityChild(badMean, "cozo")).toThrow(/derived values/u);
});

it("fails closed on report provenance, artifacts, unknown keys, and body seal", () => {
  const expected = reportBody();
  expect(admitCompetitorParityReport(sealed(expected), admissionOptions(expected)).claimEligible).toBe(false);
  expect(() => admitCompetitorParityReport(
    { ...sealed(expected), unknown: true },
    admissionOptions(expected)
  )).toThrow(/keys/u);
  const badArtifactBody = reportBody();
  badArtifactBody.artifacts.privateLockfileSha256 = "sha256:test";
  expect(() => admitCompetitorParityReport(sealed(badArtifactBody), admissionOptions(expected))).toThrow(/invalid/u);
  const mismatchedLockBody = reportBody();
  mismatchedLockBody.artifacts.rootLockfileSha256 = digest("different");
  expect(() => admitCompetitorParityReport(sealed(mismatchedLockBody), admissionOptions(expected))).toThrow(/artifacts/u);
  const unknownProvenanceBody = reportBody();
  unknownProvenanceBody.provenance.repository.unknown = true;
  expect(() => admitCompetitorParityReport(sealed(unknownProvenanceBody), admissionOptions(expected))).toThrow(/provenance/u);
  const tampered = sealed(reportBody());
  tampered.corpus.edgeCount -= 1;
  expect(() => admitCompetitorParityReport(tampered, admissionOptions(expected))).toThrow(/invariants|artifact identity/u);
  const oversizedBody = reportBody();
  oversizedBody.provenance.packageRoot = `/${"x".repeat(512 * 1_024)}`;
  expect(() => admitCompetitorParityReport(sealed(oversizedBody), admissionOptions(expected))).toThrow(/provenance|byte bound/u);
});

it("rejects resealed nested provenance and well-formed false identities", () => {
  const expected = reportBody();
  const nullStaged = reportBody();
  nullStaged.provenance.repository.sourceState.staged = null;
  expect(() => admitCompetitorParityReport(sealed(nullStaged), admissionOptions(expected))).toThrow(/provenance/u);

  const unknownNested = reportBody();
  unknownNested.provenance.repository.sourceState.untracked.unknown = true;
  expect(() => admitCompetitorParityReport(sealed(unknownNested), admissionOptions(expected))).toThrow(/provenance/u);

  const falseArtifact = reportBody();
  falseArtifact.artifacts.childSha256 = digest("different-child");
  expect(() => admitCompetitorParityReport(sealed(falseArtifact), admissionOptions(expected))).toThrow(/artifacts/u);

  const falseRuntime = reportBody();
  falseRuntime.artifacts.runtimeClosureSha256 = digest("different-runtime");
  expect(() => admitCompetitorParityReport(sealed(falseRuntime), admissionOptions(expected))).toThrow(/artifacts/u);

  const falseCorpus = reportBody();
  falseCorpus.corpus.sha256 = "f".repeat(64);
  expect(() => admitCompetitorParityReport(sealed(falseCorpus), admissionOptions(expected))).toThrow(/invariants/u);
});

it("accepts only the exact empty or json CLI argument vector", () => {
  expect(() => runCompetitorParityBenchmark(["--bogus"])).toThrow(/arguments are invalid/u);
  expect(() => runCompetitorParityBenchmark(["--", "--json"])).toThrow(/arguments are invalid/u);
});

it("admits only exact child trial directories directly under the canonical temporary root", () => {
  const canonicalTmp = realpathSync(tmpdir());
  const admittedRoot = mkdtempSync(join(canonicalTmp, "attunegraph-competitor-parity-"));
  const outsideRoot = mkdtempSync(join(canonicalTmp, "outside-attunegraph-competitor-parity-"));
  try {
    const admitted = join(admittedRoot, "trial-1-0-attunegraph-v4");
    expect(parseCompetitorParityChildArguments([
      "--engine=attunegraph-v4",
      `--database-dir=${admitted}`
    ])).toEqual({ engine: "attunegraph-v4", databaseDir: admitted });
    expect(existsSync(admitted)).toBe(false);

    expect(() => parseCompetitorParityChildArguments([
      "--engine=attunegraph-v4",
      `--database-dir=${join(outsideRoot, "trial-1-0-attunegraph-v4")}`
    ])).toThrow(/outside the admitted benchmark domain/u);
    expect(() => parseCompetitorParityChildArguments([
      "--engine=attunegraph-v4",
      `--database-dir=${join(admittedRoot, "trial-1-1-attunegraph-v4")}`
    ])).toThrow(/outside the admitted benchmark domain/u);
    expect(() => parseCompetitorParityChildArguments([
      "--engine=ladybug",
      `--database-dir=${join(admittedRoot, "trial-1-0-attunegraph-v4")}`
    ])).toThrow(/outside the admitted benchmark domain/u);
  } finally {
    rmSync(admittedRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});
