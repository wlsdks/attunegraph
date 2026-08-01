import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readinessCheckContract,
  readinessContractsMatchInventory,
  readinessContractSnapshot,
  validateReadinessCommandOutput
} from "./readiness-check-contracts.mjs";
import {
  READINESS_MEASUREMENT_PROVENANCE_SCHEMA,
  READINESS_MEASUREMENT_RESULT_SCHEMA,
  readinessMeasurementContract,
  readinessMeasurementContractSnapshot,
  validateReadinessMeasurementOutput
} from "./readiness-measurement-contracts.mjs";

export const READINESS_EVIDENCE_SCHEMA = "attunegraph-readiness-evidence@1";
export const READINESS_CHECK_SCHEMA = "attunegraph-readiness-check@1";
export const READINESS_SCORE_SCHEMA = "attunegraph-readiness-score@1";
export const READINESS_CAPTURE_SCHEMA = "attunegraph-readiness-capture@1";
export const MAX_EVIDENCE_AGE_MILLISECONDS = 168 * 60 * 60 * 1_000;

export const READINESS_GATES = Object.freeze([
  Object.freeze({
    name: "independent-clean-room",
    weight: 15,
    checks: Object.freeze(["install", "build", "test", "example", "pack", "consumer-install"])
  }),
  Object.freeze({
    name: "muse-integration",
    weight: 20,
    checks: Object.freeze([
      "submodule-pinned",
      "narrow-public-port",
      "no-duplicate-engine-source",
      "v2-durable-path"
    ])
  }),
  Object.freeze({
    name: "semantic-safety",
    weight: 20,
    checks: Object.freeze([
      "conformance",
      "adversarial",
      "property",
      "fault",
      "authority-fail-closed"
    ])
  }),
  Object.freeze({
    name: "persistence-portable",
    weight: 10,
    checks: Object.freeze(["sqlite-crash-cas", "atgx-streaming-round-trip"])
  }),
  Object.freeze({
    name: "retrieval-quality",
    weight: 10,
    checks: Object.freeze(["working-graph-golden-corpus", "abstention"])
  }),
  Object.freeze({
    name: "performance-resources",
    weight: 15,
    checks: Object.freeze([
      "corpus-10k",
      "corpus-100k",
      "corpus-1m",
      "projection-latency",
      "working-graph-latency",
      "throughput",
      "peak-rss",
      "sqlite-cold-open",
      "sqlite-warm-open",
      "concurrency",
      "portable-encode-decode"
    ])
  }),
  Object.freeze({
    name: "operability",
    weight: 5,
    checks: Object.freeze(["inspect", "verify", "diagnose", "zero-hidden-mutation"])
  }),
  Object.freeze({
    name: "public-adoption",
    weight: 5,
    checks: Object.freeze(["api-reference", "migration-notes", "independent-example"])
  })
]);

const GATES_BY_NAME = new Map(READINESS_GATES.map((gate) => [gate.name, gate]));
const CHECKS_BY_NAME = new Map(
  READINESS_GATES.flatMap((gate) => gate.checks.map((name) => [name, gate.name]))
);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CHECK_STATES = new Set(["pass", "fail", "not-run"]);
const CLI_ARGUMENTS = new Set([
  "as-of",
  "attunegraph-repository",
  "evidence",
  "muse-repository"
]);

function invalid(message) {
  throw new Error(`invalid readiness evidence: ${message}`);
}

