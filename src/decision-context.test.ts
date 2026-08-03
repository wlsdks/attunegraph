import { expect, it } from "vitest";

import {
  admitDecisionContextResult,
  openAttuneGraph,
  type AttuneGraphScope,
  type GraphAssertion,
  type GraphPredicate,
  type GraphRef
} from "./index.js";
import { createAttuneGraphStore } from "./attunegraph-backend.js";
import { InMemoryAttuneGraphStoreBackend } from "./attunegraph-in-memory-store.js";
import {
  compileDecisionContext,
  normalizeDecisionContextQuery
} from "./decision-context.js";
import {
  compileWorkingGraph,
  prepareWorkingGraph,
  selectedWorkingGraphContentId
} from "./working-graph.js";
import {
  contentIdFromFrozenUnsignedForInternalUse,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";

const NOW = "2026-08-03T09:00:00.000Z";
const BEFORE = "2026-08-03T08:00:00.000Z";
const SCOPE: AttuneGraphScope = { sourceId: "decision-context-test", threadId: "release" };
const ROOT = { kind: "thread", id: "thread:release" } as const;
const ACTION = { kind: "action", id: "action:publish" } as const;
const POLICY = { kind: "policy", id: "policy:reviewed-release" } as const;
const EVIDENCE = { kind: "evidence", id: "evidence:approval" } as const;

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
    sourceRefs: [{ namespace: "decision-context-test", id: `source:${id}` }],
    recordedAt: BEFORE,
    derivation: { kind: "projection", version: "decision-context-test" }
  };
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeJson(nested);
    Object.freeze(value);
  }
  return value;
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value)) expectDeepFrozen(nested, seen);
}

function completeAssertions(): readonly GraphAssertion[] {
  return [
    assertion("context", { kind: "artifact", id: "release-notes" }, "CONTEXT_FOR", ROOT),
    assertion("governed", ACTION, "GOVERNED_BY", POLICY),
    assertion("policy-scope", POLICY, "SCOPED_TO", ROOT),
    assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
    assertion("evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT)
  ];
}

function decisionContextQuery(
  overrides: Record<string, unknown> = {}
) {
  return {
    operator: "decision-context@1" as const,
    scope: SCOPE,
    seed: ROOT,
    action: ACTION,
    threadRoot: ROOT,
    asOf: NOW,
    head: { mode: "current" as const },
    freshness: { require: "fresh" as const },
    budget: { maxEstimatedTokens: 16_000 },
    ...overrides
  };
}

async function completeResult() {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "complete-result-fixture",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });
  const result = await graph.queryDecisionContext(decisionContextQuery());
  await graph.close();
  return result;
}

function resealFabricatedResult(candidate: any): any {
  const receiptSpec = Object.freeze({
    hashDomain: "attunegraph.decision-context-receipt.v1",
    idField: "receiptId",
    idPrefix: "attunegraph-decision-context:"
  } as const);
  let estimatedTokens = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    candidate.diagnostics.estimatedTokens = estimatedTokens;
    candidate.receipt.diagnostics = JSON.parse(JSON.stringify(candidate.diagnostics));
    const unsigned = JSON.parse(JSON.stringify(candidate.receipt));
    delete unsigned.receiptId;
    delete unsigned.canonicalJson;
    const minted = mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      freezeJson(unsigned),
      receiptSpec
    );
    candidate.receipt = JSON.parse(JSON.stringify({
      ...minted.envelope,
      canonicalJson: minted.canonicalJson
    }));
    const next = Math.ceil(Buffer.byteLength(JSON.stringify(candidate), "utf8") / 4);
    if (next === estimatedTokens) break;
    estimatedTokens = next;
  }
  return candidate;
}

function resealAuthorityEvaluation(candidate: any): void {
  candidate.receipt.authorityEvaluationId = contentIdFromFrozenUnsignedForInternalUse(
    freezeJson({
      contractRevision: 1,
      projection: candidate.authority.projection,
      frontier: candidate.authority.frontier
    }),
    Object.freeze({
      hashDomain: "attunegraph.decision-context-authority-evaluation.v1",
      idField: "authorityEvaluationId",
      idPrefix: "attunegraph-authority-evaluation:"
    })
  );
}

