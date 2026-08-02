import { expect, it } from "vitest";

import { createAttuneGraphStore, type AttuneGraphStoreBackend } from "./attunegraph-backend.js";
import type {
  AttuneGraphDecisionQuery,
  AttuneGraphProjectCommand,
  AttuneGraphScope
} from "./attunegraph-contracts.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import { InMemoryAttuneGraphStoreBackend } from "./attunegraph-in-memory-store.js";
import { parseAttuneQL } from "./attuneql.js";
import type { GraphAssertion, GraphPredicate, GraphRef } from "./types.js";

const NOW = "2026-08-01T09:00:00.000Z";
const BEFORE = "2026-08-01T08:00:00.000Z";
const AFTER = "2026-08-01T10:00:00.000Z";
const SCOPE: AttuneGraphScope = { sourceId: "notes", threadId: "trip-planning" };
const ROOT: GraphRef = { kind: "thread", id: "thread:trip-planning" };

function assertion(
  id: string,
  subject: GraphRef,
  predicate: GraphPredicate,
  object: GraphRef,
  temporal: Partial<Pick<GraphAssertion, "recordedAt" | "validFrom" | "validTo" | "supersededAt">> = {}
): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject: { kind: subject.kind, id: subject.id },
    predicate,
    object: { kind: object.kind, id: object.id },
    epistemicClass: "source-observed",
    sourceRefs: [{
      namespace: id === "active" ? "z-source" : id === "at-start" ? "ä-source" : "decision-query-test",
      id: `source:${id}`
    }],
    recordedAt: temporal.recordedAt ?? BEFORE,
    ...(temporal.validFrom ? { validFrom: temporal.validFrom } : {}),
    ...(temporal.validTo ? { validTo: temporal.validTo } : {}),
    ...(temporal.supersededAt ? { supersededAt: temporal.supersededAt } : {}),
    derivation: { kind: "projection", version: "decision-query-test" }
  };
}

function observation(
  key: string,
  freshness: "fresh" | "stale" | "unknown" = "fresh"
): AttuneGraphProjectCommand {
  const action: GraphRef = { kind: "action", id: "action:book" };
  return {
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: key,
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: freshness, observedAt: NOW },
      assertions: [
        assertion("active", { kind: "artifact", id: "hotel-comparison" }, "CONTEXT_FOR", ROOT),
        assertion("at-start", { kind: "artifact", id: "flight-change" }, "CONTEXT_FOR", ROOT, { validFrom: NOW }),
        assertion("expired", { kind: "artifact", id: "expired" }, "CONTEXT_FOR", ROOT, { validTo: NOW }),
        assertion("future-valid", { kind: "artifact", id: "future-valid" }, "CONTEXT_FOR", ROOT, { validFrom: AFTER }),
        assertion("future-recorded", { kind: "artifact", id: "future-recorded" }, "CONTEXT_FOR", ROOT, { recordedAt: AFTER }),
        assertion("superseded", { kind: "artifact", id: "superseded" }, "CONTEXT_FOR", ROOT, { supersededAt: NOW }),
        assertion("governance-context", action, "CORRELATES_WITH", ROOT),
        assertion("authority-evidence", action, "AUTHORIZED_BY", { kind: "evidence", id: "approval-receipt" })
      ]
    }
  };
}

function objectQuery(
  overrides: Partial<AttuneGraphDecisionQuery> = {}
): AttuneGraphDecisionQuery {
  return {
    operator: "decision-query@1",
    scope: SCOPE,
    seed: ROOT,
    asOf: NOW,
    head: { mode: "current" },
    freshness: { require: "fresh" },
    budget: { maxEstimatedTokens: 4_000 },
    ...overrides
  };
}

function textQuery(head = "CURRENT HEAD", tokens = 4_000): AttuneGraphDecisionQuery {
  return parseAttuneQL(`
    EVIDENCE FOR thread("thread:trip-planning")
    IN SCOPE("notes", "trip-planning")
    AS OF "${NOW}"
    AT ${head}
    REQUIRE FRESH
    BUDGET ${tokens.toString()} TOKENS;
  `);
}

