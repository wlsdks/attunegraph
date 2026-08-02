import { Buffer } from "node:buffer";

import { AttuneGraphError } from "./attunegraph-error.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import { mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse } from "./canonical-immutable-envelope.js";
import type {
  AttuneGraphOperatorResult,
  AttuneGraphSnapshot,
  AttuneGraphSourceFreshness,
  AttuneGraphWorkingGraph
} from "./attunegraph-contracts.js";
import { ACTIVATION_PREDICATES } from "./constants.js";
import type { GraphAssertion, GraphRef } from "./types.js";
import { graphRefKey, instantEpoch } from "./validation.js";

const MAX_WORKING_ASSERTIONS = 64;
const SELECTED_WORKING_GRAPH_SPEC = Object.freeze({
  hashDomain: "attunegraph.selected-working-graph.v1",
  idField: "selectedWorkingGraphId",
  idPrefix: "attunegraph-selected-working-graph:sha256:"
} as const);

export const WORKING_GRAPH_LIMITS = Object.freeze({
  maxAssertions: MAX_WORKING_ASSERTIONS,
  maxConsideredAssertions: 128,
  maxDepth: 2,
  maxReturnedRefs: MAX_WORKING_ASSERTIONS + 1,
  maxVisitedRefs: 64
} as const);

const ASSERTIONS_PREFIX_BYTES = Buffer.byteLength("{\"assertions\":[", "utf8");
const SEED_PREFIX_BYTES = Buffer.byteLength("],\"seed\":", "utf8");

type WorkingGraphOrdering = "legacy-locale" | "decision-code-unit";

interface PreparedWorkingGraphDecisionEligibility {
  readonly eligibleFrom: number;
  readonly eligibleTo: number;
}

interface PreparedWorkingGraph {
  /** Only execution metadata is retained; canonical/source projection text stays in the Store. */
  readonly snapshot: AttuneGraphSnapshot;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
  readonly assertionBytes: ReadonlyMap<string, number>;
  readonly eligibility: ReadonlyMap<string, PreparedWorkingGraphDecisionEligibility>;
  readonly adjacency: ReadonlyMap<string, readonly GraphAssertion[]>;
}

interface WorkingGraphCompileCommand {
  readonly seed: GraphRef;
  readonly nowEpoch: number;
  readonly maxEstimatedTokens: number;
}

interface WorkingGraphAdmissionAtoms {
  readonly assertions: readonly GraphAssertion[];
  readonly refs: readonly GraphRef[];
  readonly seed: GraphRef;
  readonly querySeed: GraphRef;
  readonly asOfEpoch: number;
  readonly diagnostics: AttuneGraphWorkingGraph["diagnostics"];
}

function invalid(message: string): never {
  throw new AttuneGraphError("INVALID_INPUT", message);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAssertions(
  left: GraphAssertion,
  right: GraphAssertion,
  ordering: WorkingGraphOrdering
): number {
  return ordering === "decision-code-unit"
    ? compareCodeUnits(left.predicate, right.predicate)
      || compareCodeUnits(left.id, right.id)
    : left.predicate.localeCompare(right.predicate)
      || left.id.localeCompare(right.id);
}

function sameRef(left: GraphRef, right: GraphRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function freezeSnapshot(input: AttuneGraphSnapshot): AttuneGraphSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    scope: Object.freeze({ ...input.scope }),
    generation: input.generation,
    commitId: input.commitId
  });
}

function buildAdjacency(
  assertions: readonly GraphAssertion[]
): ReadonlyMap<string, readonly GraphAssertion[]> {
  const adjacency = new Map<string, GraphAssertion[]>();
  for (const assertion of assertions) {
    const subjectKey = graphRefKey(assertion.subject);
    const objectKey = graphRefKey(assertion.object);
    const subjectAssertions = adjacency.get(subjectKey);
    if (subjectAssertions) subjectAssertions.push(assertion);
    else adjacency.set(subjectKey, [assertion]);
    if (objectKey !== subjectKey) {
      const objectAssertions = adjacency.get(objectKey);
      if (objectAssertions) objectAssertions.push(assertion);
      else adjacency.set(objectKey, [assertion]);
    }
  }
  return adjacency;
}

function collectRefs(
  seed: GraphRef,
  assertions: readonly GraphAssertion[],
  ordering: WorkingGraphOrdering
): readonly GraphRef[] {
  const refs = [...new Map([
    seed,
    ...assertions.flatMap((assertion) => [assertion.subject, assertion.object])
  ].map((ref) => [graphRefKey(ref), ref])).values()];
  refs.sort((left, right) => ordering === "decision-code-unit"
    ? compareCodeUnits(graphRefKey(left), graphRefKey(right))
    : graphRefKey(left).localeCompare(graphRefKey(right))
  );
  return Object.freeze(refs.map((ref) => Object.freeze({ ...ref })));
}

function workingGraphJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function prepareWorkingGraphDecisionEligibility(
  assertion: GraphAssertion
): PreparedWorkingGraphDecisionEligibility {
  const recordedAt = instantEpoch(assertion.recordedAt);
  const supersededAt = assertion.supersededAt
    ? instantEpoch(assertion.supersededAt)
    : Infinity;
  const validFrom = assertion.validFrom ? instantEpoch(assertion.validFrom) : -Infinity;
  const validTo = assertion.validTo ? instantEpoch(assertion.validTo) : Infinity;
  return Object.freeze({
    eligibleFrom: Math.max(recordedAt, validFrom),
    eligibleTo: Math.min(supersededAt, validTo)
  });
}

function workingGraphDecisionEligible(
  eligibility: PreparedWorkingGraphDecisionEligibility,
  validAt: number
): boolean {
  return eligibility.eligibleFrom <= validAt && validAt < eligibility.eligibleTo;
}

function estimateWorkingGraphTokens(
  assertionBytes: number,
  assertionCount: number,
  seedBytes: number
): number {
  const commaBytes = Math.max(0, assertionCount - 1);
  const bytes = ASSERTIONS_PREFIX_BYTES
    + assertionBytes
    + commaBytes
    + SEED_PREFIX_BYTES
    + seedBytes
    + 1;
  return Math.ceil(bytes / 4);
}

export function estimateNormalizedWorkingGraphTokens(
  assertions: readonly GraphAssertion[],
  seed: GraphRef
): number {
  return estimateWorkingGraphTokens(
    assertions.reduce((total, assertion) => total + workingGraphJsonBytes(assertion), 0),
    assertions.length,
    workingGraphJsonBytes(seed)
  );
}

export function selectedWorkingGraphContentId(
  assertions: readonly GraphAssertion[],
  seed: GraphRef
): string {
  return mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
    Object.freeze({
      schemaVersion: 1 as const,
      assertions: Object.freeze([...assertions]),
      seed: Object.freeze({ ...seed })
    }),
    SELECTED_WORKING_GRAPH_SPEC
  ).contentId;
}