function assertObject(value, name) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${name} must be an object`);
  }
}

function assertExactKeys(value, keys, name) {
  assertObject(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(`${name} has unknown or missing fields`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    invalid(`${name} must be a non-empty string without NUL bytes`);
  }
}

function parseTimestamp(value, name) {
  assertNonEmptyString(value, name);
  if (!ISO_TIMESTAMP_PATTERN.test(value)) {
    invalid(`${name} must be an exact UTC ISO-8601 timestamp with milliseconds`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    invalid(`${name} must be a valid UTC timestamp`);
  }
  return milliseconds;
}

function assertSha(value, name) {
  assertNonEmptyString(value, name);
  if (!SHA_PATTERN.test(value)) invalid(`${name} must be a lowercase exact 40-hex Git SHA`);
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function toolchainIdentity(toolchain) {
  return {
    arch: toolchain.arch,
    node: toolchain.node,
    packageManager: toolchain.packageManager,
    platform: toolchain.platform
  };
}

export function createReadinessToolchain({
  arch = process.arch,
  node = process.version,
  packageManager = process.env.npm_config_user_agent?.split(" ")[0] ?? null,
  platform = process.platform
} = {}) {
  const identity = { arch, node, packageManager, platform };
  return Object.freeze({
    ...identity,
    digest: sha256(JSON.stringify(identity))
  });
}

function validateToolchain(toolchain, name) {
  assertExactKeys(toolchain, ["arch", "digest", "node", "packageManager", "platform"], name);
  for (const field of ["arch", "node", "platform"]) {
    assertNonEmptyString(toolchain[field], `${name}.${field}`);
  }
  if (toolchain.packageManager !== null) {
    assertNonEmptyString(toolchain.packageManager, `${name}.packageManager`);
  }
  if (typeof toolchain.digest !== "string" || !SHA256_PATTERN.test(toolchain.digest)) {
    invalid(`${name}.digest must be a sha256 digest`);
  }
  if (toolchain.digest !== sha256(JSON.stringify(toolchainIdentity(toolchain)))) {
    invalid(`${name}.digest does not match the exact toolchain identity`);
  }
}

function validateGitlink(gitlink, name) {
  assertExactKeys(gitlink, ["path", "sha"], name);
  assertNonEmptyString(gitlink.path, `${name}.path`);
  if (isAbsolute(gitlink.path) || gitlink.path.split(/[\\/]/u).includes("..")) {
    invalid(`${name}.path must be relative without traversal`);
  }
  assertSha(gitlink.sha, `${name}.sha`);
}

function validateSubject(subject, name) {
  assertExactKeys(subject, ["attunegraph", "muse"], name);
  assertExactKeys(subject.attunegraph, ["clean", "sha", "tree"], `${name}.attunegraph`);
  assertExactKeys(subject.muse, ["attunegraphGitlink", "clean", "sha", "tree"], `${name}.muse`);
  for (const repository of [subject.attunegraph, subject.muse]) {
    assertSha(repository.sha, `${name} repository SHA`);
    assertSha(repository.tree, `${name} repository tree SHA`);
    if (repository.clean !== true) invalid(`${name} requires clean repository subjects`);
  }
  validateGitlink(subject.muse.attunegraphGitlink, `${name}.muse.attunegraphGitlink`);
}

function sameSubject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function git(repository, arguments_, failure = invalid) {
  try {
    return execFileSync("git", ["-C", repository, ...arguments_], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    failure(`cannot inspect Git repository ${repository}: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function resolveRepository(repositoryPath, label, failure = invalid) {
  const lexical = resolve(repositoryPath);
  try {
    const lexicalStat = lstatSync(lexical);
    if (lexicalStat.isSymbolicLink()) failure(`${label} repository path must not be a symlink`);
    const repository = realpathSync(lexical);
    if (!lstatSync(repository).isDirectory()) failure(`${label} repository must be a directory`);
    return repository;
  } catch (error) {
    failure(`${label} repository cannot be resolved: ${error.message}`);
  }
}

function inspectRepository(repositoryPath, label, failure = invalid) {
  const repository = resolveRepository(repositoryPath, label, failure);
  const dirty = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"], failure);
  if (dirty !== "") failure(`${label} repository is dirty`);
  return {
    repository,
    identity: {
      clean: true,
      sha: git(repository, ["rev-parse", "HEAD"], failure),
      tree: git(repository, ["rev-parse", "HEAD^{tree}"], failure)
    }
  };
}

