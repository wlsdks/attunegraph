import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAttuneGraph, type GraphAssertion } from "./index.js";
import { createInMemoryAttuneGraphStore } from "./testing.js";
import { createAttuneGraphStore, type AttuneGraphStoreBackend } from "./attunegraph-backend.js";
import { InMemoryAttuneGraphStoreBackend } from "./attunegraph-in-memory-store.js";
import { canonicalizeImmutableEnvelope } from "./canonical-immutable-envelope.js";
import { openLocalAttuneGraph } from "./local.js";

const scope = { sourceId: "transition-source", threadId: "transition-thread" };
const now = "2026-08-01T00:00:00.000Z";
const later = "2026-08-01T00:01:00.000Z";

function assertion(id: string, sourceId = "contact-7"): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject: { kind: "artifact", id: `artifact-${id}` },
    predicate: "LINKED_TO",
    object: { kind: "thread", id: scope.threadId },
    epistemicClass: "deterministic-derived",
    sourceRefs: [{ namespace: "crm", id: sourceId, version: "v1" }],
    recordedAt: now,
    derivation: { kind: "rule", version: "test@1" }
  };
}

function replacement(
  assertions: readonly GraphAssertion[] = [],
  overrides: Partial<{
    readonly threadRoot: { readonly kind: "thread"; readonly id: string };
    readonly observedAt: string;
    readonly sourceFreshness: { readonly state: "fresh" | "stale" | "unknown"; readonly observedAt: string };
  }> = {}
) {
  const observedAt = overrides.observedAt ?? later;
  return {
    operator: "canonical-projection@2" as const,
    observation: {
      schemaVersion: 2 as const,
      threadRoot: overrides.threadRoot ?? { kind: "thread" as const, id: scope.threadId },
      observationKey: `replacement-${observedAt}`,
      scope,
      observedAt,
      sourceFreshness: overrides.sourceFreshness ?? { state: "fresh" as const, observedAt },
      assertions
    }
  };
}

async function preparedGraph(
  store = createInMemoryAttuneGraphStore(),
  assertions: readonly GraphAssertion[] = [assertion("revoked")]
) {
  const graph = await openAttuneGraph({ scope, store });
  const prior = await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      threadRoot: { kind: "thread", id: scope.threadId },
      observationKey: "prepared-predecessor",
      scope,
      observedAt: now,
      sourceFreshness: { state: "fresh", observedAt: now },
      assertions
    }
  });
  const plan = await graph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] },
    maxAssertions: 16,
    maxConsideredAssertions: 4096
  });
  return { graph, prior, plan };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key]);
  }
}

function resealReceipt(
  receiptCanonicalJson: string,
  mutate: (receipt: Record<string, unknown>) => void
): string {
  const receipt = JSON.parse(receiptCanonicalJson) as Record<string, unknown>;
  delete receipt.receiptId;
  mutate(receipt);
  return canonicalizeImmutableEnvelope(receipt, "external-mutable", {
    hashDomain: "attunegraph.revocation-impact.v1",
    idField: "receiptId",
    idPrefix: "attunegraph-revocation-impact:"
  }).canonicalJson;
}

it("commits a complete impact plan only through a fresh v2 authoritative replacement, then replays it", async () => {
  const graph = await openAttuneGraph({ scope, store: createInMemoryAttuneGraphStore() });
  const prior = await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      threadRoot: { kind: "thread", id: scope.threadId },
      observationKey: "before-revocation",
      scope,
      observedAt: now,
      sourceFreshness: { state: "fresh", observedAt: now },
      assertions: [assertion("revoked")]
    }
  });
  const plan = await graph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] },
    maxAssertions: 16,
    maxConsideredAssertions: 4096
  });
  const command = {
    operator: "revocation-transition@1" as const,
    receiptCanonicalJson: plan.receipt.canonicalJson,
    replacement: {
      operator: "canonical-projection@2" as const,
      observation: {
        schemaVersion: 2 as const,
        threadRoot: { kind: "thread" as const, id: scope.threadId },
        observationKey: "after-revocation",
        scope,
        observedAt: later,
        sourceFreshness: { state: "fresh" as const, observedAt: later },
        assertions: []
      }
    }
  };

  const committed = await graph.applyRevocationTransition(command);
  expect(committed.disposition).toBe("committed");
  if (committed.disposition !== "committed") throw new Error("expected initial commit");
  expect(committed).toMatchObject({
    operator: "revocation-transition@1",
    disposition: "committed",
    receipt: { priorSnapshot: prior, plannedImpactIds: ["revoked"], zeroResidueProof: { impactIds: 0, selectorMatches: 0, witnessAssertionRefs: 0 } }
  });
  expectDeepFrozen(committed);
  await expect(graph.applyRevocationTransition(command)).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
});