function replaceSelectedWorkingGraph(candidate: any, assertions: readonly GraphAssertion[]): void {
  const compiled = compileWorkingGraph(prepareWorkingGraph(freezeJson({
    schemaVersion: 1,
    snapshot: candidate.snapshot,
    observationId: candidate.authority.projection.observationId,
    canonicalProjection: candidate.authority.projection.canonicalProjection,
    projectionFingerprint: candidate.authority.projection.observationId,
    observedAt: candidate.authority.projection.observedAt,
    sourceFreshness: candidate.sourceFreshness,
    assertions: JSON.parse(JSON.stringify(assertions))
  })), {
    seed: candidate.receipt.query.seed,
    nowEpoch: Date.parse(candidate.receipt.query.asOf),
    maxEstimatedTokens: candidate.receipt.query.budget.maxEstimatedTokens
  }, "decision-code-unit");
  candidate.workingGraph = JSON.parse(JSON.stringify({
    assertions: compiled.assertions,
    refs: compiled.refs,
    seed: compiled.seed,
    diagnostics: compiled.diagnostics
  }));
  candidate.receipt.selectedAssertions = JSON.parse(JSON.stringify(compiled.assertions));
  candidate.receipt.selectedWorkingGraphId = selectedWorkingGraphContentId(
    compiled.assertions,
    compiled.seed
  );
}

it("compiles complete evidence and action authority from one exact head receipt", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const snapshot = await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "complete-decision-context",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });

  const result = await graph.queryDecisionContext({
    operator: "decision-context@1",
    scope: SCOPE,
    seed: ROOT,
    action: ACTION,
    threadRoot: ROOT,
    asOf: NOW,
    head: { mode: "exact", generation: snapshot.generation, commitId: snapshot.commitId },
    freshness: { require: "fresh" },
    budget: { maxEstimatedTokens: 16_000 }
  });

  expect(result).toMatchObject({
    operator: "decision-context@1",
    use: "decision-context",
    status: "complete",
    decisionReady: true,
    executionCapability: "none",
    snapshot,
    diagnostics: {
      evidenceClosure: "complete",
      authorityClosure: "complete",
      conflictClosure: "complete"
    }
  });
  expect(result.authority.witnessAssertions.map((entry) => entry.id)).toEqual([
    "authorized", "evidence-scope", "governed", "policy-scope"
  ]);
  expect(result.receipt.receiptId).toMatch(/^attunegraph-decision-context:/u);
  expect(result.receipt.snapshot).toEqual(snapshot);
  expect(result.receipt.selectedWorkingGraphId).toBeTruthy();
  await graph.close();
});

it("rejects an exact head mismatch before compiling any context", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const snapshot = await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "exact-mismatch",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });

  await expect(graph.queryDecisionContext(decisionContextQuery({
    head: { mode: "exact", generation: snapshot.generation + 1, commitId: snapshot.commitId }
  }))).rejects.toMatchObject({ code: "SNAPSHOT_CONFLICT" });
  await graph.close();
});

it("abstains for a governance conflict even when the conflict is outside selected evidence", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const otherPolicy = { kind: "policy", id: "policy:emergency" } as const;
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "outside-frontier-conflict",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        ...completeAssertions(),
        assertion("conflicting-governance", ACTION, "GOVERNED_BY", otherPolicy),
        assertion("conflicting-scope", otherPolicy, "SCOPED_TO", ROOT)
      ]
    }
  });

  const result = await graph.queryDecisionContext(decisionContextQuery({
    seed: { kind: "artifact", id: "release-notes" }
  }));

  expect(result.status).toBe("abstained");
  expect(result.decisionReady).toBe(false);
  expect(result.authority.authority).toBe("undetermined");
  expect(result.diagnostics.conflictClosure).toBe("conflict");
  expect(result.authority.conflicts).toHaveLength(1);
  expect(admitDecisionContextResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
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
      observationKey: `${state}-source`,
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state, observedAt: NOW },
      assertions: completeAssertions()
    }
  });

  const result = await graph.queryDecisionContext(decisionContextQuery());

  expect(result.status).toBe("abstained");
  expect(result.decisionReady).toBe(false);
  expect(result.authority.witnessAssertions).toEqual([]);
  expect(result.diagnostics.terminalReasons).toContain("source-not-fresh");
  expect(admitDecisionContextResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  await graph.close();
});

