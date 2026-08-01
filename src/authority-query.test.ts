import { expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openAttuneGraph,
  type AttuneGraphScope,
  type GraphAssertion,
  type GraphPredicate,
  type GraphRef
} from "./index.js";
import { createAttuneGraphStore } from "./attunegraph-backend.js";
import { InMemoryAttuneGraphStoreBackend } from "./attunegraph-in-memory-store.js";
import { openLocalAttuneGraph } from "./local.js";

const NOW = "2026-08-01T09:00:00.000Z";
const BEFORE = "2026-08-01T08:00:00.000Z";
const AFTER = "2026-08-01T10:00:00.000Z";
const SCOPE: AttuneGraphScope = {
  sourceId: "authority-test",
  threadId: "release-thread"
};
const ACTION: GraphRef & { readonly kind: "action" } = { kind: "action", id: "action:publish" };
const POLICY: GraphRef = { kind: "policy", id: "policy:reviewed-release" };
const EVIDENCE: GraphRef = { kind: "evidence", id: "evidence:approval" };
const ROOT: GraphRef & { readonly kind: "thread" } = { kind: "thread", id: "thread:release" };

function assertion(
  id: string,
  subject: GraphRef,
  predicate: GraphPredicate,
  object: GraphRef
): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject: { ...subject },
    predicate,
    object: { ...object },
    epistemicClass: "source-observed",
    sourceRefs: [{ namespace: "authority-test", id: `source:${id}` }],
    recordedAt: BEFORE,
    derivation: { kind: "projection", version: "authority-test" }
  };
}

function completeAuthorityAssertions(): readonly GraphAssertion[] {
  return [
    assertion("governed", ACTION, "GOVERNED_BY", POLICY),
    assertion("policy-scope", POLICY, "SCOPED_TO", ROOT),
    assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
    assertion("evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT)
  ];
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeepFrozen(nested, seen);
}

async function openCompleteAuthorityGraph() {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "complete-authority-chain",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAuthorityAssertions()
    }
  });
  return graph;
}

function authorityQuery(maxEstimatedTokens = 4_000) {
  return {
    operator: "authority-query@1" as const,
    scope: SCOPE,
    action: ACTION,
    threadRoot: ROOT,
    asOf: NOW,
    head: { mode: "current" as const },
    freshness: { require: "fresh" as const },
    budget: { maxEstimatedTokens }
  };
}

it("authorizes only an exact current four-edge authority witness", async () => {
  const graph = await openCompleteAuthorityGraph();

  const result = await graph.queryAuthority(authorityQuery());

  expect(result).toMatchObject({
    operator: "authority-query@1",
    use: "current-world-action-authority",
    status: "complete",
    authority: "authorized",
    witness: {
      assertionIds: ["authorized", "evidence-scope", "governed", "policy-scope"]
    },
    diagnostics: {
      authorityClosure: "complete",
      conflictClosure: "complete",
      truncationReasons: [],
      terminalReasons: []
    }
  });
  expect(result.receipt.receiptId).toMatch(/^attunegraph-authority-query:/u);
  expect(result.diagnostics.estimatedTokens).toBe(
    Math.ceil(Buffer.byteLength(JSON.stringify(result), "utf8") / 4)
  );
  expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(4_000);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.witness.assertionIds)).toBe(true);
  expectDeepFrozen(result);
  await graph.close();
});

