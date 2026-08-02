import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 } from "./attunegraph-physical-schema-v1.mjs";
import {
  ATTUNEGRAPH_PROJECTION_ENCODING,
  MAX_ENCODED_PROJECTION_BYTES,
  MAX_UNCOMPRESSED_PROJECTION_BYTES
} from "./attunegraph-projection-codec.mjs";

const CREATE_JOURNAL = `CREATE TABLE attunegraph_projection_journal (
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  projection_encoding TEXT NOT NULL CHECK (projection_encoding = '${ATTUNEGRAPH_PROJECTION_ENCODING}'),
  projection_payload BLOB NOT NULL CHECK (length(projection_payload) BETWEEN 1 AND ${MAX_ENCODED_PROJECTION_BYTES}),
  projection_uncompressed_bytes INTEGER NOT NULL CHECK (projection_uncompressed_bytes BETWEEN 1 AND ${MAX_UNCOMPRESSED_PROJECTION_BYTES}),
  projection_payload_sha256 TEXT NOT NULL CHECK (length(projection_payload_sha256) = 71),
  projection_fingerprint TEXT NOT NULL,
  PRIMARY KEY (source_id, thread_id, generation, commit_id)
) STRICT, WITHOUT ROWID`;
const CREATE_GENERATION_INDEX = ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createGenerationIndex;
const CREATE_HEAD = ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createHead;

/** @param {string} value */
function normalizeSql(value) {
  return value.replace(/\s+/g, " ").trim();
}

const objects = Object.freeze([
  Object.freeze({
    type: "index",
    name: "attunegraph_projection_journal_generation",
    tableName: "attunegraph_projection_journal",
    normalizedSql: normalizeSql(CREATE_GENERATION_INDEX)
  }),
  Object.freeze({
    type: "table",
    name: "attunegraph_projection_head",
    tableName: "attunegraph_projection_head",
    normalizedSql: normalizeSql(CREATE_HEAD)
  }),
  Object.freeze({
    type: "table",
    name: "attunegraph_projection_journal",
    tableName: "attunegraph_projection_journal",
    normalizedSql: normalizeSql(CREATE_JOURNAL)
  })
]);

export const ATTUNEGRAPH_PHYSICAL_SCHEMA_V2 = Object.freeze({
  applicationId: ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId,
  userVersion: 2,
  maxProjectionBytes: MAX_UNCOMPRESSED_PROJECTION_BYTES,
  encoding: ATTUNEGRAPH_PROJECTION_ENCODING,
  createJournal: CREATE_JOURNAL,
  createGenerationIndex: CREATE_GENERATION_INDEX,
  createHead: CREATE_HEAD,
  objects,
  headForeignKey: ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.headForeignKey
});

const MATCH = Object.freeze({ kind: "match" });
const FUTURE = Object.freeze({ kind: "future" });
const FOREIGN_OR_CORRUPT = Object.freeze({ kind: "foreign-or-corrupt" });

/** @param {{ readonly applicationId: number; readonly userVersion: number;
 * readonly objects: readonly Readonly<Record<string, unknown>>[];
 * readonly headForeignKey: readonly Readonly<Record<string, unknown>>[] }} admittedProfile */
export function classifyAttuneGraphPhysicalSchemaV2(admittedProfile) {
  if (
    admittedProfile.applicationId === ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.applicationId
    && Number.isInteger(admittedProfile.userVersion)
    && admittedProfile.userVersion > ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.userVersion
  ) return FUTURE;
  if (
    admittedProfile.applicationId !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.applicationId
    || admittedProfile.userVersion !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.userVersion
    || admittedProfile.objects.length !== objects.length
    || admittedProfile.headForeignKey.length !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.headForeignKey.length
  ) return FOREIGN_OR_CORRUPT;
  for (let index = 0; index < objects.length; index += 1) {
    const actual = admittedProfile.objects[index];
    const expected = objects[index];
    if (
      actual?.type !== expected?.type
      || actual?.name !== expected?.name
      || actual?.tableName !== expected?.tableName
      || actual?.normalizedSql !== expected?.normalizedSql
    ) return FOREIGN_OR_CORRUPT;
  }
  for (let index = 0; index < ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.headForeignKey.length; index += 1) {
    const actual = admittedProfile.headForeignKey[index];
    const expected = ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.headForeignKey[index];
    if (
      actual?.id !== expected?.id || actual?.seq !== expected?.seq
      || actual?.table !== expected?.table || actual?.from !== expected?.from
      || actual?.to !== expected?.to || actual?.onUpdate !== expected?.onUpdate
      || actual?.onDelete !== expected?.onDelete || actual?.match !== expected?.match
    ) return FOREIGN_OR_CORRUPT;
  }
  return MATCH;
}
