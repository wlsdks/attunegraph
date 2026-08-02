import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { ACTIVATION_PREDICATES } from "../dist/constants.js";

export const SIMULATED_WITNESS_METADATA_SCAN_LIMIT = 64;
export const SIMULATED_WITNESS_SOURCE_REF_SCAN_LIMIT = 64;
const SIMULATED_WITNESS_INDEX_REVISION = "normalized-current-head@2";

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

export function sqliteAllocation(database) {
  const pageCount = Number(database.prepare("PRAGMA page_count").get()?.page_count);
  const pageSize = Number(database.prepare("PRAGMA page_size").get()?.page_size);
  if (!Number.isSafeInteger(pageCount) || !Number.isSafeInteger(pageSize)) {
    throw new Error("simulated witness SQLite allocation is invalid");
  }
  return Object.freeze({ pageCount, pageSize, bytes: pageCount * pageSize });
}

function assertionRows(database, indexId, metadataScanLimit) {
  return database.prepare(`
    SELECT assertion_ordinal AS assertionOrdinal, assertion_id AS assertionId,
           subject_kind AS subjectKind, subject_id AS subjectId,
           object_kind AS objectKind, object_id AS objectId, predicate,
           epistemic_class AS epistemicClass, valid_from AS validFrom,
           valid_to AS validTo, recorded_at AS recordedAt,
           superseded_at AS supersededAt, derivation_kind AS derivationKind,
           derivation_version AS derivationVersion, derivation_run_id AS derivationRunId,
           simulated_source_ref_count AS sourceRefCount,
           simulated_source_ref_digest AS sourceRefDigest
    FROM attunegraph_current_assertion WHERE index_id = ?
    ORDER BY assertion_ordinal LIMIT ?
  `).all(BigInt(indexId), BigInt(metadataScanLimit + 1)).map((row) => Object.freeze({
    assertionOrdinal: Number(row.assertionOrdinal),
    assertionId: row.assertionId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    objectKind: row.objectKind,
    objectId: row.objectId,
    predicate: row.predicate,
    epistemicClass: row.epistemicClass,
    validFrom: row.validFrom,
    validTo: row.validTo,
    recordedAt: row.recordedAt,
    supersededAt: row.supersededAt,
    derivationKind: row.derivationKind,
    derivationVersion: row.derivationVersion,
    derivationRunId: row.derivationRunId,
    sourceRefCount: Number(row.sourceRefCount),
    sourceRefDigest: row.sourceRefDigest
  }));
}

function sourceRefRows(database, indexId, assertionOrdinals, sourceRefScanLimit) {
  if (assertionOrdinals.length === 0) return [];
  return database.prepare(`
    SELECT assertion_ordinal AS assertionOrdinal, source_ref_ordinal AS sourceRefOrdinal,
           source_namespace AS sourceNamespace, source_id_value AS sourceIdValue,
           source_version AS sourceVersion
    FROM attunegraph_current_source_ref
    WHERE index_id = ? AND assertion_ordinal IN (${assertionOrdinals.map(() => "?").join(", ")})
    ORDER BY assertion_ordinal, source_ref_ordinal LIMIT ?
  `).all(
    BigInt(indexId),
    ...assertionOrdinals.map(BigInt),
    BigInt(sourceRefScanLimit + 1)
  ).map((row) => Object.freeze({
    assertionOrdinal: Number(row.assertionOrdinal),
    sourceRefOrdinal: Number(row.sourceRefOrdinal),
    sourceNamespace: row.sourceNamespace,
    sourceIdValue: row.sourceIdValue,
    sourceVersion: row.sourceVersion
  }));
}

function sourceRefDigest(sourceRefs) {
  return digest("attunegraph.current-source-ref.v1", sourceRefs.map((row) => ({
    sourceRefOrdinal: row.sourceRefOrdinal,
    sourceNamespace: row.sourceNamespace,
    sourceIdValue: row.sourceIdValue,
    sourceVersion: row.sourceVersion
  })));
}

function assertionSetDigest(identity, rows) {
  return digest("attunegraph.current-assertion-set.v1", Object.freeze({
    ...identity,
    assertions: rows
  }));
}

function witnessIdentity(row, scope) {
  return Object.freeze({
    sourceId: scope.sourceId,
    threadId: scope.threadId,
    generation: Number(row.generation),
    commitId: row.commitId,
    projectionFingerprint: row.projectionFingerprint,
    indexRevision: SIMULATED_WITNESS_INDEX_REVISION
  });
}