it("abstains for a V1 root-unverified projection and a wrong V2 root", async () => {
  const v1 = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await v1.project({
    operator: "canonical-projection@1",
    observation: {
      schemaVersion: 1,
      observationKey: "legacy-root",
      scope: SCOPE,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });
  const v1Result = await v1.queryDecisionContext(decisionContextQuery());
  expect(v1Result.status).toBe("abstained");
  expect(v1Result.diagnostics.terminalReasons).toContain("root-unverified");
  expect(admitDecisionContextResult(JSON.parse(JSON.stringify(v1Result)))).toEqual(v1Result);
  await v1.close();

  const v2 = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await v2.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "wrong-root",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });
  const wrongRoot = await v2.queryDecisionContext(decisionContextQuery({
    threadRoot: { kind: "thread", id: "thread:other" }
  }));
  expect(wrongRoot.status).toBe("abstained");
  expect(wrongRoot.diagnostics.terminalReasons).toContain("root-mismatch");
  expect(admitDecisionContextResult(JSON.parse(JSON.stringify(wrongRoot)))).toEqual(wrongRoot);
  await v2.close();
});

it("never treats a model-hypothesis authority-chain edge as action authority", async () => {
  const assertions = completeAssertions().map((entry) => entry.id === "policy-scope"
    ? {
      ...entry,
      epistemicClass: "model-hypothesis" as const,
      derivation: { kind: "model" as const, version: "decision-context-test", runId: "run:hypothesis" }
    }
    : entry);
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "hypothesis-authority",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions
    }
  });

  const result = await graph.queryDecisionContext(decisionContextQuery());
  expect(result.status).toBe("abstained");
  expect(result.decisionReady).toBe(false);
  expect(result.authority.authority).toBe("undetermined");
  expect(result.authority.exclusions).toContainEqual({
    assertionId: "policy-scope",
    reason: "model-hypothesis"
  });
  await graph.close();
});

it.each([
  ["governance", ["authorized", "evidence-scope"]],
  ["evidence", ["governed", "policy-scope"]]
] as const)("abstains when the %s chain is missing", async (_label, authorityIds) => {
  const keep = new Set<string>(["context", ...authorityIds]);
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: `missing-${_label}`,
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions().filter((entry) => keep.has(entry.id))
    }
  });
  const result = await graph.queryDecisionContext(decisionContextQuery());
  expect(result.status).toBe("abstained");
  expect(result.decisionReady).toBe(false);
  expect(result.diagnostics.terminalReasons).toContain(`missing-${_label}-chain`);
  await graph.close();
});

it("abstains when bounded authority work cannot close", async () => {
  const fillers = Array.from({ length: 33 }, (_, index) => assertion(
    `filler-${index.toString().padStart(2, "0")}`,
    { kind: "artifact", id: `artifact:${index.toString()}` },
    "CONTEXT_FOR",
    ROOT
  ));
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "authority-work-cut",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [...completeAssertions(), ...fillers]
    }
  });
  const result = await graph.queryDecisionContext(decisionContextQuery());
  expect(result.status).toBe("abstained");
  expect(result.authority.authority).toBe("undetermined");
  expect(result.diagnostics.authorityClosure).toBe("incomplete");
  expect(result.diagnostics.truncationReasons).toContain("authority-work-budget");
  expect(result.authority.frontier).toMatchObject({
    evaluatedAssertions: 32,
    totalAssertions: 38,
    scanClosure: "work-cut"
  });
  expect(result.authority.frontier.assertions).toHaveLength(33);
  expect(admitDecisionContextResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  await graph.close();
});

it("returns partial without decision readiness when authorized evidence is token-cut", async () => {
  const contexts = Array.from({ length: 10 }, (_, index) => assertion(
    `large-context-${index.toString().padStart(2, "0")}-${"x".repeat(40)}`,
    { kind: "artifact", id: `artifact:${index.toString()}:${"y".repeat(40)}` },
    "CONTEXT_FOR",
    ROOT
  ));
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "evidence-token-cut",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [...completeAssertions(), ...contexts]
    }
  });
  const result = await graph.queryDecisionContext(decisionContextQuery({
    budget: { maxEstimatedTokens: 8_000 }
  }));
  expect(result.status).toBe("partial");
  expect(result.decisionReady).toBe(false);
  expect(result.executionCapability).toBe("none");
  expect(result.authority.authority).toBe("authorized");
  expect(result.authority.witnessAssertions).toHaveLength(4);
  expect(result.diagnostics.truncationReasons).toContain("token-budget");
  expect(admitDecisionContextResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  await graph.close();
});

it("round-trips an honest no-head abstention through full fixed-profile replay", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const result = await graph.queryDecisionContext(decisionContextQuery());
  expect(result.status).toBe("abstained");
  expect(result.diagnostics.terminalReasons).toContain("no-head");
  expect(admitDecisionContextResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  await graph.close();
});

