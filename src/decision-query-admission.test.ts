import { expect, it } from "vitest";

import { createAttuneGraphStore } from "./attunegraph-backend.js";
import type {
  AttuneGraphDecisionQuery,
  AttuneGraphDecisionQueryResult,
  AttuneGraphProjectCommand,
  AttuneGraphScope
} from "./attunegraph-contracts.js";
import { admitDecisionQueryResult, sealDecisionQueryReceipt } from "./decision-query.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import { InMemoryAttuneGraphStoreBackend } from "./attunegraph-in-memory-store.js";
import type { GraphAssertion, GraphRef } from "./types.js";
import { graphRefKey } from "./validation.js";
import { estimateNormalizedWorkingGraphTokens } from "./working-graph.js";

const NOW = "2026-08-01T09:00:00.000Z";
const BEFORE = "2026-08-01T08:00:00.000Z";
const AFTER = "2026-08-01T10:00:00.000Z";
const SCOPE: AttuneGraphScope = { sourceId: "notes", threadId: "admission" };
const ROOT: GraphRef = { kind: "thread", id: "thread:admission" };

function assertion(id = "context"): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject: { kind: "artifact", id: "artifact:context" },
    predicate: "CONTEXT_FOR",
    object: { ...ROOT },
    epistemicClass: "source-observed",
    sourceRefs: [{ namespace: "decision-result-test", id: "source:context" }],
    recordedAt: BEFORE,
    derivation: { kind: "projection", version: "decision-result-test" }
  };
}

function observation(
  key: string,
  freshness: "fresh" | "stale" | "unknown" = "fresh"
): AttuneGraphProjectCommand {
  return {
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: key,
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: freshness, observedAt: NOW },
      assertions: [assertion(), assertion("context-2")]
    }
  };
}

function query(
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

function mutable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key]);
  }
}

async function producerResult(
  freshness: "fresh" | "stale" | "unknown" = "fresh",
  command: AttuneGraphDecisionQuery = query()
): Promise<AttuneGraphDecisionQueryResult> {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project(observation(`producer-${freshness}`, freshness));
  const result = await graph.query(command);
  await graph.close();
  return result;
}

it("roundtrips actual producer complete and zero-selected partial results", async () => {
  const complete = await producerResult();
  const partial = await producerResult("fresh", query({
    budget: { maxEstimatedTokens: 1 }
  }));

  expect(partial).toMatchObject({ status: "partial" });
  expect(partial.workingGraph.assertions).toEqual([]);
  expect(partial.workingGraph.diagnostics.truncationReasons).toEqual(["token-budget"]);
  expect(admitDecisionQueryResult(complete)).toEqual(complete);
  expect(admitDecisionQueryResult(partial)).toEqual(partial);
  expect(admitDecisionQueryResult(mutable(complete))).toEqual(complete);
  expect(admitDecisionQueryResult(mutable(partial))).toEqual(partial);
});

it("binds normalized selected assertion content and seed in receipt revision 2", async () => {
  const produced = await producerResult();
  expect(produced.receipt).toMatchObject({
    contractRevision: 2,
    selectedWorkingGraphId: expect.stringMatching(
      /^attunegraph-selected-working-graph:sha256:[a-f0-9]{64}$/u
    )
  });
  expect(JSON.parse(produced.receipt.canonicalJson)).toMatchObject({
    contractRevision: 2,
    selectedWorkingGraphId: produced.receipt.selectedWorkingGraphId
  });

  const sameLengthDrift = mutable(produced);
  const driftedAssertion = sameLengthDrift.workingGraph.assertions[0]!;
  const before = JSON.stringify(driftedAssertion);
  (driftedAssertion.derivation as { version: string }).version = "decision-result-best";
  expect(JSON.stringify(driftedAssertion)).toHaveLength(before.length);
  expect(sameLengthDrift.workingGraph.diagnostics.estimatedTokens)
    .toBe(produced.workingGraph.diagnostics.estimatedTokens);
  expect(() => admitDecisionQueryResult(sameLengthDrift))
    .toThrow(/receipt does not exactly match/u);

  const resealed = sealDecisionQueryReceipt({
    query: produced.receipt.query,
    snapshot: produced.snapshot ?? null,
    sourceFreshness: produced.sourceFreshness ?? null,
    status: produced.status,
    workingGraph: deepFreeze(sameLengthDrift.workingGraph),
    abstentionReasons: []
  });
  expect(resealed.selectedWorkingGraphId)
    .not.toBe(produced.receipt.selectedWorkingGraphId);
  expect(resealed.receiptId).not.toBe(produced.receipt.receiptId);

  const legacyRevision = mutable(produced);
  (legacyRevision.receipt as { contractRevision: number }).contractRevision = 1;
  expect(() => admitDecisionQueryResult(legacyRevision)).toThrow();
});