it("detaches the full public result from caller-owned observation and query inputs", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const observation = {
    schemaVersion: 2 as const,
    observationKey: "caller-owned-authority-chain",
    scope: { ...SCOPE },
    threadRoot: { ...ROOT },
    observedAt: NOW,
    sourceFreshness: { state: "fresh" as const, observedAt: NOW },
    assertions: completeAuthorityAssertions().map((entry) => ({
      ...entry,
      subject: { ...entry.subject },
      object: { ...entry.object },
      sourceRefs: entry.sourceRefs.map((sourceRef) => ({ ...sourceRef })),
      derivation: { ...entry.derivation }
    }))
  };
  await graph.project({ operator: "canonical-projection@2", observation });

  observation.scope.sourceId = "mutated-source";
  observation.threadRoot.id = "thread:mutated";
  observation.assertions[0]!.id = "mutated-governance";
  observation.assertions[0]!.subject.id = "action:mutated";
  observation.assertions[0]!.sourceRefs[0]!.id = "source:mutated";

  const query = {
    operator: "authority-query@1" as const,
    scope: { ...SCOPE },
    action: { ...ACTION },
    threadRoot: { ...ROOT },
    asOf: NOW,
    head: { mode: "current" as const },
    freshness: { require: "fresh" as const },
    budget: { maxEstimatedTokens: 4_000 }
  };
  const result = await graph.queryAuthority(query);
  const serialized = JSON.stringify(result);

  query.scope.sourceId = "mutated-query-source";
  query.action.id = "action:mutated-after-query";
  query.threadRoot.id = "thread:mutated-after-query";
  query.budget.maxEstimatedTokens = 1_024;

  expect(result.status).toBe("complete");
  expect(result.authority).toBe("authorized");
  expect(JSON.stringify(result)).toBe(serialized);
  expect(serialized).not.toContain("mutated");
  expect(result.receipt.query.scope).not.toBe(query.scope);
  expect(result.receipt.query.action).not.toBe(query.action);
  expect(result.receipt.query.threadRoot).not.toBe(query.threadRoot);
  expectDeepFrozen(result);
  await graph.close();
});

it("returns partial when the complete public result cannot fit its token budget", async () => {
  const graph = await openCompleteAuthorityGraph();
  const result = await graph.queryAuthority(authorityQuery(1_024));

  expect(result.status).toBe("partial");
  expect(result.authority).toBe("undetermined");
  expect(result.witness.assertionIds).toEqual([]);
  expect(result.diagnostics.truncationReasons).toEqual(["token-budget"]);
  expect(result.diagnostics.estimatedTokens).toBeLessThanOrEqual(1_024);
  await graph.close();
});

it("abstains when the exact action has conflicting governed policies", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const otherPolicy: GraphRef = { kind: "policy", id: "policy:emergency-release" };
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "governance-conflict",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        assertion("governed-a", ACTION, "GOVERNED_BY", POLICY),
        assertion("scope-a", POLICY, "SCOPED_TO", ROOT),
        assertion("governed-b", ACTION, "GOVERNED_BY", otherPolicy),
        assertion("scope-b", otherPolicy, "SCOPED_TO", ROOT),
        assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
        assertion("evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT)
      ]
    }
  });

  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.conflictClosure).toBe("conflict");
  expect(result.diagnostics.terminalReasons).toEqual(["authority-conflict"]);
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]?.assertionIds).toEqual(["governed-a", "governed-b"]);
  expectDeepFrozen(result);
  const bounded = await graph.queryAuthority(authorityQuery(1_024));
  expect(bounded.status).toBe("partial");
  expect(bounded.authority).toBe("undetermined");
  expect(bounded.conflicts).toEqual([]);
  expect(bounded.diagnostics.truncationReasons).toEqual(["token-budget"]);
  expect(bounded.diagnostics.estimatedTokens).toBeLessThanOrEqual(1_024);
  await graph.close();
});

it("keeps a known conflict abstained when the reachable work ceiling is also exceeded", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const otherPolicy: GraphRef = { kind: "policy", id: "policy:emergency-release" };
  const fillers = Array.from({ length: 33 }, (_, index) => assertion(
    `z-filler-${index.toString().padStart(4, "0")}`,
    { kind: "artifact", id: `a${index.toString()}` },
    "LINKED_TO",
    ROOT
  ));
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "conflict-and-work-budget",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        assertion("a-governed-a", ACTION, "GOVERNED_BY", POLICY),
        assertion("a-scope-a", POLICY, "SCOPED_TO", ROOT),
        assertion("a-governed-b", ACTION, "GOVERNED_BY", otherPolicy),
        assertion("a-scope-b", otherPolicy, "SCOPED_TO", ROOT),
        assertion("a-authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
        assertion("a-evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT),
        ...fillers
      ]
    }
  });

  const result = await graph.queryAuthority(authorityQuery(8_000));
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.maxConsideredAssertions).toBe(32);
  expect(result.diagnostics.consideredAssertions).toBe(32);
  expect(result.diagnostics.truncationReasons).toEqual(["work-budget"]);
  expect(result.diagnostics.terminalReasons).toEqual(["authority-conflict"]);
  expect(result.diagnostics.conflictClosure).toBe("conflict");
  expect(result.conflicts).toHaveLength(1);
  await graph.close();
});

