import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION } from "./attunegraph-physical-schema-v3.mjs";
import { parseCanonicalAssertion } from "./attunegraph-local-projection.mjs";

const DIGEST_DOMAIN = "attunegraph.current-head-index.v1";
const MAX_CURRENT_SCOPES = 1_000_000;
const MAX_CURRENT_ROWS_PER_SCOPE = 1_000_000;
const MAX_DECISION_ENDPOINT_CANDIDATES = 128;
export const ATTUNEGRAPH_CURRENT_DECISION_ENDPOINT_SOURCE_REFS_FOR_MEASUREMENT = 128;
// This source .mjs is loaded directly by the Worker before TypeScript output
// exists. local.test.ts guards byte-for-byte drift from ACTIVATION_PREDICATES.
export const ATTUNEGRAPH_CURRENT_DECISION_ENDPOINT_PREDICATES_FOR_MEASUREMENT = Object.freeze([
  "SUPPORTED_BY", "DERIVED_FROM", "REVISION_OF", "SUPERSEDES", "GOVERNED_BY",
  "AUTHORIZED_BY", "PRODUCED_OUTCOME", "PROPOSES_POLICY", "SCOPED_TO",
  "NEXT_STEP_FOR", "CONTEXT_FOR", "LINKED_TO", "DELIVERED_FOR", "OBSERVED_DURING",
  "PRECEDED", "CORRELATES_WITH", "PERFORMED"
]);

/** @typedef {Readonly<{
 * assertionOrdinal: number; assertionId: string; subjectKind: string; subjectId: string;
 * objectKind: string; objectId: string; predicate: string; epistemicClass: string;
 * validFrom: string | null; validTo: string | null; recordedAt: string;
 * supersededAt: string | null; derivationKind: string; derivationVersion: string;
 * derivationRunId: string | null;
 * }>} CurrentAssertionRow */
/** @typedef {Readonly<{
 * assertionOrdinal: number; sourceRefOrdinal: number; sourceNamespace: string;
 * sourceIdValue: string; sourceVersion: string | null;
 * }>} CurrentSourceRefRow */
/** @typedef {{ prepare(sql: string): { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown } }} CurrentIndexDatabase */

/** @param {import("./types.js").GraphAssertion} assertion @param {number} assertionOrdinal @returns {CurrentAssertionRow} */
function materializeAssertion(assertion, assertionOrdinal) {
  return Object.freeze({
    assertionOrdinal,
    assertionId: assertion.id,
    subjectKind: assertion.subject.kind,
    subjectId: assertion.subject.id,
    objectKind: assertion.object.kind,
    objectId: assertion.object.id,
    predicate: assertion.predicate,
    epistemicClass: assertion.epistemicClass,
    validFrom: assertion.validFrom ?? null,
    validTo: assertion.validTo ?? null,
    recordedAt: assertion.recordedAt,
    supersededAt: assertion.supersededAt ?? null,
    derivationKind: assertion.derivation.kind,
    derivationVersion: assertion.derivation.version,
    derivationRunId: assertion.derivation.runId ?? null
  });
}

/** @param {Readonly<Record<string, unknown>>} manifest @param {readonly unknown[]} assertions @param {readonly unknown[]} sourceRefs */
function currentIndexDigest(manifest, assertions, sourceRefs) {
  const digestBody = Object.freeze({
    schemaVersion: 1,
    scope: Object.freeze({ sourceId: manifest.sourceId, threadId: manifest.threadId }),
    generation: manifest.generation,
    commitId: manifest.commitId,
    projectionFingerprint: manifest.projectionFingerprint,
    indexRevision: manifest.indexRevision,
    assertions,
    sourceRefs
  });
  return `sha256:${createHash("sha256")
    .update(DIGEST_DOMAIN, "utf8")
    .update(Buffer.from([0]))
    .update(JSON.stringify(digestBody), "utf8")
    .digest("hex")}`;
}