it("admits the structurally producer-valid selected-ref overflow at the visited cap", async () => {
  const produced = await producerResult("fresh", query({
    budget: { maxEstimatedTokens: 32_768 }
  }));
  const suffixes = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const assertions = Array.from({ length: 64 }, (_, index): GraphAssertion => ({
    schemaVersion: 1,
    id: suffixes[index]!,
    subject: { kind: "thread", id: suffixes[index]! },
    predicate: "PRECEDED",
    object: { ...ROOT },
    epistemicClass: "user-asserted",
    sourceRefs: [{ namespace: "s", id: "s" }],
    recordedAt: BEFORE,
    derivation: { kind: "rule", version: "v" }
  })).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const seed = deepFreeze(mutable(produced.workingGraph.seed));
  const refs = [...new Map([
    seed,
    ...assertions.flatMap((entry) => [entry.subject, entry.object])
  ].map((ref) => [graphRefKey(ref), ref])).values()]
    .sort((left, right) => graphRefKey(left) < graphRefKey(right) ? -1 : 1)
    .map((ref) => ({ ...ref }));
  const workingGraph = deepFreeze({
    assertions,
    refs,
    seed,
    diagnostics: {
      consideredAssertions: 64,
      estimatedTokens: estimateNormalizedWorkingGraphTokens(assertions, seed),
      maxDepthReached: 1,
      visitedRefs: 64,
      truncationReasons: ["traversal-budget" as const]
    }
  });
  const receipt = sealDecisionQueryReceipt({
    query: produced.receipt.query,
    snapshot: produced.snapshot ?? null,
    sourceFreshness: produced.sourceFreshness ?? null,
    status: "partial",
    workingGraph,
    abstentionReasons: []
  });
  const structural = deepFreeze({
    ...mutable(produced),
    status: "partial" as const,
    workingGraph,
    receipt
  });

  expect(structural.workingGraph.assertions).toHaveLength(64);
  expect(structural.workingGraph.refs).toHaveLength(65);
  expect(structural.workingGraph.diagnostics).toMatchObject({
    consideredAssertions: 64,
    visitedRefs: 64,
    truncationReasons: ["traversal-budget"]
  });
  expect(admitDecisionQueryResult(structural)).toEqual(structural);
  expect(admitDecisionQueryResult(mutable(structural))).toEqual(structural);

  const missingTraversalGraph = deepFreeze({
    ...mutable(structural.workingGraph),
    diagnostics: {
      ...mutable(structural.workingGraph.diagnostics),
      truncationReasons: []
    }
  });
  const missingTraversal = deepFreeze({
    ...mutable(structural),
    status: "complete" as const,
    workingGraph: missingTraversalGraph,
    receipt: sealDecisionQueryReceipt({
      query: structural.receipt.query,
      snapshot: structural.snapshot ?? null,
      sourceFreshness: structural.sourceFreshness ?? null,
      status: "complete",
      workingGraph: missingTraversalGraph,
      abstentionReasons: []
    })
  });
  expect(() => admitDecisionQueryResult(missingTraversal))
    .toThrow(/refs beyond the visited cap require traversal truncation/u);

  const overbound = mutable(structural);
  (overbound.workingGraph.refs as GraphRef[]).push({ kind: "thread", id: "overbound" });
  expect(() => admitDecisionQueryResult(overbound)).toThrow(/at most 65 items/u);
});

it("rejects producer diagnostic closure drift even with a revision-2 receipt", async () => {
  const complete = await producerResult();
  const extraConsideredGraph = deepFreeze({
    ...mutable(complete.workingGraph),
    diagnostics: {
      ...mutable(complete.workingGraph.diagnostics),
      consideredAssertions: complete.workingGraph.assertions.length + 1
    }
  });
  const extraConsidered = deepFreeze({
    ...mutable(complete),
    workingGraph: extraConsideredGraph,
    receipt: sealDecisionQueryReceipt({
      query: complete.receipt.query,
      snapshot: complete.snapshot ?? null,
      sourceFreshness: complete.sourceFreshness ?? null,
      status: complete.status,
      workingGraph: extraConsideredGraph,
      abstentionReasons: []
    })
  });
  expect(() => admitDecisionQueryResult(extraConsidered))
    .toThrow(/consideredAssertions exceeds selection without token truncation/u);

  const partial = await producerResult("fresh", query({
    budget: { maxEstimatedTokens: 1 }
  }));
  const missingRejectedGraph = deepFreeze({
    ...mutable(partial.workingGraph),
    diagnostics: {
      ...mutable(partial.workingGraph.diagnostics),
      consideredAssertions: partial.workingGraph.assertions.length
    }
  });
  const missingRejected = deepFreeze({
    ...mutable(partial),
    workingGraph: missingRejectedGraph,
    receipt: sealDecisionQueryReceipt({
      query: partial.receipt.query,
      snapshot: partial.snapshot ?? null,
      sourceFreshness: partial.sourceFreshness ?? null,
      status: partial.status,
      workingGraph: missingRejectedGraph,
      abstentionReasons: []
    })
  });
  expect(() => admitDecisionQueryResult(missingRejected))
    .toThrow(/token truncation has no rejected considered assertion/u);
});