function readGitlink(museRepository, museTree, path, failure = invalid) {
  const entry = git(museRepository, ["ls-tree", museTree, "--", path], failure);
  const match = /^160000 commit ([a-f0-9]{40})\t/u.exec(entry);
  if (!match) failure(`Muse gitlink is missing at ${path}`);
  return match[1];
}

export function inspectReadinessSubject({
  attunegraphRepository,
  museGitlinkPath = "packages/attunegraph",
  museRepository
}) {
  const failure = (message) => { throw new Error(`readiness capture refused: ${message}`); };
  if (isAbsolute(museGitlinkPath) || museGitlinkPath.split(/[\\/]/u).includes("..")) {
    failure("Muse gitlink path must be relative without traversal");
  }
  const attunegraph = inspectRepository(attunegraphRepository, "AttuneGraph", failure);
  const muse = inspectRepository(museRepository, "Muse", failure);
  const gitlinkSha = readGitlink(muse.repository, muse.identity.tree, museGitlinkPath, failure);
  if (gitlinkSha !== attunegraph.identity.sha) {
    failure("Muse gitlink does not equal the AttuneGraph subject SHA");
  }
  return Object.freeze({
    attunegraphRoot: attunegraph.repository,
    museRoot: muse.repository,
    subject: Object.freeze({
      attunegraph: Object.freeze(attunegraph.identity),
      muse: Object.freeze({
        ...muse.identity,
        attunegraphGitlink: Object.freeze({ path: museGitlinkPath, sha: gitlinkSha })
      })
    })
  });
}

function assertRepositoryBinding(attunegraphPath, musePath, expected) {
  const actual = inspectReadinessSubject({
    attunegraphRepository: attunegraphPath,
    museGitlinkPath: expected.muse.attunegraphGitlink.path,
    museRepository: musePath
  });
  if (!sameSubject(actual.subject, expected)) {
    invalid("repositories do not match the clean exact SHA/tree/gitlink subject");
  }
  return actual;
}

function escapesRoot(relativePath) {
  return relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath);
}

export function readReadinessRepositoryRegularFile(repositoryRoot, pathSegments) {
  const lexical = join(repositoryRoot, ...pathSegments);
  if (escapesRoot(relative(repositoryRoot, lexical))) {
    invalid("repository artifact path escapes its repository");
  }
  let stat;
  let realPath;
  try {
    stat = lstatSync(lexical);
    realPath = realpathSync(lexical);
  } catch {
    invalid("repository artifact does not exist");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    invalid("repository artifact must be a regular non-symlink file");
  }
  if (escapesRoot(relative(repositoryRoot, realPath))) {
    invalid("repository artifact escapes its repository through a symlink");
  }
  return readFileSync(realPath);
}

