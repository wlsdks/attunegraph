import { Buffer } from "node:buffer";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it } from "vitest";

import type {
  AttuneGraphProjectCommand,
  AttuneGraphScope
} from "./attunegraph-contracts.js";
import { openLocalAttuneGraph } from "./local.js";
import {
  readLocalAttuneGraphWorkingGraph
} from "./readonly-working-graph.js";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 } from "./attunegraph-physical-schema-v1.mjs";

const NOW = "2026-08-02T00:00:00.000Z";
const SCOPE: AttuneGraphScope = {
  sourceId: "readonly-source",
  threadId: "readonly-thread"
};
const temporaryDirectories: string[] = [];

async function temporaryDatabase(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "attunegraph-readonly-working-graph-"))
  );
  temporaryDirectories.push(directory);
  return join(directory, "attunegraph.sqlite");
}

function projectCommand(key: string): AttuneGraphProjectCommand {
  const threadRoot = { id: SCOPE.threadId, kind: "thread" as const };
  return {
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: key,
      scope: SCOPE,
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
        sourceRefs: [{ id: `source-ref-${key}`, namespace: "readonly.test" }],
        recordedAt: NOW,
        derivation: { kind: "projection", version: "readonly-test@1" }
      }]
    }
  };
}

function workingGraphCommand() {
  return {
    operator: "working-graph@1" as const,
    seed: { id: SCOPE.threadId, kind: "thread" as const },
    now: NOW,
    maxEstimatedTokens: 256
  };
}

async function bootstrapPhysicalV1(databasePath: string): Promise<void> {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createJournal};
      ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createGenerationIndex};
      ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createHead};
      PRAGMA application_id = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId};
      PRAGMA user_version = ${ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion};
    `);
  } finally {
    database.close();
  }
  await chmod(databasePath, 0o600);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

it("reads a Working Graph from a closed physical-v2 local store", async () => {
  const databasePath = await temporaryDatabase();
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await graph.project(projectCommand("physical-v2"));
  const expected = await graph.execute(workingGraphCommand());
  await graph.close();

  await expect(readLocalAttuneGraphWorkingGraph({
    command: workingGraphCommand(),
    databasePath,
    scope: SCOPE
  })).resolves.toEqual(expected);
});

it("preserves exact legacy text reads from a closed physical-v1 store", async () => {
  const databasePath = await temporaryDatabase();
  await bootstrapPhysicalV1(databasePath);
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await graph.project(projectCommand("physical-v1"));
  const expected = await graph.execute(workingGraphCommand());
  await graph.close();

  await expect(readLocalAttuneGraphWorkingGraph({
    command: workingGraphCommand(),
    databasePath,
    scope: SCOPE
  })).resolves.toEqual(expected);
});

it("rejects a corrupt physical-v2 projection payload as CORRUPT_STORE", async () => {
  const databasePath = await temporaryDatabase();
  const graph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  await graph.project(projectCommand("corrupt-v2"));
  await graph.close();

  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare(
      "SELECT projection_payload AS payload FROM attunegraph_projection_journal"
    ).get() as { readonly payload: Uint8Array };
    const corrupt = Buffer.from(row.payload);
    corrupt[0] = corrupt[0]! ^ 0xff;
    database.prepare(
      "UPDATE attunegraph_projection_journal SET projection_payload = ?"
    ).run(corrupt);
  } finally {
    database.close();
  }

  await expect(readLocalAttuneGraphWorkingGraph({
    command: workingGraphCommand(),
    databasePath,
    scope: SCOPE
  })).rejects.toMatchObject({ code: "CORRUPT_STORE" });
});