it("rejects one token below the mandatory decision-context metadata budget", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await expect(graph.queryDecisionContext(decisionContextQuery({
    budget: { maxEstimatedTokens: 4_095 }
  }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await graph.close();
});

it("is byte-identical under assertion input permutation", async () => {
  const backend = new InMemoryAttuneGraphStoreBackend();
  const graph = await openAttuneGraph({ scope: SCOPE, store: createAttuneGraphStore(backend) });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "permutation",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });
  const projection = await backend.read(SCOPE);
  expect(projection).toBeDefined();
  const query = normalizeDecisionContextQuery(decisionContextQuery());
  const admitted = freezeJson(JSON.parse(JSON.stringify(projection)) as NonNullable<typeof projection>);
  const left = compileDecisionContext(admitted, query);
  const permuted = JSON.parse(JSON.stringify(projection)) as typeof projection;
  (permuted!.assertions as GraphAssertion[]).reverse();
  const right = compileDecisionContext(freezeJson(permuted), query);
  expect(JSON.stringify(right)).toBe(JSON.stringify(left));
  expect(right.receipt.receiptId).toBe(left.receipt.receiptId);
  await graph.close();
});

it("admits a JSON round-trip and deeply freezes the resealed result", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "transport-round-trip",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });
  const result = await graph.queryDecisionContext(decisionContextQuery());
  const admitted = admitDecisionContextResult(JSON.parse(JSON.stringify(result)));
  expect(admitted).toEqual(result);
  expectDeepFrozen(admitted);
  await graph.close();
});

it("rejects selected content, proof, closure, status, budget, snapshot, and receipt substitution", async () => {
  const result = await completeResult();
  const mutations: Array<(candidate: any) => void> = [
    (candidate) => { candidate.workingGraph.assertions[0].id = "substituted-selection"; },
    (candidate) => { candidate.authority.witnessAssertions[0].id = "substituted-witness"; },
    (candidate) => { candidate.authority.witnessAssertions[0].sourceRefs[0].id = "substituted-source"; },
    (candidate) => { candidate.diagnostics.authorityClosure = "incomplete"; },
    (candidate) => { candidate.status = "partial"; },
    (candidate) => { candidate.receipt.query.budget.maxEstimatedTokens = 15_999; },
    (candidate) => { candidate.snapshot.commitId = "attunegraph-commit:substituted"; },
    (candidate) => { candidate.receipt.receiptId = "attunegraph-decision-context:substituted"; }
  ];
  for (const mutate of mutations) {
    const candidate = JSON.parse(JSON.stringify(result));
    mutate(candidate);
    expect(() => admitDecisionContextResult(candidate)).toThrow();
  }
});

it("rejects a self-consistent fabricated governance conflict unsupported by transported assertions", async () => {
  const candidate: any = JSON.parse(JSON.stringify(await completeResult()));
  const fabricatedConflict = {
    predicate: "GOVERNED_BY",
    subject: { ...ACTION },
    assertionIds: ["fabricated-governance-a", "fabricated-governance-b"],
    objectRefs: [
      { kind: "policy", id: "policy:fabricated-a" },
      { kind: "policy", id: "policy:fabricated-b" }
    ],
    sourceRefs: [
      { namespace: "fabricated", id: "source:a" },
      { namespace: "fabricated", id: "source:b" }
    ]
  };
  candidate.status = "abstained";
  candidate.decisionReady = false;
  candidate.authority.authority = "undetermined";
  candidate.authority.witnessAssertions = [];
  candidate.authority.conflicts = [fabricatedConflict];
  candidate.authority.exclusions = [];
  candidate.authority.diagnostics = {
    ...candidate.authority.diagnostics,
    eligibleFrontierAssertions: 5,
    truncationReasons: [],
    terminalReasons: ["authority-conflict"],
    authorityClosure: "incomplete",
    conflictClosure: "conflict"
  };
  candidate.diagnostics = {
    ...candidate.diagnostics,
    authorityClosure: "incomplete",
    conflictClosure: "conflict",
    truncationReasons: [],
    terminalReasons: ["authority-conflict"]
  };
  candidate.receipt.status = candidate.status;
  candidate.receipt.decisionReady = candidate.decisionReady;
  candidate.receipt.authorityWitnessAssertions = [];
  candidate.receipt.conflicts = [fabricatedConflict];
  candidate.receipt.exclusions = [];

  expect(() => admitDecisionContextResult(resealFabricatedResult(candidate))).toThrow();
});

