import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

import { afterEach, expect, it } from "vitest";

import { createInMemoryAttuneGraphStore } from "./attunegraph-in-memory-store.js";
import { createAttuneGraphStore } from "./attunegraph-backend.js";
import type { AttuneGraphProjectCommand, AttuneGraphScope } from "./attunegraph-contracts.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import { parseAttuneQL } from "./attuneql.js";
import { openLocalAttuneGraph, openLocalAttuneGraphSession } from "./local.js";
import { openLocalAttuneGraphSessionForTesting } from "./local-session-internal.js";
import { openSqliteAttuneGraphStore } from "./attunegraph-sqlite-store.js";
import { runAttuneGraphStoreConformance } from "./attunegraph-testing.js";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 } from "./attunegraph-physical-schema-v1.mjs";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V2 } from "./attunegraph-physical-schema-v2.mjs";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V3 } from "./attunegraph-physical-schema-v3.mjs";
import { verifyAttuneGraphCurrentHeadIndexScope } from "./attunegraph-current-head-index.mjs";
import { createAttuneGraphAdminReadOnlyInspector } from "./attunegraph-admin-readonly-inspector.mjs";
import { canonicalAssertion, normalizeGraphAssertion } from "./validation.js";

const NOW = "2026-07-30T00:00:00.000Z";
const SCOPE: AttuneGraphScope = {
  sourceId: "local-source",
  threadId: "local-thread"
};
const temporaryDirectories: string[] = [];

async function temporaryDatabase(name = "attunegraph.sqlite"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-local-"));
  const canonicalDirectory = await realpath(directory);
  temporaryDirectories.push(canonicalDirectory);
  return join(canonicalDirectory, name);
}

function command(
  key: string,
  scope: AttuneGraphScope = SCOPE
): AttuneGraphProjectCommand {
  const threadRoot = { id: scope.threadId, kind: "thread" as const };
  return {
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: key,
      scope,
      threadRoot,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [{
        schemaVersion: 1,
        id: `assertion-${key}`,
        subject: { id: `artifact-${key}`, kind: "artifact" },
        predicate: "LINKED_TO",
        object: { ...threadRoot },
        epistemicClass: "source-observed",
        sourceRefs: [{ id: `source-ref-${key}`, namespace: "example.local-test" }],
        recordedAt: NOW,
        derivation: { kind: "projection", version: "local-test@1" }
      }]
    }
  };
}

function execute(scope: AttuneGraphScope = SCOPE) {
  return {
    operator: "working-graph@1" as const,
    seed: { id: scope.threadId, kind: "thread" as const },
    now: NOW,
    maxEstimatedTokens: 256
  };
}

function decisionQuery(scope: AttuneGraphScope = SCOPE) {
  return {
    operator: "decision-query@1" as const,
    scope,
    seed: { id: scope.threadId, kind: "thread" as const },
    asOf: NOW,
    head: { mode: "current" as const },
    freshness: { require: "fresh" as const },
    budget: { maxEstimatedTokens: 256 }
  };
}

function expectDeeplyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

