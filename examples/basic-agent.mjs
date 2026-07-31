import {
  openAttuneGraph
} from "@attunegraph/core";
import {
  createInMemoryAttuneGraphStore
} from "@attunegraph/core/testing";

const scope = { sourceId: "support-desk", threadId: "incident-42" };
const threadRoot = { id: "thread:incident-42", kind: "thread" };
const now = "2026-07-31T09:00:00.000Z";

const graph = await openAttuneGraph({
  scope,
  store: createInMemoryAttuneGraphStore()
});

await graph.project({
  operator: "canonical-projection@2",
  observation: {
    schemaVersion: 2,
    observationKey: "incident-42-revision-1",
    scope,
    threadRoot,
    observedAt: now,
    sourceFreshness: { state: "fresh", observedAt: now },
    assertions: [{
      schemaVersion: 1,
      id: "incident-42-is-blocked-by-database",
      subject: { kind: "artifact", id: "database-runbook" },
      predicate: "LINKED_TO",
      object: { ...threadRoot },
      epistemicClass: "source-observed",
      sourceRefs: [{ namespace: "support.example", id: "INC-42" }],
      recordedAt: now,
      derivation: { kind: "projection", version: "support-sync@1" }
    }]
  }
});

const result = await graph.execute({
  operator: "working-graph@1",
  seed: threadRoot,
  now,
  maxEstimatedTokens: 500
});

console.log(JSON.stringify({ status: result.status, workingGraph: result.workingGraph }, null, 2));
await graph.close();