it("executes object and AttuneQL forms as one deterministic evidence-only contract", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const snapshot = await graph.project(observation("equivalence"));

  const objectResult = await graph.query(objectQuery());
  const textResult = await graph.query(textQuery());
  const exactResult = await graph.query(textQuery(
    `HEAD ${snapshot.generation.toString()} ${JSON.stringify(snapshot.commitId)}`
  ));

  expect(JSON.stringify(textResult)).toBe(JSON.stringify(objectResult));
  expect(JSON.stringify(exactResult.workingGraph)).toBe(JSON.stringify(objectResult.workingGraph));
  expect(objectResult.status).toBe("complete");
  expect(objectResult.use).toBe("evidence-only");
  expect(objectResult.workingGraph.assertions.map((entry) => entry.id)).toEqual([
    "active",
    "at-start",
    "governance-context",
    "authority-evidence"
  ]);
  expect(objectResult.receipt.diagnostics).toMatchObject({
    authorityEvaluation: "not-performed",
    conflictClosure: "not-performed",
    abstentionReasons: []
  });
  expect(objectResult.receipt.witness.sourceRefs.map((entry) => entry.namespace)).toEqual([
    "decision-query-test",
    "decision-query-test",
    "z-source",
    "ä-source"
  ]);
  expect(objectResult.receipt.receiptId).toMatch(/^attunegraph-decision-query:/u);
  expect(JSON.parse(objectResult.receipt.canonicalJson)).toMatchObject({
    contractRevision: 2,
    receiptId: objectResult.receipt.receiptId,
    selectedWorkingGraphId: objectResult.receipt.selectedWorkingGraphId,
    use: "evidence-only"
  });
  expect(objectResult.receipt.selectedWorkingGraphId)
    .toMatch(/^attunegraph-selected-working-graph:sha256:[a-f0-9]{64}$/u);
  expect(Object.isFrozen(objectResult.receipt)).toBe(true);
  await graph.close();
});

it("seeds the exact committed plan for the first query and still re-admits a changed head", async () => {
  const backing = new InMemoryAttuneGraphStoreBackend();
  let compareAndSwaps = 0;
  let headReads = 0;
  let projectionReads = 0;
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore({
      async read(scope) {
        projectionReads += 1;
        return backing.read(scope);
      },
      async readHead(scope) {
        headReads += 1;
        return backing.readHead(scope);
      },
      async compareAndSwap(scope, expected, proposed) {
        compareAndSwaps += 1;
        return backing.compareAndSwap(scope, expected, proposed);
      }
    })
  });

  await graph.projectAgainstHead(observation("prepared-plan-seed"));
  expect({ compareAndSwaps, headReads, projectionReads }).toEqual({
    compareAndSwaps: 1,
    headReads: 0,
    projectionReads: 1
  });

  const first = await graph.query(objectQuery());
  const repeated = await graph.query(objectQuery());
  expect(JSON.stringify(repeated)).toBe(JSON.stringify(first));
  expect({ compareAndSwaps, headReads, projectionReads }).toEqual({
    compareAndSwaps: 1,
    headReads: 2,
    projectionReads: 1
  });

  const cold = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(backing)
  });
  expect(JSON.stringify(await cold.query(objectQuery()))).toBe(JSON.stringify(first));
  await cold.close();

  const writer = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(backing)
  });
  await writer.projectAgainstHead(observation("prepared-plan-changed-head"));
  const changed = await graph.query(objectQuery());
  expect(changed.snapshot).toMatchObject({ generation: 2 });
  expect({ compareAndSwaps, headReads, projectionReads }).toEqual({
    compareAndSwaps: 1,
    headReads: 3,
    projectionReads: 2
  });
  const changedCold = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(backing)
  });
  expect(JSON.stringify(await changedCold.query(objectQuery())))
    .toBe(JSON.stringify(changed));

  await Promise.all([graph.close(), writer.close(), changedCold.close()]);
});