export function dedupeGraphAssertions(
  assertions: readonly GraphAssertion[],
  code: AttuneGraphError["code"]
): readonly GraphAssertion[] {
  const byId = new Map<string, GraphAssertion>();
  for (const assertion of assertions) {
    const existing = byId.get(assertion.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(assertion)) {
      throw new AttuneGraphError(
        code,
        `assertion id ${assertion.id} has conflicting content`
      );
    }
    if (!existing) byId.set(assertion.id, assertion);
  }
  return Object.freeze(
    [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
  );
}

export function prepareWorkingGraph(
  projection: AttuneGraphStoredProjection
): PreparedWorkingGraph {
  const usable = dedupeGraphAssertions(projection.assertions, "CORRUPT_STORE")
    .filter((assertion) => ACTIVATION_PREDICATES.includes(assertion.predicate))
    .sort((left, right) => compareAssertions(left, right, "legacy-locale"));
  return {
    snapshot: freezeSnapshot(projection.snapshot),
    sourceFreshness: Object.freeze({ ...projection.sourceFreshness }),
    assertionBytes: new Map(
      usable.map((assertion) => [assertion.id, workingGraphJsonBytes(assertion)])
    ),
    eligibility: new Map(usable.map((assertion) => [
      assertion.id,
      prepareWorkingGraphDecisionEligibility(assertion)
    ])),
    adjacency: buildAdjacency(usable)
  };
}

export function compileWorkingGraph(
  prepared: PreparedWorkingGraph,
  command: WorkingGraphCompileCommand,
  ordering: WorkingGraphOrdering = "legacy-locale"
): AttuneGraphWorkingGraph & { readonly status: AttuneGraphOperatorResult["status"] } {
  const eligible = (assertion: GraphAssertion): boolean => {
    const eligibility = prepared.eligibility.get(assertion.id);
    if (eligibility === undefined) {
      throw new AttuneGraphError(
        "CORRUPT_STORE",
        "Working Graph assertion eligibility is unavailable"
      );
    }
    return workingGraphDecisionEligible(eligibility, command.nowEpoch);
  };
  const seedBytes = workingGraphJsonBytes(command.seed);
  const queue: Array<{ readonly ref: GraphRef; readonly depth: number }> = [
    { ref: command.seed, depth: 0 }
  ];
  const visited = new Set<string>([graphRefKey(command.seed)]);
  const selected: GraphAssertion[] = [];
  const selectedIds = new Set<string>();
  let considered = 0;
  let maxDepthReached = 0;
  let traversalTruncated = false;
  let tokenTruncated = false;
  let selectedAssertionBytes = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    maxDepthReached = Math.max(maxDepthReached, current.depth);
    const storedReachable = prepared.adjacency.get(graphRefKey(current.ref)) ?? [];
    const reachable = ordering === "decision-code-unit"
      ? [...storedReachable].sort((left, right) =>
        compareAssertions(left, right, ordering)
      )
      : storedReachable;
    if (current.depth >= WORKING_GRAPH_LIMITS.maxDepth) {
      if (reachable.some((assertion) =>
        eligible(assertion) && !selectedIds.has(assertion.id)
      )) traversalTruncated = true;
      continue;
    }
    for (const assertion of reachable) {
      if (selectedIds.has(assertion.id) || !eligible(assertion)) continue;
      if (
        considered >= WORKING_GRAPH_LIMITS.maxConsideredAssertions
        || selected.length >= WORKING_GRAPH_LIMITS.maxAssertions
      ) {
        traversalTruncated = true;
        break;
      }
      considered += 1;
      const candidateBytes = prepared.assertionBytes.get(assertion.id);
      if (candidateBytes === undefined) {
        throw new AttuneGraphError(
          "CORRUPT_STORE",
          "Working Graph assertion bytes are unavailable"
        );
      }
      if (
        estimateWorkingGraphTokens(
          selectedAssertionBytes + candidateBytes,
          selected.length + 1,
          seedBytes
        ) > command.maxEstimatedTokens
      ) {
        tokenTruncated = true;
        continue;
      }
      selected.push(assertion);
      selectedIds.add(assertion.id);
      selectedAssertionBytes += candidateBytes;
      for (const ref of [assertion.subject, assertion.object]) {
        const key = graphRefKey(ref);
        if (visited.has(key)) continue;
        if (visited.size >= WORKING_GRAPH_LIMITS.maxVisitedRefs) {
          traversalTruncated = true;
          continue;
        }
        visited.add(key);
        queue.push({ ref, depth: current.depth + 1 });
      }
    }
  }
  const truncationReasons = Object.freeze([
    ...(tokenTruncated ? ["token-budget" as const] : []),
    ...(traversalTruncated ? ["traversal-budget" as const] : [])
  ]);
  const graph = Object.freeze({
    assertions: Object.freeze([...selected]),
    refs: collectRefs(command.seed, selected, ordering),
    seed: Object.freeze({ ...command.seed }),
    diagnostics: Object.freeze({
      consideredAssertions: considered,
      estimatedTokens: estimateWorkingGraphTokens(
        selectedAssertionBytes,
        selected.length,
        seedBytes
      ),
      maxDepthReached,
      visitedRefs: visited.size,
      truncationReasons
    })
  });
  return Object.freeze({
    ...graph,
    status: truncationReasons.length > 0
      ? "partial" as const
      : selected.length === 0
        ? "abstained" as const
        : "complete" as const
  });
}

export function emptyWorkingGraph(seed: GraphRef): AttuneGraphWorkingGraph {
  const frozenSeed = Object.freeze({ ...seed });
  return Object.freeze({
    assertions: Object.freeze([]),
    refs: Object.freeze([frozenSeed]),
    seed: frozenSeed,
    diagnostics: Object.freeze({
      consideredAssertions: 0,
      estimatedTokens: estimateWorkingGraphTokens(
        0,
        0,
        workingGraphJsonBytes(frozenSeed)
      ),
      maxDepthReached: 0,
      visitedRefs: 1,
      truncationReasons: Object.freeze([])
    })
  });
}

function validateSelectedTraversal(
  assertions: readonly GraphAssertion[],
  seed: GraphRef
): number {
  const adjacency = buildAdjacency(assertions);
  const queue: Array<{ readonly ref: GraphRef; readonly depth: number }> = [
    { ref: seed, depth: 0 }
  ];
  const visited = new Set([graphRefKey(seed)]);
  const ordered: GraphAssertion[] = [];
  const selectedIds = new Set<string>();
  let maxDepth = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    maxDepth = Math.max(maxDepth, current.depth);
    if (current.depth >= WORKING_GRAPH_LIMITS.maxDepth) continue;
    const reachable = [...(adjacency.get(graphRefKey(current.ref)) ?? [])]
      .sort((left, right) =>
        compareAssertions(left, right, "decision-code-unit")
      );
    for (const assertion of reachable) {
      if (selectedIds.has(assertion.id)) continue;
      selectedIds.add(assertion.id);
      ordered.push(assertion);
      for (const ref of [assertion.subject, assertion.object]) {
        const key = graphRefKey(ref);
        if (visited.has(key)) continue;
        if (visited.size >= WORKING_GRAPH_LIMITS.maxVisitedRefs) continue;
        visited.add(key);
        queue.push({ ref, depth: current.depth + 1 });
      }
    }
  }
  if (ordered.length !== assertions.length) {
    invalid("decision query result Working Graph assertions are disconnected or over-depth");
  }
  if (ordered.some((assertion, index) => assertion.id !== assertions[index]?.id)) {
    invalid("decision query result Working Graph assertions are not in producer order");
  }
  return maxDepth;
}