/** @param {import("./attunegraph-backend.js").AttuneGraphStoredProjection} projection */
export function materializeAttuneGraphCurrentHeadIndex(projection) {
  const { scope, generation, commitId } = projection.snapshot;
  const assertions = projection.assertions.map(materializeAssertion);
  const sourceRefs = projection.assertions.flatMap((assertion, assertionOrdinal) =>
    assertion.sourceRefs.map((sourceRef, sourceRefOrdinal) => Object.freeze({
      assertionOrdinal,
      sourceRefOrdinal,
      sourceNamespace: sourceRef.namespace,
      sourceIdValue: sourceRef.id,
      sourceVersion: sourceRef.version ?? null
    }))
  );
  const identity = Object.freeze({
    sourceId: scope.sourceId,
    threadId: scope.threadId,
    generation,
    commitId,
    projectionFingerprint: projection.projectionFingerprint,
    indexRevision: ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION
  });
  const manifest = Object.freeze({
    ...identity,
    assertionCount: assertions.length,
    sourceRefCount: sourceRefs.length,
    indexDigest: currentIndexDigest(identity, assertions, sourceRefs)
  });
  return Object.freeze({
    manifest,
    assertions: Object.freeze(assertions),
    sourceRefs: Object.freeze(sourceRefs)
  });
}

/** @param {unknown} value @param {number} [minimum] */
function exactInteger(value, minimum = 0) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < minimum) {
    throw new TypeError("current-head index integer is invalid");
  }
  return number;
}

/** @param {unknown} value */
function exactText(value) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 1_048_576) {
    throw new TypeError("current-head index text is invalid");
  }
  return value;
}

/** @param {unknown} value */
function nullableText(value) {
  return value === null ? null : exactText(value);
}

/** @param {unknown} value @param {string} label */
function rowRecord(value, label) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    if (typeof key !== "string") return true;
    const descriptor = descriptors[key];
    return descriptor === undefined || !Object.hasOwn(descriptor, "value");
  })) throw new TypeError(`${label} is invalid`);
  return Object.fromEntries(keys.map((key) => {
    if (typeof key !== "string") throw new TypeError(`${label} is invalid`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} is invalid`);
    }
    return [key, descriptor.value];
  }));
}

/**
 * Reconstructs and strictly admits one exact GraphAssertion from normalized v3
 * rows. The field order is the canonical GraphAssertion order.
 * @param {CurrentAssertionRow} row
 * @param {readonly CurrentSourceRefRow[]} sourceRefs
 */
export function reconstructAttuneGraphCurrentAssertion(row, sourceRefs) {
  return parseCanonicalAssertion({
    schemaVersion: 1,
    id: row.assertionId,
    subject: { id: row.subjectId, kind: row.subjectKind },
    predicate: row.predicate,
    object: { id: row.objectId, kind: row.objectKind },
    epistemicClass: row.epistemicClass,
    sourceRefs: sourceRefs.map((sourceRef) => ({
      id: sourceRef.sourceIdValue,
      namespace: sourceRef.sourceNamespace,
      ...(sourceRef.sourceVersion === null ? {} : { version: sourceRef.sourceVersion })
    })),
    ...(row.validFrom === null ? {} : { validFrom: row.validFrom }),
    ...(row.validTo === null ? {} : { validTo: row.validTo }),
    recordedAt: row.recordedAt,
    ...(row.supersededAt === null ? {} : { supersededAt: row.supersededAt }),
    derivation: {
      kind: row.derivationKind,
      ...(row.derivationRunId === null ? {} : { runId: row.derivationRunId }),
      version: row.derivationVersion
    }
  }, `current assertion[${row.assertionOrdinal.toString()}]`);
}

/** @param {unknown} value @param {string} label */
function canonicalInstant(value, label) {
  const text = exactText(value);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    throw new TypeError(`${label} is invalid`);
  }
  return text;
}

/** @param {unknown} value @param {string} label */
function nullableCanonicalInstant(value, label) {
  return value === null ? null : canonicalInstant(value, label);
}

/** @param {unknown} value @param {string} label @param {readonly string[]} allowed
 * @param {readonly string[]} [required] @returns {Record<string, unknown>} */
function exactInputRecord(value, label, allowed, required = allowed) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) throw new TypeError(`${label} is invalid`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} is invalid`);
  }
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
    || keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor);
    })
  ) throw new TypeError(`${label} is invalid`);
  return Object.fromEntries(keys.map((key) => {
    if (typeof key !== "string") throw new TypeError(`${label} is invalid`);
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`${label} is invalid`);
    }
    return [key, descriptor.value];
  }));
}