it("rejects fabricated, replaced, or omitted selected evidence outside full projection replay", async () => {
  const base: any = JSON.parse(JSON.stringify(await completeResult()));
  const canonical = JSON.parse(base.authority.projection.canonicalProjection) as {
    assertions: GraphAssertion[];
  };
  const mutations: Array<(assertions: GraphAssertion[]) => GraphAssertion[]> = [
    (assertions) => [
      ...assertions,
      assertion("fabricated-context", { kind: "artifact", id: "fabricated" }, "CONTEXT_FOR", ROOT)
    ],
    (assertions) => assertions.map((entry) => entry.id === "context"
      ? { ...entry, id: "replace" }
      : entry),
    (assertions) => assertions.filter((entry) => entry.id !== "context")
  ];
  for (const mutate of mutations) {
    const candidate: any = JSON.parse(JSON.stringify(base));
    replaceSelectedWorkingGraph(candidate, mutate(JSON.parse(JSON.stringify(canonical.assertions))));
    expect(() => admitDecisionContextResult(resealFabricatedResult(candidate))).toThrow();
  }
});

it("rejects altered selected Working Graph refs and diagnostics", async () => {
  const mutations: Array<(candidate: any) => void> = [
    (candidate) => { candidate.workingGraph.refs[0].id = "fabricated-ref"; },
    (candidate) => { candidate.workingGraph.diagnostics.estimatedTokens += 1; }
  ];
  for (const mutate of mutations) {
    const candidate: any = JSON.parse(JSON.stringify(await completeResult()));
    mutate(candidate);
    expect(() => admitDecisionContextResult(resealFabricatedResult(candidate))).toThrow();
  }
});

it("rejects false authorization produced by omitting a transported governance conflict", async () => {
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  const otherPolicy = { kind: "policy", id: "policy:omitted-conflict" } as const;
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "omitted-conflict",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: [
        ...completeAssertions(),
        assertion("omitted-governance", ACTION, "GOVERNED_BY", otherPolicy),
        assertion("omitted-scope", otherPolicy, "SCOPED_TO", ROOT)
      ]
    }
  });
  const candidate: any = JSON.parse(JSON.stringify(
    await graph.queryDecisionContext(decisionContextQuery())
  ));
  await graph.close();
  const honestComplete: any = JSON.parse(JSON.stringify(await completeResult()));
  candidate.status = "complete";
  candidate.decisionReady = true;
  candidate.authority = {
    ...honestComplete.authority,
    projection: candidate.authority.projection,
    frontier: {
      assertions: candidate.authority.frontier.assertions.filter(
        (entry: GraphAssertion) => !entry.id.startsWith("omitted-")
      ),
      evaluatedAssertions: 5,
      totalAssertions: 5,
      scanClosure: "complete"
    }
  };
  candidate.receipt.status = "complete";
  candidate.receipt.decisionReady = true;
  candidate.receipt.authorityWitnessAssertions = candidate.authority.witnessAssertions;
  candidate.receipt.conflicts = [];
  candidate.receipt.exclusions = [];
  resealAuthorityEvaluation(candidate);

  expect(() => admitDecisionContextResult(resealFabricatedResult(candidate))).toThrow();
});

it("rejects a fabricated terminal reason unsupported by projection posture", async () => {
  const candidate: any = JSON.parse(JSON.stringify(await completeResult()));
  candidate.status = "abstained";
  candidate.decisionReady = false;
  candidate.authority.authority = "undetermined";
  candidate.authority.witnessAssertions = [];
  candidate.authority.diagnostics = {
    ...candidate.authority.diagnostics,
    consideredAssertions: 0,
    eligibleFrontierAssertions: 0,
    terminalReasons: ["source-not-fresh"],
    authorityClosure: "incomplete",
    conflictClosure: "incomplete"
  };
  candidate.diagnostics = {
    ...candidate.diagnostics,
    authorityClosure: "incomplete",
    conflictClosure: "incomplete",
    terminalReasons: ["source-not-fresh"]
  };
  candidate.receipt.status = "abstained";
  candidate.receipt.decisionReady = false;
  candidate.receipt.authorityWitnessAssertions = [];

  expect(() => admitDecisionContextResult(resealFabricatedResult(candidate))).toThrow();
});

