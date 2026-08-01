import { expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GRAPH_ASSERTION_SOURCE_NAMESPACE,
  InMemoryAttuneGraphDataStore,
  openAttuneGraph,
  type GraphAssertion
} from "./index.js";
import { createAttuneGraphStore, type AttuneGraphStoreBackend } from "./attunegraph-backend.js";
import { InMemoryAttuneGraphStoreBackend, createInMemoryAttuneGraphStore } from "./testing.js";
import { openLocalAttuneGraph } from "./local.js";

const SCOPE = { sourceId: "revocation-source", threadId: "revocation-thread" };
const NOW = "2026-08-01T00:00:00.000Z";
const HAS_REVIEWED_LOCAL_PROFILE = process.platform === "darwin" || process.platform === "linux";

function assertion(
  id: string,
  sourceRefs: readonly GraphAssertion["sourceRefs"][number][] = [{
    namespace: "example.source",
    id: `source-${id}`,
    version: "v1"
  }]
): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject: { kind: "artifact", id: `artifact-${id}` },
    predicate: "LINKED_TO",
    object: { kind: "thread", id: SCOPE.threadId },
    epistemicClass: "deterministic-derived",
    sourceRefs,
    recordedAt: NOW,
    derivation: { kind: "rule", version: "test@1" }
  };
}

async function graph(assertions: readonly GraphAssertion[]) {
  const attuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createInMemoryAttuneGraphStore()
  });
  const snapshot = await attuneGraph.project({
    operator: "canonical-projection@1",
    observation: {
      schemaVersion: 1,
      observationKey: "revocation-test",
      scope: SCOPE,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions
    }
  });
  return { attuneGraph, snapshot };
}

it("plans an exact-head direct source revocation and its immutable dependency closure", async () => {
  const { attuneGraph, snapshot } = await graph([
    assertion("source", [{ namespace: "crm", id: "contact-7", version: "v1" }]),
    assertion("derived-a", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "source" }]),
    assertion("derived-b", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "derived-a" }])
  ]);

  const plan = await attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  });

  expect(plan).toMatchObject({
    operator: "revocation-impact@1",
    status: "complete",
    snapshot,
    impacts: [
      { assertionId: "derived-a", reason: "dependency", witnessAssertionIds: ["source", "derived-a"] },
      { assertionId: "derived-b", reason: "dependency", witnessAssertionIds: ["source", "derived-a", "derived-b"] },
      { assertionId: "source", reason: "direct", witnessAssertionIds: ["source"] }
    ]
  });
  expect(plan.selector).toEqual({
    sourceRefs: [{ namespace: "crm", id: "contact-7" }]
  });
  expect(plan.receipt.snapshot).toEqual(snapshot);
  expect(plan.receipt.receiptId).toMatch(/^attunegraph-revocation-impact:/);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.impacts)).toBe(true);
  expect(Object.isFrozen(plan.receipt)).toBe(true);
  await expect(attuneGraph.head()).resolves.toEqual(snapshot);
});

it("treats an absent selected assertion id as a dependency root without outputting it", async () => {
  const assertions = [
    assertion("derived", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "missing-root" }]),
    assertion("transitive", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "derived" }])
  ];
  const { attuneGraph } = await graph(assertions);

  const plan = await attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["missing-root"] },
    maxAssertions: 2,
    maxConsideredAssertions: 2
  });
  expect(plan).toMatchObject({
    status: "complete",
    impacts: [
      { assertionId: "derived", reason: "dependency", witnessAssertionIds: ["missing-root", "derived"] },
      { assertionId: "transitive", reason: "dependency", witnessAssertionIds: ["missing-root", "derived", "transitive"] }
    ],
    diagnostics: { directMatches: 0, truncationReasons: [] }
  });
  const legacy = new InMemoryAttuneGraphDataStore();
  await legacy.append(assertions);
  const legacyReceipt = await legacy.forget({ assertionIds: ["missing-root"] });
  expect(plan.impacts.map((impact) => impact.assertionId)).toEqual(legacyReceipt.removedAssertionIds);
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["missing-root"] },
    maxAssertions: 1,
    maxConsideredAssertions: 2
  })).resolves.toMatchObject({
    status: "partial",
    impacts: [{ assertionId: "derived", witnessAssertionIds: ["missing-root", "derived"] }],
    diagnostics: { truncationReasons: ["assertion-budget"] }
  });
});

