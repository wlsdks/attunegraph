import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const READINESS_EVIDENCE_SCHEMA = "attunegraph-readiness-evidence@1";
export const READINESS_CHECK_SCHEMA = "attunegraph-readiness-check@1";
export const READINESS_SCORE_SCHEMA = "attunegraph-readiness-score@1";
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
const CHECK_STATES = new Set(["pass", "fail", "not-run", "stale"]);
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
    invalid(`${name} has unknown, missing, or duplicate fields`);
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${name} must be a non-empty string`);
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
  if (!SHA_PATTERN.test(value)) invalid(`${name} must be a lowercase exact Git SHA`);
}

function validateToolchain(toolchain, name) {
  assertExactKeys(toolchain, ["digest"], name);
  if (typeof toolchain.digest !== "string" || !SHA256_PATTERN.test(toolchain.digest)) {
    invalid(`${name}.digest must be a sha256 digest`);
  }
}

function validateSubject(subject, name) {
  assertExactKeys(subject, ["attunegraph", "muse"], name);
  assertExactKeys(subject.attunegraph, ["clean", "sha", "tree"], `${name}.attunegraph`);
  assertExactKeys(subject.muse, ["attunegraphGitlink", "clean", "sha", "tree"], `${name}.muse`);
  for (const repository of [subject.attunegraph, subject.muse]) {
    assertSha(repository.sha, `${name} repository SHA`);
    assertSha(repository.tree, `${name} repository tree SHA`);
    if (repository.clean !== true) invalid(`${name} requires a clean repository subject`);
  }
  assertExactKeys(subject.muse.attunegraphGitlink, ["path", "sha"], `${name}.muse.attunegraphGitlink`);
  assertNonEmptyString(subject.muse.attunegraphGitlink.path, `${name}.muse.attunegraphGitlink.path`);
  if (
    isAbsolute(subject.muse.attunegraphGitlink.path)
    || subject.muse.attunegraphGitlink.path.split("/").includes("..")
  ) {
    invalid(`${name}.muse.attunegraphGitlink.path must be relative without traversal`);
  }
  assertSha(subject.muse.attunegraphGitlink.sha, `${name}.muse.attunegraphGitlink.sha`);
}

function sameSubject(left, right) {
  return left.attunegraph.sha === right.attunegraph.sha
    && left.attunegraph.tree === right.attunegraph.tree
    && left.attunegraph.clean === right.attunegraph.clean
    && left.muse.sha === right.muse.sha
    && left.muse.tree === right.muse.tree
    && left.muse.clean === right.muse.clean
    && left.muse.attunegraphGitlink.path === right.muse.attunegraphGitlink.path
    && left.muse.attunegraphGitlink.sha === right.muse.attunegraphGitlink.sha;
}

function git(repository, arguments_) {
  try {
    return execFileSync("git", ["-C", repository, ...arguments_], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    invalid(`cannot inspect Git repository ${repository}: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function assertRepositoryBinding(repositoryPath, expected, label) {
  let repository;
  try {
    repository = realpathSync(repositoryPath);
    if (!lstatSync(repository).isDirectory()) invalid(`${label} repository must be a directory`);
  } catch (error) {
    invalid(`${label} repository cannot be resolved: ${error.message}`);
  }
  const sha = git(repository, ["rev-parse", "HEAD"]);
  const tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
  const dirty = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty !== "") invalid(`${label} repository is dirty`);
  if (sha !== expected.sha || tree !== expected.tree || expected.clean !== true) {
    invalid(`${label} repository does not match the clean exact SHA/tree subject`);
  }
  return repository;
}

