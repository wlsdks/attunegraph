import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { arch, cpus, hostname, platform, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { types as nodeTypes } from "node:util";

import { createAttuneGraphStore } from "../dist/attunegraph-backend.js";
import { createAttuneGraphAdminReadOnlyInspector } from "../dist/attunegraph-admin-readonly-inspector.mjs";
import { openAttuneGraph } from "../dist/attunegraph-engine.js";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V2 } from "../dist/attunegraph-physical-schema-v2.mjs";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V3 } from "../dist/attunegraph-physical-schema-v3.mjs";
import { openSqliteAttuneGraphStore } from "../dist/attunegraph-sqlite-store.js";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import {
  captureContentAddressedSourceCheckoutProvenance
} from "./source-checkout-provenance.mjs";

const CORPUS_SEED = "normalized-current-head-materialization@1";
const ASSERTIONS_PER_SCOPE = 32;
const OFFICIAL_SCALES = new Set([10_000, 100_000, 1_000_000]);
const OFFICIAL_SEMANTIC_AGGREGATES = new Map([
  [10_000, "a64896a4375ab7aaa6fce8b94c825ddbc16aa5c5a16771e85a33e58c0d6fa0e4"],
  [100_000, "8683df667e42cf2cd36d1c977ff4bf8bcefe4bf5528e48388722412349bce562"],
  [1_000_000, "410a96f27517ea47783b9caebba80d5beaa86789aaef8e4e6377a0af09efc2ba"]
]);
const OBSERVED_AT = "2026-08-02T00:00:00.000Z";
const MAX_REPORT_BYTES = 256 * 1024;
const PACKAGE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME_ROOTS = Object.freeze([
  "dist/attunegraph-admin-readonly-inspector.mjs",
  "dist/attunegraph-backend.js",
  "dist/attunegraph-engine.js",
  "dist/attunegraph-physical-schema-v2.mjs",
  "dist/attunegraph-sqlite-store.js"
]);
const RUNTIME_MODULE_RESOLUTION =
  "recursive relative static import/export and worker URL closure";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Identity(value) {
  return `sha256:${sha256(value)}`;
}

function exactRecord(value, keys, label) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.getOwnPropertySymbols(value).length !== 0
  ) throw new Error(`${label} is invalid`);
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    JSON.stringify(actual) !== JSON.stringify(expected)
    || actual.some((key) => !descriptors[key] || !("value" in descriptors[key]))
  ) throw new Error(`${label} is invalid`);
  return value;
}

function exactArray(value, label) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) throw new Error(`${label} is invalid`);
  const expectedKeys = [...value.keys()].map(String).concat("length").sort();
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || JSON.stringify(Object.getOwnPropertyNames(value).sort()) !== JSON.stringify(expectedKeys)
    || Object.getOwnPropertyNames(value).some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !("value" in descriptor);
    })
  ) throw new Error(`${label} is invalid`);
  return value;
}