it("is byte-stable across competing equal-length dependency witnesses", async () => {
  const { attuneGraph } = await graph([
    assertion("z-root"),
    assertion("a-root"),
    assertion("middle", [
      { namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "z-root" },
      { namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "a-root" }
    ])
  ]);
  const command = {
    operator: "revocation-impact@1" as const,
    selector: { assertionIds: ["z-root", "a-root"] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  };

  const first = await attuneGraph.planRevocationImpact(command);
  const replay = await attuneGraph.planRevocationImpact(command);

  expect(first.impacts.find((impact) => impact.assertionId === "middle"))
    .toMatchObject({ witnessAssertionIds: ["a-root", "middle"] });
  expect(replay.receipt).toEqual(first.receipt);
  expect(replay.receipt.canonicalJson).toBe(first.receipt.canonicalJson);
});

it("matches assertion ids and graph refs, and distinguishes exact from versionless source refs", async () => {
  const { attuneGraph } = await graph([
    assertion("v1", [{ namespace: "crm", id: "contact-7", version: "v1" }]),
    assertion("v2", [{ namespace: "crm", id: "contact-7", version: "v2" }]),
    assertion("graph", [{ namespace: "other", id: "graph" }])
  ]);

  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "crm", id: "contact-7", version: "v1" }] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  })).resolves.toMatchObject({ impacts: [{ assertionId: "v1" }] });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "crm", id: "contact-7" }] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  })).resolves.toMatchObject({ impacts: [{ assertionId: "v1" }, { assertionId: "v2" }] });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["missing"], graphRefs: [{ kind: "artifact", id: "artifact-graph" }] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  })).resolves.toMatchObject({ status: "complete", impacts: [{ assertionId: "graph" }] });
});

it("terminates cycles and returns partial rather than falsely completing over either cap", async () => {
  const { attuneGraph } = await graph([
    assertion("a", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "b" }]),
    assertion("b", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "a" }]),
    assertion("c", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "b" }])
  ]);
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["a"] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  })).resolves.toMatchObject({
    status: "complete",
    impacts: [
      { assertionId: "a", witnessAssertionIds: ["a"] },
      { assertionId: "b", witnessAssertionIds: ["a", "b"] },
      { assertionId: "c", witnessAssertionIds: ["a", "b", "c"] }
    ]
  });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["a"] },
    maxAssertions: 2,
    maxConsideredAssertions: 8
  })).resolves.toMatchObject({ status: "partial", diagnostics: { truncationReasons: ["assertion-budget"] } });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["a"] },
    maxAssertions: 1,
    maxConsideredAssertions: 2
  })).resolves.toMatchObject({ status: "partial", diagnostics: { truncationReasons: expect.arrayContaining(["considered-budget"]) } });
});

it("hard-bounds many direct matches and adversarial longest witnesses before sealing a receipt", async () => {
  const directIds = Array.from({ length: 17 }, (_, index) => `direct-${index.toString().padStart(2, "0")}`);
  const manyDirect = await graph(directIds.map((id) => assertion(id)));
  await expect(manyDirect.attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: directIds },
    maxAssertions: 16,
    maxConsideredAssertions: 17
  })).resolves.toMatchObject({
    status: "partial",
    impacts: Array.from({ length: 16 }, (_, index) => ({ assertionId: `direct-${index.toString().padStart(2, "0")}` })),
    diagnostics: { directMatches: 17, truncationReasons: ["assertion-budget"] }
  });
  const longId = (index: number) => `${index.toString().padStart(2, "0")}-${"x".repeat(300)}`;
  const chain = Array.from({ length: 8 }, (_, index) => assertion(
    longId(index),
    index === 0 ? [{ namespace: "adversarial", id: "root" }] : [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: longId(index - 1) }]
  ));
  const longest = await graph(chain);
  await expect(longest.attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "adversarial", id: "root" }] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  })).resolves.toMatchObject({ status: "complete", impacts: Array.from({ length: 8 }, () => expect.any(Object)) });
});