it("rejects hostile options before creating a database", async () => {
  const databasePath = await temporaryDatabase();
  const options = { databasePath, scope: SCOPE };

  await expect(
    openLocalAttuneGraph(new Proxy(options, {}))
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });

  const accessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(accessor, "databasePath", {
    enumerable: true,
    get: () => databasePath
  });
  Object.defineProperty(accessor, "scope", {
    enumerable: true,
    value: SCOPE
  });
  await expect(openLocalAttuneGraph(accessor as never)).rejects.toMatchObject({
    code: "INVALID_INPUT"
  });
  await expect(lstat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("persists and reopens byte-identical Engine snapshots and results", async () => {
  const databasePath = await temporaryDatabase();
  const local = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const memory = await openAttuneGraph({
    scope: SCOPE,
    store: createInMemoryAttuneGraphStore()
  });
  const input = command("restart");

  const [localSnapshot, memorySnapshot] = await Promise.all([
    local.project(input),
    memory.project(input)
  ]);
  await expect(local.head()).resolves.toEqual(localSnapshot);
  await expect(memory.head()).resolves.toEqual(memorySnapshot);
  const [localResult, memoryResult] = await Promise.all([
    local.execute(execute()),
    memory.execute(execute())
  ]);
  expect(JSON.stringify(localSnapshot)).toBe(JSON.stringify(memorySnapshot));
  expect(JSON.stringify(localResult)).toBe(JSON.stringify(memoryResult));
  await Promise.all([local.close(), memory.close()]);

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.head()).resolves.toEqual(localSnapshot);
  expect(JSON.stringify(await reopened.project(input))).toBe(
    JSON.stringify(localSnapshot)
  );
  expect(JSON.stringify(await reopened.execute(execute()))).toBe(
    JSON.stringify(localResult)
  );
  await reopened.close();
  await reopened.close();
  await expect(reopened.head()).rejects.toMatchObject({ code: "CLOSED" });
  await expect(reopened.project(input)).rejects.toMatchObject({ code: "CLOSED" });
  await expect(reopened.projectAgainstHead(input)).rejects.toMatchObject({ code: "CLOSED" });
  await expect(reopened.execute(execute())).rejects.toMatchObject({ code: "CLOSED" });
  await expect(reopened.query(decisionQuery())).rejects.toMatchObject({ code: "CLOSED" });
});

it("bootstraps physical schema v3 while retaining exact compressed projection metadata", async () => {
  const databasePath = await temporaryDatabase();
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const snapshot = await graph.project(command("physical-v2"));
  await graph.close();

  const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  const version = database.prepare("PRAGMA user_version").get();
  const columns = database.prepare(
    "SELECT name FROM pragma_table_info('attunegraph_projection_journal') ORDER BY cid"
  ).all().map((row) => row.name);
  const row = database.prepare(`
    SELECT typeof(projection_payload) AS payloadType,
           projection_encoding AS encoding,
           projection_uncompressed_bytes AS uncompressedBytes,
           projection_payload_sha256 AS payloadSha256,
           projection_fingerprint AS projectionFingerprint
    FROM attunegraph_projection_journal
  `).get();
  database.close();

  expect(version).toEqual({ user_version: 3n });
  expect(columns).toContain("projection_payload");
  expect(columns).not.toContain("projection_json");
  expect(row).toMatchObject({
    payloadType: "blob",
    encoding: "deflate-raw@1",
    payloadSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    projectionFingerprint: snapshot.commitId.replace("attunegraph-commit:", "")
  });
  expect(row?.uncompressedBytes).toEqual(expect.any(BigInt));

  expect(ATTUNEGRAPH_PHYSICAL_SCHEMA_V3).toMatchObject({
    applicationId: ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.applicationId,
    userVersion: 3,
    encoding: ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.encoding
  });
});

it("materializes the exact current-head assertion, endpoint, provenance, and derivation atoms", async () => {
  const databasePath = await temporaryDatabase("normalized-v3.sqlite");
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const input = command("normalized-v3");
  const assertion = {
    ...input.observation.assertions[0]!,
    sourceRefs: [
      { id: "z-source", namespace: "example.local-test", version: "2" },
      { id: "a-source", namespace: "example.local-test", version: "1" }
    ],
    validFrom: "2026-07-01T00:00:00.000Z",
    validTo: "2026-09-01T00:00:00.000Z",
    supersededAt: "2026-08-01T00:00:00.000Z",
    derivation: { kind: "projection" as const, runId: "run-normalized-v3", version: "local-test@2" }
  };
  const snapshot = await graph.project({
    ...input,
    observation: { ...input.observation, assertions: [assertion] }
  } as AttuneGraphProjectCommand);
  await graph.close();

  const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  const manifest = database.prepare("SELECT * FROM attunegraph_current_manifest").get();
  const assertions = database.prepare("SELECT * FROM attunegraph_current_assertion").all();
  const sourceRefs = database.prepare(
    "SELECT * FROM attunegraph_current_source_ref ORDER BY assertion_ordinal, source_ref_ordinal"
  ).all();
  const currentObjects = database.prepare(`
    SELECT type, name FROM sqlite_schema
    WHERE name LIKE 'attunegraph_current_%' ORDER BY type, name
  `).all();
  database.close();

  expect(manifest).toMatchObject({
    source_id: SCOPE.sourceId,
    thread_id: SCOPE.threadId,
    generation: 1n,
    commit_id: snapshot.commitId,
    projection_fingerprint: snapshot.commitId.replace("attunegraph-commit:", ""),
    index_revision: "normalized-current-head@1",
    assertion_count: 1n,
    source_ref_count: 2n,
    index_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u)
  });
  expect(assertions).toEqual([expect.objectContaining({
    assertion_ordinal: 0n,
    assertion_id: assertion.id,
    subject_kind: "artifact",
    subject_id: assertion.subject.id,
    object_kind: "thread",
    object_id: assertion.object.id,
    predicate: "LINKED_TO",
    epistemic_class: "source-observed",
    valid_from: assertion.validFrom,
    valid_to: assertion.validTo,
    recorded_at: assertion.recordedAt,
    superseded_at: assertion.supersededAt,
    derivation_kind: "projection",
    derivation_version: "local-test@2",
    derivation_run_id: "run-normalized-v3"
  })]);
  const assertionRow = assertions[0] as Record<string, unknown>;
  const reconstructed = normalizeGraphAssertion({
    schemaVersion: 1,
    id: assertionRow.assertion_id,
    subject: { kind: assertionRow.subject_kind, id: assertionRow.subject_id },
    predicate: assertionRow.predicate,
    object: { kind: assertionRow.object_kind, id: assertionRow.object_id },
    epistemicClass: assertionRow.epistemic_class,
    sourceRefs: sourceRefs.map((row) => ({
      namespace: row.source_namespace,
      id: row.source_id_value,
      ...((row.source_version ?? undefined) === undefined ? {} : { version: row.source_version })
    })),
    ...(assertionRow.valid_from === null ? {} : { validFrom: assertionRow.valid_from }),
    ...(assertionRow.valid_to === null ? {} : { validTo: assertionRow.valid_to }),
    recordedAt: assertionRow.recorded_at,
    ...(assertionRow.superseded_at === null ? {} : { supersededAt: assertionRow.superseded_at }),
    derivation: {
      kind: assertionRow.derivation_kind,
      version: assertionRow.derivation_version,
      ...(assertionRow.derivation_run_id === null ? {} : { runId: assertionRow.derivation_run_id })
    }
  });
  expect(canonicalAssertion(reconstructed)).toBe(JSON.stringify({
    schemaVersion: 1,
    id: assertion.id,
    subject: assertion.subject,
    predicate: assertion.predicate,
    object: assertion.object,
    epistemicClass: assertion.epistemicClass,
    sourceRefs: [assertion.sourceRefs[1]!, assertion.sourceRefs[0]!],
    validFrom: assertion.validFrom,
    validTo: assertion.validTo,
    recordedAt: assertion.recordedAt,
    supersededAt: assertion.supersededAt,
    derivation: assertion.derivation
  }));
  expect(sourceRefs).toEqual([
    expect.objectContaining({ index_id: expect.any(BigInt), source_ref_ordinal: 0n, source_id_value: "a-source", source_version: "1" }),
    expect.objectContaining({ index_id: expect.any(BigInt), source_ref_ordinal: 1n, source_id_value: "z-source", source_version: "2" })
  ]);
  expect(currentObjects).toEqual([
    { type: "index", name: "attunegraph_current_assertion_object_lookup" },
    { type: "index", name: "attunegraph_current_assertion_subject_lookup" },
    { type: "table", name: "attunegraph_current_assertion" },
    { type: "table", name: "attunegraph_current_manifest" },
    { type: "table", name: "attunegraph_current_source_ref" }
  ]);
});

it("replaces all prior current-index rows for one scope without disturbing another scope", async () => {
  const databasePath = await temporaryDatabase("normalized-replacement-v3.sqlite");
  const alternateScope = { sourceId: "other-source", threadId: "other-thread" };
  const session = await openLocalAttuneGraphSession({ databasePath });
  const main = await session.open({ scope: SCOPE });
  const other = await session.open({ scope: alternateScope });
  const first = await main.project(command("replace-old"));
  await other.project(command("replace-other", alternateScope));
  const second = await main.project({
    ...command("replace-new"),
    expectedSnapshot: first
  });
  await main.close();
  await other.close();
  await session.close();

  const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  const manifests = database.prepare(`
    SELECT source_id, thread_id, generation, commit_id
    FROM attunegraph_current_manifest ORDER BY source_id, thread_id
  `).all();
  const assertionIds = database.prepare(`
    SELECT m.source_id, m.thread_id, a.assertion_id
    FROM attunegraph_current_assertion AS a
    JOIN attunegraph_current_manifest AS m ON m.index_id = a.index_id
    ORDER BY m.source_id, m.thread_id, a.assertion_ordinal
  `).all();
  const counts = database.prepare(`
    SELECT source_id, thread_id, COUNT(*) AS journal_count
    FROM attunegraph_projection_journal GROUP BY source_id, thread_id ORDER BY source_id, thread_id
  `).all();
  database.close();

  expect(manifests).toEqual([
    { source_id: SCOPE.sourceId, thread_id: SCOPE.threadId, generation: 2n, commit_id: second.commitId },
    expect.objectContaining({ source_id: alternateScope.sourceId, thread_id: alternateScope.threadId, generation: 1n })
  ]);
  expect(assertionIds).toEqual([
    { source_id: SCOPE.sourceId, thread_id: SCOPE.threadId, assertion_id: "assertion-replace-new" },
    { source_id: alternateScope.sourceId, thread_id: alternateScope.threadId, assertion_id: "assertion-replace-other" }
  ]);
  expect(counts).toEqual([
    { source_id: SCOPE.sourceId, thread_id: SCOPE.threadId, journal_count: 2n },
    { source_id: alternateScope.sourceId, thread_id: alternateScope.threadId, journal_count: 1n }
  ]);
});