it("returns a truthful conflict-free partial result when the work ceiling is exceeded", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const fillers = Array.from({ length: 33 }, (_, index) => assertion(
    `z-filler-${index.toString().padStart(4, "0")}`,
    { kind: "artifact", id: `a${index.toString()}` },
    "LINKED_TO",
    ROOT
  ));
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "complete-chain-and-work-budget",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        assertion("a-authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
        assertion("a-evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT),
        assertion("a-governed", ACTION, "GOVERNED_BY", POLICY),
        assertion("a-policy-scope", POLICY, "SCOPED_TO", ROOT),
        ...fillers
      ]
    }
  });

  const result = await graph.queryAuthority(authorityQuery(8_000));
  expect(result.status).toBe("partial");
  expect(result.authority).toBe("undetermined");
  expect(result.witness.assertionIds).toEqual([]);
  expect(result.conflicts).toEqual([]);
  expect(result.diagnostics).toMatchObject({
    maxConsideredAssertions: 32,
    consideredAssertions: 32,
    eligibleFrontierAssertions: 4,
    rejectedFrontierAssertions: 0,
    truncationReasons: ["work-budget"],
    terminalReasons: [],
    authorityClosure: "incomplete",
    conflictClosure: "incomplete"
  });
  expectDeepFrozen(result);
  await graph.close();
});

it("abstains when the projection cannot prove the exact current thread root", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@1",
    observation: {
      schemaVersion: 1,
      observationKey: "legacy-root-unverified",
      scope: SCOPE,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: []
    }
  });

  const result = await graph.queryAuthority(authorityQuery());
  expect(result).toMatchObject({
    status: "abstained",
    authority: "undetermined",
    projection: { threadRoot: null },
    diagnostics: { terminalReasons: ["root-unverified"] }
  });
  await graph.close();
});

it("abstains when the requested root differs from the V2 embedded root", async () => {
  const graph = await openCompleteAuthorityGraph();
  const result = await graph.queryAuthority({
    ...authorityQuery(),
    threadRoot: { kind: "thread", id: "thread:other" }
  });
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.terminalReasons).toEqual(["root-mismatch"]);
  expect(result.projection?.threadRoot).toEqual(ROOT);
  await graph.close();
});

it("rejects future source posture before examining authority edges", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "future-posture",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: "2026-08-01T10:00:00.000Z",
      sourceFreshness: { state: "fresh", observedAt: "2026-08-01T10:00:00.000Z" },
      assertions: []
    }
  });

  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.consideredAssertions).toBe(0);
  expect(result.diagnostics.terminalReasons).toEqual(["projection-from-future"]);
  await graph.close();
});

it.each(["stale", "unknown"] as const)("abstains when source freshness is %s", async (state) => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: `source-${state}`,
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state, observedAt: NOW },
      assertions: completeAuthorityAssertions()
    }
  });
  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.terminalReasons).toEqual(["source-not-fresh"]);
  expect(result.diagnostics.consideredAssertions).toBe(0);
  await graph.close();
});

it("distinguishes a future freshness observation from a future projection", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "future-freshness-only",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: AFTER },
      assertions: completeAuthorityAssertions()
    }
  });
  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.diagnostics.terminalReasons).toEqual(["freshness-from-future"]);
  expect(result.diagnostics.consideredAssertions).toBe(0);
  await graph.close();
});