function exactHead(database, scope, allowUnsealed = false) {
  const rows = database.prepare(`
    SELECT m.index_id AS indexId, h.generation, h.commit_id AS commitId,
           j.projection_fingerprint AS projectionFingerprint,
           m.assertion_count AS assertionCount, m.source_ref_count AS sourceRefCount,
           m.simulated_index_digest AS indexDigest
    FROM attunegraph_projection_head AS h
    LEFT JOIN attunegraph_projection_journal AS j
      ON j.source_id = h.source_id AND j.thread_id = h.thread_id
     AND j.generation = h.generation AND j.commit_id = h.commit_id
    LEFT JOIN attunegraph_current_manifest AS m
      ON m.source_id = h.source_id AND m.thread_id = h.thread_id
     AND m.generation = h.generation AND m.commit_id = h.commit_id
     AND m.projection_fingerprint = j.projection_fingerprint
    WHERE h.source_id = ? AND h.thread_id = ? LIMIT 2
  `).all(scope.sourceId, scope.threadId);
  if (rows.length !== 1) throw new Error("simulated witness exact head is invalid");
  const row = rows[0];
  if (
    row.indexId === null
    || row.projectionFingerprint === null
    || !Number.isSafeInteger(Number(row.assertionCount))
    || !Number.isSafeInteger(Number(row.sourceRefCount))
    || (!allowUnsealed && !/^sha256:[0-9a-f]{64}$/u.test(row.indexDigest))
  ) throw new Error("simulated witness manifest is invalid");
  return row;
}

export function resealSimulatedAssertionSet(database, scope) {
  const head = exactHead(database, scope, true);
  const rows = assertionRows(database, Number(head.indexId), SIMULATED_WITNESS_METADATA_SCAN_LIMIT);
  const indexDigest = assertionSetDigest(witnessIdentity(head, scope), rows);
  database.prepare(`
    UPDATE attunegraph_current_manifest SET simulated_index_digest = ? WHERE index_id = ?
  `).run(indexDigest, head.indexId);
}

export function installSimulatedV4Witness(database, scope) {
  database.exec(`
    ALTER TABLE attunegraph_current_assertion
      ADD COLUMN simulated_source_ref_count INTEGER NOT NULL DEFAULT -1;
    ALTER TABLE attunegraph_current_assertion
      ADD COLUMN simulated_source_ref_digest TEXT NOT NULL DEFAULT '';
    ALTER TABLE attunegraph_current_manifest
      ADD COLUMN simulated_index_digest TEXT NOT NULL DEFAULT '';
  `);
  const head = exactHead(database, scope, true);
  const indexId = Number(head.indexId);
  const rows = assertionRows(database, indexId, SIMULATED_WITNESS_METADATA_SCAN_LIMIT);
  const refs = sourceRefRows(
    database,
    indexId,
    rows.map((row) => row.assertionOrdinal),
    SIMULATED_WITNESS_SOURCE_REF_SCAN_LIMIT
  );
  const refsByAssertion = new Map();
  for (const ref of refs) {
    const current = refsByAssertion.get(ref.assertionOrdinal) ?? [];
    current.push(ref);
    refsByAssertion.set(ref.assertionOrdinal, current);
  }
  const update = database.prepare(`
    UPDATE attunegraph_current_assertion
    SET simulated_source_ref_count = ?, simulated_source_ref_digest = ?
    WHERE index_id = ? AND assertion_ordinal = ?
  `);
  for (const row of rows) {
    const assertionRefs = refsByAssertion.get(row.assertionOrdinal) ?? [];
    update.run(
      BigInt(assertionRefs.length),
      sourceRefDigest(assertionRefs),
      BigInt(indexId),
      BigInt(row.assertionOrdinal)
    );
  }
  resealSimulatedAssertionSet(database, scope);
}

function reconstruct(row, sourceRefs) {
  const derivation = { kind: row.derivationKind, version: row.derivationVersion };
  if (row.derivationRunId !== null) derivation.runId = row.derivationRunId;
  const assertion = {
    schemaVersion: 1,
    id: row.assertionId,
    subject: { id: row.subjectId, kind: row.subjectKind },
    predicate: row.predicate,
    object: { id: row.objectId, kind: row.objectKind },
    epistemicClass: row.epistemicClass,
    sourceRefs: sourceRefs.map((sourceRef) => {
      const result = { id: sourceRef.sourceIdValue, namespace: sourceRef.sourceNamespace };
      if (sourceRef.sourceVersion !== null) result.version = sourceRef.sourceVersion;
      return result;
    })
  };
  if (row.validFrom !== null) assertion.validFrom = row.validFrom;
  if (row.validTo !== null) assertion.validTo = row.validTo;
  assertion.recordedAt = row.recordedAt;
  if (row.supersededAt !== null) assertion.supersededAt = row.supersededAt;
  assertion.derivation = derivation;
  return Object.freeze(assertion);
}