function exactString(value, label, maximum = 512) {
  if (typeof value !== "string" || value === "" || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactFiniteNumber(value, label, { positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (positive && value <= 0)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactSha256(value, label, { prefixed = false } = {}) {
  const pattern = prefixed ? /^sha256:[0-9a-f]{64}$/u : /^[0-9a-f]{64}$/u;
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function runtimeRelativeDependencies(source) {
  const dependencies = new Set();
  const patterns = [
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/gu,
    /new\s+URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) dependencies.add(match[1]);
  }
  return [...dependencies].sort();
}

function exactRuntimePath(relativePath) {
  if (
    typeof relativePath !== "string" || !relativePath.startsWith("dist/")
    || relativePath.includes("\0") || relativePath.split(/[\\/]/u).includes("..")
  ) throw new Error("materialization runtime artifact path is invalid");
  const path = resolve(PACKAGE_ROOT, ...relativePath.split("/"));
  const fromRoot = path.slice(PACKAGE_ROOT.length + 1);
  if (fromRoot !== relativePath) throw new Error("materialization runtime artifact path is invalid");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("materialization runtime artifact file is invalid");
  }
  return path;
}

function captureMaterializationRuntimeArtifact() {
  const pending = [...RUNTIME_ROOTS];
  const visited = new Set();
  const files = [];
  while (pending.length > 0) {
    const relativePath = pending.shift();
    if (visited.has(relativePath)) continue;
    visited.add(relativePath);
    const path = exactRuntimePath(relativePath);
    const bytes = readFileSync(path);
    files.push(Object.freeze({
      path: relativePath,
      bytes: bytes.length,
      sha256: sha256Identity(bytes)
    }));
    const directory = relativePath.slice(0, relativePath.lastIndexOf("/")+1);
    for (const specifier of runtimeRelativeDependencies(bytes.toString("utf8"))) {
      const dependencyPath = resolve(PACKAGE_ROOT, directory, specifier);
      const dependency = dependencyPath.slice(PACKAGE_ROOT.length + 1).replaceAll("\\", "/");
      if (!visited.has(dependency)) pending.push(dependency);
    }
    pending.sort();
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const identityInput = Object.freeze({
    schema: "attunegraph-runtime-artifact-identity-input@1",
    roots: RUNTIME_ROOTS,
    files
  });
  return Object.freeze({
    schema: "attunegraph-runtime-artifact@1",
    roots: RUNTIME_ROOTS,
    moduleResolution: RUNTIME_MODULE_RESOLUTION,
    files: Object.freeze(files),
    aggregateSha256: sha256Identity(Buffer.from(JSON.stringify(identityInput), "utf8"))
  });
}

function exactSourceProvenance(value) {
  const hash = /^sha256:[0-9a-f]{64}$/u;
  const objectId = /^[0-9a-f]{40,64}$/u;
  exactRecord(value, ["packageRoot", "repository"], "materialization source provenance");
  if (
    typeof value.packageRoot !== "string"
    || resolve(value.packageRoot) !== value.packageRoot
  ) {
    throw new Error("materialization source provenance is invalid");
  }
  const repository = exactRecord(value.repository, [
    "clean", "commit", "lockfileSha256", "tree", "sourceIdentity", "sourceState"
  ], "materialization source provenance repository");
  const state = repository?.sourceState;
  exactRecord(state, [
    "schema", "claim", "included", "excluded", "staged", "unstaged", "untracked",
    "aggregateSha256"
  ], "materialization source provenance state");
  exactRecord(state.staged, ["files", "patchSha256"], "materialization staged provenance");
  exactRecord(state.unstaged, ["files", "patchSha256"], "materialization unstaged provenance");
  exactRecord(state.untracked, ["files", "manifestSha256"], "materialization untracked provenance");
  const stages = [state?.staged, state?.unstaged];
  const exactPaths = (paths) => exactArray(paths, "materialization provenance paths")
    && paths.every((path) =>
      typeof path === "string" && path !== "" && path.length <= 4_096 && !path.startsWith("/")
      && !/^[A-Za-z]:[\\/]/u.test(path) && !path.split(/[\\/]/u).includes("..")
      && !path.includes("\0")
    )
    && JSON.stringify(paths) === JSON.stringify([...new Set(paths)].sort());
  const untrackedFiles = exactArray(state.untracked.files, "materialization untracked files");
  const exactUntracked = untrackedFiles.every((entry) =>
      exactRecord(entry, ["path", "kind", "mode", "sha256"], "materialization untracked entry")
      && entry.kind === "file"
      && Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777
      && hash.test(entry.sha256)
    ) && exactPaths(untrackedFiles.map((entry) => entry.path));
  if (
    (repository?.clean !== true && repository?.clean !== false)
    || !objectId.test(repository?.commit ?? "")
    || !objectId.test(repository?.tree ?? "")
    || !hash.test(repository?.lockfileSha256 ?? "")
    || !hash.test(repository?.sourceIdentity ?? "")
    || state?.schema !== "attunegraph-source-state@1"
    || JSON.stringify(exactArray(state.included, "materialization provenance inclusions")) !== JSON.stringify([
      "tracked staged patch against HEAD",
      "tracked unstaged patch against the index",
      "untracked files not matched by Git ignore rules"
    ])
    || JSON.stringify(exactArray(state.excluded, "materialization provenance exclusions")) !== JSON.stringify([
      "untracked files matched by Git ignore rules, including generated build and runtime outputs"
    ])
    || stages.some((stage) => !exactPaths(stage?.files) || !hash.test(stage?.patchSha256 ?? ""))
    || !exactUntracked || !hash.test(state.untracked.manifestSha256 ?? "")
    || !hash.test(state.aggregateSha256 ?? "")
  ) throw new Error("materialization source provenance is invalid");
  const expectedUntrackedManifest = sha256Identity(
    Buffer.from(JSON.stringify(state.untracked.files), "utf8")
  );
  const expectedAggregate = sha256Identity(Buffer.from(JSON.stringify({
    schema: "attunegraph-source-state-identity-input@1",
    stagedPatchSha256: state.staged.patchSha256,
    unstagedPatchSha256: state.unstaged.patchSha256,
    untrackedManifestSha256: state.untracked.manifestSha256
  }), "utf8"));
  const expectedSourceIdentity = sha256Identity(Buffer.from(JSON.stringify({
    schema: "attunegraph-source-checkout-identity-input@1",
    commit: repository.commit,
    tree: repository.tree,
    lockfileSha256: repository.lockfileSha256,
    sourceStateAggregateSha256: expectedAggregate
  }), "utf8"));
  const cleanFiles = state.staged.files.length === 0
    && state.unstaged.files.length === 0
    && state.untracked.files.length === 0;
  if (
    state.untracked.manifestSha256 !== expectedUntrackedManifest
    || state.aggregateSha256 !== expectedAggregate
    || repository.sourceIdentity !== expectedSourceIdentity
    || repository.clean !== cleanFiles
    || state.claim !== (repository.clean
      ? "exact-clean-commit-tree-lockfile"
      : "exact-content-addressed-dirty-source-state")
  ) throw new Error("materialization source provenance identity is invalid");
  return value;
}

function exactRuntimeArtifact(value) {
  exactRecord(value, [
    "schema", "roots", "moduleResolution", "files", "aggregateSha256"
  ], "materialization runtime artifact");
  if (
    value.schema !== "attunegraph-runtime-artifact@1"
    || JSON.stringify(exactArray(value.roots, "materialization runtime roots")) !== JSON.stringify(RUNTIME_ROOTS)
    || value.moduleResolution !== RUNTIME_MODULE_RESOLUTION
  ) throw new Error("materialization runtime artifact is invalid");
  const files = exactArray(value.files, "materialization runtime files");
  if (files.length < RUNTIME_ROOTS.length || files.length > 128) {
    throw new Error("materialization runtime artifact is invalid");
  }
  let previous = "";
  for (const entry of files) {
    exactRecord(entry, ["path", "bytes", "sha256"], "materialization runtime file");
    if (
      typeof entry.path !== "string" || !entry.path.startsWith("dist/")
      || entry.path <= previous || entry.path.split(/[\\/]/u).includes("..")
      || exactInteger(entry.bytes, "materialization runtime file bytes", { minimum: 1 }) !== entry.bytes
    ) throw new Error("materialization runtime artifact is invalid");
    exactSha256(entry.sha256, "materialization runtime file SHA-256", { prefixed: true });
    previous = entry.path;
  }
  for (const root of RUNTIME_ROOTS) {
    if (!files.some((entry) => entry.path === root)) throw new Error("materialization runtime artifact is invalid");
  }
  const expected = sha256Identity(Buffer.from(JSON.stringify({
    schema: "attunegraph-runtime-artifact-identity-input@1",
    roots: RUNTIME_ROOTS,
    files
  }), "utf8"));
  if (value.aggregateSha256 !== expected) throw new Error("materialization runtime artifact identity is invalid");
  return value;
}

function captureMaterializationIdentity() {
  return Object.freeze({
    provenance: exactSourceProvenance(captureContentAddressedSourceCheckoutProvenance()),
    runtimeArtifact: exactRuntimeArtifact(captureMaterializationRuntimeArtifact())
  });
}

function captureMaterializationRuntime(runtimeArtifact) {
  return Object.freeze({
    node: process.version,
    sqlite: process.versions.sqlite ?? "unknown",
    arch: arch(),
    platform: platform(),
    hostname: hostname(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    hostTotalMemoryBytes: totalmem(),
    runtimeArtifact
  });
}

function exactMaterializationRuntime(value, label = "materialization profile runtime") {
  const runtime = exactRecord(value, [
    "node", "sqlite", "arch", "platform", "hostname", "cpuModel", "hostTotalMemoryBytes",
    "runtimeArtifact"
  ], label);
  for (const key of ["node", "sqlite", "arch", "platform", "hostname", "cpuModel"]) {
    exactString(runtime[key], `${label} ${key}`, 512);
  }
  exactInteger(runtime.hostTotalMemoryBytes, `${label} host memory`, { minimum: 1 });
  exactRuntimeArtifact(runtime.runtimeArtifact);
  return runtime;
}

function officialMaterializationAdmission(scale, identity) {
  const semanticAggregateSha256 = OFFICIAL_SEMANTIC_AGGREGATES.get(scale);
  if (semanticAggregateSha256 === undefined) {
    throw new Error("materialization admission requires an official workload scale");
  }
  return Object.freeze({
    scale,
    runtime: captureMaterializationRuntime(identity.runtimeArtifact),
    semanticAggregateSha256
  });
}

function requireIdenticalMaterializationIdentity(start, end, label) {
  if (
    JSON.stringify(start.provenance) !== JSON.stringify(end.provenance)
    || JSON.stringify(start.runtimeArtifact) !== JSON.stringify(end.runtimeArtifact)
  ) throw new Error(`${label} source or runtime identity changed during materialization`);
}

function exactNumber(value) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new Error("SQLite measurement integer is invalid");
  }
  return number;
}

function fileBytes(path) {
  return existsSync(path) ? lstatSync(path).size : 0;
}

function storageSnapshot(databasePath) {
  const databaseBytes = fileBytes(databasePath);
  const walBytes = fileBytes(`${databasePath}-wal`);
  const shmBytes = fileBytes(`${databasePath}-shm`);
  return Object.freeze({
    databaseBytes,
    walBytes,
    shmBytes,
    totalLogicalBytes: databaseBytes + walBytes + shmBytes
  });
}

function maxRssBytes() {
  return process.resourceUsage().maxRSS * 1024;
}

function scopeAt(index) {
  return Object.freeze({
    sourceId: "materialization-source",
    threadId: `materialization-thread-${index.toString().padStart(6, "0")}`
  });
}

function assertionAt(scope, globalIndex) {
  const suffix = globalIndex.toString().padStart(8, "0");
  return Object.freeze({
    schemaVersion: 1,
    id: `assertion-${suffix}`,
    subject: Object.freeze({ id: `artifact-${suffix}`, kind: "artifact" }),
    predicate: "LINKED_TO",
    object: Object.freeze({ id: scope.threadId, kind: "thread" }),
    epistemicClass: "source-observed",
    sourceRefs: Object.freeze([Object.freeze({
      id: `source-${suffix}`,
      namespace: "benchmark.attunegraph"
    })]),
    recordedAt: OBSERVED_AT,
    derivation: Object.freeze({ kind: "projection", version: "materialization@1" })
  });
}

function corpusShard(scale, scopeIndex) {
  const start = scopeIndex * ASSERTIONS_PER_SCOPE;
  const count = Math.min(ASSERTIONS_PER_SCOPE, scale - start);
  const scope = scopeAt(scopeIndex);
  const assertions = Object.freeze(Array.from(
    { length: count },
    (_, offset) => assertionAt(scope, start + offset)
  ));
  return Object.freeze({
    scope,
    command: Object.freeze({
      operator: "canonical-projection@2",
      observation: Object.freeze({
        schemaVersion: 2,
        observationKey: `${CORPUS_SEED}:${scopeIndex.toString().padStart(6, "0")}`,
        scope,
        threadRoot: Object.freeze({ id: scope.threadId, kind: "thread" }),
        observedAt: OBSERVED_AT,
        sourceFreshness: Object.freeze({ state: "fresh", observedAt: OBSERVED_AT }),
        assertions
      })
    })
  });
}

function createV2Database(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createJournal};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createGenerationIndex};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createHead};
    PRAGMA application_id = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.applicationId};
    PRAGMA user_version = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.userVersion};
  `);
  database.close();
  chmodSync(databasePath, 0o600);
}

function createV3Database(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createJournal};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createGenerationIndex};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createHead};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentManifest};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentAssertion};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentAssertionSubjectLookup};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentAssertionObjectLookup};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentSourceRef};
    PRAGMA application_id = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.applicationId};
    PRAGMA user_version = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.userVersion};
  `);
  database.close();
  chmodSync(databasePath, 0o600);
}

