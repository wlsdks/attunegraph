import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import { captureContentAddressedSourceCheckoutProvenance } from "./source-checkout-provenance.mjs";

const ASSERTION_COUNT = 10_000;
const ASSERTIONS_PER_SCOPE = 32;
const SCOPE_COUNT = Math.ceil(ASSERTION_COUNT / ASSERTIONS_PER_SCOPE);
const EXCLUSIONS = Object.freeze([
  "no-temporal-product-ratio",
  "no-provenance-product-ratio",
  "no-authority-product-ratio",
  "no-receipt-product-ratio"
]);
const MAX_CHILD_BYTES = 128 * 1_024;
const MAX_REPORT_BYTES = 512 * 1_024;
const PRIVATE_PACKAGE = fileURLToPath(new URL("../benchmarks/competitor-parity/", import.meta.url));
const CHILD_SCRIPT = join(PRIVATE_PACKAGE, "run-engine.mjs");
const DIST_DIRECTORY = fileURLToPath(new URL("../dist/", import.meta.url));
const REQUIRED_ATTUNEGRAPH_RUNTIME_ENTRIES = Object.freeze([
  "attunegraph-engine.js",
  "attunegraph-backend.js",
  "attunegraph-sqlite-store.js",
  "attunegraph-current-head-index.mjs"
]);

function fileSha256(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function runtimeClosureSha256() {
  const canonicalDirectory = realpathSync(DIST_DIRECTORY);
  const names = readdirSync(canonicalDirectory)
    .filter((name) => name.endsWith(".js") || name.endsWith(".mjs"))
    .sort();
  if (
    names.length === 0
    || REQUIRED_ATTUNEGRAPH_RUNTIME_ENTRIES.some((name) => !names.includes(name))
  ) throw new Error("competitor parity AttuneGraph runtime closure is incomplete");
  const files = names.map((name) => {
    const path = join(canonicalDirectory, name);
    const stat = lstatSync(path);
    const canonicalPath = realpathSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || dirname(canonicalPath) !== canonicalDirectory) {
      throw new Error("competitor parity AttuneGraph runtime closure is invalid");
    }
    return frozen({ path: `dist/${name}`, sha256: fileSha256(canonicalPath) });
  });
  return sha256(JSON.stringify({
    schema: "attunegraph-competitor-runtime-closure-identity-input@1",
    files
  }));
}