it.each([
  ["missing manifest", "DELETE FROM attunegraph_current_manifest"],
  ["stale manifest", "UPDATE attunegraph_current_manifest SET generation = generation + 1"],
  ["extra manifest", `INSERT INTO attunegraph_current_manifest (
      index_id, source_id, thread_id, generation, commit_id, projection_fingerprint,
      index_revision, assertion_count, source_ref_count, index_digest
    ) SELECT index_id + 1000, 'extra-source', 'extra-thread', generation, commit_id,
      projection_fingerprint, index_revision, 0, 0, index_digest
      FROM attunegraph_current_manifest LIMIT 1`]
] as const)("fails store open when the v3 current-head index has structural %s", async (_label, mutation) => {
  const databasePath = await temporaryDatabase("normalized-structural-corrupt-v3.sqlite");
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await graph.project(command("normalized-structural-corruption"));
  await graph.close();

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(mutation);
  database.close();

  await expect(openLocalAttuneGraph({ databasePath, scope: SCOPE })).rejects.toMatchObject({
    code: "CORRUPT_STORE"
  });
});

it.each([
  ["digest drift", "UPDATE attunegraph_current_manifest SET index_digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'"],
  ["row-count drift", "UPDATE attunegraph_current_manifest SET assertion_count = assertion_count + 1"],
  ["altered assertion", "UPDATE attunegraph_current_assertion SET predicate = 'CONTEXT_FOR'"],
  ["missing source ref", "DELETE FROM attunegraph_current_source_ref"],
  ["altered adjacency", "UPDATE attunegraph_current_assertion SET subject_id = 'wrong-ref'"],
  ["extra assertion", `INSERT INTO attunegraph_current_assertion (
      index_id, assertion_ordinal, assertion_id,
      subject_kind, subject_id, object_kind, object_id,
      predicate, epistemic_class, recorded_at, derivation_kind, derivation_version
    ) SELECT index_id, 99, 'extra',
      subject_kind, subject_id, object_kind, object_id,
      predicate, epistemic_class, recorded_at, derivation_kind, derivation_version
      FROM attunegraph_current_assertion LIMIT 1`]
] as const)("leaves unused semantic %s to Admin/full per-scope verification", async (_label, mutation) => {
  const databasePath = await temporaryDatabase("normalized-corrupt-v3.sqlite");
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await graph.project(command("normalized-corruption"));
  await graph.close();

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(mutation);
  database.close();

  const perScope = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  expect(() => verifyAttuneGraphCurrentHeadIndexScope(perScope, SCOPE)).toThrow();
  perScope.close();

  const adminDatabase = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  const inspector = createAttuneGraphAdminReadOnlyInspector(adminDatabase);
  expect(() => inspector.verifyIntegrity()).toThrow();
  adminDatabase.close();

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.execute(execute())).resolves.toBeDefined();
  await reopened.close();
});

it("opens v3 from normalized integrity rows without decoding the current compressed projection", async () => {
  const databasePath = await temporaryDatabase("normalized-open-without-projection-decode-v3.sqlite");
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const snapshot = await graph.project(command("normalized-open-no-decode"));
  await graph.close();

  const invalidPayload = Buffer.from([0]);
  const database = new DatabaseSync(databasePath);
  database.prepare(`
    UPDATE attunegraph_projection_journal
    SET projection_payload = ?, projection_payload_sha256 = ?
    WHERE source_id = ? AND thread_id = ? AND generation = ? AND commit_id = ?
  `).run(
    invalidPayload,
    `sha256:${createHash("sha256").update(invalidPayload).digest("hex")}`,
    SCOPE.sourceId,
    SCOPE.threadId,
    snapshot.generation,
    snapshot.commitId
  );
  database.close();

  const reopened = await openSqliteAttuneGraphStore({ databasePath });
  await expect(reopened.backend.readHead?.(SCOPE)).resolves.toEqual(snapshot);
  await expect(reopened.backend.read(SCOPE)).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  await reopened.close();
});

it("opens and keeps writing exact physical schema v1 without automatic migration", async () => {
  const databasePath = await temporaryDatabase("legacy-v1.sqlite");
  const fixture = new DatabaseSync(databasePath);
  fixture.exec(`
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createJournal};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createGenerationIndex};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createHead};
    PRAGMA application_id = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId};
    PRAGMA user_version = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion};
  `);
  fixture.close();
  await chmod(databasePath, 0o600);

  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const snapshot = await graph.project(command("legacy-v1-write"));
  const result = await graph.execute(execute());
  await graph.close();

  const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1n });
  const columns = database.prepare(
    "SELECT name FROM pragma_table_info('attunegraph_projection_journal') ORDER BY cid"
  ).all().map((row) => row.name);
  expect(columns).toContain("projection_json");
  expect(columns).not.toContain("projection_payload");
  database.close();

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.head()).resolves.toEqual(snapshot);
  expect(JSON.stringify(await reopened.execute(execute()))).toBe(JSON.stringify(result));
  await reopened.close();
});

it("fails closed on v2 trailing bytes even when their payload hash is recomputed", async () => {
  const databasePath = await temporaryDatabase("trailing-v2.sqlite");
  const fixture = new DatabaseSync(databasePath);
  fixture.exec(`
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createJournal};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createGenerationIndex};
    ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.createHead};
    PRAGMA application_id = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.applicationId};
    PRAGMA user_version = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V2.userVersion};
  `);
  fixture.close();
  await chmod(databasePath, 0o600);
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await graph.project(command("trailing-v2"));
  await graph.close();

  const database = new DatabaseSync(databasePath);
  expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(database.prepare(
    "SELECT name FROM sqlite_schema WHERE name = 'attunegraph_current_manifest'"
  ).get()).toBeUndefined();
  const row = database.prepare(
    "SELECT projection_payload AS payload FROM attunegraph_projection_journal"
  ).get() as { payload: Uint8Array };
  const trailing = Buffer.concat([Buffer.from(row.payload), Buffer.from([0xde, 0xad])]);
  const payloadSha256 = `sha256:${createHash("sha256").update(trailing).digest("hex")}`;
  database.prepare(`
    UPDATE attunegraph_projection_journal
    SET projection_payload = ?, projection_payload_sha256 = ?
  `).run(trailing, payloadSha256);
  database.close();

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.execute(execute())).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  await reopened.close();
});