it("seeds exact replay and concurrent identical-winner plans without a post-convergence full read", async () => {
  const replayBacking = new InMemoryAttuneGraphStoreBackend();
  let replayHeadReads = 0;
  let replayProjectionReads = 0;
  let replaySwaps = 0;
  const replayGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore({
      async read(scope) {
        replayProjectionReads += 1;
        return replayBacking.read(scope);
      },
      async readHead(scope) {
        replayHeadReads += 1;
        return replayBacking.readHead(scope);
      },
      async compareAndSwap(scope, expected, proposed) {
        replaySwaps += 1;
        return replayBacking.compareAndSwap(scope, expected, proposed);
      }
    })
  });
  const replayCommand = observation("prepared-plan-replay");
  const committed = await replayGraph.projectAgainstHead(replayCommand);
  const replayed = await replayGraph.projectAgainstHead(replayCommand);
  expect(replayed).toEqual(committed);
  expect({ replayProjectionReads, replaySwaps }).toEqual({
    replayProjectionReads: 2,
    replaySwaps: 1
  });
  replayHeadReads = 0;
  replayProjectionReads = 0;
  await replayGraph.query(objectQuery());
  expect({ replayHeadReads, replayProjectionReads }).toEqual({
    replayHeadReads: 1,
    replayProjectionReads: 0
  });
  await replayGraph.close();

  const concurrentBacking = new InMemoryAttuneGraphStoreBackend();
  let initialReads = 0;
  const barrier = (() => {
    let release: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release: () => release?.() };
  })();
  const counters: [
    { headReads: number; projectionReads: number },
    { headReads: number; projectionReads: number }
  ] = [
    { headReads: 0, projectionReads: 0 },
    { headReads: 0, projectionReads: 0 }
  ];
  const openContender = (index: 0 | 1) => openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore({
      async read(scope) {
        counters[index].projectionReads += 1;
        initialReads += 1;
        if (initialReads <= 2) {
          if (initialReads === 2) barrier.release();
          await barrier.promise;
        }
        return concurrentBacking.read(scope);
      },
      async readHead(scope) {
        counters[index].headReads += 1;
        return concurrentBacking.readHead(scope);
      },
      compareAndSwap: concurrentBacking.compareAndSwap.bind(concurrentBacking)
    })
  });
  const [left, right] = await Promise.all([openContender(0), openContender(1)]);
  const same = observation("prepared-plan-concurrent-winner");
  const [leftSnapshot, rightSnapshot] = await Promise.all([
    left.projectAgainstHead(same),
    right.projectAgainstHead(same)
  ]);
  expect(rightSnapshot).toEqual(leftSnapshot);
  expect(counters.map(({ projectionReads }) => projectionReads).sort())
    .toEqual([1, 2]);
  const readsBeforeQueries = counters.map(({ projectionReads }) => projectionReads);

  const [leftResult, rightResult] = await Promise.all([
    left.query(objectQuery()),
    right.query(objectQuery())
  ]);
  expect(JSON.stringify(rightResult)).toBe(JSON.stringify(leftResult));
  expect(counters.map(({ headReads }) => headReads)).toEqual([1, 1]);
  expect(counters.map(({ projectionReads }) => projectionReads))
    .toEqual(readsBeforeQueries);
  await Promise.all([left.close(), right.close()]);
});

it("settles partial evidence by locale-independent code-unit order", async () => {
  const single = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await single.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "single-ordering-budget",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [assertion("Z", { kind: "artifact", id: "artifact-Z" }, "CONTEXT_FOR", ROOT)]
    }
  });
  const oneAssertion = await single.query(objectQuery());
  const oneAssertionBudget = oneAssertion.workingGraph.diagnostics.estimatedTokens;
  await single.close();

  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "locale-independent-ordering",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        assertion("a", { kind: "artifact", id: "artifact-a" }, "CONTEXT_FOR", ROOT),
        assertion("Z", { kind: "artifact", id: "artifact-Z" }, "CONTEXT_FOR", ROOT)
      ]
    }
  });

  const query = objectQuery({ budget: { maxEstimatedTokens: oneAssertionBudget } });
  const first = await graph.query(query);
  const second = await graph.query(query);
  expect(first.status).toBe("partial");
  expect(first.workingGraph.assertions.map((entry) => entry.id)).toEqual(["Z"]);
  expect(first.receipt.diagnostics.truncationReasons).toEqual(["token-budget"]);
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  await graph.close();
});