function currentArtifacts(provenance) {
  return frozen({
    rootLockfileSha256: provenance.repository.lockfileSha256,
    privateLockfileSha256: fileSha256(join(PRIVATE_PACKAGE, "pnpm-lock.yaml")),
    privatePackageSha256: fileSha256(join(PRIVATE_PACKAGE, "package.json")),
    orchestratorSha256: fileSha256(fileURLToPath(import.meta.url)),
    childSha256: fileSha256(CHILD_SCRIPT),
    runtimeClosureSha256: runtimeClosureSha256()
  });
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactSha256(value, label) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function frozen(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} keys are invalid`);
  }
  return value;
}

export function buildCompetitorParityCorpus() {
  const scopes = [];
  let offset = 0;
  for (let scopeIndex = 0; scopeIndex < SCOPE_COUNT; scopeIndex += 1) {
    const count = Math.min(ASSERTIONS_PER_SCOPE, ASSERTION_COUNT - offset);
    const scopeId = `scope:${scopeIndex.toString().padStart(3, "0")}`;
    const rootId = `root:${scopeIndex.toString().padStart(3, "0")}`;
    const orderedNeighbors = Array.from({ length: count }, (_, localIndex) =>
      `node:${(offset + localIndex).toString().padStart(5, "0")}`
    ).sort();
    scopes.push(frozen({
      scopeId,
      rootId,
      scopeSourceRef: `source:${scopeId}`,
      degree: count,
      orderedNeighbors,
      assertions: orderedNeighbors.map((neighborId, localIndex) => frozen({
        assertionId: `assertion:${(offset + localIndex).toString().padStart(5, "0")}`,
        neighborId,
        sourceRef: `source:assertion:${(offset + localIndex).toString().padStart(5, "0")}`
      }))
    }));
    offset += count;
  }
  const identity = {
    schema: "attunegraph-competitor-parity-corpus@1",
    seed: "attunegraph-competitor-parity-10k@1",
    assertionCount: ASSERTION_COUNT,
    scopeCount: SCOPE_COUNT,
    sourceRefCount: ASSERTION_COUNT + SCOPE_COUNT,
    edgeCount: ASSERTION_COUNT,
    scopes
  };
  return frozen({
    ...identity,
    sha256: createHash("sha256").update(JSON.stringify(identity)).digest("hex")
  });
}

export function createCompetitorParityPlan() {
  const engines = Object.freeze(["attunegraph-v4", "ladybug", "cozo"]);
  return frozen({
    schema: "attunegraph-competitor-parity-plan@1",
    trials: Array.from({ length: 5 }, (_, trialIndex) => ({
      trial: trialIndex + 1,
      order: Array.from({ length: engines.length }, (_, offset) =>
        engines[(trialIndex + offset) % engines.length]
      )
    })),
    warmupQueries: 20,
    sampleQueries: 200
  });
}

export function admitCompetitorParityReport(value, options = {}) {
  exactRecord(value, [
    "schema", "measurementOnly", "claimEligible", "productBoundaryEquivalent", "lane",
    "provenance", "artifacts", "corpus", "plan", "trials", "exclusions", "artifactIdentity"
  ], "competitor parity report");
  const provenance = exactRecord(value.provenance, ["packageRoot", "repository"], "competitor parity provenance");
  const expectedProvenance = options.expectedProvenance
    ?? captureContentAddressedSourceCheckoutProvenance();
  if (JSON.stringify(provenance) !== JSON.stringify(expectedProvenance)) {
    throw new Error("competitor parity provenance does not match the current source checkout");
  }
  const repository = exactRecord(provenance.repository, [
    "clean", "commit", "lockfileSha256", "tree", "sourceIdentity", "sourceState"
  ], "competitor parity repository provenance");
  const sourceState = exactRecord(repository.sourceState, [
    "schema", "claim", "included", "excluded", "staged", "unstaged", "untracked", "aggregateSha256"
  ], "competitor parity source state");
  if (
    typeof provenance.packageRoot !== "string" || provenance.packageRoot.length < 1
    || typeof repository.clean !== "boolean"
    || typeof repository.commit !== "string" || !/^[0-9a-f]{40}$/u.test(repository.commit)
    || typeof repository.tree !== "string" || !/^[0-9a-f]{40}$/u.test(repository.tree)
    || sourceState.schema !== "attunegraph-source-state@1"
    || (sourceState.claim !== "exact-clean-commit-tree-lockfile"
      && sourceState.claim !== "exact-content-addressed-dirty-source-state")
  ) throw new Error("competitor parity provenance invariants are invalid");
  exactSha256(repository.lockfileSha256, "competitor parity root lockfile SHA-256");
  exactSha256(repository.sourceIdentity, "competitor parity source identity");
  exactSha256(sourceState.aggregateSha256, "competitor parity source-state aggregate");
  const artifacts = exactRecord(value.artifacts, [
    "rootLockfileSha256", "privateLockfileSha256", "privatePackageSha256",
    "orchestratorSha256", "childSha256", "runtimeClosureSha256"
  ], "competitor parity artifacts");
  for (const [key, digest] of Object.entries(artifacts)) exactSha256(digest, `competitor parity artifact ${key}`);
  const expectedArtifacts = options.expectedArtifacts ?? currentArtifacts(expectedProvenance);
  if (JSON.stringify(artifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error("competitor parity artifacts do not match the current benchmark files");
  }
  if (artifacts.rootLockfileSha256 !== repository.lockfileSha256) {
    throw new Error("competitor parity root lockfile identity is invalid");
  }
  const corpus = exactRecord(value.corpus, [
    "schema", "seed", "sha256", "assertionCount", "scopeCount", "sourceRefCount", "edgeCount",
    "exactOracleEveryScope"
  ], "competitor parity corpus summary");
  const expectedCorpus = buildCompetitorParityCorpus();
  if (
    value.schema !== "attunegraph-competitor-parity@1"
    || value.measurementOnly !== true
    || value.claimEligible !== false
    || value.productBoundaryEquivalent !== false
    || value.lane !== "native-storage-only"
    || corpus.schema !== "attunegraph-competitor-parity-corpus@1"
    || corpus.seed !== "attunegraph-competitor-parity-10k@1"
    || corpus.sha256 !== expectedCorpus.sha256
    || corpus.assertionCount !== ASSERTION_COUNT || corpus.scopeCount !== SCOPE_COUNT
    || corpus.sourceRefCount !== ASSERTION_COUNT + SCOPE_COUNT
    || corpus.edgeCount !== ASSERTION_COUNT || corpus.exactOracleEveryScope !== true
    || JSON.stringify(value.plan) !== JSON.stringify(createCompetitorParityPlan())
    || !Array.isArray(value.trials)
    || (!options.allowEmptyTrialsForTest && value.trials.length !== 15)
    || JSON.stringify(value.exclusions) !== JSON.stringify(EXCLUSIONS)
  ) throw new Error("competitor parity report invariants are invalid");
  if (!options.allowEmptyTrialsForTest) {
    const expected = value.plan.trials.flatMap((trial) => trial.order.map((engine, orderPosition) => ({
      trial: trial.trial, orderPosition, engine
    })));
    value.trials.forEach((entry, index) => {
      exactRecord(entry, ["trial", "orderPosition", "engine", "measurement"], "competitor parity trial");
      if (
        entry.trial !== expected[index].trial || entry.orderPosition !== expected[index].orderPosition
        || entry.engine !== expected[index].engine
      ) throw new Error("competitor parity trial order is invalid");
      admitChild(entry.measurement, entry.engine);
    });
  }
  const { artifactIdentity, ...body } = value;
  exactSha256(artifactIdentity, "competitor parity artifact identity");
  if (artifactIdentity !== sha256(JSON.stringify(body))) {
    throw new Error("competitor parity artifact identity is invalid");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_REPORT_BYTES) {
    throw new Error("competitor parity report exceeded its byte bound");
  }
  return frozen(value);
}

function exactFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`);
}