it("does not promote proximity or model-hypothesis scope to action authority", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const hypothesisScope: GraphAssertion = {
    ...assertion("hypothesis-scope", POLICY, "SCOPED_TO", ROOT),
    epistemicClass: "model-hypothesis",
    derivation: { kind: "model", runId: "run:hypothesis", version: "authority-test" }
  };
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "hypothesis-is-not-authority",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        assertion("governed", ACTION, "GOVERNED_BY", POLICY),
        hypothesisScope,
        assertion("nearby", ACTION, "CORRELATES_WITH", ROOT),
        assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
        assertion("evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT)
      ]
    }
  });

  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.terminalReasons).toEqual(["missing-governance-chain"]);
  expect(result.diagnostics.rejectedFrontierAssertions).toBe(1);
  expect(result.exclusions).toEqual([{
    assertionId: "hypothesis-scope",
    reason: "model-hypothesis"
  }]);
  expect(result.witness.assertionIds).toEqual([]);
  await graph.close();
});

it("does not promote model-hypothesis evidence scope and reports the missing evidence chain", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const hypothesisEvidenceScope: GraphAssertion = {
    ...assertion("hypothesis-evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT),
    epistemicClass: "model-hypothesis",
    derivation: { kind: "model", runId: "run:evidence-hypothesis", version: "authority-test" }
  };
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "hypothesis-evidence-is-not-authority",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        assertion("governed", ACTION, "GOVERNED_BY", POLICY),
        assertion("policy-scope", POLICY, "SCOPED_TO", ROOT),
        assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
        hypothesisEvidenceScope
      ]
    }
  });
  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.terminalReasons).toEqual(["missing-evidence-chain"]);
  expect(result.exclusions).toEqual([{
    assertionId: "hypothesis-evidence-scope",
    reason: "model-hypothesis"
  }]);
  await graph.close();
});

it("excludes a linked authority edge scoped to the wrong thread root", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const otherRoot: GraphRef = { kind: "thread", id: "thread:other" };
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "linked-root-mismatch",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        assertion("governed", ACTION, "GOVERNED_BY", POLICY),
        assertion("policy-other-root", POLICY, "SCOPED_TO", otherRoot),
        assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
        assertion("evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT),
        assertion("other-root-connected", { kind: "artifact", id: "other-root-anchor" }, "LINKED_TO", otherRoot),
        assertion("roots-connected", { kind: "artifact", id: "other-root-anchor" }, "LINKED_TO", ROOT)
      ]
    }
  });
  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.diagnostics.terminalReasons).toEqual(["missing-governance-chain"]);
  expect(result.exclusions).toContainEqual({
    assertionId: "policy-other-root",
    reason: "thread-root-mismatch"
  });
  await graph.close();
});

it.each([
  ["reversed governance", assertion("reversed-governance", POLICY, "GOVERNED_BY", ACTION)],
  ["wrong governance object kind", assertion("wrong-governance-kind", ACTION, "GOVERNED_BY", EVIDENCE)],
  ["hypothesis governance", {
    ...assertion("hypothesis-governance", ACTION, "GOVERNED_BY", POLICY),
    epistemicClass: "model-hypothesis" as const,
    derivation: { kind: "model" as const, runId: "run:governance", version: "authority-test" }
  }],
  ["hypothesis authorization", {
    ...assertion("hypothesis-authorization", ACTION, "AUTHORIZED_BY", EVIDENCE),
    epistemicClass: "model-hypothesis" as const,
    derivation: { kind: "model" as const, runId: "run:authorization", version: "authority-test" }
  }]
] as const)("rejects %s at public projection admission", async (_name, hostileAssertion) => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await expect(graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: `hostile-${hostileAssertion.id}`,
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [hostileAssertion]
    }
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await graph.close();
});

it("replays byte-identically only while the exact head remains current", async () => {
  const graph = await openCompleteAuthorityGraph();
  const snapshot = await graph.head();
  expect(snapshot).toBeDefined();
  const exactQuery = {
    ...authorityQuery(),
    head: {
      mode: "exact" as const,
      generation: snapshot!.generation,
      commitId: snapshot!.commitId
    }
  };

  const first = await graph.queryAuthority(exactQuery);
  const replay = await graph.queryAuthority(exactQuery);
  expect(JSON.stringify(replay)).toBe(JSON.stringify(first));

  await graph.projectAgainstHead({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "replacement-head",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAuthorityAssertions()
    }
  });
  await expect(graph.queryAuthority(exactQuery)).rejects.toMatchObject({
    code: "SNAPSHOT_CONFLICT"
  });
  await graph.close();
});