export function admitSelectedWorkingGraph(
  atoms: WorkingGraphAdmissionAtoms
): AttuneGraphWorkingGraph {
  const { assertions, refs, seed, querySeed, asOfEpoch, diagnostics } = atoms;
  if (assertions.length > WORKING_GRAPH_LIMITS.maxAssertions) {
    invalid("decision query result Working Graph assertions exceed the producer cap");
  }
  if (new Set(assertions.map((assertion) => assertion.id)).size !== assertions.length) {
    invalid("decision query result Working Graph assertion IDs must be unique");
  }
  if (!sameRef(seed, querySeed)) {
    invalid("decision query result Working Graph seed does not close over the receipt query");
  }
  if (assertions.some((assertion) => !workingGraphDecisionEligible(
    prepareWorkingGraphDecisionEligibility(assertion),
    asOfEpoch
  ))) invalid("decision query result Working Graph assertion is temporally ineligible");
  const maxTraversalDepth = validateSelectedTraversal(assertions, seed);
  const expectedRefs = collectRefs(seed, assertions, "decision-code-unit");
  if (
    refs.length !== expectedRefs.length
    || refs.some((ref, index) => !sameRef(ref, expectedRefs[index]!))
  ) invalid("decision query result Working Graph refs are not exact producer refs");
  if (diagnostics.consideredAssertions < assertions.length) {
    invalid("decision query result consideredAssertions is below its selected assertion count");
  }
  const estimatedTokens = estimateNormalizedWorkingGraphTokens(assertions, seed);
  if (diagnostics.estimatedTokens !== estimatedTokens) {
    invalid("decision query result workingGraph.diagnostics.estimatedTokens does not match full assertion bytes");
  }
  if (diagnostics.maxDepthReached !== maxTraversalDepth) {
    invalid("decision query result maxDepthReached is not closed over the Working Graph");
  }
  if (
    diagnostics.visitedRefs !== Math.min(
      expectedRefs.length,
      WORKING_GRAPH_LIMITS.maxVisitedRefs
    )
  ) invalid("decision query result visitedRefs is not closed over the Working Graph");
  const expectedTruncationReasons = [
    ...(diagnostics.truncationReasons.includes("token-budget")
      ? ["token-budget" as const]
      : []),
    ...(diagnostics.truncationReasons.includes("traversal-budget")
      ? ["traversal-budget" as const]
      : [])
  ];
  if (
    diagnostics.truncationReasons.length !== expectedTruncationReasons.length
    || diagnostics.truncationReasons.some((reason, index) =>
      reason !== expectedTruncationReasons[index]
    )
  ) invalid("decision query result Working Graph truncation reasons are not in producer order");
  const tokenTruncated = diagnostics.truncationReasons.includes("token-budget");
  if (tokenTruncated && diagnostics.consideredAssertions <= assertions.length) {
    invalid("decision query result token truncation has no rejected considered assertion");
  }
  if (!tokenTruncated && diagnostics.consideredAssertions !== assertions.length) {
    invalid("decision query result consideredAssertions exceeds selection without token truncation");
  }
  if (
    expectedRefs.length > WORKING_GRAPH_LIMITS.maxVisitedRefs
    && !diagnostics.truncationReasons.includes("traversal-budget")
  ) invalid("decision query result refs beyond the visited cap require traversal truncation");
  if (
    diagnostics.truncationReasons.includes("traversal-budget")
    && diagnostics.maxDepthReached !== WORKING_GRAPH_LIMITS.maxDepth
    && diagnostics.consideredAssertions !== WORKING_GRAPH_LIMITS.maxConsideredAssertions
    && assertions.length !== WORKING_GRAPH_LIMITS.maxAssertions
    && diagnostics.visitedRefs !== WORKING_GRAPH_LIMITS.maxVisitedRefs
  ) invalid("decision query result traversal truncation has no saturated producer cap");
  return Object.freeze({
    assertions: Object.freeze([...assertions]),
    refs: expectedRefs,
    seed,
    diagnostics: Object.freeze({
      ...diagnostics,
      truncationReasons: Object.freeze([...diagnostics.truncationReasons])
    })
  });
}