function inspectDatabase(databasePath, profile) {
  const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  try {
    const integer = (sql) => {
      const row = database.prepare(sql).get();
      return exactNumber(row.value ?? Object.values(row)[0]);
    };
    const journalRows = integer("SELECT COUNT(*) AS value FROM attunegraph_projection_journal");
    const headRows = integer("SELECT COUNT(*) AS value FROM attunegraph_projection_head");
    const projectionUncompressedBytes = integer(
      "SELECT COALESCE(SUM(projection_uncompressed_bytes), 0) AS value FROM attunegraph_projection_journal"
    );
    const projectionCompressedBytes = integer(
      "SELECT COALESCE(SUM(length(projection_payload)), 0) AS value FROM attunegraph_projection_journal"
    );
    const derived = profile === "v3" ? Object.freeze({
      manifestRows: integer("SELECT COUNT(*) AS value FROM attunegraph_current_manifest"),
      assertionRows: integer("SELECT COUNT(*) AS value FROM attunegraph_current_assertion"),
      sourceRefRows: integer("SELECT COUNT(*) AS value FROM attunegraph_current_source_ref"),
      adjacencyLookupIndexes: 2
    }) : Object.freeze({
      manifestRows: 0,
      assertionRows: 0,
      sourceRefRows: 0,
      adjacencyLookupIndexes: 0
    });
    return Object.freeze({
      userVersion: integer("PRAGMA user_version"),
      pageCount: integer("PRAGMA page_count"),
      pageSizeBytes: integer("PRAGMA page_size"),
      freelistPages: integer("PRAGMA freelist_count"),
      journalRows,
      headRows,
      projectionUncompressedBytes,
      projectionCompressedBytes,
      ...derived,
      finalPhysicalRows: journalRows + headRows + derived.manifestRows
        + derived.assertionRows + derived.sourceRefRows
    });
  } finally {
    database.close();
  }
}

