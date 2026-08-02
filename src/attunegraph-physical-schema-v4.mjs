import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V3 } from "./attunegraph-physical-schema-v3.mjs";

export const ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION_V4 = "normalized-current-head@2";

const CREATE_CURRENT_MANIFEST = `CREATE TABLE attunegraph_current_manifest (
  index_id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  projection_fingerprint TEXT NOT NULL,
  index_revision TEXT NOT NULL CHECK (index_revision = '${ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION_V4}'),
  assertion_count INTEGER NOT NULL CHECK (assertion_count >= 0),
  source_ref_count INTEGER NOT NULL CHECK (source_ref_count >= 0),
  index_digest TEXT NOT NULL CHECK (length(index_digest) = 71),
  UNIQUE (source_id, thread_id),
  UNIQUE (source_id, thread_id, generation, commit_id),
  FOREIGN KEY (source_id, thread_id, generation, commit_id)
    REFERENCES attunegraph_projection_head (source_id, thread_id, generation, commit_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (source_id, thread_id, generation, commit_id)
    REFERENCES attunegraph_projection_journal (source_id, thread_id, generation, commit_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT`;
const CREATE_CURRENT_ASSERTION = `CREATE TABLE attunegraph_current_assertion (
  index_id INTEGER NOT NULL,
  assertion_ordinal INTEGER NOT NULL CHECK (assertion_ordinal >= 0),
  assertion_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  epistemic_class TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  recorded_at TEXT NOT NULL,
  superseded_at TEXT,
  derivation_kind TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  derivation_run_id TEXT,
  source_ref_count INTEGER NOT NULL CHECK (source_ref_count >= 0),
  source_ref_digest TEXT NOT NULL CHECK (length(source_ref_digest) = 71),
  PRIMARY KEY (index_id, assertion_ordinal),
  UNIQUE (index_id, assertion_id),
  FOREIGN KEY (index_id) REFERENCES attunegraph_current_manifest (index_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID`;
const CREATE_CURRENT_ENDPOINT_DEGREE = `CREATE TABLE attunegraph_current_endpoint_degree (
  index_id INTEGER NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  incident_assertion_count INTEGER NOT NULL CHECK (incident_assertion_count >= 1),
  PRIMARY KEY (index_id, ref_kind, ref_id),
  FOREIGN KEY (index_id) REFERENCES attunegraph_current_manifest (index_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID`;

/** @param {string} value */
function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

const objectInputs = /** @type {readonly (readonly ["index" | "table", string, string, string])[]} */ ([
  ["index", "attunegraph_current_assertion_object_lookup", "attunegraph_current_assertion", ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentAssertionObjectLookup],
  ["index", "attunegraph_current_assertion_subject_lookup", "attunegraph_current_assertion", ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentAssertionSubjectLookup],
  ["index", "attunegraph_projection_journal_generation", "attunegraph_projection_journal", ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createGenerationIndex],
  ["table", "attunegraph_current_assertion", "attunegraph_current_assertion", CREATE_CURRENT_ASSERTION],
  ["table", "attunegraph_current_endpoint_degree", "attunegraph_current_endpoint_degree", CREATE_CURRENT_ENDPOINT_DEGREE],
  ["table", "attunegraph_current_manifest", "attunegraph_current_manifest", CREATE_CURRENT_MANIFEST],
  ["table", "attunegraph_current_source_ref", "attunegraph_current_source_ref", ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentSourceRef],
  ["table", "attunegraph_projection_head", "attunegraph_projection_head", ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createHead],
  ["table", "attunegraph_projection_journal", "attunegraph_projection_journal", ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createJournal]
]);
const objects = Object.freeze(objectInputs.map(([type, name, tableName, sql]) => Object.freeze({
  type,
  name,
  tableName,
  normalizedSql: normalizeSql(sql)
})));

export const ATTUNEGRAPH_PHYSICAL_SCHEMA_V4 = Object.freeze({
  applicationId: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.applicationId,
  userVersion: 4,
  maxProjectionBytes: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.maxProjectionBytes,
  encoding: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.encoding,
  currentIndexRevision: ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION_V4,
  createJournal: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createJournal,
  createGenerationIndex: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createGenerationIndex,
  createHead: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createHead,
  createCurrentManifest: CREATE_CURRENT_MANIFEST,
  createCurrentAssertion: CREATE_CURRENT_ASSERTION,
  createCurrentAssertionSubjectLookup: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentAssertionSubjectLookup,
  createCurrentAssertionObjectLookup: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentAssertionObjectLookup,
  createCurrentEndpointDegree: CREATE_CURRENT_ENDPOINT_DEGREE,
  createCurrentSourceRef: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.createCurrentSourceRef,
  objects,
  headForeignKey: ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.headForeignKey
});

const MATCH = Object.freeze({ kind: "match" });
const FUTURE = Object.freeze({ kind: "future" });
const FOREIGN_OR_CORRUPT = Object.freeze({ kind: "foreign-or-corrupt" });

/** @param {{ readonly applicationId: number; readonly userVersion: number;
 * readonly objects: readonly Readonly<Record<string, unknown>>[];
 * readonly headForeignKey: readonly Readonly<Record<string, unknown>>[] }} admittedProfile */
export function classifyAttuneGraphPhysicalSchemaV4(admittedProfile) {
  if (
    admittedProfile.applicationId === ATTUNEGRAPH_PHYSICAL_SCHEMA_V4.applicationId
    && Number.isInteger(admittedProfile.userVersion)
    && admittedProfile.userVersion > ATTUNEGRAPH_PHYSICAL_SCHEMA_V4.userVersion
  ) return FUTURE;
  if (
    admittedProfile.applicationId !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V4.applicationId
    || admittedProfile.userVersion !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V4.userVersion
    || admittedProfile.objects.length !== objects.length
    || admittedProfile.headForeignKey.length !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V4.headForeignKey.length
  ) return FOREIGN_OR_CORRUPT;
  for (let index = 0; index < objects.length; index += 1) {
    const actual = admittedProfile.objects[index];
    const expected = objects[index];
    if (
      actual?.type !== expected?.type || actual?.name !== expected?.name
      || actual?.tableName !== expected?.tableName || actual?.normalizedSql !== expected?.normalizedSql
    ) return FOREIGN_OR_CORRUPT;
  }
  for (let index = 0; index < ATTUNEGRAPH_PHYSICAL_SCHEMA_V4.headForeignKey.length; index += 1) {
    const actual = admittedProfile.headForeignKey[index];
    const expected = ATTUNEGRAPH_PHYSICAL_SCHEMA_V4.headForeignKey[index];
    if (
      actual?.id !== expected?.id || actual?.seq !== expected?.seq
      || actual?.table !== expected?.table || actual?.from !== expected?.from
      || actual?.to !== expected?.to || actual?.onUpdate !== expected?.onUpdate
      || actual?.onDelete !== expected?.onDelete || actual?.match !== expected?.match
    ) return FOREIGN_OR_CORRUPT;
  }
  return MATCH;
}