it("keeps AttuneQL and object decision queries byte-identical across memory and local reopen", async () => {
  const databasePath = await temporaryDatabase();
  const local = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const memory = await openAttuneGraph({
    scope: SCOPE,
    store: createInMemoryAttuneGraphStore()
  });
  const input = command("decision-query-parity");
  await Promise.all([local.project(input), memory.project(input)]);
  const text = parseAttuneQL(`
    EVIDENCE FOR thread("${SCOPE.threadId}")
    IN SCOPE("${SCOPE.sourceId}", "${SCOPE.threadId}")
    AS OF "${NOW}"
    AT CURRENT HEAD
    REQUIRE FRESH
    BUDGET 256 TOKENS;
  `);
  const object = decisionQuery();

  const [localText, localObject, memoryText, memoryObject] = await Promise.all([
    local.query(text),
    local.query(object),
    memory.query(text),
    memory.query(object)
  ]);
  expect(JSON.stringify(localText)).toBe(JSON.stringify(memoryText));
  expect(JSON.stringify(localObject)).toBe(JSON.stringify(memoryObject));
  expect(JSON.stringify(localText)).toBe(JSON.stringify(localObject));
  await Promise.all([local.close(), memory.close()]);

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  expect(JSON.stringify(await reopened.query(text))).toBe(JSON.stringify(localText));
  await reopened.close();
});

it("uses exact SQLite head reads to reuse one Working Graph plan per open handle", async () => {
  const databasePath = await temporaryDatabase();
  const requests: string[] = [];
  const session = await openLocalAttuneGraphSessionForTesting({
    databasePath,
    testHooks: {
      requestSent: (type) => { requests.push(type); }
    }
  });
  const graph = await session.open({ scope: SCOPE });
  await graph.project(command("head-pinned-plan"));
  requests.length = 0;

  const first = await graph.execute(execute());
  const second = await graph.execute(execute());

  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  expect(requests).toEqual(["readHead", "readHead"]);
  requests.length = 0;
  await graph.query(decisionQuery());
  expect(requests).toEqual(["readHead"]);
  const writer = await session.open({ scope: SCOPE });
  await writer.project({
    ...command("head-pinned-plan-external-update"),
    expectedSnapshot: first.snapshot
  });
  requests.length = 0;

  const updated = await graph.execute(execute());
  expect(updated).toMatchObject({ snapshot: { generation: 2 } });
  expect(updated.workingGraph.assertions.map((item) => item.id)).toEqual([
    "assertion-head-pinned-plan-external-update"
  ]);
  expect(requests).toEqual(["readHead", "read"]);
  await Promise.all([graph.close(), writer.close()]);
  await session.close();
});

it("opens independent scope-bound handles through one local session", async () => {
  const databasePath = await temporaryDatabase();
  let workerStarts = 0;
  let terminalSettlements = 0;
  const alternateScope: AttuneGraphScope = {
    sourceId: "local-source",
    threadId: "local-thread-alternate"
  };
  const session = await openLocalAttuneGraphSessionForTesting({
    databasePath,
    testHooks: {
      workerStarted: () => { workerStarts += 1; },
      workerTerminalSettled: () => { terminalSettlements += 1; }
    }
  });
  const [first, second] = await Promise.all([
    session.open({ scope: SCOPE }),
    session.open({ scope: alternateScope })
  ]);

  const [firstSnapshot, secondSnapshot] = await Promise.all([
    first.project(command("session-first")),
    second.project(command("session-second", alternateScope))
  ]);

  expect(firstSnapshot.scope).toEqual(SCOPE);
  expect(secondSnapshot.scope).toEqual(alternateScope);
  await Promise.all([first.close(), second.close()]);
  await session.close();
  expect(workerStarts).toBe(1);
  expect(terminalSettlements).toBe(1);
});

it("persists projectAgainstHead through the public local session handle", async () => {
  const databasePath = await temporaryDatabase();
  const session = await openLocalAttuneGraphSession({ databasePath });
  const graph = await session.open({ scope: SCOPE });
  await graph.project(command("against-head-seed"));

  const updated = await graph.projectAgainstHead(command("against-head-update"));
  expect(updated).toMatchObject({ generation: 2 });
  await graph.close();
  await session.close();

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.head()).resolves.toEqual(updated);
  await reopened.close();
});

it("preserves CAS semantics across concurrent session handles", async () => {
  const databasePath = await temporaryDatabase();
  const alternateScope: AttuneGraphScope = {
    sourceId: "local-source",
    threadId: "local-thread-alternate"
  };
  const session = await openLocalAttuneGraphSession({ databasePath });
  const [left, right, alternate] = await Promise.all([
    session.open({ scope: SCOPE }),
    session.open({ scope: SCOPE }),
    session.open({ scope: alternateScope })
  ]);

  const [leftRace, rightRace, alternateRace] = await Promise.allSettled([
    left.project(command("session-race-left")),
    right.project(command("session-race-right")),
    alternate.project(command("session-race-alternate", alternateScope))
  ]);
  const sameScope = [leftRace, rightRace];
  expect(sameScope.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(sameScope.filter(
    (result) => result.status === "rejected"
      && (result.reason as { code?: unknown }).code === "SNAPSHOT_CONFLICT"
  )).toHaveLength(1);

  expect(alternateRace).toMatchObject({ status: "fulfilled", value: { generation: 1 } });
  await Promise.all([left.close(), right.close(), alternate.close()]);
  await session.close();
});

it("keeps other handles alive after a handle closes, then closes the whole session", async () => {
  const databasePath = await temporaryDatabase();
  const alternateScope: AttuneGraphScope = {
    sourceId: "local-source",
    threadId: "local-thread-alternate"
  };
  const session = await openLocalAttuneGraphSession({ databasePath });
  const [first, second] = await Promise.all([
    session.open({ scope: SCOPE }),
    session.open({ scope: alternateScope })
  ]);
  await first.close();
  await expect(first.head()).rejects.toMatchObject({ code: "CLOSED" });
  await expect(second.project(command("still-open", alternateScope))).resolves.toMatchObject({
    generation: 1
  });

  await session.close();
  await expect(second.head()).rejects.toMatchObject({ code: "CLOSED" });
  await second.close();
});

it("rejects new session handles as soon as session close begins", async () => {
  const session = await openLocalAttuneGraphSession({
    databasePath: await temporaryDatabase()
  });
  const closing = session.close();
  await expect(session.open({ scope: SCOPE })).rejects.toMatchObject({ code: "CLOSED" });
  await closing;
});

it("drains handle work accepted before session close begins", async () => {
  const session = await openLocalAttuneGraphSessionForTesting({
    databasePath: await temporaryDatabase(),
    testResponseDelayMs: 25
  });
  const graph = await session.open({ scope: SCOPE });
  const accepted = graph.project(command("session-drain"));
  const closing = session.close();
  await expect(session.open({ scope: SCOPE })).rejects.toMatchObject({ code: "CLOSED" });
  await expect(accepted).resolves.toMatchObject({ generation: 1 });
  await closing;
  await graph.close();
});

it("admits session-handle projection before an immediate handle close", async () => {
  const databasePath = await temporaryDatabase();
  const session = await openLocalAttuneGraphSession({ databasePath });
  const graph = await session.open({ scope: SCOPE });

  const projection = graph.project(command("session-handle-immediate-close"));
  const closing = graph.close();
  const snapshot = await projection;
  await closing;
  expect(snapshot.generation).toBe(1);
  await session.close();

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.head()).resolves.toEqual(snapshot);
  await reopened.close();
});