it("roundtrips actual producer terminal abstentions", async () => {
  const empty = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const noHead = await empty.query(query());
  await empty.close();

  const stale = await producerResult("stale");
  const unknown = await producerResult("unknown");
  const noEvidence = await producerResult("fresh", query({
    seed: { kind: "thread", id: "thread:unrelated" }
  }));

  for (const result of [noHead, stale, unknown, noEvidence]) {
    expect(admitDecisionQueryResult(mutable(result))).toEqual(result);
  }
});

it("rejects a canonically reminted impossible low-token result", async () => {
  const produced = await producerResult();
  const impossibleWorkingGraph = deepFreeze({
    ...mutable(produced.workingGraph),
    assertions: [{
      ...mutable(produced.workingGraph.assertions[0]!),
      id: "x".repeat(512)
    }],
    diagnostics: {
      ...mutable(produced.workingGraph.diagnostics),
      estimatedTokens: 13
    }
  });
  const remintedReceipt = sealDecisionQueryReceipt({
    query: produced.receipt.query,
    snapshot: produced.snapshot ?? null,
    sourceFreshness: produced.sourceFreshness ?? null,
    status: produced.status,
    workingGraph: impossibleWorkingGraph,
    abstentionReasons: []
  });
  const impossible = deepFreeze({
    ...mutable(produced),
    workingGraph: impossibleWorkingGraph,
    receipt: remintedReceipt
  });

  expect(() => admitDecisionQueryResult(impossible)).toThrow(/estimatedTokens/u);

  const impossibleBudgetQuery = deepFreeze({
    ...mutable(produced.receipt.query),
    budget: { maxEstimatedTokens: 1 }
  });
  const impossibleBudgetReceipt = sealDecisionQueryReceipt({
    query: impossibleBudgetQuery,
    snapshot: produced.snapshot ?? null,
    sourceFreshness: produced.sourceFreshness ?? null,
    status: produced.status,
    workingGraph: produced.workingGraph,
    abstentionReasons: []
  });
  const impossibleBudget = deepFreeze({
    ...mutable(produced),
    receipt: impossibleBudgetReceipt
  });
  expect(() => admitDecisionQueryResult(impossibleBudget)).toThrow(/token budget/u);
});

it("rejects canonically reminted temporally ineligible assertions", async () => {
  const produced = await producerResult();
  const temporalDrifts: readonly Partial<GraphAssertion>[] = [
    { recordedAt: AFTER },
    { validFrom: AFTER },
    { validTo: NOW },
    { supersededAt: NOW }
  ];

  for (const temporal of temporalDrifts) {
    const assertions = [
      { ...mutable(produced.workingGraph.assertions[0]!), ...temporal },
      ...mutable(produced.workingGraph.assertions.slice(1))
    ] as GraphAssertion[];
    const seed = deepFreeze(mutable(produced.workingGraph.seed));
    const workingGraph = deepFreeze({
      ...mutable(produced.workingGraph),
      assertions,
      seed,
      diagnostics: {
        ...mutable(produced.workingGraph.diagnostics),
        estimatedTokens: estimateNormalizedWorkingGraphTokens(assertions, seed)
      }
    });
    const receipt = sealDecisionQueryReceipt({
      query: produced.receipt.query,
      snapshot: produced.snapshot ?? null,
      sourceFreshness: produced.sourceFreshness ?? null,
      status: produced.status,
      workingGraph,
      abstentionReasons: []
    });
    const reminted = deepFreeze({
      ...mutable(produced),
      workingGraph,
      receipt
    });
    expect(() => admitDecisionQueryResult(reminted)).toThrow(/temporally ineligible/u);
  }
});