function assertArtifact(artifact, evidenceRoot, name, artifactPaths) {
  assertExactKeys(artifact, ["path", "sha256"], name);
  assertNonEmptyString(artifact.path, `${name}.path`);
  if (
    isAbsolute(artifact.path)
    || artifact.path.split(/[\\/]/u).includes("..")
    || artifact.path.split(/[\\/]/u).includes("")
  ) {
    invalid(`${name}.path must be relative without traversal`);
  }
  if (typeof artifact.sha256 !== "string" || !SHA256_PATTERN.test(artifact.sha256)) {
    invalid(`${name}.sha256 must be a sha256 digest`);
  }
  const resolved = resolve(evidenceRoot, artifact.path);
  if (escapesRoot(relative(evidenceRoot, resolved))) invalid(`${name}.path escapes the evidence directory`);
  let stat;
  let realPath;
  try {
    stat = lstatSync(resolved);
    realPath = realpathSync(resolved);
  } catch {
    invalid(`${name}.path does not exist`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid(`${name}.path must be a regular non-symlink file`);
  if (escapesRoot(relative(evidenceRoot, realPath))) {
    invalid(`${name}.path escapes the real evidence directory through a symlink`);
  }
  if (artifactPaths.has(realPath)) invalid(`duplicate artifact path: ${artifact.path}`);
  artifactPaths.add(realPath);
  const bytes = readFileSync(realPath);
  if (sha256(bytes) !== artifact.sha256) invalid(`${name}.sha256 does not match artifact bytes`);
  return bytes;
}

function nullableString(value, name) {
  if (value !== null) assertNonEmptyString(value, name);
}

function validateExecutionState(result, name) {
  if (!CHECK_STATES.has(result.state)) invalid(`${name}.state is unsupported`);
  if (result.exitCode !== null && (!Number.isInteger(result.exitCode) || result.exitCode < 0)) {
    invalid(`${name}.exitCode must be a non-negative integer or null`);
  }
  nullableString(result.signal, `${name}.signal`);
  nullableString(result.spawnError, `${name}.spawnError`);
  if (result.state === "pass") {
    if (result.exitCode !== 0 || result.signal !== null || result.spawnError !== null) {
      invalid(`${name} pass requires exitCode 0 without signal or spawn error`);
    }
  } else if (result.state === "fail") {
    if (
      (result.exitCode === null || result.exitCode === 0)
      && result.signal === null
      && result.spawnError === null
    ) {
      invalid(`${name} fail requires a nonzero exit, signal, or spawn error`);
    }
  } else if (result.exitCode !== null || result.signal !== null || result.spawnError !== null) {
    invalid(`${name} not-run must not claim a process outcome`);
  }
}

function validateProvenance(provenance, name) {
  assertExactKeys(
    provenance,
    ["captureScriptSha256", "kind", "producer", "schema"],
    name
  );
  if (provenance.schema !== "attunegraph-readiness-provenance@1") {
    invalid(`${name}.schema is unsupported`);
  }
  if (provenance.kind !== "local-unattested") {
    invalid(`${name}.kind cannot claim attestation without live cryptographic verification`);
  }
  if (provenance.producer !== "capture-attunegraph-readiness@1") {
    invalid(`${name}.producer is unsupported`);
  }
  if (!SHA256_PATTERN.test(provenance.captureScriptSha256)) {
    invalid(`${name}.captureScriptSha256 must be a sha256 digest`);
  }
}

function validateCommand(command, checkName, gate, name) {
  const contract = readinessCheckContract(checkName);
  if (!contract || contract.gate !== gate) invalid(`${name} has no fixed check contract`);
  assertExactKeys(
    command,
    ["argv", "availability", "cwdRole", "id", "output", "parameters", "unavailableReason"],
    name
  );
  if (!sameValue(command, readinessContractSnapshot(contract))) {
    invalid(`${name} does not match the fixed registry contract`);
  }
  return contract;
}

function validateExecutable(executable, contract, state, name) {
  if (contract.availability === "unavailable" || state === "not-run") {
    if (executable !== null) invalid(`${name} must be null for an unavailable check`);
    return;
  }
  assertExactKeys(executable, ["path", "sha256", "version"], name);
  assertNonEmptyString(executable.path, `${name}.path`);
  assertNonEmptyString(executable.version, `${name}.version`);
  if (!isAbsolute(executable.path)) invalid(`${name}.path must be absolute`);
  if (!SHA256_PATTERN.test(executable.sha256)) invalid(`${name}.sha256 must be a sha256 digest`);
}

function validateCheckResult(
  check,
  evidenceRoot,
  artifactPaths,
  evidenceSubject,
  asOfMilliseconds,
  repositoryRoots
) {
  const resultBytes = assertArtifact(
    check.result,
    evidenceRoot,
    `check ${check.name}.result`,
    artifactPaths
  );
  let result;
  try {
    result = JSON.parse(resultBytes.toString("utf8"));
  } catch {
    invalid(`check ${check.name}.result must contain valid JSON`);
  }
  assertExactKeys(result, [
    "command",
    "cwd",
    "endedAt",
    "executable",
    "exitCode",
    "gate",
    "name",
    "provenance",
    "schema",
    "signal",
    "spawnError",
    "startedAt",
    "state",
    "stderr",
    "stdout",
    "subject",
    "toolchain"
  ], `check ${check.name}.result content`);
  if (result.schema !== READINESS_CHECK_SCHEMA) {
    invalid(`check ${check.name}.result schema must be ${READINESS_CHECK_SCHEMA}`);
  }
  if (result.name !== check.name || result.gate !== check.gate) {
    invalid(`check ${check.name}.result name/gate does not match its manifest entry`);
  }
  const contract = validateCommand(
    result.command,
    check.name,
    check.gate,
    `check ${check.name}.result command`
  );
  validateExecutable(result.executable, contract, result.state, `check ${check.name}.result executable`);
  validateProvenance(result.provenance, `check ${check.name}.result provenance`);
  assertNonEmptyString(result.cwd, `check ${check.name}.result cwd`);
  const expectedCwd = contract.cwdRole === "muse"
    ? repositoryRoots.museRoot
    : repositoryRoots.attunegraphRoot;
  if (result.cwd !== expectedCwd) {
    invalid(`check ${check.name}.result cwd does not match the canonical ${contract.cwdRole} repository root`);
  }
  validateExecutionState(result, `check ${check.name}.result`);
  if (contract.availability === "unavailable" && result.state !== "not-run") {
    invalid(`check ${check.name} is unavailable and must be not-run`);
  }
  const startedAt = parseTimestamp(result.startedAt, `check ${check.name}.result startedAt`);
  const endedAt = parseTimestamp(result.endedAt, `check ${check.name}.result endedAt`);
  if (endedAt < startedAt) invalid(`check ${check.name}.result endedAt precedes startedAt`);
  if (endedAt > asOfMilliseconds) invalid(`check ${check.name}.result endedAt is after --as-of`);
  validateSubject(result.subject, `check ${check.name}.result subject`);
  if (!sameSubject(result.subject, evidenceSubject)) {
    invalid(`check ${check.name}.result subject does not match the evidence subject`);
  }
  validateToolchain(result.toolchain, `check ${check.name}.result toolchain`);
  const stdout = assertArtifact(result.stdout, evidenceRoot, `check ${check.name}.stdout`, artifactPaths);
  const stderr = assertArtifact(result.stderr, evidenceRoot, `check ${check.name}.stderr`, artifactPaths);
  if (contract.availability === "available" && result.state === "pass") {
    try {
      validateReadinessCommandOutput(stdout, contract);
    } catch (error) {
      invalid(`check ${check.name}.stdout ${error.message}`);
    }
  }
  if (result.state === "not-run" && (stdout.length !== 0 || stderr.length !== 0)) {
    invalid(`check ${check.name} not-run output artifacts must be empty`);
  }
  return {
    state: asOfMilliseconds - endedAt > MAX_EVIDENCE_AGE_MILLISECONDS ? "stale" : result.state
  };
}

function validateMeasurementProvenance(provenance, name) {
  assertExactKeys(
    provenance,
    ["captureScriptSha256", "kind", "producer", "schema"],
    name
  );
  if (
    provenance.schema !== READINESS_MEASUREMENT_PROVENANCE_SCHEMA
    || provenance.kind !== "local-unattested"
    || provenance.producer !== "capture-attunegraph-measurement@1"
    || !SHA256_PATTERN.test(provenance.captureScriptSha256)
  ) {
    invalid(`${name} does not match the local-unattested measurement producer`);
  }
}

function validateMeasurementExecutionState(result, name) {
  if (!new Set(["observed", "failed"]).has(result.state)) {
    invalid(`${name}.state is unsupported`);
  }
  if (result.exitCode !== null && (!Number.isInteger(result.exitCode) || result.exitCode < 0)) {
    invalid(`${name}.exitCode must be a non-negative integer or null`);
  }
  nullableString(result.signal, `${name}.signal`);
  nullableString(result.spawnError, `${name}.spawnError`);
  if (result.state === "observed") {
    if (result.exitCode !== 0 || result.signal !== null || result.spawnError !== null) {
      invalid(`${name} observed requires exitCode 0 without signal or spawn error`);
    }
  } else if (
    (result.exitCode === null || result.exitCode === 0)
    && result.signal === null
    && result.spawnError === null
  ) {
    invalid(`${name} failed requires a nonzero exit, signal, or spawn error`);
  }
}

function validateMeasurementLimits(limits, name) {
  assertExactKeys(limits, [
    "environment",
    "maxStderrBytes",
    "maxStdoutBytes",
    "timeoutMilliseconds"
  ], name);
  if (
    limits.environment !== "sanitized-minimal"
    || limits.maxStderrBytes !== 65_536
    || limits.maxStdoutBytes !== 2_097_152
    || limits.timeoutMilliseconds !== 30_000
  ) {
    invalid(`${name} does not match the fixed bounded execution contract`);
  }
}

function validateMeasurementResult(
  measurement,
  evidenceRoot,
  artifactPaths,
  evidenceSubject,
  asOfMilliseconds,
  repositoryRoots
) {
  const resultBytes = assertArtifact(
    measurement.result,
    evidenceRoot,
    `measurement ${measurement.name}.result`,
    artifactPaths
  );
  let result;
  try {
    result = JSON.parse(resultBytes.toString("utf8"));
  } catch {
    invalid(`measurement ${measurement.name}.result must contain valid JSON`);
  }
  assertExactKeys(result, [
    "command",
    "cwd",
    "endedAt",
    "executable",
    "exitCode",
    "limits",
    "measurement",
    "provenance",
    "schema",
    "signal",
    "spawnError",
    "startedAt",
    "state",
    "stderr",
    "stdout",
    "subject",
    "toolchain"
  ], `measurement ${measurement.name}.result content`);
  if (result.schema !== READINESS_MEASUREMENT_RESULT_SCHEMA) {
    invalid(`measurement ${measurement.name}.result schema must be ${READINESS_MEASUREMENT_RESULT_SCHEMA}`);
  }
  if (result.measurement !== measurement.name) {
    invalid(`measurement ${measurement.name}.result name does not match its manifest entry`);
  }
  const contract = readinessMeasurementContract(measurement.name);
  if (!contract) invalid(`measurement ${measurement.name} has no fixed measurement contract`);
  assertExactKeys(result.command, [
    "argv",
    "authority",
    "cwdRole",
    "id",
    "output",
    "parameters",
    "scoring"
  ], `measurement ${measurement.name}.result command`);
  if (!sameValue(result.command, readinessMeasurementContractSnapshot(contract))) {
    invalid(`measurement ${measurement.name}.result does not match the fixed registry contract`);
  }
  validateExecutable(
    result.executable,
    { availability: "available" },
    result.state,
    `measurement ${measurement.name}.result executable`
  );
  validateMeasurementProvenance(
    result.provenance,
    `measurement ${measurement.name}.result provenance`
  );
  validateMeasurementLimits(result.limits, `measurement ${measurement.name}.result limits`);
  if (result.cwd !== repositoryRoots.attunegraphRoot) {
    invalid(`measurement ${measurement.name}.result cwd does not match the canonical attunegraph repository root`);
  }
  validateMeasurementExecutionState(result, `measurement ${measurement.name}.result`);
  const startedAt = parseTimestamp(
    result.startedAt,
    `measurement ${measurement.name}.result startedAt`
  );
  const endedAt = parseTimestamp(result.endedAt, `measurement ${measurement.name}.result endedAt`);
  if (endedAt < startedAt) invalid(`measurement ${measurement.name}.result endedAt precedes startedAt`);
  if (endedAt > asOfMilliseconds) invalid(`measurement ${measurement.name}.result endedAt is after --as-of`);
  validateSubject(result.subject, `measurement ${measurement.name}.result subject`);
  if (!sameSubject(result.subject, evidenceSubject)) {
    invalid(`measurement ${measurement.name}.result subject does not match the evidence subject`);
  }
  validateToolchain(result.toolchain, `measurement ${measurement.name}.result toolchain`);
  const stdout = assertArtifact(
    result.stdout,
    evidenceRoot,
    `measurement ${measurement.name}.stdout`,
    artifactPaths
  );
  assertArtifact(
    result.stderr,
    evidenceRoot,
    `measurement ${measurement.name}.stderr`,
    artifactPaths
  );
  if (result.state === "observed") {
    let report;
    try {
      report = validateReadinessMeasurementOutput(stdout, contract);
    } catch (error) {
      invalid(`measurement ${measurement.name}.stdout ${error.message}`);
    }
    const reportCapturedAt = Date.parse(report.provenance.capturedAt);
    if (reportCapturedAt < startedAt || reportCapturedAt > endedAt) {
      invalid(`measurement ${measurement.name}.stdout capture time is outside the process interval`);
    }
    if (
      report.provenance.runtime.node !== result.toolchain.node
      || report.provenance.runtime.platform !== result.toolchain.platform
      || report.provenance.runtime.arch !== result.toolchain.arch
    ) {
      invalid(`measurement ${measurement.name}.stdout runtime does not match the outer toolchain`);
    }
    const tracerBytes = readReadinessRepositoryRegularFile(
      repositoryRoots.attunegraphRoot,
      ["scripts", "benchmark-attunegraph-agent-decision-mixed-durable.mjs"]
    );
    if (report.provenance.harness.sha256 !== sha256(tracerBytes)) {
      invalid(`measurement ${measurement.name}.stdout harness hash does not match the checked-out tracer`);
    }
  }
  return {
    claimEligible: false,
    state: asOfMilliseconds - endedAt > MAX_EVIDENCE_AGE_MILLISECONDS
      ? "stale"
      : result.state
  };
}

function validateEvidence(evidence, evidenceDirectory, asOfMilliseconds, repositoryRoots) {
  assertExactKeys(
    evidence,
    ["checks", "measurements", "schema", "subject"],
    "evidence"
  );
  if (evidence.schema !== READINESS_EVIDENCE_SCHEMA) {
    invalid(`schema must be ${READINESS_EVIDENCE_SCHEMA}`);
  }
  validateSubject(evidence.subject, "subject");
  if (!Array.isArray(evidence.checks)) invalid("checks must be an array");
  if (evidence.checks.length !== CHECKS_BY_NAME.size) {
    invalid("checks must contain every required check exactly once");
  }
  let evidenceRoot;
  try {
    const lexical = resolve(evidenceDirectory);
    if (lstatSync(lexical).isSymbolicLink()) invalid("evidence directory must not be a symlink");
    evidenceRoot = realpathSync(lexical);
    if (!lstatSync(evidenceRoot).isDirectory()) invalid("evidence directory must be a directory");
  } catch (error) {
    invalid(`evidence directory cannot be resolved: ${error.message}`);
  }
  const names = new Set();
  const artifactPaths = new Set();
  const states = new Map();
  for (const check of evidence.checks) {
    assertExactKeys(check, ["gate", "name", "result"], "check");
    assertNonEmptyString(check.name, "check.name");
    assertNonEmptyString(check.gate, `check ${check.name}.gate`);
    if (names.has(check.name)) invalid(`duplicate check name: ${check.name}`);
    names.add(check.name);
    if (CHECKS_BY_NAME.get(check.name) !== check.gate || !GATES_BY_NAME.has(check.gate)) {
      invalid(`check ${check.name} is not a required check for its gate`);
    }
    const result = validateCheckResult(
      check,
      evidenceRoot,
      artifactPaths,
      evidence.subject,
      asOfMilliseconds,
      repositoryRoots
    );
    states.set(check, result.state);
  }
  for (const requiredName of CHECKS_BY_NAME.keys()) {
    if (!names.has(requiredName)) invalid(`missing required check: ${requiredName}`);
  }
  const measurements = [];
  if (!Array.isArray(evidence.measurements) || evidence.measurements.length !== 1) {
    invalid("measurements must contain every required measurement exactly once");
  }
  const measurementNames = new Set();
  for (const measurement of evidence.measurements) {
    assertExactKeys(measurement, ["name", "result"], "measurement");
    assertNonEmptyString(measurement.name, "measurement.name");
    if (measurementNames.has(measurement.name)) {
      invalid(`duplicate measurement name: ${measurement.name}`);
    }
    measurementNames.add(measurement.name);
    const observed = validateMeasurementResult(
      measurement,
      evidenceRoot,
      artifactPaths,
      evidence.subject,
      asOfMilliseconds,
      repositoryRoots
    );
    measurements.push(Object.freeze({
      claimEligible: observed.claimEligible,
      name: measurement.name,
      state: observed.state
    }));
  }
  if (!measurementNames.has("mixed-durable-agent-decision-observation")) {
    invalid("missing required measurement: mixed-durable-agent-decision-observation");
  }
  return { measurements, states };
}

function gateState(checks, states) {
  if (checks.every((check) => states.get(check) === "pass")) return "pass";
  for (const state of ["fail", "not-run", "stale"]) {
    if (checks.some((check) => states.get(check) === state)) return state;
  }
  invalid("check state could not be scored");
}

export function parseReadinessArguments(args) {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const values = new Map();
  for (const argument of normalized) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || !CLI_ARGUMENTS.has(match[1])) {
      throw new Error(`unsupported readiness scorer argument: ${argument}`);
    }
    if (values.has(match[1])) throw new Error(`duplicate readiness scorer argument: --${match[1]}`);
    values.set(match[1], match[2]);
  }
  for (const required of CLI_ARGUMENTS) {
    if (!values.has(required)) throw new Error(`--${required} is required`);
  }
  parseTimestamp(values.get("as-of"), "--as-of");
  return Object.freeze({
    asOf: values.get("as-of"),
    attunegraphRepository: values.get("attunegraph-repository"),
    evidencePath: values.get("evidence"),
    museRepository: values.get("muse-repository")
  });
}