it("rejects malformed receipt canonical JSON before Store I/O", async () => {
  let reads = 0;
  let swaps = 0;
  const store = createAttuneGraphStore({
    async read() { reads += 1; return undefined; },
    async compareAndSwap() { swaps += 1; return false; }
  });
  const graph = await openAttuneGraph({ scope, store });
  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: "{}",
    replacement: {} as never
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect({ reads, swaps }).toEqual({ reads: 0, swaps: 0 });
  await graph.close();
});

it("rejects an addition instead of treating a source replacement as arbitrary overwrite", async () => {
  const graph = await openAttuneGraph({ scope, store: createInMemoryAttuneGraphStore() });
  const prior = await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      threadRoot: { kind: "thread", id: scope.threadId },
      observationKey: "before-addition",
      scope,
      observedAt: now,
      sourceFreshness: { state: "fresh", observedAt: now },
      assertions: [assertion("revoked")]
    }
  });
  const plan = await graph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] },
    maxAssertions: 16,
    maxConsideredAssertions: 4096
  });
  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: plan.receipt.canonicalJson,
    replacement: {
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        threadRoot: { kind: "thread", id: scope.threadId },
        observationKey: "attempt-addition",
        scope,
        observedAt: later,
        sourceFreshness: { state: "fresh", observedAt: later },
        assertions: [assertion("unplanned-addition")]
      }
    }
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.head()).resolves.toEqual(prior);
});

class ConcurrentWinnerStore extends InMemoryAttuneGraphStoreBackend {
  private loseNextTransition = false;
  casCalls = 0;

  convergeNextTransition(): void {
    this.loseNextTransition = true;
  }

  override async compareAndSwap(...args: Parameters<AttuneGraphStoreBackend["compareAndSwap"]>): Promise<boolean> {
    this.casCalls += 1;
    if (!this.loseNextTransition) return super.compareAndSwap(...args);
    this.loseNextTransition = false;
    await super.compareAndSwap(...args);
    return false;
  }
}

it("converges only when its one CAS loses to the identical validated replacement", async () => {
  const backend = new ConcurrentWinnerStore();
  const graph = await openAttuneGraph({ scope, store: createAttuneGraphStore(backend) });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      threadRoot: { kind: "thread", id: scope.threadId },
      observationKey: "before-race",
      scope,
      observedAt: now,
      sourceFreshness: { state: "fresh", observedAt: now },
      assertions: [assertion("revoked")]
    }
  });
  const plan = await graph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] },
    maxAssertions: 16,
    maxConsideredAssertions: 4096
  });
  backend.convergeNextTransition();
  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: plan.receipt.canonicalJson,
    replacement: {
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        threadRoot: { kind: "thread", id: scope.threadId },
        observationKey: "after-race",
        scope,
        observedAt: later,
        sourceFreshness: { state: "fresh", observedAt: later },
        assertions: []
      }
    }
  })).resolves.toMatchObject({ disposition: "converged" });
  expect(backend.casCalls).toBe(2);
});

it("rejects semantically inconsistent complete receipts before Store I/O", async () => {
  const source = await preparedGraph();
  const emptyComplete = resealReceipt(source.plan.receipt.canonicalJson, (receipt) => {
    receipt.impacts = [];
    receipt.diagnostics = { consideredAssertions: 1, directMatches: 0, truncationReasons: [] };
    receipt.status = "complete";
  });
  let reads = 0;
  let swaps = 0;
  const graph = await openAttuneGraph({
    scope,
    store: createAttuneGraphStore({
      async read() { reads += 1; return undefined; },
      async compareAndSwap() { swaps += 1; return false; }
    })
  });
  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: emptyComplete,
    replacement: replacement()
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect({ reads, swaps }).toEqual({ reads: 0, swaps: 0 });
  await Promise.all([source.graph.close(), graph.close()]);
});

it.each([
  ["tampered", (json: string) => `${json} `],
  ["duplicate field", (json: string) => json.replace("{", '{"status":"complete",')],
  ["future revision", (json: string) => resealReceipt(json, (receipt) => { receipt.contractRevision = 2; })],
  ["partial without truncation", (json: string) => resealReceipt(json, (receipt) => { receipt.status = "partial"; })],
  ["abstained with impact", (json: string) => resealReceipt(json, (receipt) => { receipt.status = "abstained"; })],
  ["null snapshot", (json: string) => resealReceipt(json, (receipt) => { receipt.snapshot = null; })]
])("rejects %s receipt before mutation", async (_name, alter) => {
  const { graph, plan, prior } = await preparedGraph();
  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: alter(plan.receipt.canonicalJson),
    replacement: replacement()
  })).rejects.toMatchObject({ code: expect.any(String) });
  await expect(graph.head()).resolves.toEqual(prior);
  await graph.close();
});