/** @param {unknown} value */
function currentAssertionRow(value) {
  const current = rowRecord(value, "decision endpoint assertion row");
  return Object.freeze({
    assertionOrdinal: exactInteger(current.assertionOrdinal),
    assertionId: exactText(current.assertionId),
    subjectKind: exactText(current.subjectKind),
    subjectId: exactText(current.subjectId),
    objectKind: exactText(current.objectKind),
    objectId: exactText(current.objectId),
    predicate: exactText(current.predicate),
    epistemicClass: exactText(current.epistemicClass),
    validFrom: nullableCanonicalInstant(current.validFrom, "decision endpoint validFrom"),
    validTo: nullableCanonicalInstant(current.validTo, "decision endpoint validTo"),
    recordedAt: canonicalInstant(current.recordedAt, "decision endpoint recordedAt"),
    supersededAt: nullableCanonicalInstant(
      current.supersededAt,
      "decision endpoint supersededAt"
    ),
    derivationKind: exactText(current.derivationKind),
    derivationVersion: exactText(current.derivationVersion),
    derivationRunId: nullableText(current.derivationRunId)
  });
}

/** @param {unknown} value */
function currentSourceRefRow(value) {
  const current = rowRecord(value, "decision endpoint source-ref row");
  return Object.freeze({
    assertionOrdinal: exactInteger(current.assertionOrdinal),
    sourceRefOrdinal: exactInteger(current.sourceRefOrdinal),
    sourceNamespace: exactText(current.sourceNamespace),
    sourceIdValue: exactText(current.sourceIdValue),
    sourceVersion: nullableText(current.sourceVersion)
  });
}

/**
 * Package-private measurement primitive for one decision-query frontier step.
 * It never claims to be a complete Working Graph or a completeness-proven
 * endpoint. V3 has no assertion-local source-ref count/digest, so returned
 * candidates stay explicitly built-unverified. A hub above the explicit
 * candidate bound abstains instead of returning a truncated candidate set.
 * @param {CurrentIndexDatabase} database
 * @param {Readonly<{
 *   scope: { sourceId: string; threadId: string };
 *   seed: { kind: string; id: string };
 *   asOf: string;
 *   maxCandidateAssertions?: number;
 * }>} input
 */