it("retains cold openLocalAttuneGraph projection-before-close ordering", async () => {
  const databasePath = await temporaryDatabase();
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });

  const projection = graph.project(command("cold-immediate-close"));
  const closing = graph.close();
  const snapshot = await projection;
  await closing;
  expect(snapshot.generation).toBe(1);

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await expect(reopened.head()).resolves.toEqual(snapshot);
  await reopened.close();
});

it("pins one terminal worker failure across every session handle", async () => {
  const databasePath = await temporaryDatabase();
  const alternateScope: AttuneGraphScope = {
    sourceId: "local-source",
    threadId: "local-thread-alternate"
  };
  const session = await openLocalAttuneGraphSessionForTesting({
    databasePath,
    testFault: "hang-read",
    testTimeoutMs: 50
  });
  const [first, second] = await Promise.all([
    session.open({ scope: SCOPE }),
    session.open({ scope: alternateScope })
  ]);

  const failed = await Promise.allSettled([first.head(), second.head()]);
  expect(failed.every((result) =>
    result.status === "rejected" && (result.reason as { code?: unknown }).code === "STORE_FAILURE"
  )).toBe(true);
  await expect(first.head()).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await expect(second.head()).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await expect(session.close()).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await Promise.all([first.close(), second.close()]);
});

it("cold reopens the exact session generation and Working Graph after session close", async () => {
  const databasePath = await temporaryDatabase();
  const session = await openLocalAttuneGraphSession({ databasePath });
  const writer = await session.open({ scope: SCOPE });
  const snapshot = await writer.project(command("session-cold-reopen"));
  const result = await writer.execute(execute());
  await writer.close();
  await session.close();

  const reopened = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  expect(JSON.stringify(await reopened.head())).toBe(JSON.stringify(snapshot));
  expect(JSON.stringify(await reopened.execute(execute()))).toBe(JSON.stringify(result));
  await reopened.close();
});

function inspectDatabaseWithoutMutation(databasePath: string): {
  readonly pragmas: Readonly<Record<string, unknown>>;
  readonly schema: readonly unknown[];
  readonly tables: Readonly<Record<string, readonly unknown[]>>;
} {
  const database = new DatabaseSync(databasePath, {
    readBigInts: true,
    readOnly: true
  });
  try {
    const schema = database.prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const tables: Record<string, readonly unknown[]> = {};
    for (const row of schema) {
      if (row.type !== "table" || typeof row.name !== "string") continue;
      if (!/^[a-z0-9_]+$/u.test(row.name)) throw new Error("fixture table name is unsafe");
      tables[row.name] = database.prepare(
        `SELECT * FROM "${row.name}"`
      ).all();
    }
    return {
      pragmas: {
        applicationId: database.prepare("PRAGMA application_id").get(),
        journalMode: database.prepare("PRAGMA journal_mode").get(),
        userVersion: database.prepare("PRAGMA user_version").get()
      },
      schema,
      tables
    };
  } finally {
    database.close();
  }
}

async function inspectDatabaseBytes(bytes: Uint8Array): Promise<
  ReturnType<typeof inspectDatabaseWithoutMutation>
> {
  const inspectionPath = await temporaryDatabase("inspection.sqlite");
  await writeFile(inspectionPath, bytes, { mode: 0o600 });
  return inspectDatabaseWithoutMutation(inspectionPath);
}