it("makes no-head, freshness, empty, and budget outcomes explicit", async () => {
  const empty = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const noHead = await empty.query(objectQuery());
  expect(noHead).toMatchObject({ status: "abstained" });
  expect(noHead.receipt.diagnostics.abstentionReasons).toEqual(["no-head"]);
  await expect(empty.query(objectQuery({
    head: { mode: "exact", generation: 1, commitId: "missing" }
  }))).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  await empty.close();

  for (const state of ["stale", "unknown"] as const) {
    const graph = await openAttuneGraph({
      scope: SCOPE,
      store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
    });
    await graph.project(observation(`freshness-${state}`, state));
    const result = await graph.query(objectQuery());
    expect(result.status).toBe("abstained");
    expect(result.sourceFreshness?.state).toBe(state);
    expect(result.workingGraph.assertions).toEqual([]);
    expect(result.receipt.diagnostics.abstentionReasons).toEqual(["source-not-fresh"]);
    await graph.close();
  }

  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project(observation("terminal-states"));
  const partial = await graph.query(objectQuery({ budget: { maxEstimatedTokens: 1 } }));
  expect(partial.status).toBe("partial");
  expect(partial.receipt.diagnostics.truncationReasons).toEqual(["token-budget"]);
  expect(partial.receipt.diagnostics.abstentionReasons).toEqual([]);
  const abstained = await graph.query(objectQuery({ seed: { kind: "thread", id: "unrelated" } }));
  expect(abstained.status).toBe("abstained");
  expect(abstained.receipt.diagnostics.abstentionReasons).toEqual(["no-eligible-evidence"]);
  await graph.close();
});

it("rejects hostile input, scope drift, and exact-head drift before returning evidence", async () => {
  const backing = new InMemoryAttuneGraphStoreBackend();
  let reads = 0;
  let headReads = 0;
  const counted: AttuneGraphStoreBackend = {
    async read(scope) {
      reads += 1;
      return backing.read(scope);
    },
    async readHead(scope) {
      headReads += 1;
      return backing.readHead(scope);
    },
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const graph = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(counted) });

  await expect(graph.query(new Proxy(objectQuery(), {}) as never))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.query({ ...objectQuery(), operator: "decision-query@2" } as never))
    .rejects.toMatchObject({ code: "UNSUPPORTED_OPERATOR" });
  await expect(graph.query({ ...objectQuery(), extra: true } as never))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.query({ ...objectQuery(), asOf: "2026-08-01T09:00:00Z" } as never))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.query({ ...objectQuery(), budget: { maxEstimatedTokens: 0 } } as never))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.query({
    ...objectQuery(),
    seed: { kind: "thread", id: "thread:trip-\uD800planning" }
  } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const accessor = { ...objectQuery() } as Record<string, unknown>;
  Object.defineProperty(accessor, "seed", {
    enumerable: true,
    get: () => ROOT
  });
  await expect(graph.query(accessor as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.query(objectQuery({
    scope: { sourceId: "other", threadId: "scope" }
  }))).rejects.toMatchObject({ code: "INVALID_SCOPE" });
  expect({ reads, headReads }).toEqual({ reads: 0, headReads: 0 });

  const snapshot = await graph.project(observation("exact-head"));
  reads = 0;
  headReads = 0;
  await expect(graph.query(objectQuery({
    head: {
      mode: "exact",
      generation: snapshot.generation + 1,
      commitId: snapshot.commitId
    }
  }))).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  expect(headReads).toBeGreaterThan(0);
  expect(reads).toBe(0);
  await graph.close();
});