it.each([
  ["legacy predecessor", replacement([], { observedAt: later })],
  ["different root", replacement([], { threadRoot: { kind: "thread", id: "other-thread" } })],
  ["non-fresh", replacement([], { sourceFreshness: { state: "stale", observedAt: later } })],
  ["freshness mismatch", replacement([], { sourceFreshness: { state: "fresh", observedAt: now } })],
  ["equal observation time", replacement([], { observedAt: now })]
])("fails closed for %s replacement boundary", async (name, commandReplacement) => {
  const graph = await openAttuneGraph({ scope, store: createInMemoryAttuneGraphStore() });
  const legacy = name === "legacy predecessor";
  await graph.project({
    operator: legacy ? "canonical-projection@1" : "canonical-projection@2",
    observation: (legacy
      ? {
        schemaVersion: 1,
        observationKey: "legacy",
        scope,
        observedAt: now,
        sourceFreshness: { state: "fresh", observedAt: now },
        assertions: [assertion("revoked")]
      }
      : {
        schemaVersion: 2,
        threadRoot: { kind: "thread", id: scope.threadId },
        observationKey: "v2",
        scope,
        observedAt: now,
        sourceFreshness: { state: "fresh", observedAt: now },
        assertions: [assertion("revoked")]
      }) as never
  });
  const plan = await graph.planRevocationImpact({ operator: "revocation-impact@1", selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] }, maxAssertions: 16, maxConsideredAssertions: 4096 });
  await expect(graph.applyRevocationTransition({ operator: "revocation-transition@1", receiptCanonicalJson: plan.receipt.canonicalJson, replacement: commandReplacement })).rejects.toMatchObject({ code: expect.any(String) });
  await graph.close();
});

it("rejects duplicate raw survivor IDs before Store I/O after a complete plan, then seals the survivor count", async () => {
  const backend = new InMemoryAttuneGraphStoreBackend();
  let reads = 0;
  let swaps = 0;
  const store = createAttuneGraphStore({
    async read(requestedScope) {
      reads += 1;
      return backend.read(requestedScope);
    },
    async compareAndSwap(requestedScope, expected, proposed) {
      swaps += 1;
      return backend.compareAndSwap(requestedScope, expected, proposed);
    }
  });
  const survivor = assertion("survivor", "contact-8");
  const { graph, plan } = await preparedGraph(store, [assertion("revoked"), survivor]);
  reads = 0;
  swaps = 0;
  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: plan.receipt.canonicalJson,
    replacement: replacement([survivor, JSON.parse(JSON.stringify(survivor)) as GraphAssertion])
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect({ reads, swaps }).toEqual({ reads: 0, swaps: 0 });
  const committed = await graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: plan.receipt.canonicalJson,
    replacement: replacement([survivor])
  });
  expect(committed.receipt.preservedSurvivorCount).toBe(1);
  expectDeepFrozen(committed);
  await graph.close();
});

it("admits a re-sealed complete subset, then rejects the exact replan after one read and no CAS", async () => {
  const backend = new InMemoryAttuneGraphStoreBackend();
  let reads = 0;
  let swaps = 0;
  const store = createAttuneGraphStore({
    async read(requestedScope) {
      reads += 1;
      return backend.read(requestedScope);
    },
    async compareAndSwap(requestedScope, expected, proposed) {
      swaps += 1;
      return backend.compareAndSwap(requestedScope, expected, proposed);
    }
  });
  const { graph, plan } = await preparedGraph(store, [
    assertion("revoked-one"),
    assertion("revoked-two")
  ]);
  const fabricatedSubset = resealReceipt(plan.receipt.canonicalJson, (receipt) => {
    receipt.impacts = (receipt.impacts as unknown[]).slice(0, 1);
    receipt.diagnostics = {
      consideredAssertions: 1,
      directMatches: 1,
      truncationReasons: []
    };
    receipt.status = "complete";
  });
  reads = 0;
  swaps = 0;

  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: fabricatedSubset,
    replacement: replacement()
  })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  expect({ reads, swaps }).toEqual({ reads: 1, swaps: 0 });
  await graph.close();
});