it("seals a multibyte long-witness chain without leaking an envelope failure", async () => {
  const longId = (index: number) => `${index.toString()}-${"😀".repeat(120)}`;
  const chain = Array.from({ length: 8 }, (_, index) => assertion(
    longId(index),
    index === 0 ? [{ namespace: "multibyte", id: "root" }] : [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: longId(index - 1) }]
  ));
  const { attuneGraph } = await graph(chain);
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { sourceRefs: [{ namespace: "multibyte", id: "root" }] },
    maxAssertions: 8,
    maxConsideredAssertions: 8
  })).resolves.toMatchObject({ status: "complete", impacts: Array.from({ length: 8 }, () => expect.any(Object)) });
});

it("abstains honestly for a missing head or a fully inspected empty intersection", async () => {
  const empty = await openAttuneGraph({ scope: SCOPE, store: createInMemoryAttuneGraphStore() });
  await expect(empty.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["nothing"] },
    maxAssertions: 1,
    maxConsideredAssertions: 1
  })).resolves.toMatchObject({ status: "abstained", receipt: { snapshot: null } });
  const { attuneGraph } = await graph([assertion("present")]);
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["nothing"] },
    maxAssertions: 1,
    maxConsideredAssertions: 1
  })).resolves.toMatchObject({ status: "abstained", impacts: [] });
});

it("rejects malformed selectors before Store reads or mutation", async () => {
  let reads = 0;
  let swaps = 0;
  const attuneGraph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore({
      async read() { reads += 1; return undefined; },
      async compareAndSwap() { swaps += 1; return false; }
    })
  });
  const accessor = Object.create(null) as { readonly assertionIds: readonly string[] };
  Object.defineProperty(accessor, "assertionIds", { get: () => ["x"], enumerable: true });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: accessor,
    maxAssertions: 1,
    maxConsideredAssertions: 1
  } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["x", "x"] },
    maxAssertions: 1,
    maxConsideredAssertions: 1
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["unsafe\u0000id"] },
    maxAssertions: 1,
    maxConsideredAssertions: 1
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["\ud800"] },
    maxAssertions: 1,
    maxConsideredAssertions: 1
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect({ reads, swaps }).toEqual({ reads: 0, swaps: 0 });
});

it("does not let projection insertion order affect impact ordering or witnesses", async () => {
  const assertions = [
    assertion("root", [{ namespace: "order", id: "source" }]),
    assertion("dependent", [{ namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE, id: "root" }])
  ];
  const forward = await graph(assertions);
  const reverse = await graph([...assertions].reverse());
  const command = {
    operator: "revocation-impact@1" as const,
    selector: { sourceRefs: [{ namespace: "order", id: "source" }] },
    maxAssertions: 2,
    maxConsideredAssertions: 2
  };
  const [left, right] = await Promise.all([
    forward.attuneGraph.planRevocationImpact(command),
    reverse.attuneGraph.planRevocationImpact(command)
  ]);
  expect(left.impacts).toEqual(right.impacts);
  expect(left.selector).toEqual(right.selector);
  expect(left.diagnostics).toEqual(right.diagnostics);
  expect(left.status).toBe(right.status);
});