function exactStorageSnapshot(value, label) {
  exactRecord(value, ["databaseBytes", "walBytes", "shmBytes", "totalLogicalBytes"], label);
  const databaseBytes = exactInteger(value.databaseBytes, `${label} database bytes`, { minimum: 1 });
  const walBytes = exactInteger(value.walBytes, `${label} WAL bytes`);
  const shmBytes = exactInteger(value.shmBytes, `${label} SHM bytes`);
  exactInteger(value.totalLogicalBytes, `${label} total logical bytes`, { minimum: 1 });
  if (value.totalLogicalBytes !== databaseBytes + walBytes + shmBytes) {
    throw new Error(`${label} identity is invalid`);
  }
  return value;
}

function exactProfileDatabase(value, profile, scale, scopeCount) {
  exactRecord(value, [
    "userVersion", "pageCount", "pageSizeBytes", "freelistPages", "journalRows", "headRows",
    "projectionUncompressedBytes", "projectionCompressedBytes", "manifestRows", "assertionRows",
    "sourceRefRows", "adjacencyLookupIndexes", "finalPhysicalRows"
  ], "materialization profile database");
  for (const key of Object.keys(value)) {
    exactInteger(value[key], `materialization profile database ${key}`);
  }
  const expectedDerived = profile === "v3"
    ? { manifestRows: scopeCount, assertionRows: scale, sourceRefRows: scale, adjacencyLookupIndexes: 2 }
    : { manifestRows: 0, assertionRows: 0, sourceRefRows: 0, adjacencyLookupIndexes: 0 };
  if (
    value.userVersion !== (profile === "v3" ? 3 : 2)
    || value.pageCount < 1 || value.pageSizeBytes < 512 || value.freelistPages > value.pageCount
    || value.journalRows !== scopeCount || value.headRows !== scopeCount
    || value.projectionUncompressedBytes < 1 || value.projectionCompressedBytes < 1
    || Object.entries(expectedDerived).some(([key, expected]) => value[key] !== expected)
    || value.finalPhysicalRows !== value.journalRows + value.headRows + value.manifestRows
      + value.assertionRows + value.sourceRefRows
  ) throw new Error("materialization profile database invariants are invalid");
  return value;
}