it("rejects the superseded numeric physical identity before mutation", async () => {
  const databasePath = await temporaryDatabase("incompatible.sqlite");
  const encoded = await readFile(
    new URL("./fixtures/attunegraph-legacy-sqlite-v1.base64", import.meta.url),
    "utf8"
  );
  const fixture = gunzipSync(Buffer.from(encoded.trim(), "base64"));
  expect(createHash("sha256").update(fixture).digest("hex")).toBe(
    "0b44d5cf634fbbed3c38125613250727739bb4e014a2846bc0d343521da63504"
  );
  await writeFile(databasePath, fixture, { mode: 0o600 });
  const beforeBytes = await readFile(databasePath);
  const beforeDirectory = await readdir(dirname(databasePath));
  const beforeDatabase = await inspectDatabaseBytes(beforeBytes);
  expect(beforeDatabase.pragmas.applicationId).toEqual({
    application_id: 0x4d414731n
  });

  await expect(openLocalAttuneGraph({
    databasePath,
    scope: { sourceId: "incompatible-source", threadId: "incompatible-thread" }
  })).rejects.toMatchObject({ code: "INCOMPATIBLE_STORE_PROFILE" });

  const afterBytes = await readFile(databasePath);
  expect(afterBytes).toEqual(beforeBytes);
  expect(await readdir(dirname(databasePath))).toEqual(beforeDirectory);
  expect(await inspectDatabaseBytes(afterBytes)).toEqual(beforeDatabase);
  for (const suffix of ["-wal", "-shm"]) {
    await expect(lstat(`${databasePath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("linearizes two independent Worker connections on one file", async () => {
  const databasePath = await temporaryDatabase();
  const first = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  const second = await openLocalAttuneGraph({ databasePath, scope: SCOPE });

  const different = await Promise.allSettled([
    first.project(command("race-a")),
    second.project(command("race-b"))
  ]);
  expect(different.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    different.filter(
      (result) =>
        result.status === "rejected"
        && (result.reason as { code?: unknown }).code === "SNAPSHOT_CONFLICT"
    )
  ).toHaveLength(1);
  await Promise.all([first.close(), second.close()]);

  const identicalPath = await temporaryDatabase("identical.sqlite");
  const left = await openLocalAttuneGraph({ databasePath: identicalPath, scope: SCOPE });
  const right = await openLocalAttuneGraph({ databasePath: identicalPath, scope: SCOPE });
  const same = command("same-race");
  const [leftSnapshot, rightSnapshot] = await Promise.all([
    left.project(same),
    right.project(same)
  ]);
  expect(leftSnapshot).toEqual(rightSnapshot);
  expect(leftSnapshot.generation).toBe(1);
  await Promise.all([left.close(), right.close()]);
});

it("uses owner-only files and rejects a symlink database target", async () => {
  const databasePath = await temporaryDatabase();
  const attuneGraph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await attuneGraph.project(command("permissions"));

  const databaseMode = (await lstat(databasePath)).mode & 0o777;
  expect(databaseMode).toBe(0o600);
  for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    const mode = (await lstat(sidecar)).mode & 0o777;
    expect(mode).toBe(0o600);
  }
  await attuneGraph.close();

  const symlinkPath = join(
    databasePath.slice(0, databasePath.lastIndexOf("/")),
    "linked.sqlite"
  );
  await symlink(databasePath, symlinkPath);
  await expect(
    openLocalAttuneGraph({ databasePath: symlinkPath, scope: SCOPE })
  ).rejects.toMatchObject({
    code: expect.stringMatching(/^(INVALID_INPUT|UNSUPPORTED_STORE_PROFILE)$/u)
  });

  const realDirectory = await realpath(join(databasePath, ".."));
  const linkedDirectory = join(realDirectory, "linked-parent");
  const targetDirectory = join(realDirectory, "target-parent");
  await mkdir(targetDirectory, { mode: 0o700 });
  await symlink(targetDirectory, linkedDirectory);
  await expect(
    openLocalAttuneGraph({
      databasePath: join(linkedDirectory, "redirected.sqlite"),
      scope: SCOPE
    })
  ).rejects.toMatchObject({ code: "UNSUPPORTED_STORE_PROFILE" });
});

it("passes the backend-neutral Store conformance corpus with disposal", async () => {
  const report = await runAttuneGraphStoreConformance(async () =>
    openSqliteAttuneGraphStore({ databasePath: await temporaryDatabase() })
  );
  expect(report).toMatchObject({ passed: true });
  expect(report.cases).toHaveLength(5);
});

it("returns deeply frozen mutation-isolated projections from direct SQLite backend reads", async () => {
  const resource = await openSqliteAttuneGraphStore({
    databasePath: await temporaryDatabase()
  });
  const attuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(resource.backend)
  });
  const snapshot = await attuneGraph.project(command("direct-backend-read"));

  const first = await resource.backend.read(SCOPE);
  const second = await resource.backend.read(SCOPE);
  expect(first).toBeDefined();
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second?.snapshot).not.toBe(first?.snapshot);
  expect(second?.assertions).not.toBe(first?.assertions);
  expect(second?.assertions[0]).not.toBe(first?.assertions[0]);
  expectDeeplyFrozen(first);
  expectDeeplyFrozen(second);

  expect(() => {
    (first?.assertions[0]?.subject as { id: string }).id = "mutated";
  }).toThrow(TypeError);
  await expect(resource.backend.read(SCOPE)).resolves.toEqual(second);
  await expect(attuneGraph.head()).resolves.toEqual(snapshot);

  await attuneGraph.close();
  await resource.close();
});

it("uses only the two protocol-size stringifications and no parent JSON parse per SQLite read", async () => {
  const resource = await openSqliteAttuneGraphStore({
    databasePath: await temporaryDatabase()
  });
  const attuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(resource.backend)
  });
  await attuneGraph.project(command("parent-json-passes"));

  const originalParse = JSON.parse;
  const originalStringify = JSON.stringify;
  let parses = 0;
  let stringifies = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parses += 1;
    return originalParse(...args);
  }) as typeof JSON.parse;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    stringifies += 1;
    return originalStringify(...args);
  }) as typeof JSON.stringify;
  try {
    await expect(resource.backend.read(SCOPE)).resolves.toBeDefined();
  } finally {
    JSON.parse = originalParse;
    JSON.stringify = originalStringify;
  }
  expect({ parses, stringifies }).toEqual({ parses: 0, stringifies: 2 });

  await attuneGraph.close();
  await resource.close();
});

it("recovers the three commit and acknowledgement crash boundaries", async () => {
  const beforeCommitPath = await temporaryDatabase("before-commit.sqlite");
  const beforeCommitResource = await openSqliteAttuneGraphStore({
    databasePath: beforeCommitPath,
    testFault: "before-commit"
  });
  const beforeCommitAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(beforeCommitResource.backend)
  });
  await expect(
    beforeCommitAttuneGraph.project(command("before-commit"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await beforeCommitAttuneGraph.close();

  const beforeCommitReopen = await openLocalAttuneGraph({
    databasePath: beforeCommitPath,
    scope: SCOPE
  });
  const firstAfterRollback = await beforeCommitReopen.project(
    command("after-rollback")
  );
  expect(firstAfterRollback.generation).toBe(1);
  await beforeCommitReopen.close();

  const lostAckPath = await temporaryDatabase("lost-ack.sqlite");
  const lostAckResource = await openSqliteAttuneGraphStore({
    databasePath: lostAckPath,
    testFault: "after-commit-before-ack"
  });
  const lostAckAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(lostAckResource.backend)
  });
  const lostAckCommand = command("lost-ack");
  await expect(lostAckAttuneGraph.project(lostAckCommand)).rejects.toMatchObject({
    code: "STORE_FAILURE"
  });
  await lostAckAttuneGraph.close();

  const lostAckReopen = await openLocalAttuneGraph({
    databasePath: lostAckPath,
    scope: SCOPE
  });
  const recoveredLostAck = await lostAckReopen.project(lostAckCommand);
  expect(recoveredLostAck.generation).toBe(1);
  const nextAfterLostAck = await lostAckReopen.project({
    ...command("after-lost-ack"),
    expectedSnapshot: recoveredLostAck
  });
  expect(nextAfterLostAck.generation).toBe(2);
  await lostAckReopen.close();

  const acknowledgedPath = await temporaryDatabase("acknowledged.sqlite");
  const acknowledgedResource = await openSqliteAttuneGraphStore({
    databasePath: acknowledgedPath
  });
  const acknowledgedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(acknowledgedResource.backend)
  });
  const acknowledgedSnapshot = await acknowledgedAttuneGraph.project(
    command("acknowledged")
  );
  await acknowledgedResource.terminateForTesting();
  await expect(
    acknowledgedAttuneGraph.execute(execute())
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await acknowledgedAttuneGraph.close();

  const acknowledgedReopen = await openLocalAttuneGraph({
    databasePath: acknowledgedPath,
    scope: SCOPE
  });
  const recoveredAcknowledged = await acknowledgedReopen.execute(execute());
  expect(recoveredAcknowledged.snapshot).toEqual(acknowledgedSnapshot);
  await acknowledgedReopen.close();
});

it("atomically recovers the v3 journal, head, manifest, and normalized rows across commit crashes", async () => {
  const inspect = (databasePath: string) => {
    const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
    try {
      return {
        head: database.prepare("SELECT generation, commit_id AS commitId FROM attunegraph_projection_head").get(),
        manifest: database.prepare("SELECT generation, commit_id AS commitId, index_digest AS indexDigest FROM attunegraph_current_manifest").get(),
        assertionIds: database.prepare("SELECT assertion_id AS assertionId FROM attunegraph_current_assertion ORDER BY assertion_ordinal").all(),
        assertionRows: database.prepare("SELECT COUNT(*) AS count FROM attunegraph_current_assertion").get(),
        sourceRefRows: database.prepare("SELECT COUNT(*) AS count FROM attunegraph_current_source_ref").get(),
        journalRows: database.prepare("SELECT COUNT(*) AS count FROM attunegraph_projection_journal").get()
      };
    } finally {
      database.close();
    }
  };

  const beforePath = await temporaryDatabase("v3-index-before-commit.sqlite");
  const beforeBase = await openLocalAttuneGraph({ databasePath: beforePath, scope: SCOPE });
  const beforeOld = await beforeBase.project(command("v3-before-old"));
  await beforeBase.close();
  const beforeResource = await openSqliteAttuneGraphStore({
    databasePath: beforePath,
    testFault: "before-commit"
  });
  const beforeGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(beforeResource.backend)
  });
  await expect(beforeGraph.project({
    ...command("v3-before-new"),
    expectedSnapshot: beforeOld
  })).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await beforeGraph.close();
  expect(inspect(beforePath)).toMatchObject({
    head: { generation: 1n, commitId: beforeOld.commitId },
    manifest: { generation: 1n, commitId: beforeOld.commitId, indexDigest: expect.stringMatching(/^sha256:/u) },
    assertionIds: [{ assertionId: "assertion-v3-before-old" }],
    assertionRows: { count: 1n },
    sourceRefRows: { count: 1n },
    journalRows: { count: 1n }
  });

  const afterPath = await temporaryDatabase("v3-index-after-commit.sqlite");
  const afterBase = await openLocalAttuneGraph({ databasePath: afterPath, scope: SCOPE });
  const afterOld = await afterBase.project(command("v3-after-old"));
  await afterBase.close();
  const afterResource = await openSqliteAttuneGraphStore({
    databasePath: afterPath,
    testFault: "after-commit-before-ack"
  });
  const afterGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(afterResource.backend)
  });
  const afterCommand = { ...command("v3-after-new"), expectedSnapshot: afterOld };
  await expect(afterGraph.project(afterCommand)).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await afterGraph.close();
  const afterState = inspect(afterPath);
  expect(afterState).toMatchObject({
    head: { generation: 2n },
    manifest: { generation: 2n, indexDigest: expect.stringMatching(/^sha256:/u) },
    assertionIds: [{ assertionId: "assertion-v3-after-new" }],
    assertionRows: { count: 1n },
    sourceRefRows: { count: 1n },
    journalRows: { count: 2n }
  });
  expect((afterState.head as { commitId: string }).commitId).toBe(
    (afterState.manifest as { commitId: string }).commitId
  );
  const afterReopen = await openLocalAttuneGraph({ databasePath: afterPath, scope: SCOPE });
  const recovered = await afterReopen.project(afterCommand);
  expect(recovered.generation).toBe(2);
  await afterReopen.close();
  expect(inspect(afterPath)).toEqual(afterState);
});

it("fails closed for future, foreign, malformed, orphaned, and NOTADB state", async () => {
  const futurePath = await temporaryDatabase("future.sqlite");
  const future = await openSqliteAttuneGraphStore({
    databasePath: futurePath,
    testFixtureMode: true
  });
  await future.mutateForTesting("future-user-version");
  await future.close();
  await expect(
    openLocalAttuneGraph({ databasePath: futurePath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "FUTURE_STORE_STATE" });

  const foreignPath = await temporaryDatabase("foreign.sqlite");
  const foreign = await openSqliteAttuneGraphStore({
    databasePath: foreignPath,
    testFixtureMode: true
  });
  await foreign.mutateForTesting("wrong-application-id");
  await foreign.close();
  await expect(
    openLocalAttuneGraph({ databasePath: foreignPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const malformedPath = await temporaryDatabase("malformed.sqlite");
  const malformed = await openSqliteAttuneGraphStore({
    databasePath: malformedPath,
    testFixtureMode: true
  });
  const malformedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(malformed.backend)
  });
  await malformedAttuneGraph.project(command("malformed"));
  await malformed.mutateForTesting("malformed-projection-json");
  await malformedAttuneGraph.close();
  await malformed.close();
  const malformedReopened = await openLocalAttuneGraph({
    databasePath: malformedPath,
    scope: SCOPE
  });
  await expect(malformedReopened.execute(execute())).rejects.toMatchObject({ code: "CORRUPT_STORE" });
  await malformedReopened.close();

  const orphanPath = await temporaryDatabase("orphan.sqlite");
  const orphan = await openSqliteAttuneGraphStore({
    databasePath: orphanPath,
    testFixtureMode: true
  });
  const orphanAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(orphan.backend)
  });
  await orphanAttuneGraph.project(command("orphan"));
  await orphan.mutateForTesting("missing-journal-row");
  await orphanAttuneGraph.close();
  await orphan.close();
  await expect(
    openLocalAttuneGraph({ databasePath: orphanPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const partialPath = await temporaryDatabase("partial-bootstrap.sqlite");
  const partial = await openSqliteAttuneGraphStore({
    databasePath: partialPath,
    testFixtureMode: true
  });
  await partial.mutateForTesting("partial-bootstrap");
  await partial.close();
  await expect(
    openLocalAttuneGraph({ databasePath: partialPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const oversizedPath = await temporaryDatabase("oversized.sqlite");
  const oversized = await openSqliteAttuneGraphStore({
    databasePath: oversizedPath,
    testFixtureMode: true
  });
  const oversizedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(oversized.backend)
  });
  await oversizedAttuneGraph.project(command("oversized"));
  await oversized.mutateForTesting("oversized-projection-json");
  await oversizedAttuneGraph.close();
  await oversized.close();
  await expect(
    openLocalAttuneGraph({ databasePath: oversizedPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const mismatchedPath = await temporaryDatabase("mismatched.sqlite");
  const mismatched = await openSqliteAttuneGraphStore({
    databasePath: mismatchedPath,
    testFixtureMode: true
  });
  const mismatchedAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(mismatched.backend)
  });
  await mismatchedAttuneGraph.project(command("mismatched"));
  await mismatched.mutateForTesting("mismatched-head");
  await mismatchedAttuneGraph.close();
  await mismatched.close();
  await expect(
    openLocalAttuneGraph({ databasePath: mismatchedPath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });

  const quickCheckPath = await temporaryDatabase("quick-check.sqlite");
  const quickCheck = await openSqliteAttuneGraphStore({
    databasePath: quickCheckPath,
    testFixtureMode: true
  });
  await quickCheck.mutateForTesting("quick-check-corruption");
  try {
    await quickCheck.close();
  } catch (cause) {
    throw new Error("quick-check fixture close failed", { cause });
  }
  try {
    const unexpected = await openLocalAttuneGraph({
      databasePath: quickCheckPath,
      scope: SCOPE
    });
    await unexpected.close();
    throw new Error("quick-check corruption unexpectedly opened");
  } catch (cause) {
    expect(cause).toMatchObject({ code: "CORRUPT_STORE" });
  }

  const notDatabasePath = await temporaryDatabase("not-database.sqlite");
  await writeFile(notDatabasePath, "not a SQLite database", { mode: 0o600 });
  await expect(
    openLocalAttuneGraph({ databasePath: notDatabasePath, scope: SCOPE })
  ).rejects.toMatchObject({ code: "CORRUPT_STORE" });
});

it("proves stale cross-Worker CAS, monotone generations, and exact physical counts", async () => {
  const databasePath = await temporaryDatabase("multi-generation.sqlite");
  const firstResource = await openSqliteAttuneGraphStore({
    databasePath,
    testFixtureMode: true
  });
  const secondResource = await openSqliteAttuneGraphStore({
    databasePath,
    testFixtureMode: true
  });
  const first = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(firstResource.backend)
  });
  const second = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(secondResource.backend)
  });

  const generationOne = await first.project(command("generation-one"));
  expect(await second.project(command("generation-one"))).toEqual(generationOne);
  const generationTwo = await first.project({
    ...command("generation-two"),
    expectedSnapshot: generationOne
  });
  await expect(second.project({
    ...command("stale-generation-two"),
    expectedSnapshot: generationOne
  })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });

  const generationThree = await Promise.allSettled([
    first.project({
      ...command("generation-three-a"),
      expectedSnapshot: generationTwo
    }),
    second.project({
      ...command("generation-three-b"),
      expectedSnapshot: generationTwo
    })
  ]);
  expect(generationThree.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    generationThree.filter(
      (result) =>
        result.status === "rejected"
        && (result.reason as { code?: unknown }).code === "SNAPSHOT_CONFLICT"
    )
  ).toHaveLength(1);
  expect(
    generationThree.find((result) => result.status === "fulfilled")?.value
  ).toMatchObject({ generation: 3 });
  expect(await firstResource.inspectForTesting()).toEqual({
    headRows: 1,
    journalRows: 3,
    maxGeneration: 3
  });

  await Promise.all([first.close(), second.close()]);
  await Promise.all([firstResource.close(), secondResource.close()]);

  const database = new DatabaseSync(databasePath, { readBigInts: true, readOnly: true });
  expect(database.prepare("SELECT COUNT(*) AS count FROM attunegraph_projection_journal").get()).toEqual({ count: 3n });
  expect(database.prepare("SELECT COUNT(*) AS count FROM attunegraph_current_manifest").get()).toEqual({ count: 1n });
  expect(database.prepare("SELECT COUNT(*) AS count FROM attunegraph_current_assertion").get()).toEqual({ count: 1n });
  expect(database.prepare("SELECT COUNT(*) AS count FROM attunegraph_current_source_ref").get()).toEqual({ count: 1n });
  expect(database.prepare(
    "SELECT 1 AS found FROM attunegraph_current_assertion WHERE assertion_id IN ('assertion-stale-generation-two', 'assertion-generation-three-a', 'assertion-generation-three-b') LIMIT 2"
  ).all()).toHaveLength(1);
  database.close();
});

it("bounds busy exhaustion without an orphan journal or changed head", async () => {
  const databasePath = await temporaryDatabase("busy.sqlite");
  const contender = await openSqliteAttuneGraphStore({
    databasePath,
    testFixtureMode: true
  });
  const contenderAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(contender.backend)
  });
  const writeLock = new DatabaseSync(databasePath, { timeout: 0 });
  let writeLockHeld = false;

  try {
    try {
      writeLock.exec("BEGIN IMMEDIATE");
      writeLockHeld = true;
      await expect(
        contenderAttuneGraph.project(command("busy-contender"))
      ).rejects.toMatchObject({ code: "STORE_FAILURE" });
      expect(await contender.inspectForTesting()).toEqual({
        headRows: 0,
        journalRows: 0,
        maxGeneration: 0
      });
    } finally {
      try {
        if (writeLockHeld) writeLock.exec("ROLLBACK");
      } finally {
        writeLock.close();
      }
    }
  } finally {
    try {
      await contenderAttuneGraph.close();
    } finally {
      await contender.close();
    }
  }
});

it("awaits request and close timeout termination before the file can reopen", async () => {
  const lateReplyPath = await temporaryDatabase("late-reply.sqlite");
  const lateReply = await openSqliteAttuneGraphStore({
    databasePath: lateReplyPath,
    testResponseDelayMs: 75,
    testTimeoutMs: 50
  });
  const lateReplyAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(lateReply.backend)
  });
  await expect(
    lateReplyAttuneGraph.project(command("late-reply"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await lateReplyAttuneGraph.close();
  const afterLateReply = await openLocalAttuneGraph({
    databasePath: lateReplyPath,
    scope: SCOPE
  });
  await expect(
    afterLateReply.project(command("after-late-reply"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterLateReply.close();

  const readPath = await temporaryDatabase("read-timeout.sqlite");
  const hangingRead = await openSqliteAttuneGraphStore({
    databasePath: readPath,
    testFault: "hang-read",
    testTimeoutMs: 50
  });
  const hangingReadAttuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(hangingRead.backend)
  });
  await expect(
    hangingReadAttuneGraph.project(command("read-timeout"))
  ).rejects.toMatchObject({ code: "STORE_FAILURE" });
  await hangingReadAttuneGraph.close();
  const afterReadTimeout = await openLocalAttuneGraph({
    databasePath: readPath,
    scope: SCOPE
  });
  await expect(
    afterReadTimeout.project(command("after-read-timeout"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterReadTimeout.close();

  const closePath = await temporaryDatabase("close-timeout.sqlite");
  const hangingClose = await openSqliteAttuneGraphStore({
    databasePath: closePath,
    testFault: "hang-close",
    testTimeoutMs: 50
  });
  await expect(hangingClose.close()).rejects.toMatchObject({
    code: "STORE_FAILURE"
  });
  const afterCloseTimeout = await openLocalAttuneGraph({
    databasePath: closePath,
    scope: SCOPE
  });
  await expect(
    afterCloseTimeout.project(command("after-close-timeout"))
  ).resolves.toMatchObject({ generation: 1 });
  await afterCloseTimeout.close();
});