it("uses the existing bounded exact-head retry and fails closed on a persistent writer race", async () => {
  const backing = new InMemoryAttuneGraphStoreBackend();
  const seed = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backing) });
  await seed.project({
    operator: "canonical-projection@1",
    observation: { schemaVersion: 1, observationKey: "race", scope: SCOPE, observedAt: NOW, sourceFreshness: { state: "fresh", observedAt: NOW }, assertions: [assertion("race")] }
  });
  const backend: AttuneGraphStoreBackend = {
    read: backing.read.bind(backing),
    readHead: async (scope) => ({ ...(await backing.readHead(scope))!, commitId: "different-head" }),
    compareAndSwap: backing.compareAndSwap.bind(backing)
  };
  const attuneGraph = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
  await expect(attuneGraph.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["race"] },
    maxAssertions: 1,
    maxConsideredAssertions: 1
  })).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
});

it("retries once to plan against the external writer's new exact head", async () => {
  const backing = new InMemoryAttuneGraphStoreBackend();
  const initial = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backing) });
  await initial.project({
    operator: "canonical-projection@1",
    observation: { schemaVersion: 1, observationKey: "old-head", scope: SCOPE, observedAt: NOW, sourceFreshness: { state: "fresh", observedAt: NOW }, assertions: [assertion("old")] }
  });
  const writer = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backing) });
  let moved = false;
  const reader = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore({
      read: backing.read.bind(backing),
      readHead: async (scope) => {
        const head = await backing.readHead(scope);
        if (!moved) {
          moved = true;
          await writer.project({
            operator: "canonical-projection@1",
            expectedSnapshot: head,
            observation: { schemaVersion: 1, observationKey: "new-head", scope: SCOPE, observedAt: "2026-08-01T00:00:01.000Z", sourceFreshness: { state: "fresh", observedAt: "2026-08-01T00:00:01.000Z" }, assertions: [assertion("new")] }
          });
        }
        return head;
      },
      compareAndSwap: backing.compareAndSwap.bind(backing)
    })
  });
  await expect(reader.planRevocationImpact({
    operator: "revocation-impact@1",
    selector: { assertionIds: ["new"] },
    maxAssertions: 1,
    maxConsideredAssertions: 1
  })).resolves.toMatchObject({ status: "complete", snapshot: { generation: 2 }, impacts: [{ assertionId: "new" }] });
});

it.runIf(HAS_REVIEWED_LOCAL_PROFILE)("leaves SQLite bytes, head, and current Working Graph unchanged", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-revocation-impact-")));
  const databasePath = join(directory, "graph.sqlite");
  const attuneGraph = await openLocalAttuneGraph({ databasePath, scope: SCOPE });
  try {
    const snapshot = await attuneGraph.project({
      operator: "canonical-projection@1",
      observation: { schemaVersion: 1, observationKey: "sqlite", scope: SCOPE, observedAt: NOW, sourceFreshness: { state: "fresh", observedAt: NOW }, assertions: [assertion("sqlite")] }
    });
    const beforeBytes = await readFile(databasePath);
    const beforeWorkingGraph = await attuneGraph.execute({ operator: "working-graph@1", seed: { kind: "thread", id: SCOPE.threadId }, now: NOW, maxEstimatedTokens: 32 });
    await expect(attuneGraph.planRevocationImpact({
      operator: "revocation-impact@1",
      selector: { assertionIds: ["sqlite"] },
      maxAssertions: 1,
      maxConsideredAssertions: 1
    })).resolves.toMatchObject({ status: "complete", snapshot });
    expect(await readFile(databasePath)).toEqual(beforeBytes);
    await expect(attuneGraph.head()).resolves.toEqual(snapshot);
    await expect(attuneGraph.execute({ operator: "working-graph@1", seed: { kind: "thread", id: SCOPE.threadId }, now: NOW, maxEstimatedTokens: 32 })).resolves.toEqual(beforeWorkingGraph);
  } finally {
    await attuneGraph.close();
    await rm(directory, { recursive: true, force: true });
  }
});