function exactMaterializationProfile(value, expectedProfile) {
  exactRecord(value, [
    "schema", "measurementOnly", "claimEligible", "profile", "scale", "provenance", "corpus",
    "runtime", "correctness", "materialization", "storage", "resources", "exclusions"
  ], "materialization profile report");
  if (
    value.schema !== "attunegraph-current-head-materialization-profile@2"
    || value.measurementOnly !== true || value.claimEligible !== false
    || value.profile !== expectedProfile
  ) throw new Error("materialization profile report identity is invalid");
  const scale = exactInteger(value.scale, "materialization profile scale", {
    minimum: 1,
    maximum: Math.max(...OFFICIAL_SCALES)
  });
  const scopeCount = Math.ceil(scale / ASSERTIONS_PER_SCOPE);
  exactSourceProvenance(value.provenance);

  const corpus = exactRecord(value.corpus, [
    "seed", "sha256", "assertionsPerScopeMaximum", "scopeCount"
  ], "materialization profile corpus");
  if (
    corpus.seed !== CORPUS_SEED || corpus.assertionsPerScopeMaximum !== ASSERTIONS_PER_SCOPE
    || corpus.scopeCount !== scopeCount
  ) throw new Error("materialization profile corpus invariants are invalid");
  exactSha256(corpus.sha256, "materialization profile corpus SHA-256");
  const expectedCorpusHash = createHash("sha256").update(CORPUS_SEED).update("\0");
  for (let scopeIndex = 0; scopeIndex < scopeCount; scopeIndex += 1) {
    expectedCorpusHash.update(JSON.stringify(corpusShard(scale, scopeIndex)));
  }
  if (corpus.sha256 !== expectedCorpusHash.digest("hex")) {
    throw new Error("materialization profile corpus identity is invalid");
  }

  exactMaterializationRuntime(value.runtime);

  const correctness = exactRecord(value.correctness, [
    "semanticAggregateSha256", "exactCurrentProjectionReadAfterEveryCas", "expectedAssertions",
    "observedAssertionRows"
  ], "materialization profile correctness");
  exactSha256(correctness.semanticAggregateSha256, "materialization semantic aggregate SHA-256");
  if (
    correctness.exactCurrentProjectionReadAfterEveryCas !== true
    || correctness.expectedAssertions !== scale || correctness.observedAssertionRows !== scale
  ) throw new Error("materialization profile correctness invariants are invalid");

  const materialization = exactRecord(value.materialization, [
    "writeDurationMs", "reopenValidationDurationMs", "adminFullIntegrityDurationMs", "committedScopes",
    "committedAssertions", "finalPhysicalRows", "finalPhysicalRowsPerAssertion",
    "projectionUncompressedBytes", "projectionCompressedBytes"
  ], "materialization profile measurements");
  for (const key of ["writeDurationMs", "reopenValidationDurationMs", "adminFullIntegrityDurationMs"]) {
    exactFiniteNumber(materialization[key], `materialization profile ${key}`, { positive: true });
  }
  for (const key of [
    "committedScopes", "committedAssertions", "finalPhysicalRows", "projectionUncompressedBytes",
    "projectionCompressedBytes"
  ]) exactInteger(materialization[key], `materialization profile ${key}`, { minimum: 1 });
  exactFiniteNumber(
    materialization.finalPhysicalRowsPerAssertion,
    "materialization profile final rows per assertion",
    { positive: true }
  );

  const storage = exactRecord(value.storage, [
    "database", "openStorageSnapshot", "settledStorageSnapshot",
    "productionWalSnapshotIsCumulativeWriteEvidence", "cumulativeWalWriteAmplification",
    "settledLogicalBytesPerProjectionByte"
  ], "materialization profile storage");
  const database = exactProfileDatabase(storage.database, expectedProfile, scale, scopeCount);
  exactStorageSnapshot(storage.openStorageSnapshot, "materialization open storage snapshot");
  exactStorageSnapshot(storage.settledStorageSnapshot, "materialization settled storage snapshot");
  exactFiniteNumber(
    storage.settledLogicalBytesPerProjectionByte,
    "materialization settled bytes per projection byte",
    { positive: true }
  );
  if (
    materialization.committedScopes !== scopeCount || materialization.committedAssertions !== scale
    || materialization.finalPhysicalRows !== database.finalPhysicalRows
    || materialization.finalPhysicalRowsPerAssertion !== database.finalPhysicalRows / scale
    || materialization.projectionUncompressedBytes !== database.projectionUncompressedBytes
    || materialization.projectionCompressedBytes !== database.projectionCompressedBytes
    || storage.settledStorageSnapshot.databaseBytes !== database.pageCount * database.pageSizeBytes
    || storage.settledStorageSnapshot.totalLogicalBytes < database.projectionCompressedBytes
    || storage.productionWalSnapshotIsCumulativeWriteEvidence !== false
    || storage.cumulativeWalWriteAmplification
      !== "not-measured-without-wal-autocheckpoint-zero-controlled-cell"
    || storage.settledLogicalBytesPerProjectionByte
      !== storage.settledStorageSnapshot.totalLogicalBytes / database.projectionUncompressedBytes
  ) throw new Error("materialization profile measurement invariants are invalid");

  const resources = exactRecord(value.resources, [
    "processMaxRssBytes", "checkpointMaxRssBytes", "checkpointMaxHeapUsedBytes",
    "workerCheckpointMaxUsedHeapSizeBytes", "processMaxRssMethod", "heapMethod"
  ], "materialization profile resources");
  for (const key of [
    "processMaxRssBytes", "checkpointMaxRssBytes", "checkpointMaxHeapUsedBytes",
    "workerCheckpointMaxUsedHeapSizeBytes"
  ]) exactInteger(resources[key], `materialization profile resource ${key}`, { minimum: 1 });
  if (
    resources.processMaxRssMethod !== "process.resourceUsage.maxRSS"
    || resources.processMaxRssBytes < resources.checkpointMaxRssBytes
    || resources.checkpointMaxHeapUsedBytes > resources.checkpointMaxRssBytes
    || resources.heapMethod
      !== "phase-checkpoint process.memoryUsage.heapUsed and worker v8 used_heap_size"
  ) throw new Error("materialization profile resource methods are invalid");

  if (JSON.stringify(exactArray(value.exclusions, "materialization profile exclusions")) !== JSON.stringify([
    "no-query-or-engine-fast-path",
    "no-query-latency-or-throughput-claim",
    "no-cumulative-wal-write-amplification-claim",
    "no-inherited-performance-threshold"
  ])) throw new Error("materialization profile exclusions are invalid");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_REPORT_BYTES) {
    throw new Error("materialization profile report exceeded its byte bound");
  }
  return value;
}