function admitSummary(value, label, samples = 200) {
  exactRecord(value, ["samples", "rawMs", "minMs", "p50Ms", "p95Ms", "p99Ms", "maxMs", "meanMs"], label);
  if (value.samples !== samples || !Array.isArray(value.rawMs) || value.rawMs.length !== samples) {
    throw new Error(`${label} sample count is invalid`);
  }
  for (const sample of value.rawMs) exactFinite(sample, `${label} raw sample`);
  for (const key of ["minMs", "p50Ms", "p95Ms", "p99Ms", "maxMs", "meanMs"]) exactFinite(value[key], `${label} ${key}`);
  const sorted = [...value.rawMs].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  const expected = {
    minMs: sorted[0],
    p50Ms: percentile(0.50),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maxMs: sorted.at(-1),
    meanMs: sorted.reduce((total, sample) => total + sample, 0) / sorted.length
  };
  if (Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) {
    throw new Error(`${label} derived values are invalid`);
  }
}

export function admitCompetitorParityChild(value, expectedEngine) {
  exactRecord(value, expectedEngine === "attunegraph-v4" ? [
    "schema", "engine", "version", "moduleLoadMs", "openMs", "ingestMs", "settledBytes",
    "reopenMs", "firstAfterReopenMs", "adjacency", "degree", "witnessedDecisionEndpoint",
    "peakRssBytes", "oracleScopesVerified"
  ] : [
    "schema", "engine", "version", "moduleLoadMs", "openMs", "ingestMs", "settledBytes",
    "reopenMs", "firstAfterReopenMs", "adjacency", "degree", "peakRssBytes",
    "oracleScopesVerified"
  ], "competitor child report");
  const expectedVersion = expectedEngine === "attunegraph-v4" ? "0.1.0" : expectedEngine === "ladybug" ? "0.19.0" : "0.7.6";
  if (
    value.schema !== "attunegraph-competitor-parity-child@1"
    || value.engine !== expectedEngine || value.version !== expectedVersion
    || value.oracleScopesVerified !== SCOPE_COUNT
  ) throw new Error("competitor child identity is invalid");
  for (const key of [
    "moduleLoadMs", "openMs", "ingestMs", "settledBytes", "reopenMs", "firstAfterReopenMs", "peakRssBytes"
  ]) exactFinite(value[key], `competitor child ${key}`);
  if (!Number.isSafeInteger(value.settledBytes) || value.settledBytes < 1) throw new Error("settled bytes are invalid");
  if (!Number.isSafeInteger(value.peakRssBytes) || value.peakRssBytes < 1) throw new Error("peak RSS is invalid");
  admitSummary(value.adjacency, "competitor child adjacency");
  admitSummary(value.degree, "competitor child degree");
  if (expectedEngine === "attunegraph-v4") {
    exactRecord(value.witnessedDecisionEndpoint, [
      "lane", "productRatioEligible", "scanStatus", "oracleScopesVerified", "latency"
    ], "AttuneGraph witnessed endpoint");
    if (
      value.witnessedDecisionEndpoint.lane !== "attunegraph-v4-proof-assembly-only"
      || value.witnessedDecisionEndpoint.productRatioEligible !== false
      || value.witnessedDecisionEndpoint.scanStatus !== "complete"
      || value.witnessedDecisionEndpoint.oracleScopesVerified !== SCOPE_COUNT
    ) throw new Error("AttuneGraph witnessed endpoint identity is invalid");
    admitSummary(value.witnessedDecisionEndpoint.latency, "AttuneGraph witnessed endpoint latency");
  } else if (value.witnessedDecisionEndpoint !== undefined) {
    throw new Error("competitor child cannot claim an AttuneGraph witness");
  }
  return value;
}