function rematerialize(assertion, assertionOrdinal) {
  const refs = assertion.sourceRefs.map((sourceRef, sourceRefOrdinal) => Object.freeze({
    assertionOrdinal,
    sourceRefOrdinal,
    sourceNamespace: sourceRef.namespace,
    sourceIdValue: sourceRef.id,
    sourceVersion: sourceRef.version ?? null
  }));
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
    derivationRunId: assertion.derivation.runId ?? null,
    sourceRefCount: assertion.sourceRefs.length,
    sourceRefDigest: sourceRefDigest(refs)
  });
}

function phase(samples, name, operation) {
  const started = performance.now();
  const result = operation();
  samples?.[name].push(performance.now() - started);
  return result;
}

export function createSimulatedWitnessPhaseSamples() {
  return {
    exactHead: [],
    metadataProof: [],
    endpointFilter: [],
    selectedSourceRefProof: [],
    canonicalReconstruction: []
  };
}

export function simulatedV4WitnessEndpoint(database, scope, seed, options = {}) {
  if (typeof options.asOf !== "string") throw new Error("simulated witness asOf is invalid");
  const metadataScanLimit = options.metadataScanLimit ?? SIMULATED_WITNESS_METADATA_SCAN_LIMIT;
  const sourceRefScanLimit = options.sourceRefScanLimit ?? SIMULATED_WITNESS_SOURCE_REF_SCAN_LIMIT;
  const samples = options.phaseSamples;
  const head = phase(samples, "exactHead", () => exactHead(database, scope));
  const indexId = Number(head.indexId);
  const assertions = phase(samples, "metadataProof", () => {
    const rows = assertionRows(database, indexId, metadataScanLimit);
    if (rows.length > metadataScanLimit || rows.length !== Number(head.assertionCount)) {
      throw new Error("simulated witness assertion metadata bound is invalid");
    }
    rows.forEach((row, ordinal) => {
      if (row.assertionOrdinal !== ordinal) {
        throw new Error("simulated witness assertion ordinals are invalid");
      }
    });
    if (
      rows.reduce((total, row) => total + row.sourceRefCount, 0) !== Number(head.sourceRefCount)
      || assertionSetDigest(witnessIdentity(head, scope), rows) !== head.indexDigest
    ) throw new Error("simulated witness assertion-set digest is invalid");
    return rows;
  });
  const selected = phase(samples, "endpointFilter", () => assertions.filter((row) =>
    ACTIVATION_PREDICATES.includes(row.predicate)
    && ((row.subjectKind === seed.kind && row.subjectId === seed.id)
      || (row.objectKind === seed.kind && row.objectId === seed.id))
    && row.recordedAt <= options.asOf
    && (row.supersededAt === null || row.supersededAt > options.asOf)
    && (row.validFrom === null || row.validFrom <= options.asOf)
    && (row.validTo === null || row.validTo > options.asOf)
  ));
  const selectedWithRefs = phase(samples, "selectedSourceRefProof", () => {
    const refs = sourceRefRows(
      database,
      indexId,
      selected.map((row) => row.assertionOrdinal),
      sourceRefScanLimit
    );
    if (refs.length > sourceRefScanLimit) {
      throw new Error("simulated witness selected source-ref bound is invalid");
    }
    const refsByAssertion = new Map();
    for (const ref of refs) {
      const current = refsByAssertion.get(ref.assertionOrdinal) ?? [];
      if (ref.sourceRefOrdinal !== current.length) {
        throw new Error("simulated witness source-ref ordinals are invalid");
      }
      current.push(ref);
      refsByAssertion.set(ref.assertionOrdinal, current);
    }
    return selected.map((row) => {
      const assertionRefs = refsByAssertion.get(row.assertionOrdinal) ?? [];
      if (
        assertionRefs.length !== row.sourceRefCount
        || sourceRefDigest(assertionRefs) !== row.sourceRefDigest
      ) throw new Error("simulated witness selected source-ref witness is invalid");
      return Object.freeze({ row, refs: assertionRefs });
    });
  });
  return Object.freeze(phase(samples, "canonicalReconstruction", () => selectedWithRefs.map(({ row, refs }) => {
    const assertion = reconstruct(row, refs);
    if (JSON.stringify(rematerialize(assertion, row.assertionOrdinal)) !== JSON.stringify(row)) {
      throw new Error("simulated witness assertion row is not canonical");
    }
    return assertion;
  }).sort((left, right) =>
    (left.predicate < right.predicate ? -1 : left.predicate > right.predicate ? 1 : 0)
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )));
}