it("rejects a fabricated authority exclusion unsupported by the frontier", async () => {
  const candidate: any = JSON.parse(JSON.stringify(await completeResult()));
  const fabricated = { assertionId: "authorized", reason: "model-hypothesis" };
  candidate.authority.exclusions = [fabricated];
  candidate.authority.diagnostics.rejectedFrontierAssertions = 1;
  candidate.receipt.exclusions = [fabricated];

  expect(() => admitDecisionContextResult(resealFabricatedResult(candidate))).toThrow();
});

it("rejects malformed, proxy, accessor, unknown-field, unsafe-integer, and future-revision transport", async () => {
  const result = await completeResult();
  const unknown = JSON.parse(JSON.stringify(result));
  unknown.unrecognized = true;
  expect(() => admitDecisionContextResult(unknown)).toThrow();

  const future = JSON.parse(JSON.stringify(result));
  future.receipt.contractRevision = 2;
  expect(() => admitDecisionContextResult(future)).toThrow(/revision/u);

  const malformedTime = JSON.parse(JSON.stringify(result));
  malformedTime.sourceFreshness.observedAt = "not-an-instant";
  expect(() => admitDecisionContextResult(malformedTime)).toThrow();

  const unsafe = JSON.parse(JSON.stringify(result));
  unsafe.receipt.query.head = {
    mode: "exact",
    generation: Number.MAX_SAFE_INTEGER + 1,
    commitId: result.snapshot!.commitId
  };
  expect(() => admitDecisionContextResult(unsafe)).toThrow();

  expect(() => admitDecisionContextResult(new Proxy(JSON.parse(JSON.stringify(result)), {}))).toThrow(/non-proxy/u);

  const accessor = JSON.parse(JSON.stringify(result));
  Object.defineProperty(accessor, "status", { enumerable: true, get: () => "complete" });
  expect(() => admitDecisionContextResult(accessor)).toThrow(/data properties/u);

  const nestedProxy = JSON.parse(JSON.stringify(result));
  nestedProxy.receipt.selectedAssertions = new Proxy(nestedProxy.receipt.selectedAssertions, {});
  expect(() => admitDecisionContextResult(nestedProxy)).toThrow(/unsafe/u);

  const nestedAccessor = JSON.parse(JSON.stringify(result));
  Object.defineProperty(nestedAccessor.diagnostics, "estimatedTokens", {
    enumerable: true,
    get: () => result.diagnostics.estimatedTokens
  });
  expect(() => admitDecisionContextResult(nestedAccessor)).toThrow(/data properties/u);
});

it("reads exactly one admitted projection so concurrent generations cannot be mixed", async () => {
  const inner = new InMemoryAttuneGraphStoreBackend();
  let reads = 0;
  const store = createAttuneGraphStore({
    read: async (scope) => {
      reads += 1;
      return inner.read(scope);
    },
    compareAndSwap: (scope, expected, proposed) => inner.compareAndSwap(scope, expected, proposed)
  });
  const graph = await openAttuneGraph({ scope: SCOPE, store });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "single-read",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: completeAssertions()
    }
  });
  reads = 0;
  const result = await graph.queryDecisionContext(decisionContextQuery());
  expect(reads).toBe(1);
  expect(result.receipt.snapshot).toEqual(result.snapshot);
  expect(result.receipt.authorityWitnessAssertions).toEqual(result.authority.witnessAssertions);
  await graph.close();
});

it("fails closed below the minimum budget for its transported authority frontier", async () => {
  const large = completeAssertions().map((entry) => ({
    ...entry,
    id: `${entry.id}:${"q".repeat(480)}`,
    sourceRefs: [{ namespace: "authority-token-cut", id: `${entry.id}:${"z".repeat(480)}` }]
  }));
  const graph = await openAttuneGraph({
    scope: SCOPE,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  await graph.project({
    operator: "canonical-projection@2",
    observation: {
      schemaVersion: 2,
      observationKey: "authority-token-cut",
      scope: SCOPE,
      threadRoot: ROOT,
      observedAt: NOW,
      sourceFreshness: { state: "fresh", observedAt: NOW },
      assertions: large
    }
  });
  await expect(graph.queryDecisionContext(decisionContextQuery({
    budget: { maxEstimatedTokens: 8_826 }
  }))).rejects.toThrow("decision context budget cannot represent its mandatory result metadata");
  const result = await graph.queryDecisionContext(decisionContextQuery({
    budget: { maxEstimatedTokens: 8_827 }
  }));
  expect(result.status).toBe("partial");
  expect(result.authority.authority).toBe("authorized");
  expect(result.diagnostics.truncationReasons).toContain("token-budget");
  expect(result.diagnostics.estimatedTokens).toBe(8_827);
  await graph.close();
});