export async function runCurrentHeadMaterializationProfile({ profile, scale, databasePath }) {
  if (
    (profile !== "v2" && profile !== "v3") || !Number.isSafeInteger(scale)
    || scale < 1 || scale > Math.max(...OFFICIAL_SCALES)
  ) {
    throw new Error("materialization profile options are invalid");
  }
  const identity = captureMaterializationIdentity();
  if (profile === "v2") createV2Database(databasePath);
  else createV3Database(databasePath);
  const shardCount = Math.ceil(scale / ASSERTIONS_PER_SCOPE);
  const corpusHash = createHash("sha256").update(CORPUS_SEED).update("\0");
  const semanticHash = createHash("sha256").update("attunegraph.materialization-semantics.v1").update("\0");
  let checkpointMaxHeapUsedBytes = process.memoryUsage().heapUsed;
  let checkpointMaxRssBytes = process.memoryUsage().rss;
  let workerCheckpointMaxUsedHeapSizeBytes = 0;
  let writeDurationMs = 0;
  const resource = await openSqliteAttuneGraphStore({ databasePath });
  try {
    for (let scopeIndex = 0; scopeIndex < shardCount; scopeIndex += 1) {
      const shard = corpusShard(scale, scopeIndex);
      corpusHash.update(JSON.stringify(shard));
      const graph = await openAttuneGraph({
        scope: shard.scope,
        store: createAttuneGraphStore(resource.backend)
      });
      const started = performance.now();
      const snapshot = await graph.project(JSON.parse(JSON.stringify(shard.command)));
      writeDurationMs += performance.now() - started;
      await graph.close();
      const stored = await resource.backend.read(shard.scope);
      if (stored === undefined || stored.snapshot.commitId !== snapshot.commitId) {
        throw new Error("materialization profile lost its exact committed projection");
      }
      semanticHash.update(JSON.stringify({
        scope: stored.snapshot.scope,
        generation: stored.snapshot.generation,
        commitId: stored.snapshot.commitId,
        projectionFingerprint: stored.projectionFingerprint,
        canonicalAssertionBytes: stored.assertions.map((assertion) =>
          Buffer.from(JSON.stringify(assertion), "utf8").toString("base64")
        )
      }));
      if ((scopeIndex + 1) % 16 === 0 || scopeIndex + 1 === shardCount) {
        const memory = process.memoryUsage();
        checkpointMaxHeapUsedBytes = Math.max(checkpointMaxHeapUsedBytes, memory.heapUsed);
        checkpointMaxRssBytes = Math.max(checkpointMaxRssBytes, memory.rss);
        const worker = await resource.inspectWorkerHeapStatisticsForMeasurement();
        workerCheckpointMaxUsedHeapSizeBytes = Math.max(
          workerCheckpointMaxUsedHeapSizeBytes,
          worker.usedHeapSizeBytes
        );
      }
    }
    const openStorageSnapshot = storageSnapshot(databasePath);
    await resource.close();
    const reopenStarted = performance.now();
    const reopened = await openSqliteAttuneGraphStore({ databasePath });
    const reopenValidationDurationMs = performance.now() - reopenStarted;
    await reopened.close();
    const adminDatabase = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
    const inspector = createAttuneGraphAdminReadOnlyInspector(adminDatabase);
    const adminValidationStarted = performance.now();
    inspector.verifyIntegrity();
    const adminFullIntegrityDurationMs = performance.now() - adminValidationStarted;
    adminDatabase.close();
    const settledStorageSnapshot = storageSnapshot(databasePath);
    const database = inspectDatabase(databasePath, profile);
    requireIdenticalMaterializationIdentity(
      identity,
      captureMaterializationIdentity(),
      `${profile} child`
    );
    const report = Object.freeze({
      schema: "attunegraph-current-head-materialization-profile@2",
      measurementOnly: true,
      claimEligible: false,
      profile,
      scale,
      provenance: identity.provenance,
      corpus: Object.freeze({
        seed: CORPUS_SEED,
        sha256: corpusHash.digest("hex"),
        assertionsPerScopeMaximum: ASSERTIONS_PER_SCOPE,
        scopeCount: shardCount
      }),
      runtime: captureMaterializationRuntime(identity.runtimeArtifact),
      correctness: Object.freeze({
        semanticAggregateSha256: semanticHash.digest("hex"),
        exactCurrentProjectionReadAfterEveryCas: true,
        expectedAssertions: scale,
        observedAssertionRows: profile === "v3" ? database.assertionRows : scale
      }),
      materialization: Object.freeze({
        writeDurationMs,
        reopenValidationDurationMs,
        adminFullIntegrityDurationMs,
        committedScopes: shardCount,
        committedAssertions: scale,
        finalPhysicalRows: database.finalPhysicalRows,
        finalPhysicalRowsPerAssertion: database.finalPhysicalRows / scale,
        projectionUncompressedBytes: database.projectionUncompressedBytes,
        projectionCompressedBytes: database.projectionCompressedBytes
      }),
      storage: Object.freeze({
        database,
        openStorageSnapshot,
        settledStorageSnapshot,
        productionWalSnapshotIsCumulativeWriteEvidence: false,
        cumulativeWalWriteAmplification: "not-measured-without-wal-autocheckpoint-zero-controlled-cell",
        settledLogicalBytesPerProjectionByte:
          settledStorageSnapshot.totalLogicalBytes / database.projectionUncompressedBytes
      }),
      resources: Object.freeze({
        processMaxRssBytes: maxRssBytes(),
        checkpointMaxRssBytes,
        checkpointMaxHeapUsedBytes,
        workerCheckpointMaxUsedHeapSizeBytes,
        processMaxRssMethod: "process.resourceUsage.maxRSS",
        heapMethod: "phase-checkpoint process.memoryUsage.heapUsed and worker v8 used_heap_size"
      }),
      exclusions: Object.freeze([
        "no-query-or-engine-fast-path",
        "no-query-latency-or-throughput-claim",
        "no-cumulative-wal-write-amplification-claim",
        "no-inherited-performance-threshold"
      ])
    });
    exactMaterializationProfile(report, profile);
    if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BYTES) {
      throw new Error("materialization profile report exceeded its byte bound");
    }
    return report;
  } catch (cause) {
    await resource.dispose().catch(() => undefined);
    throw cause;
  }
}

