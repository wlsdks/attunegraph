import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA = "attunegraph-performance-regression@1";
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PERCENTILES = ["p50", "p95", "p99"];
const POLICY_PATH = realpathSync(fileURLToPath(new URL("../performance-regression-policy.json", import.meta.url)));
const LIMITATIONS = Object.freeze([
  "ab-ba-plan-and-attempt-ledger-self-asserted",
  "artifact-and-workload-output-identities-self-asserted",
  "dedicated-runner-attestation-unavailable",
  "host-runtime-harness-corpus-identities-self-asserted",
  "rss-scalar-self-reported"
]);

function invalid(message) {
  throw new Error(`invalid performance regression evidence: ${message}`);
}

function exactRecord(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${name} has unknown or missing fields`);
  }
  return value;
}

function exactString(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    invalid(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    invalid(`${name} must be finite and positive`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${name} must be a positive safe integer`);
  return value;
}

function timestamp(value, name) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) invalid(`${name} must be an exact UTC timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid(`${name} is invalid`);
  return milliseconds;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseArtifact(artifact, name) {
  exactRecord(artifact, ["bytes", "sha256"], name);
  if (typeof artifact.bytes !== "string" && !Buffer.isBuffer(artifact.bytes)) invalid(`${name}.bytes are required`);
  if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256) || digest(artifact.bytes) !== artifact.sha256) {
    invalid(`${name}.sha256 does not match exact bytes`);
  }
  try {
    return JSON.parse(artifact.bytes.toString());
  } catch {
    invalid(`${name}.bytes must contain JSON`);
  }
}

function validatePolicy(policy) {
  exactRecord(policy, [
    "absoluteMaximumRssBytes",
    "approvedAt",
    "percentileMinimumPairs",
    "policyId",
    "referenceClasses",
    "requiredPairCount",
    "schema"
  ], "policy");
  if (policy.schema !== "attunegraph-performance-regression-policy@1") invalid("policy schema is unsupported");
  exactString(policy.policyId, "policy.policyId");
  timestamp(policy.approvedAt, "policy.approvedAt");
  positiveInteger(policy.requiredPairCount, "policy.requiredPairCount");
  positiveInteger(policy.absoluteMaximumRssBytes, "policy.absoluteMaximumRssBytes");
  exactRecord(policy.percentileMinimumPairs, PERCENTILES, "policy.percentileMinimumPairs");
  if (
    policy.percentileMinimumPairs.p50 !== 5
    || policy.percentileMinimumPairs.p95 !== 40
    || policy.percentileMinimumPairs.p99 !== 200
  ) invalid("policy percentile eligibility must remain p50=5, p95=40, p99=200");
  if (!Array.isArray(policy.referenceClasses) || policy.referenceClasses.length === 0) {
    invalid("policy.referenceClasses must be a non-empty array");
  }
  const classes = new Map();
  for (const reference of policy.referenceClasses) {
    exactRecord(reference, ["hardLatencyThresholds", "id", "kind"], "policy reference class");
    const id = exactString(reference.id, "policy reference class id");
    if (classes.has(id)) invalid("policy reference class ids must be unique");
    if (!["dedicated", "shared-github"].includes(reference.kind)) invalid("policy reference class kind is unsupported");
    exactRecord(reference.hardLatencyThresholds, PERCENTILES, "policy hard latency thresholds");
    for (const percentile of PERCENTILES) {
      const threshold = reference.hardLatencyThresholds[percentile];
      if (threshold === null) continue;
      if (reference.kind === "shared-github") invalid("shared GitHub reference classes cannot carry hard latency thresholds");
      exactRecord(threshold, [
        "approvalId",
        "approvedAt",
        "maximumRatio",
        "minimumAbsoluteRegressionMilliseconds"
      ], `policy ${id} ${percentile} threshold`);
      exactString(threshold.approvalId, `policy ${id} ${percentile} threshold approvalId`);
      timestamp(threshold.approvedAt, `policy ${id} ${percentile} threshold approvedAt`);
      positiveNumber(threshold.maximumRatio, `policy ${id} ${percentile} threshold maximumRatio`);
      positiveNumber(
        threshold.minimumAbsoluteRegressionMilliseconds,
        `policy ${id} ${percentile} threshold minimumAbsoluteRegressionMilliseconds`
      );
    }
    classes.set(id, reference);
  }
  return classes;
}

function validateManifest(manifest, policy, policyArtifact, referenceClasses) {
  exactRecord(manifest, [
    "campaignId",
    "createdAt",
    "expectedIdentities",
    "pairs",
    "plannedAttempts",
    "policySha256",
    "referenceClassId",
    "schema"
  ], "manifest");
  if (manifest.schema !== "attunegraph-performance-regression-manifest@1") invalid("manifest schema is unsupported");
  exactString(manifest.campaignId, "manifest.campaignId");
  const createdAt = timestamp(manifest.createdAt, "manifest.createdAt");
  if (createdAt < timestamp(policy.approvedAt, "policy.approvedAt")) {
    invalid("manifest must not predate policy approval");
  }
  if (manifest.policySha256 !== policyArtifact.sha256) invalid("manifest policy identity does not match exact policy bytes");
  if (!referenceClasses.has(manifest.referenceClassId)) invalid("manifest reference class is not approved by policy");
  if (!Array.isArray(manifest.pairs) || !Array.isArray(manifest.plannedAttempts)) invalid("manifest pair plan is missing");
  exactRecord(manifest.expectedIdentities, ["base", "candidate"], "manifest.expectedIdentities");
  for (const side of ["base", "candidate"]) {
    const identity = manifest.expectedIdentities[side];
    exactRecord(identity, ["packageArtifact", "repository"], `manifest expected ${side} identity`);
    exactRecord(identity.packageArtifact, ["bytes", "kind", "sha256"], `manifest expected ${side} package artifact`);
    positiveInteger(identity.packageArtifact.bytes, `manifest expected ${side} package artifact bytes`);
    exactString(identity.packageArtifact.kind, `manifest expected ${side} package artifact kind`);
    if (!SHA256.test(identity.packageArtifact.sha256)) invalid(`manifest expected ${side} package artifact sha256 is invalid`);
    exactRecord(identity.repository, ["commit", "lockfileSha256", "tree"], `manifest expected ${side} repository`);
    if (
      !GIT_OBJECT_ID.test(identity.repository.commit)
      || !GIT_OBJECT_ID.test(identity.repository.tree)
      || !SHA256.test(identity.repository.lockfileSha256)
    ) invalid(`manifest expected ${side} repository identity is invalid`);
  }
  if (sameJson(manifest.expectedIdentities.base, manifest.expectedIdentities.candidate)) {
    invalid("manifest base and candidate identities must differ");
  }
  const { base, candidate } = manifest.expectedIdentities;
  if (base.repository.commit === candidate.repository.commit) {
    invalid("manifest base and candidate commit identities must differ");
  }
  if (base.repository.tree === candidate.repository.tree) {
    invalid("manifest base and candidate tree identities must differ");
  }
  if (base.packageArtifact.sha256 === candidate.packageArtifact.sha256) {
    invalid("manifest base and candidate package artifact identities must differ");
  }
  const reference = referenceClasses.get(manifest.referenceClassId);
  for (const percentile of PERCENTILES) {
    const threshold = reference.hardLatencyThresholds[percentile];
    if (threshold !== null && timestamp(threshold.approvedAt, `policy ${percentile} threshold approvedAt`) > createdAt) {
      invalid("latency threshold approval must not postdate manifest creation");
    }
  }
}

function validateBundle(bundle, expected, manifest) {
  exactRecord(bundle, [
    "campaignId",
    "correctness",
    "corpus",
    "harness",
    "host",
    "measurements",
    "observedAt",
    "order",
    "pairId",
    "performanceContract",
    "packageArtifact",
    "repository",
    "runtime",
    "schema",
    "side"
  ], `${expected.path} bundle`);
  if (bundle.schema !== "attunegraph-performance-regression-bundle@1") invalid(`${expected.path} bundle schema is unsupported`);
  if (
    bundle.campaignId !== manifest.campaignId
    || bundle.pairId !== expected.pairId
    || bundle.side !== expected.side
    || bundle.order !== expected.order
  ) invalid(`${expected.path} bundle identity does not match manifest`);
  if (timestamp(bundle.observedAt, `${expected.path}.observedAt`) < timestamp(manifest.createdAt, "manifest.createdAt")) {
    invalid(`${expected.path} observation predates the frozen manifest`);
  }
  exactRecord(bundle.repository, ["clean", "commit", "lockfileSha256", "tree"], `${expected.path}.repository`);
  if (
    bundle.repository.clean !== true
    || !GIT_OBJECT_ID.test(bundle.repository.commit)
    || !GIT_OBJECT_ID.test(bundle.repository.tree)
    || !SHA256.test(bundle.repository.lockfileSha256)
  ) invalid(`${expected.path} repository identity must be clean and immutable`);
  exactRecord(bundle.packageArtifact, ["bytes", "kind", "sha256"], `${expected.path}.packageArtifact`);
  exactString(bundle.packageArtifact.kind, `${expected.path}.packageArtifact.kind`);
  positiveInteger(bundle.packageArtifact.bytes, `${expected.path}.packageArtifact.bytes`);
  if (!SHA256.test(bundle.packageArtifact.sha256)) invalid(`${expected.path}.packageArtifact.sha256 is invalid`);
  exactRecord(bundle.correctness, ["checksPassed", "checksTotal", "status", "workloadOutput"], `${expected.path}.correctness`);
  const checks = positiveInteger(bundle.correctness.checksTotal, `${expected.path}.correctness.checksTotal`);
  if (
    bundle.correctness.status !== "pass"
    || bundle.correctness.checksPassed !== checks
  ) invalid(`${expected.path} correctness did not pass exactly`);
  exactRecord(bundle.correctness.workloadOutput, ["bytes", "sha256"], `${expected.path}.correctness.workloadOutput`);
  positiveInteger(bundle.correctness.workloadOutput.bytes, `${expected.path}.correctness.workloadOutput.bytes`);
  if (!SHA256.test(bundle.correctness.workloadOutput.sha256)) invalid(`${expected.path}.correctness.workloadOutput.sha256 is invalid`);
  exactRecord(bundle.measurements, ["latencyMilliseconds", "peakRssBytes"], `${expected.path}.measurements`);
  positiveNumber(bundle.measurements.latencyMilliseconds, `${expected.path}.measurements.latencyMilliseconds`);
  positiveInteger(bundle.measurements.peakRssBytes, `${expected.path}.measurements.peakRssBytes`);
  exactRecord(bundle.performanceContract, ["schema", "sha256"], `${expected.path}.performanceContract`);
  exactString(bundle.performanceContract.schema, `${expected.path}.performanceContract.schema`);
  if (!SHA256.test(bundle.performanceContract.sha256)) invalid(`${expected.path}.performanceContract.sha256 is invalid`);
  exactRecord(bundle.corpus, ["caseCount", "schema", "sha256"], `${expected.path}.corpus`);
  positiveInteger(bundle.corpus.caseCount, `${expected.path}.corpus.caseCount`);
  exactString(bundle.corpus.schema, `${expected.path}.corpus.schema`);
  if (!SHA256.test(bundle.corpus.sha256)) invalid(`${expected.path}.corpus.sha256 is invalid`);
  exactRecord(bundle.harness, ["command", "schema", "sha256"], `${expected.path}.harness`);
  if (!Array.isArray(bundle.harness.command) || bundle.harness.command.length === 0) invalid(`${expected.path}.harness.command is invalid`);
  bundle.harness.command.forEach((argument) => exactString(argument, `${expected.path}.harness.command`));
  exactString(bundle.harness.schema, `${expected.path}.harness.schema`);
  if (!SHA256.test(bundle.harness.sha256)) invalid(`${expected.path}.harness.sha256 is invalid`);
  exactRecord(bundle.runtime, ["node", "nodeExecutableSha256", "pnpm"], `${expected.path}.runtime`);
  exactString(bundle.runtime.node, `${expected.path}.runtime.node`);
  exactString(bundle.runtime.pnpm, `${expected.path}.runtime.pnpm`);
  if (!SHA256.test(bundle.runtime.nodeExecutableSha256)) invalid(`${expected.path}.runtime.nodeExecutableSha256 is invalid`);
  exactRecord(bundle.host, [
    "arch",
    "cpuCount",
    "cpuModel",
    "kernel",
    "os",
    "referenceClassId",
    "runnerImage",
    "runnerImageSha256",
    "totalMemoryBytes"
  ], `${expected.path}.host`);
  for (const key of ["arch", "cpuModel", "kernel", "os", "referenceClassId", "runnerImage"]) {
    exactString(bundle.host[key], `${expected.path}.host.${key}`);
  }
  if (!SHA256.test(bundle.host.runnerImageSha256)) invalid(`${expected.path}.host.runnerImageSha256 is invalid`);
  positiveInteger(bundle.host.cpuCount, `${expected.path}.host.cpuCount`);
  positiveInteger(bundle.host.totalMemoryBytes, `${expected.path}.host.totalMemoryBytes`);
  if (bundle.host.referenceClassId !== manifest.referenceClassId) invalid(`${expected.path} host reference class does not match manifest`);
  return bundle;
}

function sameJson(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1];
}

export function verifyPerformanceRegression(input) {
  exactRecord(input, ["bundles", "manifest", "policy"], "verification input");
  const policy = parseArtifact(input.policy, "policy artifact");
  const referenceClasses = validatePolicy(policy);
  const manifest = parseArtifact(input.manifest, "manifest artifact");
  validateManifest(manifest, policy, input.policy, referenceClasses);
  if (manifest.pairs.length !== policy.requiredPairCount) invalid("manifest pair count does not match policy");
  if (manifest.plannedAttempts.length !== policy.requiredPairCount) invalid("manifest planned attempts are incomplete");
  if (!Array.isArray(input.bundles) || input.bundles.length !== policy.requiredPairCount * 2) invalid("bundle matrix is incomplete");
  const artifacts = new Map();
  for (const artifact of input.bundles) {
    exactRecord(artifact, ["bytes", "path", "sha256"], "bundle artifact");
    const path = exactString(artifact.path, "bundle artifact path");
    if (artifacts.has(path)) invalid("bundle artifact paths must be unique");
    artifacts.set(path, artifact);
  }

  const pairDeltasMilliseconds = [];
  const pairRatios = [];
  const bundles = [];
  for (let index = 0; index < manifest.pairs.length; index += 1) {
    const pair = manifest.pairs[index];
    exactRecord(pair, ["attemptId", "base", "candidate", "order", "pairId"], `manifest pair ${index + 1}`);
    const expectedOrder = index % 2 === 0 ? "AB" : "BA";
    if (pair.order !== expectedOrder) invalid("manifest pair ordering must alternate AB/BA from AB");
    const expectedPairId = `pair-${String(index + 1).padStart(2, "0")}`;
    const expectedAttemptId = `attempt-${String(index + 1).padStart(2, "0")}`;
    if (pair.pairId !== expectedPairId || pair.attemptId !== expectedAttemptId) invalid("manifest pair plan is not contiguous");
    exactRecord(pair.base, ["path", "sha256"], `${pair.pairId}.base`);
    exactRecord(pair.candidate, ["path", "sha256"], `${pair.pairId}.candidate`);
    const attempt = manifest.plannedAttempts[index];
    exactRecord(attempt, ["attemptId", "order", "pairId", "status"], `planned attempt ${index + 1}`);
    if (
      attempt.attemptId !== pair.attemptId
      || attempt.pairId !== pair.pairId
      || attempt.order !== pair.order
      || attempt.status !== "completed"
    ) invalid("manifest contains missing, deleted, reordered, or invalid attempts");
    const pairBundles = {};
    for (const side of ["base", "candidate"]) {
      const reference = pair[side];
      const artifact = artifacts.get(reference.path);
      if (artifact === undefined) invalid(`${pair.pairId} ${side} bundle is missing`);
      if (artifact.sha256 !== reference.sha256) invalid(`${pair.pairId} ${side} manifest digest does not match bundle`);
      const document = parseArtifact({ bytes: artifact.bytes, sha256: artifact.sha256 }, `${pair.pairId} ${side} bundle`);
      pairBundles[side] = validateBundle(document, {
        order: pair.order,
        pairId: pair.pairId,
        path: reference.path,
        side
      }, manifest);
      bundles.push(pairBundles[side]);
    }
    if (!sameJson(pairBundles.base.correctness.workloadOutput, pairBundles.candidate.correctness.workloadOutput)) {
      invalid(`${pair.pairId} deterministic workload output differs between base and candidate`);
    }
    const ratio = pairBundles.candidate.measurements.latencyMilliseconds
      / pairBundles.base.measurements.latencyMilliseconds;
    const delta = pairBundles.candidate.measurements.latencyMilliseconds
      - pairBundles.base.measurements.latencyMilliseconds;
    if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(delta)) {
      invalid(`${pair.pairId} derived latency ratio or delta is invalid`);
    }
    pairRatios.push(ratio);
    pairDeltasMilliseconds.push(delta);
  }

  const anchor = bundles[0];
  for (const bundle of bundles.slice(1)) {
    if (!sameJson(bundle.correctness.workloadOutput, anchor.correctness.workloadOutput)) {
      invalid("deterministic workload output changed during the campaign");
    }
    for (const field of ["host", "runtime", "harness", "corpus", "performanceContract"]) {
      if (!sameJson(bundle[field], anchor[field])) invalid(`${field} mismatch changes the performance contract`);
    }
  }
  for (const side of ["base", "candidate"]) {
    const sameSide = bundles.filter((bundle) => bundle.side === side);
    const expectedIdentity = manifest.expectedIdentities[side];
    const observedIdentity = {
      packageArtifact: sameSide[0].packageArtifact,
      repository: {
        commit: sameSide[0].repository.commit,
        lockfileSha256: sameSide[0].repository.lockfileSha256,
        tree: sameSide[0].repository.tree
      }
    };
    if (!sameJson(observedIdentity, expectedIdentity)) invalid(`bundle does not match manifest expected ${side} identity`);
    for (const bundle of sameSide.slice(1)) {
      if (!sameJson(bundle.repository, sameSide[0].repository) || !sameJson(bundle.packageArtifact, sameSide[0].packageArtifact)) {
        invalid(`${side} package revision identity moved during the campaign`);
      }
    }
  }

  const eligible = Object.freeze({
    p50: pairRatios.length >= policy.percentileMinimumPairs.p50,
    p95: pairRatios.length >= policy.percentileMinimumPairs.p95,
    p99: pairRatios.length >= policy.percentileMinimumPairs.p99
  });
  const percentiles = Object.freeze({
    p50: eligible.p50 ? percentile(pairRatios, 0.5) : null,
    p95: eligible.p95 ? percentile(pairRatios, 0.95) : null,
    p99: eligible.p99 ? percentile(pairRatios, 0.99) : null
  });
  const deltaPercentiles = Object.freeze({
    p50: eligible.p50 ? percentile(pairDeltasMilliseconds, 0.5) : null,
    p95: eligible.p95 ? percentile(pairDeltasMilliseconds, 0.95) : null,
    p99: eligible.p99 ? percentile(pairDeltasMilliseconds, 0.99) : null
  });
  const reference = referenceClasses.get(manifest.referenceClassId);
  const maximumObservedRssBytes = Math.max(...bundles.map((bundle) => bundle.measurements.peakRssBytes));
  const halfHostMemoryRssBytes = Math.floor(anchor.host.totalMemoryBytes * 0.5);
  const resourcePolicySatisfied = maximumObservedRssBytes <= policy.absoluteMaximumRssBytes
    && maximumObservedRssBytes <= halfHostMemoryRssBytes;
  const configuredThresholds = PERCENTILES.filter((percentile) => reference.hardLatencyThresholds[percentile] !== null);
  const thresholdsEligible = configuredThresholds.length > 0
    && configuredThresholds.every((percentile) => eligible[percentile]);
  const blockers = ["evidence-bundle-unattested"];
  let latencyPolicySatisfied = reference.kind === "dedicated" && thresholdsEligible;
  if (maximumObservedRssBytes > policy.absoluteMaximumRssBytes) blockers.push("absolute-rss-ceiling-exceeded");
  if (maximumObservedRssBytes > halfHostMemoryRssBytes) blockers.push("half-host-memory-rss-ceiling-exceeded");
  if (reference.kind === "shared-github") blockers.push("latency-advisory-shared-github-reference-class");
  else if (configuredThresholds.length === 0) blockers.push("latency-threshold-not-approved-for-reference-class");
  else {
    for (const percentile of configuredThresholds) {
      if (!eligible[percentile]) blockers.push(`latency-threshold-${percentile}-ineligible`);
      else if (
        percentiles[percentile] > reference.hardLatencyThresholds[percentile].maximumRatio
        && deltaPercentiles[percentile]
          > reference.hardLatencyThresholds[percentile].minimumAbsoluteRegressionMilliseconds
      ) {
        blockers.push(`latency-${percentile}-ratio-and-delta-exceed-approved-threshold`);
        latencyPolicySatisfied = false;
      }
    }
  }
  const advisoryGateQualified = reference.kind === "shared-github"
    && resourcePolicySatisfied
    && blockers.length === 2
    && blockers.includes("evidence-bundle-unattested")
    && blockers.includes("latency-advisory-shared-github-reference-class");

  return Object.freeze({
    advisoryGateQualified,
    blockers: Object.freeze(blockers),
    claimEligible: false,
    evidenceAuthority: "unattested",
    identities: Object.freeze({
      base: Object.freeze({ packageArtifact: bundles[0].packageArtifact, repository: bundles[0].repository }),
      candidate: Object.freeze({ packageArtifact: bundles[1].packageArtifact, repository: bundles[1].repository }),
      corpus: anchor.corpus,
      harness: anchor.harness,
      host: anchor.host,
      performanceContract: anchor.performanceContract,
      runtime: anchor.runtime
    }),
    integrityQualified: true,
    latency: Object.freeze({
      eligible,
      deltaPercentiles,
      medianDeltaMilliseconds: deltaPercentiles.p50,
      medianRatio: percentiles.p50,
      pairCount: pairRatios.length,
      pairDeltasMilliseconds: Object.freeze(pairDeltasMilliseconds),
      pairRatios: Object.freeze(pairRatios),
      percentiles
    }),
    latencyAuthoritative: false,
    latencyMeasured: true,
    latencyPolicySatisfied,
    limitations: LIMITATIONS,
    manifestSha256: input.manifest.sha256,
    measurementOnly: true,
    policy: Object.freeze({ id: policy.policyId, sha256: input.policy.sha256 }),
    regressionQualified: false,
    resourceAuthoritative: false,
    resourcePolicySatisfied,
    resourceQualified: false,
    resources: Object.freeze({
      maximumAllowedRssBytes: policy.absoluteMaximumRssBytes,
      maximumHalfHostMemoryRssBytes: halfHostMemoryRssBytes,
      maximumObservedRssBytes
    }),
    schema: SCHEMA
  });
}

export function parsePerformanceRegressionArguments(args) {
  if (args.filter((argument) => argument === "--").length > 1) {
    throw new Error("duplicate argument separator");
  }
  const normalized = args.filter((argument) => argument !== "--");
  const values = new Map();
  for (const argument of normalized) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || !["gate", "manifest"].includes(match[1])) {
      throw new Error(`unsupported performance regression argument: ${argument}`);
    }
    if (values.has(match[1])) throw new Error(`duplicate --${match[1]}`);
    if (match[1] === "gate") {
      if (!["advisory", "qualification"].includes(match[2])) {
        throw new Error("--gate must be advisory or qualification");
      }
      values.set(match[1], match[2]);
      continue;
    }
    if (!isAbsolute(match[2]) || resolve(match[2]) !== match[2]) {
      throw new Error(`--${match[1]} must be an absolute normalized path`);
    }
    values.set(match[1], match[2]);
  }
  if (!values.has("manifest")) throw new Error("--manifest is required");
  return Object.freeze({
    gate: values.get("gate") ?? "qualification",
    manifestPath: values.get("manifest")
  });
}

function loadRegularArtifact(path, name) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid(`${name} must be a regular non-symlink file`);
  const bytes = readFileSync(realpathSync(path));
  return Object.freeze({ bytes, sha256: digest(bytes) });
}

function validateRelativeBundlePath(path) {
  if (
    typeof path !== "string"
    || path.length === 0
    || path.includes("\0")
    || path.includes("\\")
    || path.startsWith("/")
    || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) invalid("manifest bundle paths must be normalized relative POSIX paths");
  return path;
}

export function runPerformanceRegressionCommand(argv) {
  const options = parsePerformanceRegressionArguments(argv);
  const policy = loadRegularArtifact(POLICY_PATH, "packaged policy path");
  const manifest = loadRegularArtifact(options.manifestPath, "manifest path");
  let manifestDocument;
  try {
    manifestDocument = JSON.parse(manifest.bytes.toString());
  } catch {
    invalid("manifest bytes must contain JSON");
  }
  if (!Array.isArray(manifestDocument?.pairs)) invalid("manifest pair plan is missing");
  const manifestRoot = realpathSync(dirname(options.manifestPath));
  const canonicalPaths = new Set();
  const bundles = [];
  for (const pair of manifestDocument.pairs) {
    for (const side of ["base", "candidate"]) {
      const logicalPath = validateRelativeBundlePath(pair?.[side]?.path);
      const lexicalPath = resolve(manifestRoot, ...logicalPath.split("/"));
      const canonicalPath = realpathSync(lexicalPath);
      const fromRoot = relative(manifestRoot, canonicalPath);
      if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
        invalid("manifest bundle path escapes its evidence directory");
      }
      if (canonicalPaths.has(canonicalPath)) invalid("manifest bundle files must resolve uniquely");
      canonicalPaths.add(canonicalPath);
      bundles.push(Object.freeze({
        path: logicalPath,
        ...loadRegularArtifact(lexicalPath, `${pair.pairId ?? "unknown"} ${side} bundle path`)
      }));
    }
  }
  return verifyPerformanceRegression({ bundles, manifest, policy });
}

function rejectedResult(cause) {
  return {
    advisoryGateQualified: false,
    blockers: [`integrity-rejected:${cause instanceof Error ? cause.message : "unknown verifier failure"}`],
    claimEligible: false,
    evidenceAuthority: "unattested",
    integrityQualified: false,
    latencyAuthoritative: false,
    latencyMeasured: false,
    latencyPolicySatisfied: false,
    limitations: LIMITATIONS,
    measurementOnly: true,
    regressionQualified: false,
    resourceAuthoritative: false,
    resourcePolicySatisfied: false,
    resourceQualified: false,
    schema: SCHEMA
  };
}

function main() {
  let result;
  let gate = "qualification";
  try {
    gate = parsePerformanceRegressionArguments(process.argv.slice(2)).gate;
    result = runPerformanceRegressionCommand(process.argv.slice(2));
  } catch (cause) {
    result = rejectedResult(cause);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const gateQualified = gate === "advisory" ? result.advisoryGateQualified : result.regressionQualified;
  if (!gateQualified) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