function assertMuseGitlink(museRepository, subject) {
  const entry = git(museRepository, [
    "ls-tree",
    subject.muse.tree,
    "--",
    subject.muse.attunegraphGitlink.path
  ]);
  const match = /^160000 commit ([a-f0-9]{40,64})\t/u.exec(entry);
  if (!match || match[1] !== subject.attunegraph.sha || match[1] !== subject.muse.attunegraphGitlink.sha) {
    invalid("Muse gitlink does not equal the AttuneGraph subject SHA");
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function escapesRoot(relativePath) {
  return relativePath === ""
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath);
}

function assertArtifact(artifact, evidenceRoot, name) {
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
  const lexicalRelative = relative(evidenceRoot, resolved);
  if (escapesRoot(lexicalRelative)) {
    invalid(`${name}.path escapes the evidence directory`);
  }
  let stat;
  let realPath;
  try {
    stat = lstatSync(resolved);
    realPath = realpathSync(resolved);
  } catch {
    invalid(`${name}.path does not exist`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) invalid(`${name}.path must be a regular non-symlink file`);
  const realRelative = relative(evidenceRoot, realPath);
  if (escapesRoot(realRelative)) {
    invalid(`${name}.path escapes the real evidence directory through a symlink`);
  }
  const bytes = readFileSync(realPath);
  if (sha256(bytes) !== artifact.sha256) invalid(`${name}.sha256 does not match artifact bytes`);
  return { bytes, realPath };
}

function assertCheckArtifact(check, evidenceRoot, artifactPaths) {
  const name = `check ${check.name}.artifact`;
  const { bytes, realPath } = assertArtifact(check.artifact, evidenceRoot, name);
  if (artifactPaths.has(realPath)) invalid(`duplicate artifact path: ${check.artifact.path}`);
  artifactPaths.add(realPath);

  let content;
  try {
    content = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid(`${name} must contain valid JSON`);
  }
  assertExactKeys(
    content,
    ["command", "exitCode", "gate", "name", "observedAt", "schema", "state", "subject", "toolchain"],
    `${name} content`
  );
  if (content.schema !== READINESS_CHECK_SCHEMA) {
    invalid(`${name} content.schema must be attunegraph-readiness-check@1`);
  }
  for (const field of ["name", "gate", "command", "observedAt", "state"]) {
    assertNonEmptyString(content[field], `${name} content.${field}`);
    if (content[field] !== check[field]) invalid(`${name} content.${field} does not match its check`);
  }
  if (content.exitCode !== check.exitCode) invalid(`${name} content.exitCode does not match its check`);
  validateSubject(content.subject, `${name} content.subject`);
  if (!sameSubject(content.subject, check.subject)) invalid(`${name} content.subject does not match its check`);
  validateToolchain(content.toolchain, `${name} content.toolchain`);
  if (content.toolchain.digest !== check.toolchain.digest) {
    invalid(`${name} content.toolchain.digest does not match its check`);
  }
}

function effectiveCheckState(check, asOfMilliseconds) {
  const observedAtMilliseconds = parseTimestamp(check.observedAt, `check ${check.name}.observedAt`);
  if (observedAtMilliseconds > asOfMilliseconds) {
    invalid(`check ${check.name}.observedAt is after --as-of`);
  }
  if (asOfMilliseconds - observedAtMilliseconds > MAX_EVIDENCE_AGE_MILLISECONDS) return "stale";
  return check.state;
}

function validateEvidence(evidence, evidenceDirectory, asOfMilliseconds) {
  assertExactKeys(evidence, ["checks", "schema", "subject", "toolchain"], "evidence");
  if (evidence.schema !== READINESS_EVIDENCE_SCHEMA) invalid("schema must be attunegraph-readiness-evidence@1");
  validateSubject(evidence.subject, "subject");
  validateToolchain(evidence.toolchain, "toolchain");
  if (!Array.isArray(evidence.checks)) invalid("checks must be an array");
  if (evidence.checks.length !== CHECKS_BY_NAME.size) invalid("checks must contain every required check exactly once");

  let evidenceRoot;
  try {
    evidenceRoot = realpathSync(evidenceDirectory);
    if (!lstatSync(evidenceRoot).isDirectory()) invalid("evidence directory must be a directory");
  } catch (error) {
    invalid(`evidence directory cannot be resolved: ${error.message}`);
  }

  const names = new Set();
  const artifactPaths = new Set();
  const states = new Map();
  for (const check of evidence.checks) {
    assertExactKeys(
      check,
      ["artifact", "command", "exitCode", "gate", "name", "observedAt", "state", "subject", "toolchain"],
      "check"
    );
    assertNonEmptyString(check.name, "check.name");
    assertNonEmptyString(check.gate, `check ${check.name}.gate`);
    if (names.has(check.name)) invalid(`duplicate check name: ${check.name}`);
    names.add(check.name);
    if (CHECKS_BY_NAME.get(check.name) !== check.gate || !GATES_BY_NAME.has(check.gate)) {
      invalid(`check ${check.name} is not a required check for its gate`);
    }
    if (!CHECK_STATES.has(check.state)) invalid(`check ${check.name}.state is unsupported`);
    assertNonEmptyString(check.command, `check ${check.name}.command`);
    if (check.exitCode !== 0) invalid(`check ${check.name}.exitCode must be 0`);
    validateSubject(check.subject, `check ${check.name}.subject`);
    if (!sameSubject(check.subject, evidence.subject)) {
      invalid(`check ${check.name}.subject does not match the evidence subject`);
    }
    validateToolchain(check.toolchain, `check ${check.name}.toolchain`);
    if (check.toolchain.digest !== evidence.toolchain.digest) {
      invalid(`check ${check.name}.toolchain.digest does not match the evidence toolchain`);
    }
    assertCheckArtifact(check, evidenceRoot, artifactPaths);
    states.set(check, effectiveCheckState(check, asOfMilliseconds));
  }
  for (const requiredName of CHECKS_BY_NAME.keys()) {
    if (!names.has(requiredName)) invalid(`missing required check: ${requiredName}`);
  }
  return states;
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
  const states = validateEvidence(evidence, evidenceDirectory, asOfMilliseconds);
  assertRepositoryBinding(
    attunegraphRepository,
    evidence.subject.attunegraph,
    "AttuneGraph"
  );
  const museRoot = assertRepositoryBinding(museRepository, evidence.subject.muse, "Muse");
  assertMuseGitlink(museRoot, evidence.subject);

  const gates = READINESS_GATES.map((gate) => {
    const checks = evidence.checks.filter((check) => check.gate === gate.name);
    const state = gateState(checks, states);
    return Object.freeze({
      checks: Object.freeze(checks.map((check) => Object.freeze({
        name: check.name,
        state: states.get(check)
      }))),
      name: gate.name,
      score: state === "pass" ? gate.weight : 0,
      state,
      weight: gate.weight
    });
  });
  const score = gates.reduce((total, gate) => total + gate.score, 0);
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  const eligible = score >= 90
    && byName.get("muse-integration").state === "pass"
    && byName.get("semantic-safety").state === "pass"
    && byName.get("persistence-portable").state === "pass";

  return Object.freeze({
    asOf,
    eligible,
    gates: Object.freeze(gates),
    note: "This score measures evidence coverage, never product usefulness.",
    schema: READINESS_SCORE_SCHEMA,
    score,
    subject: evidence.subject
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