it("rejects result, receipt, closure, and ordering drift", async () => {
  const produced = await producerResult();
  const mutations: Array<(value: AttuneGraphDecisionQueryResult) => void> = [
    (value) => { (value.workingGraph.assertions[0] as { id: string }).id = "tampered"; },
    (value) => { (value.receipt as { receiptId: string }).receiptId = "attunegraph-decision-query:tampered"; },
    (value) => { (value.workingGraph.refs as GraphRef[]).push({ kind: "thread", id: "extra" }); },
    (value) => { (value.workingGraph.seed as { id: string }).id = "thread:drift"; },
    (value) => { (value.workingGraph.diagnostics as { estimatedTokens: number }).estimatedTokens += 1; },
    (value) => { (value as { status: string }).status = "partial"; },
    (value) => { (value.receipt.query.scope as { threadId: string }).threadId = "other"; }
  ];

  for (const mutate of mutations) {
    const candidate = mutable(produced);
    mutate(candidate);
    expect(() => admitDecisionQueryResult(candidate)).toThrow();
  }
});

it("rejects hostile non-JSON shapes without invoking accessors", async () => {
  const produced = await producerResult();
  const candidates: unknown[] = [];

  const aliased = mutable(produced);
  (aliased.workingGraph.refs as GraphRef[])[0] = aliased.workingGraph.seed;
  candidates.push(aliased);

  let getterCalls = 0;
  const accessor = mutable(produced) as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "status", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return "complete";
    }
  });
  candidates.push(accessor);

  const hidden = mutable(produced) as unknown as Record<string, unknown>;
  Object.defineProperty(hidden, "hidden", { value: true });
  candidates.push(hidden);

  const extra = mutable(produced) as unknown as Record<string, unknown>;
  extra.extra = true;
  candidates.push(extra);

  const symbol = mutable(produced) as unknown as Record<PropertyKey, unknown>;
  symbol[Symbol("hidden")] = true;
  candidates.push(symbol);

  const sparse = mutable(produced);
  (sparse.workingGraph as unknown as { refs: GraphRef[] }).refs = new Array(1);
  candidates.push(sparse);

  const nan = mutable(produced);
  (nan.workingGraph.diagnostics as { estimatedTokens: number }).estimatedTokens = Number.NaN;
  candidates.push(nan);

  const infinity = mutable(produced);
  (infinity.workingGraph.diagnostics as { estimatedTokens: number }).estimatedTokens = Number.POSITIVE_INFINITY;
  candidates.push(infinity);

  const malformedUnicode = mutable(produced);
  (malformedUnicode.workingGraph.seed as { id: string }).id = "thread:\uD800";
  candidates.push(malformedUnicode);

  const unsafePrototype = mutable(produced);
  Object.setPrototypeOf(unsafePrototype.workingGraph, { unsafe: true });
  candidates.push(unsafePrototype);
  candidates.push(new Proxy(mutable(produced), {}));

  for (const candidate of candidates) {
    expect(() => admitDecisionQueryResult(candidate)).toThrow();
  }
  expect(getterCalls).toBe(0);
});

it("rejects oversized arrays from the length descriptor before property walks", () => {
  const candidates = [
    new Array(32_769),
    new Array(1_000_000).fill(null)
  ];
  const originalDescriptor = Object.getOwnPropertyDescriptor;
  const originalDescriptors = Object.getOwnPropertyDescriptors;

  for (const candidate of candidates) {
    const inspectedKeys: PropertyKey[] = [];
    let bulkDescriptorCalls = 0;
    Object.getOwnPropertyDescriptor = ((target: object, key: PropertyKey) => {
      if (target === candidate) inspectedKeys.push(key);
      return originalDescriptor(target, key);
    }) as typeof Object.getOwnPropertyDescriptor;
    Object.getOwnPropertyDescriptors = ((target: object) => {
      if (target === candidate) bulkDescriptorCalls += 1;
      return originalDescriptors(target);
    }) as typeof Object.getOwnPropertyDescriptors;
    try {
      expect(() => admitDecisionQueryResult(candidate))
        .toThrow(/safe JSON descriptor cap/u);
    } finally {
      Object.getOwnPropertyDescriptor = originalDescriptor;
      Object.getOwnPropertyDescriptors = originalDescriptors;
    }
    expect(inspectedKeys).toEqual(["length"]);
    expect(bulkDescriptorCalls).toBe(0);
  }
});

it("returns a detached deeply frozen result and is root-public", async () => {
  const input = mutable(await producerResult());
  const admitted = admitDecisionQueryResult(input);

  expect(admitted).not.toBe(input);
  expect(admitted.workingGraph).not.toBe(input.workingGraph);
  expectDeepFrozen(admitted);
  (input.workingGraph.assertions[0] as { id: string }).id = "mutated-after-admission";
  (input.receipt.query.scope as { threadId: string }).threadId = "mutated-after-admission";
  expect(admitted.workingGraph.assertions[0]?.id).toBe("context");
  expect(admitted.receipt.query.scope.threadId).toBe("admission");

  const root = await import("./index.js");
  expect(root.admitDecisionQueryResult).toBe(admitDecisionQueryResult);
});