const admitChild = admitCompetitorParityChild;

function verifyPrivatePackage() {
  const packageJson = JSON.parse(readFileSync(join(PRIVATE_PACKAGE, "package.json"), "utf8"));
  if (
    packageJson.private !== true
    || packageJson.dependencies?.["@ladybugdb/core"] !== "0.19.0"
    || packageJson.dependencies?.["cozo-node"] !== "0.7.6"
    || !existsSync(join(PRIVATE_PACKAGE, "pnpm-lock.yaml"))
    || !existsSync(join(PRIVATE_PACKAGE, "node_modules"))
  ) throw new Error("competitor private package is not installed at exact versions");
}

export function runCompetitorParityBenchmark(argv = process.argv.slice(2)) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) throw new Error("competitor parity requires Node 24.15 or newer");
  if (JSON.stringify(argv) !== "[]" && JSON.stringify(argv) !== '["--json"]') {
    throw new Error("competitor parity arguments are invalid");
  }
  verifyPrivatePackage();
  const corpus = buildCompetitorParityCorpus();
  const plan = createCompetitorParityPlan();
  const provenance = captureContentAddressedSourceCheckoutProvenance();
  const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), "attunegraph-competitor-parity-"));
  const trials = [];
  try {
    for (const trial of plan.trials) {
      for (let orderPosition = 0; orderPosition < trial.order.length; orderPosition += 1) {
        const engine = trial.order[orderPosition];
        const databaseDir = join(temporaryRoot, `trial-${trial.trial}-${orderPosition}-${engine}`);
        const child = spawnSync(process.execPath, [
          CHILD_SCRIPT,
          `--engine=${engine}`,
          `--database-dir=${databaseDir}`
        ], {
          cwd: PRIVATE_PACKAGE,
          encoding: "utf8",
          maxBuffer: MAX_CHILD_BYTES,
          timeout: 300_000,
          env: { ...process.env, NO_COLOR: "1" }
        });
        if (child.error || child.status !== 0 || child.signal !== null || child.stderr !== "") {
          throw new Error(`competitor parity ${engine} child failed: ${child.error?.message ?? child.stderr.trim()}`);
        }
        if (Buffer.byteLength(child.stdout, "utf8") > MAX_CHILD_BYTES || child.stdout.trim().split("\n").length !== 1) {
          throw new Error(`competitor parity ${engine} child output is invalid`);
        }
        const measurement = admitChild(JSON.parse(child.stdout), engine);
        trials.push(frozen({ trial: trial.trial, orderPosition, engine, measurement }));
      }
    }
    const body = {
      schema: "attunegraph-competitor-parity@1",
      measurementOnly: true,
      claimEligible: false,
      productBoundaryEquivalent: false,
      lane: "native-storage-only",
      provenance,
      artifacts: currentArtifacts(provenance),
      corpus: frozen({
        schema: corpus.schema,
        seed: corpus.seed,
        sha256: corpus.sha256,
        assertionCount: corpus.assertionCount,
        scopeCount: corpus.scopeCount,
        sourceRefCount: corpus.sourceRefCount,
        edgeCount: corpus.edgeCount,
        exactOracleEveryScope: true
      }),
      plan,
      trials: frozen(trials),
      exclusions: EXCLUSIONS
    };
    const report = admitCompetitorParityReport({
      ...body,
      artifactIdentity: sha256(JSON.stringify(body))
    });
    return report;
  } finally {
    if (!temporaryRoot.startsWith(`${realpathSync(tmpdir())}/attunegraph-competitor-parity-`)) {
      throw new Error("competitor parity cleanup target is invalid");
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  try {
    const argv = process.argv.slice(2);
    const report = runCompetitorParityBenchmark(argv);
    process.stdout.write(`${JSON.stringify(report, null, argv.includes("--json") ? 0 : 2)}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