export function readAttuneGraphCurrentDecisionEndpointForMeasurement(database, input) {
  const options = exactInputRecord(
    input,
    "decision endpoint input",
    ["scope", "seed", "asOf", "maxCandidateAssertions"],
    ["scope", "seed", "asOf"]
  );
  const scope = exactInputRecord(
    options.scope,
    "decision endpoint scope",
    ["sourceId", "threadId"]
  );
  const seed = exactInputRecord(options.seed, "decision endpoint seed", ["kind", "id"]);
  const sourceId = exactText(scope.sourceId);
  const threadId = exactText(scope.threadId);
  const seedKind = exactText(seed.kind);
  const seedId = exactText(seed.id);
  const asOf = canonicalInstant(options.asOf, "decision endpoint asOf");
  const maximum = options.maxCandidateAssertions === undefined
    ? MAX_DECISION_ENDPOINT_CANDIDATES
    : exactInteger(options.maxCandidateAssertions, 1);
  if (maximum > MAX_DECISION_ENDPOINT_CANDIDATES) {
    throw new TypeError("decision endpoint candidate bound is invalid");
  }

  const heads = database.prepare(`
    SELECT m.index_id AS indexId, h.generation, h.commit_id AS commitId,
           j.projection_fingerprint AS projectionFingerprint,
           m.index_revision AS indexRevision, m.assertion_count AS assertionCount,
           m.source_ref_count AS sourceRefCount, m.index_digest AS indexDigest
    FROM attunegraph_projection_head AS h
    LEFT JOIN attunegraph_projection_journal AS j
      ON j.source_id = h.source_id AND j.thread_id = h.thread_id
     AND j.generation = h.generation AND j.commit_id = h.commit_id
    LEFT JOIN attunegraph_current_manifest AS m
      ON m.source_id = h.source_id AND m.thread_id = h.thread_id
     AND m.generation = h.generation AND m.commit_id = h.commit_id
     AND m.projection_fingerprint = j.projection_fingerprint
    WHERE h.source_id = ? AND h.thread_id = ? LIMIT 2
  `).all(sourceId, threadId);
  if (!Array.isArray(heads) || heads.length > 1) {
    throw new Error("decision endpoint head identity is invalid");
  }
  if (heads.length === 0) {
    const orphanManifest = database.prepare(`
      SELECT 1 AS invalid FROM attunegraph_current_manifest
      WHERE source_id = ? AND thread_id = ? LIMIT 1
    `).get(sourceId, threadId);
    if (orphanManifest !== undefined) {
      throw new Error("decision endpoint manifest exists without an exact head");
    }
    return Object.freeze({
      schema: "attunegraph-current-decision-endpoint-measurement@1",
      measurementOnly: true,
      scanStatus: "complete",
      snapshot: null,
      projectionFingerprint: null,
      scannedAssertions: 0,
      assertions: Object.freeze([])
    });
  }
  const head = rowRecord(heads[0], "decision endpoint head row");
  const indexId = exactInteger(head.indexId, 1);
  const assertionCount = exactInteger(head.assertionCount);
  const sourceRefCount = exactInteger(head.sourceRefCount);
  if (
    exactText(head.indexRevision) !== ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION
    || assertionCount > MAX_CURRENT_ROWS_PER_SCOPE
    || sourceRefCount > MAX_CURRENT_ROWS_PER_SCOPE
    || !/^sha256:[0-9a-f]{64}$/u.test(exactText(head.indexDigest))
  ) throw new Error("decision endpoint manifest identity is invalid");
  const snapshot = Object.freeze({
    schemaVersion: 1,
    scope: Object.freeze({ sourceId, threadId }),
    generation: exactInteger(head.generation, 1),
    commitId: exactText(head.commitId)
  });
  const projectionFingerprint = exactText(head.projectionFingerprint);
  const predicatePlaceholders = ATTUNEGRAPH_CURRENT_DECISION_ENDPOINT_PREDICATES_FOR_MEASUREMENT
    .map(() => "?").join(", ");
  const candidateValues = [
    BigInt(indexId), seedKind, seedId, seedKind, seedId,
    ...ATTUNEGRAPH_CURRENT_DECISION_ENDPOINT_PREDICATES_FOR_MEASUREMENT,
    asOf, asOf, asOf, asOf, BigInt(maximum + 1)
  ];
  const assertions = database.prepare(`
    SELECT assertion_ordinal AS assertionOrdinal, assertion_id AS assertionId,
           subject_kind AS subjectKind, subject_id AS subjectId,
           object_kind AS objectKind, object_id AS objectId, predicate,
           epistemic_class AS epistemicClass, valid_from AS validFrom,
           valid_to AS validTo, recorded_at AS recordedAt,
           superseded_at AS supersededAt, derivation_kind AS derivationKind,
           derivation_version AS derivationVersion, derivation_run_id AS derivationRunId
    FROM attunegraph_current_assertion
    WHERE index_id = ?
      AND ((subject_kind = ? AND subject_id = ?) OR (object_kind = ? AND object_id = ?))
      AND predicate IN (${predicatePlaceholders})
      AND recorded_at <= ?
      AND (superseded_at IS NULL OR superseded_at > ?)
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_to IS NULL OR valid_to > ?)
    ORDER BY assertion_ordinal LIMIT ?
  `).all(...candidateValues).map(currentAssertionRow);
  if (assertions.length > maximum) {
    return Object.freeze({
      schema: "attunegraph-current-decision-endpoint-measurement@1",
      measurementOnly: true,
      scanStatus: "abstained",
      abstentionReason: "candidate-scan-budget",
      snapshot,
      projectionFingerprint,
      scannedAssertions: assertions.length,
      assertions: Object.freeze([])
    });
  }
  const sourceRefs = assertions.length === 0 ? [] : database.prepare(`
    SELECT assertion_ordinal AS assertionOrdinal, source_ref_ordinal AS sourceRefOrdinal,
           source_namespace AS sourceNamespace, source_id_value AS sourceIdValue,
           source_version AS sourceVersion
    FROM attunegraph_current_source_ref
    WHERE index_id = ? AND assertion_ordinal IN (${assertions.map(() => "?").join(", ")})
    ORDER BY assertion_ordinal, source_ref_ordinal LIMIT ?
  `).all(
    BigInt(indexId),
    ...assertions.map((assertion) => BigInt(assertion.assertionOrdinal)),
    BigInt(maximum * ATTUNEGRAPH_CURRENT_DECISION_ENDPOINT_SOURCE_REFS_FOR_MEASUREMENT + 1)
  )
    .map(currentSourceRefRow);
  if (
    sourceRefs.length
      > maximum * ATTUNEGRAPH_CURRENT_DECISION_ENDPOINT_SOURCE_REFS_FOR_MEASUREMENT
  ) throw new Error("decision endpoint source-ref bound is invalid");
  const refsByAssertion = new Map();
  for (const sourceRef of sourceRefs) {
    const current = refsByAssertion.get(sourceRef.assertionOrdinal);
    if (current === undefined) {
      if (sourceRef.sourceRefOrdinal !== 0) {
        throw new Error("decision endpoint source-ref ordinals are invalid");
      }
      refsByAssertion.set(sourceRef.assertionOrdinal, [sourceRef]);
    } else {
      if (sourceRef.sourceRefOrdinal !== current.length) {
        throw new Error("decision endpoint source-ref ordinals are invalid");
      }
      current.push(sourceRef);
    }
  }
  const admitted = assertions.map((assertion) => {
    const assertionSourceRefs = refsByAssertion.get(assertion.assertionOrdinal) ?? [];
    const reconstructed = reconstructAttuneGraphCurrentAssertion(assertion, assertionSourceRefs);
    if (
      JSON.stringify(materializeAssertion(reconstructed, assertion.assertionOrdinal))
        !== JSON.stringify(assertion)
    ) throw new Error("decision endpoint assertion row is not canonical");
    const reconstructedSourceRefs = reconstructed.sourceRefs.map((sourceRef, sourceRefOrdinal) => ({
      assertionOrdinal: assertion.assertionOrdinal,
      sourceRefOrdinal,
      sourceNamespace: sourceRef.namespace,
      sourceIdValue: sourceRef.id,
      sourceVersion: sourceRef.version ?? null
    }));
    if (JSON.stringify(reconstructedSourceRefs) !== JSON.stringify(assertionSourceRefs)) {
      throw new Error("decision endpoint source-ref rows are not canonical");
    }
    return reconstructed;
  }).sort((left, right) =>
    (left.predicate < right.predicate ? -1 : left.predicate > right.predicate ? 1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
  return Object.freeze({
    schema: "attunegraph-current-decision-endpoint-measurement@1",
    measurementOnly: true,
    scanStatus: "built-unverified",
    verificationLimitations: Object.freeze([
      "selected-bucket-and-source-ref-tail-completeness-not-proven-by-v3"
    ]),
    snapshot,
    projectionFingerprint,
    scannedAssertions: assertions.length,
    assertions: Object.freeze(admitted)
  });
}

/**
 * Store-open admission: exact head/journal/manifest structure and manifest
 * metadata only. This intentionally does not scan assertion or source-ref rows.
 * @param {{ prepare(sql: string): { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown } }} database
 */
export function verifyAttuneGraphCurrentHeadIndexStructureDatabase(database) {
  const rows = database.prepare(`
    SELECT h.source_id AS sourceId, h.thread_id AS threadId,
           h.generation, h.commit_id AS commitId,
           j.source_id AS journalSourceId,
           j.projection_fingerprint AS projectionFingerprint,
           m.index_id AS indexId, m.source_id AS manifestSourceId,
           m.thread_id AS manifestThreadId, m.generation AS manifestGeneration,
           m.commit_id AS manifestCommitId,
           m.projection_fingerprint AS manifestProjectionFingerprint,
           m.index_revision AS indexRevision,
           m.assertion_count AS assertionCount,
           m.source_ref_count AS sourceRefCount,
           m.index_digest AS indexDigest
    FROM attunegraph_projection_head AS h
    LEFT JOIN attunegraph_projection_journal AS j
      ON j.source_id = h.source_id AND j.thread_id = h.thread_id
     AND j.generation = h.generation AND j.commit_id = h.commit_id
    LEFT JOIN attunegraph_current_manifest AS m
      ON m.source_id = h.source_id AND m.thread_id = h.thread_id
    ORDER BY h.source_id, h.thread_id LIMIT 1000001
  `).all();
  if (!Array.isArray(rows) || rows.length > MAX_CURRENT_SCOPES) {
    throw new Error("current-head index scope bound is invalid");
  }
  for (const value of rows) {
    const row = rowRecord(value, "current-head structure row");
    const sourceId = exactText(row.sourceId);
    const threadId = exactText(row.threadId);
    const generation = exactInteger(row.generation, 1);
    const commitId = exactText(row.commitId);
    const projectionFingerprint = exactText(row.projectionFingerprint);
    if (exactText(row.journalSourceId) !== sourceId) {
      throw new Error("current head lacks its exact journal row");
    }
    exactInteger(row.indexId, 1);
    if (
      exactText(row.manifestSourceId) !== sourceId
      || exactText(row.manifestThreadId) !== threadId
      || exactInteger(row.manifestGeneration, 1) !== generation
      || exactText(row.manifestCommitId) !== commitId
      || exactText(row.manifestProjectionFingerprint) !== projectionFingerprint
      || exactText(row.indexRevision) !== ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION
      || exactInteger(row.assertionCount) > MAX_CURRENT_ROWS_PER_SCOPE
      || exactInteger(row.sourceRefCount) > MAX_CURRENT_ROWS_PER_SCOPE
      || !/^sha256:[0-9a-f]{64}$/u.test(exactText(row.indexDigest))
    ) throw new Error("current-head manifest structure is stale or invalid");
  }
  const extra = database.prepare(`
    SELECT 1 AS invalid FROM attunegraph_current_manifest AS m
    LEFT JOIN attunegraph_projection_head AS h
      ON h.source_id = m.source_id AND h.thread_id = m.thread_id
    WHERE h.source_id IS NULL LIMIT 1
  `).get();
  if (extra !== undefined) throw new Error("current-head index has an extra manifest");
}

/**
 * Verifies v3 from normalized rows plus exact head/journal identity. It never
 * reads or decodes a projection payload.
 * @param {CurrentIndexDatabase} database
 * @param {{ readonly sourceId: string; readonly threadId: string } | undefined} requestedScope
 */
function verifyCurrentHeadRows(database, requestedScope) {
  const headRows = requestedScope === undefined ? database.prepare(`
    SELECT h.source_id AS sourceId, h.thread_id AS threadId,
           h.generation, h.commit_id AS commitId,
           j.source_id AS journalSourceId,
           j.projection_fingerprint AS projectionFingerprint,
           m.index_id AS indexId, m.source_id AS manifestSourceId,
           m.thread_id AS manifestThreadId, m.generation AS manifestGeneration,
           m.commit_id AS manifestCommitId,
           m.projection_fingerprint AS manifestProjectionFingerprint,
           m.index_revision AS indexRevision,
           m.assertion_count AS assertionCount,
           m.source_ref_count AS sourceRefCount,
           m.index_digest AS indexDigest
    FROM attunegraph_projection_head AS h
    LEFT JOIN attunegraph_projection_journal AS j
      ON j.source_id = h.source_id AND j.thread_id = h.thread_id
     AND j.generation = h.generation AND j.commit_id = h.commit_id
    LEFT JOIN attunegraph_current_manifest AS m
      ON m.source_id = h.source_id AND m.thread_id = h.thread_id
    ORDER BY h.source_id, h.thread_id LIMIT 1000001
  `).all() : database.prepare(`
    SELECT h.source_id AS sourceId, h.thread_id AS threadId,
           h.generation, h.commit_id AS commitId,
           j.source_id AS journalSourceId,
           j.projection_fingerprint AS projectionFingerprint,
           m.index_id AS indexId, m.source_id AS manifestSourceId,
           m.thread_id AS manifestThreadId, m.generation AS manifestGeneration,
           m.commit_id AS manifestCommitId,
           m.projection_fingerprint AS manifestProjectionFingerprint,
           m.index_revision AS indexRevision,
           m.assertion_count AS assertionCount,
           m.source_ref_count AS sourceRefCount,
           m.index_digest AS indexDigest
    FROM attunegraph_projection_head AS h
    LEFT JOIN attunegraph_projection_journal AS j
      ON j.source_id = h.source_id AND j.thread_id = h.thread_id
     AND j.generation = h.generation AND j.commit_id = h.commit_id
    LEFT JOIN attunegraph_current_manifest AS m
      ON m.source_id = h.source_id AND m.thread_id = h.thread_id
    WHERE h.source_id = ? AND h.thread_id = ? LIMIT 2
  `).all(requestedScope.sourceId, requestedScope.threadId);
  if (!Array.isArray(headRows) || headRows.length > MAX_CURRENT_SCOPES) {
    throw new Error("current-head index scope bound is invalid");
  }
  for (const value of headRows) {
    const row = rowRecord(value, "current head row");
    const head = Object.freeze({
      sourceId: exactText(row.sourceId),
      threadId: exactText(row.threadId),
      generation: exactInteger(row.generation, 1),
      commitId: exactText(row.commitId),
      projectionFingerprint: exactText(row.projectionFingerprint)
    });
    if (exactText(row.journalSourceId) !== head.sourceId) {
      throw new Error("current head lacks its exact journal row");
    }
    const indexId = exactInteger(row.indexId, 1);
    const manifest = Object.freeze({
      sourceId: exactText(row.manifestSourceId),
      threadId: exactText(row.manifestThreadId),
      generation: exactInteger(row.manifestGeneration, 1),
      commitId: exactText(row.manifestCommitId),
      projectionFingerprint: exactText(row.manifestProjectionFingerprint),
      indexRevision: exactText(row.indexRevision),
      assertionCount: exactInteger(row.assertionCount),
      sourceRefCount: exactInteger(row.sourceRefCount),
      indexDigest: exactText(row.indexDigest)
    });
    if (
      manifest.sourceId !== head.sourceId || manifest.threadId !== head.threadId
      || manifest.generation !== head.generation || manifest.commitId !== head.commitId
      || manifest.projectionFingerprint !== head.projectionFingerprint
      || manifest.indexRevision !== ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION
    ) throw new Error("current-head manifest identity is stale or invalid");
    if (
      manifest.assertionCount > MAX_CURRENT_ROWS_PER_SCOPE
      || manifest.sourceRefCount > MAX_CURRENT_ROWS_PER_SCOPE
    ) throw new Error("current-head index row bound is invalid");

    const assertions = database.prepare(`
      SELECT assertion_ordinal AS assertionOrdinal, assertion_id AS assertionId,
             subject_kind AS subjectKind, subject_id AS subjectId,
             object_kind AS objectKind, object_id AS objectId, predicate,
             epistemic_class AS epistemicClass, valid_from AS validFrom,
             valid_to AS validTo, recorded_at AS recordedAt,
             superseded_at AS supersededAt, derivation_kind AS derivationKind,
             derivation_version AS derivationVersion, derivation_run_id AS derivationRunId
      FROM attunegraph_current_assertion WHERE index_id = ?
      ORDER BY assertion_ordinal LIMIT 1000001
    `).all(BigInt(indexId)).map((item) => {
      const current = rowRecord(item, "current assertion row");
      return Object.freeze({
        assertionOrdinal: exactInteger(current.assertionOrdinal),
        assertionId: exactText(current.assertionId),
        subjectKind: exactText(current.subjectKind),
        subjectId: exactText(current.subjectId),
        objectKind: exactText(current.objectKind),
        objectId: exactText(current.objectId),
        predicate: exactText(current.predicate),
        epistemicClass: exactText(current.epistemicClass),
        validFrom: nullableText(current.validFrom),
        validTo: nullableText(current.validTo),
        recordedAt: exactText(current.recordedAt),
        supersededAt: nullableText(current.supersededAt),
        derivationKind: exactText(current.derivationKind),
        derivationVersion: exactText(current.derivationVersion),
        derivationRunId: nullableText(current.derivationRunId)
      });
    });
    const sourceRefs = database.prepare(`
      SELECT assertion_ordinal AS assertionOrdinal, source_ref_ordinal AS sourceRefOrdinal,
             source_namespace AS sourceNamespace, source_id_value AS sourceIdValue,
             source_version AS sourceVersion
      FROM attunegraph_current_source_ref WHERE index_id = ?
      ORDER BY assertion_ordinal, source_ref_ordinal LIMIT 1000001
    `).all(BigInt(indexId)).map((item) => {
      const current = rowRecord(item, "current source-ref row");
      return Object.freeze({
        assertionOrdinal: exactInteger(current.assertionOrdinal),
        sourceRefOrdinal: exactInteger(current.sourceRefOrdinal),
        sourceNamespace: exactText(current.sourceNamespace),
        sourceIdValue: exactText(current.sourceIdValue),
        sourceVersion: nullableText(current.sourceVersion)
      });
    });
    if (
      assertions.length !== manifest.assertionCount
      || sourceRefs.length !== manifest.sourceRefCount
      || assertions.length > MAX_CURRENT_ROWS_PER_SCOPE
      || sourceRefs.length > MAX_CURRENT_ROWS_PER_SCOPE
    ) throw new Error("current-head index count is invalid");

    const reconstructedSourceRefs = [];
    let sourceRefCursor = 0;
    for (let assertionOrdinal = 0; assertionOrdinal < assertions.length; assertionOrdinal += 1) {
      const assertionRow = assertions[assertionOrdinal];
      if (assertionRow === undefined) throw new Error("current assertion row is missing");
      if (assertionRow.assertionOrdinal !== assertionOrdinal) {
        throw new Error("current assertion ordinals are not contiguous");
      }
      const sourceRefStart = sourceRefCursor;
      while (sourceRefs[sourceRefCursor]?.assertionOrdinal === assertionOrdinal) {
        sourceRefCursor += 1;
      }
      const assertionSourceRefs = sourceRefs.slice(sourceRefStart, sourceRefCursor);
      for (let sourceRefOrdinal = 0; sourceRefOrdinal < assertionSourceRefs.length; sourceRefOrdinal += 1) {
        const sourceRef = assertionSourceRefs[sourceRefOrdinal];
        if (sourceRef === undefined || sourceRef.sourceRefOrdinal !== sourceRefOrdinal) {
          throw new Error("current source-ref ordinals are not contiguous");
        }
      }
      const admitted = reconstructAttuneGraphCurrentAssertion(assertionRow, assertionSourceRefs);
      if (JSON.stringify(materializeAssertion(admitted, assertionOrdinal)) !== JSON.stringify(assertionRow)) {
        throw new Error("current assertion row is not canonical");
      }
      const admittedSourceRefs = admitted.sourceRefs.map((sourceRef, sourceRefOrdinal) => Object.freeze({
        assertionOrdinal,
        sourceRefOrdinal,
        sourceNamespace: sourceRef.namespace,
        sourceIdValue: sourceRef.id,
        sourceVersion: sourceRef.version ?? null
      }));
      if (JSON.stringify(admittedSourceRefs) !== JSON.stringify(assertionSourceRefs)) {
        throw new Error("current source-ref rows are not canonical");
      }
      reconstructedSourceRefs.push(...admittedSourceRefs);
    }
    if (
      sourceRefCursor !== sourceRefs.length
      || JSON.stringify(reconstructedSourceRefs) !== JSON.stringify(sourceRefs)
    ) {
      throw new Error("current source-ref rows do not belong to exact assertions");
    }
    const digestIdentity = Object.freeze({
      sourceId: manifest.sourceId,
      threadId: manifest.threadId,
      generation: manifest.generation,
      commitId: manifest.commitId,
      projectionFingerprint: manifest.projectionFingerprint,
      indexRevision: manifest.indexRevision
    });
    if (currentIndexDigest(digestIdentity, assertions, sourceRefs) !== manifest.indexDigest) {
      throw new Error("current-head index digest is invalid");
    }
  }
  const extraManifest = requestedScope === undefined ? database.prepare(`
    SELECT 1 AS invalid FROM attunegraph_current_manifest AS m
    LEFT JOIN attunegraph_projection_head AS h
      ON h.source_id = m.source_id AND h.thread_id = m.thread_id
    WHERE h.source_id IS NULL LIMIT 1
  `).get() : database.prepare(`
    SELECT 1 AS invalid FROM attunegraph_current_manifest AS m
    LEFT JOIN attunegraph_projection_head AS h
      ON h.source_id = m.source_id AND h.thread_id = m.thread_id
    WHERE m.source_id = ? AND m.thread_id = ? AND h.source_id IS NULL LIMIT 1
  `).get(requestedScope.sourceId, requestedScope.threadId);
  if (extraManifest !== undefined) throw new Error("current-head index has an extra manifest");
  if (requestedScope !== undefined) return;
  const orphanAssertion = database.prepare(`
    SELECT 1 AS invalid FROM attunegraph_current_assertion AS a
    LEFT JOIN attunegraph_current_manifest AS m ON m.index_id = a.index_id
    WHERE m.index_id IS NULL LIMIT 1
  `).get();
  if (orphanAssertion !== undefined) throw new Error("current-head index has an orphan assertion");
  const orphanSourceRef = database.prepare(`
    SELECT 1 AS invalid FROM attunegraph_current_source_ref AS r
    LEFT JOIN attunegraph_current_assertion AS a
      ON a.index_id = r.index_id AND a.assertion_ordinal = r.assertion_ordinal
    WHERE a.index_id IS NULL LIMIT 1
  `).get();
  if (orphanSourceRef !== undefined) throw new Error("current-head index has an orphan source ref");
}

/** Explicit full-index Admin verification. */
/** @param {CurrentIndexDatabase} database */
export function verifyAttuneGraphCurrentHeadIndexDatabase(database) {
  verifyAttuneGraphCurrentHeadIndexStructureDatabase(database);
  verifyCurrentHeadRows(database, undefined);
}

/** Package-private future-query seam: strict verification of one exact scope. */
/** @param {CurrentIndexDatabase} database @param {unknown} scope */
export function verifyAttuneGraphCurrentHeadIndexScope(database, scope) {
  const scopeRecord = rowRecord(scope, "current-head index scope");
  const admittedScope = Object.freeze({
    sourceId: exactText(scopeRecord.sourceId),
    threadId: exactText(scopeRecord.threadId)
  });
  verifyCurrentHeadRows(database, admittedScope);
}