export function scoreReadinessEvidence({
  asOf,
  attunegraphRepository,
  evidence,
  evidenceDirectory,
  museRepository
}) {
  const asOfMilliseconds = parseTimestamp(asOf, "--as-of");
  if (!readinessContractsMatchInventory(READINESS_GATES)) {
    invalid("fixed check-contract registry does not match the readiness inventory");
  }
  const repositoryRoots = assertRepositoryBinding(
    attunegraphRepository,
    museRepository,
    evidence.subject
  );
  const validation = validateEvidence(
    evidence,
    evidenceDirectory,
    asOfMilliseconds,
    repositoryRoots
  );
  const gates = READINESS_GATES.map((gate) => {
    const checks = evidence.checks.filter((check) => check.gate === gate.name);
    const state = gateState(checks, validation.states);
    return Object.freeze({
      checks: Object.freeze(checks.map((check) => Object.freeze({
        name: check.name,
        state: validation.states.get(check)
      }))),
      name: gate.name,
      score: state === "pass" ? gate.weight : 0,
      state,
      weight: gate.weight
    });
  });
  const score = gates.reduce((total, gate) => total + gate.score, 0);
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  const integrityThresholdMet = score >= 90
    && byName.get("muse-integration").state === "pass"
    && byName.get("semantic-safety").state === "pass"
    && byName.get("persistence-portable").state === "pass";
  const common = {
    asOf,
    authenticity: "unattested",
    eligible: false,
    gates: Object.freeze(gates),
    integrityThresholdMet,
    note: "This is an integrity-only local coverage report. It is not execution-authentic qualification evidence.",
    score,
    subject: evidence.subject
  };
  return Object.freeze({
    ...common,
    measurements: Object.freeze(validation.measurements),
    schema: READINESS_SCORE_SCHEMA
  });
}

export function runReadinessScorer(options) {
  const evidencePath = realpathSync(options.evidencePath);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  return scoreReadinessEvidence({
    ...options,
    evidence,
    evidenceDirectory: dirname(evidencePath)
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runReadinessScorer(parseReadinessArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
