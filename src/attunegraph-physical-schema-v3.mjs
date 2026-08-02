import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V2 } from "./attunegraph-physical-schema-v2.mjs";

export const ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION = "normalized-current-head@1";

const CREATE_JOURNAL = ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createJournal;
const CREATE_GENERATION_INDEX = ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createGenerationIndex;
const CREATE_HEAD = `CREATE TABLE attunegraph_projection_head (
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  PRIMARY KEY (source_id, thread_id),
  UNIQUE (source_id, thread_id, generation, commit_id),
  FOREIGN KEY (source_id, thread_id, generation, commit_id)
    REFERENCES attunegraph_projection_journal (source_id, thread_id, generation, commit_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`;
const CREATE_CURRENT_MANIFEST = `CREATE TABLE attunegraph_current_manifest (
  index_id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  projection_fingerprint TEXT NOT NULL,
  index_revision TEXT NOT NULL CHECK (index_revision = '${ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION}'),
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
  PRIMARY KEY (index_id, assertion_ordinal),
  UNIQUE (index_id, assertion_id),
  FOREIGN KEY (index_id) REFERENCES attunegraph_current_manifest (index_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID`;
const CREATE_CURRENT_ASSERTION_SUBJECT_LOOKUP = `CREATE INDEX attunegraph_current_assertion_subject_lookup
ON attunegraph_current_assertion (index_id, subject_kind, subject_id, assertion_ordinal)`;
const CREATE_CURRENT_ASSERTION_OBJECT_LOOKUP = `CREATE INDEX attunegraph_current_assertion_object_lookup
ON attunegraph_current_assertion (index_id, object_kind, object_id, assertion_ordinal)`;
const CREATE_CURRENT_SOURCE_REF = `CREATE TABLE attunegraph_current_source_ref (
  index_id INTEGER NOT NULL,
  assertion_ordinal INTEGER NOT NULL CHECK (assertion_ordinal >= 0),
  source_ref_ordinal INTEGER NOT NULL CHECK (source_ref_ordinal >= 0),
  source_namespace TEXT NOT NULL,
  source_id_value TEXT NOT NULL,
  source_version TEXT,
  PRIMARY KEY (index_id, assertion_ordinal, source_ref_ordinal),
  FOREIGN KEY (index_id, assertion_ordinal)
    REFERENCES attunegraph_current_assertion (index_id, assertion_ordinal)
    ON UPDATE RESTRICT ON DELETE CASCADE
) STRICT, WITHOUT ROWID`;

/** @param {string} value */
function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

const objectInputs = /** @type {readonly (readonly ["index" | "table", string, string, string])[]} */ ([
  ["index", "attunegraph_current_assertion_object_lookup", "attunegraph_current_assertion", CREATE_CURRENT_ASSERTION_OBJECT_LOOKUP],
  ["index", "attunegraph_current_assertion_subject_lookup", "attunegraph_current_assertion", CREATE_CURRENT_ASSERTION_SUBJECT_LOOKUP],
  ["index", "attunegraph_projection_journal_generation", "attunegraph_projection_journal", CREATE_GENERATION_INDEX],
  ["table", "attunegraph_current_assertion", "attunegraph_current_assertion", CREATE_CURRENT_ASSERTION],
  ["table", "attunegraph_current_manifest", "attunegraph_current_manifest", CREATE_CURRENT_MANIFEST],
  ["table", "attunegraph_current_source_ref", "attunegraph_current_source_ref", CREATE_CURRENT_SOURCE_REF],
  ["table", "attunegraph_projection_head", "attunegraph_projection_head", CREATE_HEAD],
  ["table", "attunegraph_projection_journal", "attunegraph_projection_journal", CREATE_JOURNAL]
]);
const objects = Object.freeze(objectInputs.map(([type, name, tableName, sql]) => Object.freeze({
  type,
  name,
  tableName,
  normalizedSql: normalizeSql(sql)
})));

export const ATTUNEGRAPH_PHYSICAL_SCHEMA_V3 = Object.freeze({
  applicationId: ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.applicationId,
  userVersion: 3,
  maxProjectionBytes: ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.maxProjectionBytes,
  encoding: ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.encoding,
  currentIndexRevision: ATTUNEGRAPH_CURRENT_HEAD_INDEX_REVISION,
  createJournal: CREATE_JOURNAL,
  createGenerationIndex: CREATE_GENERATION_INDEX,
  createHead: CREATE_HEAD,
  createCurrentManifest: CREATE_CURRENT_MANIFEST,
  createCurrentAssertion: CREATE_CURRENT_ASSERTION,
  createCurrentAssertionSubjectLookup: CREATE_CURRENT_ASSERTION_SUBJECT_LOOKUP,
  createCurrentAssertionObjectLookup: CREATE_CURRENT_ASSERTION_OBJECT_LOOKUP,
  createCurrentSourceRef: CREATE_CURRENT_SOURCE_REF,
  objects,
  headForeignKey: ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.headForeignKey
});

const MATCH = Object.freeze({ kind: "match" });
const FUTURE = Object.freeze({ kind: "future" });
const FOREIGN_OR_CORRUPT = Object.freeze({ kind: "foreign-or-corrupt" });

/** @param {{ readonly applicationId: number; readonly userVersion: number;
 * readonly objects: readonly Readonly<Record<string, unknown>>[];
 * readonly headForeignKey: readonly Readonly<Record<string, unknown>>[] }} admittedProfile */
export function classifyAttuneGraphPhysicalSchemaV3(admittedProfile) {
  if (
    admittedProfile.applicationId === ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.applicationId
    && Number.isInteger(admittedProfile.userVersion)
    && admittedProfile.userVersion > ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.userVersion
  ) return FUTURE;
  if (
    admittedProfile.applicationId !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.applicationId
    || admittedProfile.userVersion !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.userVersion
    || admittedProfile.objects.length !== objects.length
    || admittedProfile.headForeignKey.length !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.headForeignKey.length
  ) return FOREIGN_OR_CORRUPT;
  for (let index = 0; index < objects.length; index += 1) {
    const actual = admittedProfile.objects[index];
    const expected = objects[index];
    if (
      actual?.type !== expected?.type || actual?.name !== expected?.name
      || actual?.tableName !== expected?.tableName || actual?.normalizedSql !== expected?.normalizedSql
    ) return FOREIGN_OR_CORRUPT;
  }
  for (let index = 0; index < ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.headForeignKey.length; index += 1) {
    const actual = admittedProfile.headForeignKey[index];
    const expected = ATTUNEGRAPH_PHYSICAL_SCHEMA_V3.headForeignKey[index];
    if (
      actual?.id !== expected?.id || actual?.seq !== expected?.seq
      || actual?.table !== expected?.table || actual?.from !== expected?.from
      || actual?.to !== expected?.to || actual?.onUpdate !== expected?.onUpdate
      || actual?.onDelete !== expected?.onDelete || actual?.match !== expected?.match
    ) return FOREIGN_OR_CORRUPT;
  }
  return MATCH;
}