function parseArguments(argv) {
  const values = Object.create(null);
  for (const argument of argv) {
    if (argument === "--") continue;
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || values[match[1]] !== undefined) throw new Error("materialization benchmark arguments are invalid");
    values[match[1]] = match[2];
  }
  return values;
}

export function pairCurrentHeadMaterializationProfiles(v2, v3, admission) {
  exactMaterializationProfile(v2, "v2");
  exactMaterializationProfile(v3, "v3");
  exactRecord(admission, ["scale", "runtime", "semanticAggregateSha256"], "materialization admission");
  const expectedScale = exactInteger(admission.scale, "materialization admission scale", {
    minimum: 1,
    maximum: Math.max(...OFFICIAL_SCALES)
  });
  const expectedRuntime = exactMaterializationRuntime(
    admission.runtime,
    "materialization admission runtime"
  );
  const expectedSemanticAggregate = exactSha256(
    admission.semanticAggregateSha256,
    "materialization admission semantic aggregate SHA-256"
  );
  const currentIdentity = captureMaterializationIdentity();
  const v2Provenance = v2.provenance;
  const v3Provenance = v3.provenance;
  if (JSON.stringify(v2Provenance) !== JSON.stringify(v3Provenance)) {
    throw new Error("v2/v3 materialization source provenance diverged");
  }
  if (JSON.stringify(v3Provenance) !== JSON.stringify(currentIdentity.provenance)) {
    throw new Error("paired materialization source provenance is not current");
  }
  if (v2.scale !== expectedScale || v3.scale !== expectedScale) {
    throw new Error("paired materialization scale is not the requested scale");
  }
  if (JSON.stringify(v2.corpus) !== JSON.stringify(v3.corpus)) {
    throw new Error("v2/v3 materialization corpus identity diverged");
  }
  if (
    JSON.stringify(v2.runtime) !== JSON.stringify(expectedRuntime)
    || JSON.stringify(v3.runtime) !== JSON.stringify(expectedRuntime)
  ) {
    throw new Error("paired materialization runtime is not the parent runtime");
  }
  if (JSON.stringify(v3.runtime.runtimeArtifact) !== JSON.stringify(currentIdentity.runtimeArtifact)) {
    throw new Error("paired materialization runtime artifact is not current");
  }
  if (
    v2.correctness.semanticAggregateSha256 !== expectedSemanticAggregate
    || v3.correctness.semanticAggregateSha256 !== expectedSemanticAggregate
  ) {
    throw new Error("paired materialization semantics do not match the workload anchor");
  }
  const body = Object.freeze({
    schema: "attunegraph-current-head-materialization-paired@2",
    measurementOnly: true,
    claimEligible: false,
    provenance: v3Provenance,
    corpus: v3.corpus,
    runtime: v3.runtime,
    correctness: Object.freeze({
      semanticAggregateSha256: v3.correctness.semanticAggregateSha256,
      v2V3SemanticByteIdentity: true
    }),
    profiles: Object.freeze({ v2, v3 }),
    amplification: Object.freeze({
      materializationWriteDurationRatioV3OverV2:
        v3.materialization.writeDurationMs / v2.materialization.writeDurationMs,
      settledDatabaseBytesRatioV3OverV2:
        v3.storage.settledStorageSnapshot.databaseBytes / v2.storage.settledStorageSnapshot.databaseBytes,
      settledPageCountRatioV3OverV2:
        v3.storage.database.pageCount / v2.storage.database.pageCount,
      finalPhysicalRowsRatioV3OverV2:
        v3.materialization.finalPhysicalRows / v2.materialization.finalPhysicalRows,
      reopenValidationDurationRatioV3OverV2:
        v3.materialization.reopenValidationDurationMs / v2.materialization.reopenValidationDurationMs,
      adminFullIntegrityDurationRatioV3OverV2:
        v3.materialization.adminFullIntegrityDurationMs / v2.materialization.adminFullIntegrityDurationMs
    }),
    qualification: Object.freeze({
      threshold: null,
      status: "measurement-only-no-threshold",
      queryLatencyMeasured: false,
      cumulativeWalWriteAmplificationMeasured: false
    })
  });
  const report = Object.freeze({
    ...body,
    artifactIdentity: Object.freeze({
      schema: "attunegraph-json-report-content@1",
      canonicalization: "UTF-8 JSON.stringify(report without artifactIdentity)",
      sha256: sha256Identity(Buffer.from(JSON.stringify(body), "utf8"))
    })
  });
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_REPORT_BYTES) {
    throw new Error("paired materialization report exceeded its byte bound");
  }
  return report;
}