it("rejects a 17-impact partial receipt before Store I/O", async () => {
  const backend = new InMemoryAttuneGraphStoreBackend();
  let reads = 0;
  let swaps = 0;
  const store = createAttuneGraphStore({
    async read(requestedScope) {
      reads += 1;
      return backend.read(requestedScope);
    },
    async compareAndSwap(requestedScope, expected, proposed) {
      swaps += 1;
      return backend.compareAndSwap(requestedScope, expected, proposed);
    }
  });
  const { graph, plan } = await preparedGraph(
    store,
    Array.from({ length: 17 }, (_, index) => assertion(`revoked-${index.toString()}`))
  );
  expect(plan.status).toBe("partial");
  reads = 0;
  swaps = 0;

  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: plan.receipt.canonicalJson,
    replacement: replacement()
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect({ reads, swaps }).toEqual({ reads: 0, swaps: 0 });
  await graph.close();
});

class WrongGenerationWinnerStore extends InMemoryAttuneGraphStoreBackend {
  private wrongWinner = false;

  installWrongWinnerOnNextCas(): void {
    this.wrongWinner = true;
  }

  override async compareAndSwap(...args: Parameters<AttuneGraphStoreBackend["compareAndSwap"]>): Promise<boolean> {
    if (!this.wrongWinner) return super.compareAndSwap(...args);
    this.wrongWinner = false;
    const [requestedScope, expected, proposed] = args;
    await super.compareAndSwap(requestedScope, expected, {
      ...proposed,
      snapshot: { ...proposed.snapshot, generation: proposed.snapshot.generation + 1 }
    });
    return false;
  }
}

it("rejects a byte-identical CAS winner whose resulting snapshot is not predecessor plus one", async () => {
  const backend = new WrongGenerationWinnerStore();
  const { graph, plan } = await preparedGraph(createAttuneGraphStore(backend));
  backend.installWrongWinnerOnNextCas();
  await expect(graph.applyRevocationTransition({ operator: "revocation-transition@1", receiptCanonicalJson: plan.receipt.canonicalJson, replacement: replacement() })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  await graph.close();
});

it("rejects accessor/proxy commands, closes cleanly, and local SQLite reopens only the replacement head", async () => {
  const accessor = { operator: "revocation-transition@1", replacement: replacement() } as Record<string, unknown>;
  Object.defineProperty(accessor, "receiptCanonicalJson", { enumerable: true, get: () => "{}" });
  const memory = await openAttuneGraph({ scope, store: createInMemoryAttuneGraphStore() });
  await expect(memory.applyRevocationTransition(accessor as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(memory.applyRevocationTransition(new Proxy({
    operator: "revocation-transition@1",
    receiptCanonicalJson: "{}",
    replacement: replacement()
  }, {}) as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await memory.close();
  await expect(memory.applyRevocationTransition(accessor as never)).rejects.toMatchObject({ code: "CLOSED" });

  const directory = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-transition-")));
  const databasePath = join(directory, "graph.sqlite");
  try {
    const local = await openLocalAttuneGraph({ databasePath, scope });
    await local.project({ operator: "canonical-projection@2", observation: { schemaVersion: 2, threadRoot: { kind: "thread", id: scope.threadId }, observationKey: "local-before", scope, observedAt: now, sourceFreshness: { state: "fresh", observedAt: now }, assertions: [assertion("revoked")] } });
    const localPlan = await local.planRevocationImpact({ operator: "revocation-impact@1", selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] }, maxAssertions: 16, maxConsideredAssertions: 4096 });
    await local.applyRevocationTransition({ operator: "revocation-transition@1", receiptCanonicalJson: localPlan.receipt.canonicalJson, replacement: replacement() });
    const resultHead = await local.head();
    await local.close();
    const reopened = await openLocalAttuneGraph({ databasePath, scope });
    await expect(reopened.head()).resolves.toEqual(resultHead);
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves a failed transition's prepared Working Graph and invalidates it after commit", async () => {
  const { graph, plan, prior } = await preparedGraph();
  const before = await graph.execute({ operator: "working-graph@1", seed: { kind: "thread", id: scope.threadId }, now: later, maxEstimatedTokens: 1_000 });
  await expect(graph.applyRevocationTransition({
    operator: "revocation-transition@1",
    receiptCanonicalJson: plan.receipt.canonicalJson,
    replacement: replacement([assertion("extra")])
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.execute({ operator: "working-graph@1", seed: { kind: "thread", id: scope.threadId }, now: later, maxEstimatedTokens: 1_000 })).resolves.toEqual(before);
  const committed = await graph.applyRevocationTransition({ operator: "revocation-transition@1", receiptCanonicalJson: plan.receipt.canonicalJson, replacement: replacement() });
  expect(committed.receipt.priorSnapshot).toEqual(prior);
  const after = await graph.execute({ operator: "working-graph@1", seed: { kind: "thread", id: scope.threadId }, now: later, maxEstimatedTokens: 1_000 });
  expect(after.snapshot).toEqual(committed.receipt.resultSnapshot);
  await graph.close();
});