it("selects the same semantic authority witness across assertion permutations", async () => {
  const open = async (assertions: readonly GraphAssertion[]) => {
    const graph = await openAttuneGraph({
      scope: SCOPE,
      store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
    });
    await graph.project({
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        observationKey: "permutation-stability",
        scope: SCOPE,
        threadRoot: { ...ROOT },
        observedAt: NOW,
        sourceFreshness: { state: "fresh", observedAt: NOW },
        assertions
      }
    });
    return graph;
  };
  const left = await open(completeAuthorityAssertions());
  const right = await open([...completeAuthorityAssertions()].reverse());
  try {
    const leftResult = await left.queryAuthority(authorityQuery());
    const rightResult = await right.queryAuthority(authorityQuery());
    expect({
      status: rightResult.status,
      authority: rightResult.authority,
      witness: rightResult.witness,
      conflicts: rightResult.conflicts,
      exclusions: rightResult.exclusions
    }).toEqual({
      status: leftResult.status,
      authority: leftResult.authority,
      witness: leftResult.witness,
      conflicts: leftResult.conflicts,
      exclusions: leftResult.exclusions
    });
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

it("returns byte-identical authority results from memory and worker SQLite", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "attunegraph-authority-query-")));
  const memory = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const local = await openLocalAttuneGraph({
    databasePath: join(directory, "authority.sqlite"),
    scope: SCOPE
  });
  const project = () => ({
    operator: "canonical-projection@2" as const,
    observation: {
      schemaVersion: 2 as const,
      observationKey: "memory-sqlite-parity",
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh" as const, observedAt: NOW },
      assertions: completeAuthorityAssertions()
    }
  });
  try {
    await memory.project(project());
    await local.project(project());
    const memoryResult = await memory.queryAuthority(authorityQuery());
    const localResult = await local.queryAuthority(authorityQuery());
    expect(JSON.stringify(localResult)).toBe(JSON.stringify(memoryResult));
  } finally {
    await Promise.all([memory.close(), local.close()]);
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects malformed authority input before executing the query", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await expect(graph.queryAuthority({
    ...authorityQuery(),
    action: { kind: "action", id: "broken\uD800" }
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.queryAuthority({
    ...authorityQuery(),
    budget: { maxEstimatedTokens: 1_023 }
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.queryAuthority({
    ...authorityQuery(1_024),
    action: { kind: "action", id: "x".repeat(512) },
    threadRoot: { kind: "thread", id: "y".repeat(512) }
  })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await expect(graph.queryAuthority(new Proxy(authorityQuery(), {}) as ReturnType<typeof authorityQuery>))
    .rejects.toMatchObject({ code: "INVALID_INPUT" });
  await graph.close();
});

it.each([
  ["future-recorded", { recordedAt: AFTER }],
  ["future-valid", { validFrom: AFTER }],
  ["expired", { validTo: NOW }],
  ["superseded", { supersededAt: NOW }]
] as const)("excludes %s authority evidence at the exact as-of instant", async (name, temporal) => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const governed: GraphAssertion = {
    ...assertion("governed", ACTION, "GOVERNED_BY", POLICY),
    ...temporal
  };
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: `temporal-${name}`,
      scope: SCOPE,
      threadRoot: { ...ROOT },
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        governed,
        assertion("policy-scope", POLICY, "SCOPED_TO", ROOT),
        assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
        assertion("evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT)
      ]
    }
  });
  const result = await graph.queryAuthority(authorityQuery());
  expect(result.status).toBe("abstained");
  expect(result.authority).toBe("undetermined");
  expect(result.diagnostics.terminalReasons).toEqual(["missing-governance-chain"]);
  await graph.close();
});