async function runChild(values) {
  const profile = values.profile;
  const scale = Number(values.scale);
  const databasePath = values.database;
  if ((profile !== "v2" && profile !== "v3") || !databasePath || !Number.isSafeInteger(scale)) {
    throw new Error("materialization child arguments are invalid");
  }
  const report = await runCurrentHeadMaterializationProfile({ profile, scale, databasePath });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

export function runCurrentHeadMaterializationBenchmark(argv = process.argv.slice(2)) {
  const values = parseArguments(argv);
  const scale = values.scale === undefined ? 10_000 : Number(values.scale);
  if (!OFFICIAL_SCALES.has(scale) || values.child !== undefined || values.profile !== undefined || values.database !== undefined) {
    throw new Error("scale must be one of 10000, 100000, or 1000000");
  }
  const parentIdentity = captureMaterializationIdentity();
  const admission = officialMaterializationAdmission(scale, parentIdentity);
  const created = mkdtempSync(join(tmpdir(), "attunegraph-current-head-materialization-"));
  const directory = realpathSync(created);
  try {
    const profiles = {};
    for (const profile of ["v2", "v3"]) {
      const child = spawnSync(process.execPath, [
        fileURLToPath(import.meta.url),
        "--child=true",
        `--profile=${profile}`,
        `--scale=${scale.toString()}`,
        `--database=${join(directory, `${profile}.sqlite`)}`
      ], { encoding: "utf8", maxBuffer: MAX_REPORT_BYTES * 2 });
      if (child.status !== 0) throw new Error(child.stderr.trim() || `${profile} materialization child failed`);
      profiles[profile] = JSON.parse(child.stdout);
      exactMaterializationProfile(profiles[profile], profile);
      requireIdenticalMaterializationIdentity(
        parentIdentity,
        captureMaterializationIdentity(),
        `parent before/after ${profile} child`
      );
    }
    const paired = pairCurrentHeadMaterializationProfiles(profiles.v2, profiles.v3, admission);
    requireIdenticalMaterializationIdentity(
      parentIdentity,
      captureMaterializationIdentity(),
      "parent before/after materialization children"
    );
    process.stdout.write(`${JSON.stringify(paired, null, 2)}\n`);
    return paired;
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  const values = parseArguments(process.argv.slice(2));
  if (values.child === "true") {
    await runChild(values).catch((cause) => {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    });
  } else {
    try {
      runCurrentHeadMaterializationBenchmark(process.argv.slice(2));
    } catch (cause) {
      process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      process.exitCode = 1;
    }
  }
}
