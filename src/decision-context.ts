import { isDeepStrictEqual, types as nodeTypes } from "node:util";

import { AttuneGraphError } from "./attunegraph-error.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type {
  AttuneGraphAuthorityQuery,
  AttuneGraphAuthorityQueryResult,
  AttuneGraphDecisionContextProofBundle,
  AttuneGraphDecisionContextDiagnostics,
  AttuneGraphDecisionContextQuery,
  AttuneGraphDecisionContextReceipt,
  AttuneGraphDecisionContextResult
} from "./attunegraph-contracts.js";
import { compileAuthorityQuery, normalizeAuthorityQuery } from "./authority-query.js";
import {
  canonicalizeImmutableEnvelope,
  contentIdFromFrozenUnsignedForInternalUse,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import { normalizeDecisionQuery } from "./decision-query.js";
import type { GraphAssertion } from "./types.js";
import {
  compileWorkingGraph,
  admitSelectedWorkingGraph,
  emptyWorkingGraph,
  prepareWorkingGraph,
  selectedWorkingGraphContentId
} from "./working-graph.js";
import { GRAPH_NODE_KINDS, type GraphEvidenceRef, type GraphRef } from "./types.js";
import { instantEpoch, normalizeGraphAssertion } from "./validation.js";

const RECEIPT_SPEC = Object.freeze({
  hashDomain: "attunegraph.decision-context-receipt.v1",
  idField: "receiptId",
  idPrefix: "attunegraph-decision-context:"
} as const);
const AUTHORITY_EVALUATION_SPEC = Object.freeze({
  hashDomain: "attunegraph.decision-context-authority-evaluation.v1",
  idField: "authorityEvaluationId",
  idPrefix: "attunegraph-authority-evaluation:"
} as const);
const MAX_AUTHORITY_EVALUATED_ASSERTIONS = 32;
const MAX_AUTHORITY_TRANSPORTED_ASSERTIONS = 33;
const MIN_DECISION_CONTEXT_ESTIMATED_TOKENS = 4_096;
type DataRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new AttuneGraphError("INVALID_INPUT", message);
}

function record(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[]
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) {
    invalid(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) invalid(`${label} has invalid fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    if (typeof key !== "string") return true;
    const descriptor = descriptors[key];
    return descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true;
  })) invalid(`${label} fields must be visible data properties`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key as string]!.value]));
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || value.length > maximum) {
    invalid(`${label} must be a non-proxy array with at most ${maximum.toString()} items`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) invalid(`${label} has hidden or extra fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index.toString()];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      invalid(`${label} must contain only visible data properties`);
    }
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid(`${label} must be a safe integer`);
  return value as number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > 16_384) {
    invalid(`${label} must be bounded non-empty text`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString() !== normalized) {
    invalid(`${label} must be a canonical ISO instant`);
  }
  return normalized;
}

function normalizeRef(value: unknown, label: string): GraphRef {
  const input = record(value, label, ["id", "kind"], ["id", "kind"]);
  if (!GRAPH_NODE_KINDS.includes(input.kind as never)) invalid(`${label}.kind is invalid`);
  return Object.freeze({ id: text(input.id, `${label}.id`), kind: input.kind as GraphRef["kind"] });
}

function normalizeEvidenceRef(value: unknown, label: string): GraphEvidenceRef {
  const input = record(value, label, ["namespace", "id", "version"], ["namespace", "id"]);
  return Object.freeze({
    namespace: text(input.namespace, `${label}.namespace`),
    id: text(input.id, `${label}.id`),
    ...(input.version === undefined ? {} : { version: text(input.version, `${label}.version`) })
  });
}

export function normalizeDecisionContextQuery(value: AttuneGraphDecisionContextQuery): AttuneGraphDecisionContextQuery {
  const input = record(
    value,
    "decision context query",
    ["operator", "scope", "seed", "action", "threadRoot", "asOf", "head", "freshness", "budget"],
    ["operator", "scope", "seed", "action", "threadRoot", "asOf", "head", "freshness", "budget"]
  );
  if (input.operator !== "decision-context@1") {
    throw new AttuneGraphError("UNSUPPORTED_OPERATOR", "queryDecisionContext supports only decision-context@1");
  }
  const decision = normalizeDecisionQuery({
    operator: "decision-query@1",
    scope: input.scope as AttuneGraphDecisionContextQuery["scope"],
    seed: input.seed as AttuneGraphDecisionContextQuery["seed"],
    asOf: input.asOf as string,
    head: input.head as AttuneGraphDecisionContextQuery["head"],
    freshness: input.freshness as AttuneGraphDecisionContextQuery["freshness"],
    budget: input.budget as AttuneGraphDecisionContextQuery["budget"]
  });
  const authority = normalizeAuthorityQuery({
    operator: "authority-query@1",
    scope: input.scope as AttuneGraphDecisionContextQuery["scope"],
    action: input.action as AttuneGraphDecisionContextQuery["action"],
    threadRoot: input.threadRoot as AttuneGraphDecisionContextQuery["threadRoot"],
    asOf: input.asOf as string,
    head: input.head as AttuneGraphDecisionContextQuery["head"],
    freshness: input.freshness as AttuneGraphDecisionContextQuery["freshness"],
    budget: input.budget as AttuneGraphDecisionContextQuery["budget"]
  });
  if (decision.budget.maxEstimatedTokens < MIN_DECISION_CONTEXT_ESTIMATED_TOKENS) {
    invalid(`decision context query budget must be at least ${MIN_DECISION_CONTEXT_ESTIMATED_TOKENS.toString()} tokens`);
  }
  return Object.freeze({
    operator: "decision-context@1" as const,
    scope: decision.scope,
    seed: decision.seed,
    action: authority.action,
    threadRoot: authority.threadRoot,
    asOf: decision.asOf,
    head: decision.head,
    freshness: decision.freshness,
    budget: decision.budget
  });
}

function authorityQuery(query: AttuneGraphDecisionContextQuery): AttuneGraphAuthorityQuery {
  return Object.freeze({
    operator: "authority-query@1" as const,
    scope: query.scope,
    action: query.action,
    threadRoot: query.threadRoot,
    asOf: query.asOf,
    head: query.head,
    freshness: query.freshness,
    budget: query.budget
  });
}

function witnessAssertions(
  projection: AttuneGraphStoredProjection | undefined,
  ids: readonly string[]
): readonly GraphAssertion[] {
  if (projection === undefined || ids.length === 0) return Object.freeze([]);
  const byId = new Map(projection.assertions.map((assertion) => [assertion.id, assertion]));
  const assertions = ids.map((id) => byId.get(id));
  if (assertions.some((assertion) => assertion === undefined)) {
    throw new AttuneGraphError("CORRUPT_STORE", "authority witness assertion is absent from its projection");
  }
  return Object.freeze(assertions as GraphAssertion[]);
}

const PRE_SCAN_TERMINAL_REASONS = new Set([
  "no-head",
  "root-unverified",
  "root-mismatch",
  "projection-from-future",
  "freshness-from-future",
  "source-not-fresh"
]);

function authorityProjectionPosture(
  projection: AttuneGraphStoredProjection | undefined,
  authorityResult: AttuneGraphAuthorityQueryResult
): AttuneGraphDecisionContextResult["authority"]["projection"] {
  if (projection === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(projection.canonicalProjection);
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "decision context projection profile is invalid", { cause });
  }
  const schemaVersion = (parsed as { readonly schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new AttuneGraphError("CORRUPT_STORE", "decision context projection profile is unsupported");
  }
  const threadRoot = authorityResult.projection?.threadRoot ?? null;
  if (schemaVersion === 2 && threadRoot === null) {
    throw new AttuneGraphError("CORRUPT_STORE", "decision context V2 authority root is unavailable");
  }
  return Object.freeze({
    profile: schemaVersion === 1 ? "canonical-projection@1" as const : "canonical-projection@2" as const,
    observationId: projection.observationId,
    canonicalProjection: projection.canonicalProjection,
    observedAt: projection.observedAt,
    threadRoot: threadRoot === null
      ? null
      : Object.freeze({ ...threadRoot }) as GraphRef & { readonly kind: "thread" }
  });
}

function authorityFrontier(
  projection: AttuneGraphStoredProjection | undefined,
  authorityResult: AttuneGraphAuthorityQueryResult
): AttuneGraphDecisionContextResult["authority"]["frontier"] {
  if (projection === undefined) {
    return Object.freeze({
      assertions: Object.freeze([]),
      evaluatedAssertions: 0,
      totalAssertions: 0,
      scanClosure: "not-performed" as const
    });
  }
  const totalAssertions = projection.assertions.length;
  if (authorityResult.diagnostics.terminalReasons.some((reason) => PRE_SCAN_TERMINAL_REASONS.has(reason))) {
    return Object.freeze({
      assertions: Object.freeze([]),
      evaluatedAssertions: 0,
      totalAssertions,
      scanClosure: "not-performed" as const
    });
  }
  if (totalAssertions > MAX_AUTHORITY_EVALUATED_ASSERTIONS) {
    return Object.freeze({
      assertions: Object.freeze(projection.assertions.slice(0, MAX_AUTHORITY_TRANSPORTED_ASSERTIONS)),
      evaluatedAssertions: MAX_AUTHORITY_EVALUATED_ASSERTIONS,
      totalAssertions,
      scanClosure: "work-cut" as const
    });
  }
  return Object.freeze({
    assertions: Object.freeze([...projection.assertions].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    )),
    evaluatedAssertions: totalAssertions,
    totalAssertions,
    scanClosure: "complete" as const
  });
}

function authorityEvaluationId(
  authority: Pick<AttuneGraphDecisionContextResult["authority"], "projection" | "frontier">
): string {
  return contentIdFromFrozenUnsignedForInternalUse(
    Object.freeze({
      contractRevision: 1 as const,
      projection: authority.projection,
      frontier: authority.frontier
    }),
    AUTHORITY_EVALUATION_SPEC
  );
}

function decisionContextAuthority(
  projection: AttuneGraphStoredProjection | undefined,
  authorityResult: AttuneGraphAuthorityQueryResult,
  suppliedEvaluation?: Readonly<{
    readonly projection: AttuneGraphDecisionContextResult["authority"]["projection"];
    readonly frontier: AttuneGraphDecisionContextResult["authority"]["frontier"];
  }>
): AttuneGraphDecisionContextResult["authority"] {
  const evaluation = suppliedEvaluation ?? Object.freeze({
    projection: authorityProjectionPosture(projection, authorityResult),
    frontier: authorityFrontier(projection, authorityResult)
  });
  return Object.freeze({
    authority: authorityResult.authority,
    projection: evaluation.projection,
    frontier: evaluation.frontier,
    witnessAssertions: witnessAssertions(
      projection === undefined
        ? undefined
        : Object.freeze({ ...projection, assertions: evaluation.frontier.assertions }),
      authorityResult.witness.assertionIds
    ),
    conflicts: authorityResult.conflicts,
    exclusions: authorityResult.exclusions,
    diagnostics: authorityResult.diagnostics
  });
}

interface Atoms {
  readonly query: AttuneGraphDecisionContextQuery;
  readonly projection: AttuneGraphStoredProjection | undefined;
  readonly workingGraph: AttuneGraphDecisionContextResult["workingGraph"];
  readonly authority: AttuneGraphDecisionContextResult["authority"];
  readonly status: AttuneGraphDecisionContextResult["status"];
}

function deeplyFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) {
      deeplyFreeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function detachedFrozen<T>(value: T): T {
  return deeplyFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function baseDiagnostics(atoms: Atoms, estimatedTokens: number): AttuneGraphDecisionContextDiagnostics {
  const evidenceClosure = atoms.workingGraph.diagnostics.truncationReasons.length === 0
    && atoms.workingGraph.assertions.length > 0
    ? "complete" as const
    : "incomplete" as const;
  const authorityTruncation = atoms.authority.diagnostics.truncationReasons.map((reason) =>
    reason === "work-budget" ? "authority-work-budget" as const : "authority-token-budget" as const
  );
  const terminalReasons = [
    ...atoms.authority.diagnostics.terminalReasons,
    ...(atoms.workingGraph.assertions.length === 0
      && atoms.workingGraph.diagnostics.truncationReasons.length === 0
      ? ["no-eligible-evidence" as const]
      : [])
  ];
  return Object.freeze({
    estimatedTokens,
    evidenceClosure,
    authorityClosure: atoms.authority.diagnostics.authorityClosure,
    conflictClosure: atoms.authority.diagnostics.conflictClosure,
    truncationReasons: Object.freeze([
      ...atoms.workingGraph.diagnostics.truncationReasons,
      ...authorityTruncation
    ]),
    terminalReasons: Object.freeze(terminalReasons)
  });
}

function buildResult(atoms: Atoms, estimatedTokens: number): AttuneGraphDecisionContextResult {
  const diagnostics = baseDiagnostics(atoms, estimatedTokens);
  const decisionReady = atoms.status === "complete"
    && diagnostics.evidenceClosure === "complete"
    && atoms.authority.authority === "authorized"
    && diagnostics.authorityClosure === "complete"
    && diagnostics.conflictClosure === "complete";
  const snapshot = atoms.projection?.snapshot;
  const sourceFreshness = atoms.projection?.sourceFreshness;
  const unsigned = Object.freeze({
    contractRevision: 1 as const,
    use: "decision-context" as const,
    query: atoms.query,
    snapshot: snapshot ?? null,
    sourceFreshness: sourceFreshness ?? null,
    selectedWorkingGraphId: selectedWorkingGraphContentId(
      atoms.workingGraph.assertions,
      atoms.workingGraph.seed
    ),
    selectedAssertions: detachedFrozen(atoms.workingGraph.assertions),
    authorityEvaluationId: authorityEvaluationId(atoms.authority),
    authorityWitnessAssertions: detachedFrozen(atoms.authority.witnessAssertions),
    conflicts: detachedFrozen(atoms.authority.conflicts),
    exclusions: detachedFrozen(atoms.authority.exclusions),
    status: atoms.status,
    decisionReady,
    executionCapability: "none" as const,
    diagnostics
  });
  let receipt: AttuneGraphDecisionContextReceipt;
  try {
    const minted = mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(unsigned, RECEIPT_SPEC);
    receipt = Object.freeze({
      ...minted.envelope,
      canonicalJson: minted.canonicalJson
    }) as unknown as AttuneGraphDecisionContextReceipt;
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "decision context receipt could not be sealed", { cause });
  }
  return Object.freeze({
    operator: "decision-context@1" as const,
    use: "decision-context" as const,
    status: atoms.status,
    decisionReady,
    executionCapability: "none" as const,
    ...(snapshot === undefined ? {} : { snapshot: Object.freeze({ ...snapshot, scope: Object.freeze({ ...snapshot.scope }) }) }),
    ...(sourceFreshness === undefined ? {} : { sourceFreshness: Object.freeze({ ...sourceFreshness }) }),
    workingGraph: atoms.workingGraph,
    authority: atoms.authority,
    diagnostics,
    receipt
  });
}

function converge(atoms: Atoms): AttuneGraphDecisionContextResult {
  let estimatedTokens = 0;
  let result = buildResult(atoms, estimatedTokens);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const next = Math.ceil(Buffer.byteLength(JSON.stringify(result), "utf8") / 4);
    if (next === estimatedTokens) return result;
    estimatedTokens = next;
    result = buildResult(atoms, estimatedTokens);
  }
  return result;
}

export function compileDecisionContext(
  projection: AttuneGraphStoredProjection | undefined,
  query: AttuneGraphDecisionContextQuery
): AttuneGraphDecisionContextResult {
  const authorityResult = compileAuthorityQuery(projection, authorityQuery(query));
  const authority = decisionContextAuthority(projection, authorityResult);
  let workingGraph = emptyWorkingGraph(query.seed);
  if (projection !== undefined && projection.sourceFreshness.state === "fresh") {
    const compiled = compileWorkingGraph(prepareWorkingGraph(projection), {
      seed: query.seed,
      nowEpoch: instantEpoch(query.asOf),
      maxEstimatedTokens: query.budget.maxEstimatedTokens
    }, "decision-code-unit");
    workingGraph = Object.freeze({
      assertions: compiled.assertions,
      refs: compiled.refs,
      seed: compiled.seed,
      diagnostics: compiled.diagnostics
    });
  }
  const evidenceComplete = workingGraph.assertions.length > 0
    && workingGraph.diagnostics.truncationReasons.length === 0;
  const status = authority.authority !== "authorized"
    || authority.diagnostics.authorityClosure !== "complete"
    || authority.diagnostics.conflictClosure !== "complete"
    || projection?.sourceFreshness.state !== "fresh"
    ? "abstained" as const
    : evidenceComplete
      ? "complete" as const
      : workingGraph.diagnostics.truncationReasons.length > 0
        ? "partial" as const
        : "abstained" as const;
  let atoms: Atoms = Object.freeze({ query, projection, workingGraph, authority, status });
  let result = converge(atoms);
  if (result.diagnostics.estimatedTokens > query.budget.maxEstimatedTokens) {
    const empty = emptyWorkingGraph(query.seed);
    const rejectedConsideredAssertions = workingGraph.diagnostics.consideredAssertions;
    workingGraph = Object.freeze({
      ...empty,
      diagnostics: Object.freeze({
        ...empty.diagnostics,
        consideredAssertions: rejectedConsideredAssertions,
        truncationReasons: Object.freeze(
          rejectedConsideredAssertions > 0 ? ["token-budget" as const] : []
        )
      })
    });
    atoms = Object.freeze({
      query,
      projection,
      workingGraph,
      authority,
      status: status === "complete" ? "partial" as const : status
    });
    result = converge(atoms);
  }
  if (result.diagnostics.estimatedTokens > query.budget.maxEstimatedTokens) {
    invalid("decision context budget cannot represent its mandatory result metadata");
  }
  return result;
}

/** Package-private semantic replay for the compact agent proof bundle. */
export function replayDecisionContextProofBundle(
  value: AttuneGraphDecisionContextProofBundle
): AttuneGraphDecisionContextResult {
  const query = normalizeDecisionContextQuery(value.query);
  const snapshot = value.snapshot === null
    ? undefined
    : normalizeAdmissionSnapshot(value.snapshot, query);
  const sourceFreshness = value.sourceFreshness === null
    ? undefined
    : normalizeAdmissionFreshness(value.sourceFreshness);
  const evaluationProjection = normalizeAdmissionAuthorityProjection(value.projection);
  let projection: AttuneGraphStoredProjection | undefined;
  if (evaluationProjection === null) {
    if (snapshot !== undefined || sourceFreshness !== undefined) {
      invalid("no-head decision proof must not carry snapshot or freshness metadata");
    }
  } else {
    if (snapshot === undefined || sourceFreshness === undefined) {
      invalid("decision proof projection requires snapshot and freshness metadata");
    }
    if (snapshot.commitId !== `attunegraph-commit:${evaluationProjection.observationId}`) {
      invalid("decision proof projection observation does not match its snapshot commit");
    }
    const canonicalAssertions = admitAuthorityCanonicalProjection(
      evaluationProjection,
      query,
      sourceFreshness
    );
    projection = Object.freeze({
      schemaVersion: 1,
      snapshot,
      observationId: evaluationProjection.observationId,
      canonicalProjection: evaluationProjection.canonicalProjection,
      projectionFingerprint: evaluationProjection.observationId,
      observedAt: evaluationProjection.observedAt,
      sourceFreshness,
      assertions: Object.freeze([...canonicalAssertions].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      ))
    });
  }
  const replayed = compileDecisionContext(projection, query);
  if (replayed.receipt.receiptId !== value.expectedDecisionReceiptId) {
    invalid("decision proof does not reproduce its expected receipt");
  }
  return replayed;
}

/**
 * Admits a detached decision-context result. Transport admission validates the
 * bytes it receives; it does not prove that the producer head remains current
 * or that an external source remains truthful.
 */
export function admitDecisionContextResult(value: unknown): AttuneGraphDecisionContextResult {
  const input = record(
    value,
    "decision context result",
    [
      "operator", "use", "status", "decisionReady", "executionCapability",
      "snapshot", "sourceFreshness", "workingGraph", "authority", "diagnostics", "receipt"
    ],
    [
      "operator", "use", "status", "decisionReady", "executionCapability",
      "workingGraph", "authority", "diagnostics", "receipt"
    ]
  );
  if (input.operator !== "decision-context@1" || input.use !== "decision-context") {
    invalid("decision context result operator or use is invalid");
  }
  if (input.status !== "complete" && input.status !== "partial" && input.status !== "abstained") {
    invalid("decision context result status is invalid");
  }
  if (typeof input.decisionReady !== "boolean" || input.executionCapability !== "none") {
    invalid("decision context result readiness posture is invalid");
  }
  const receiptInput = record(
    input.receipt,
    "decision context result.receipt",
    [
      "contractRevision", "receiptId", "canonicalJson", "use", "query", "snapshot",
      "sourceFreshness", "selectedWorkingGraphId", "selectedAssertions",
      "authorityEvaluationId",
      "authorityWitnessAssertions", "conflicts", "exclusions", "status", "decisionReady",
      "executionCapability", "diagnostics"
    ],
    [
      "contractRevision", "receiptId", "canonicalJson", "use", "query", "snapshot",
      "sourceFreshness", "selectedWorkingGraphId", "selectedAssertions",
      "authorityEvaluationId",
      "authorityWitnessAssertions", "conflicts", "exclusions", "status", "decisionReady",
      "executionCapability", "diagnostics"
    ]
  );
  if (receiptInput.contractRevision !== 1) invalid("decision context receipt revision is unsupported");
  try {
    const suppliedReceipt = canonicalizeImmutableEnvelope(
      Object.fromEntries(Object.entries(receiptInput).filter(([key]) => key !== "canonicalJson")),
      "external-mutable",
      RECEIPT_SPEC
    );
    if (suppliedReceipt.canonicalJson !== receiptInput.canonicalJson) {
      invalid("decision context receipt canonical JSON is invalid");
    }
  } catch (cause) {
    if (cause instanceof AttuneGraphError) throw cause;
    throw new AttuneGraphError("INVALID_INPUT", "decision context receipt is unsafe or mismatched", { cause });
  }
  const query = normalizeDecisionContextQuery(receiptInput.query as AttuneGraphDecisionContextQuery);
  const snapshot = normalizeAdmissionSnapshot(input.snapshot, query);
  const sourceFreshness = normalizeAdmissionFreshness(input.sourceFreshness);
  if ((snapshot === undefined) !== (sourceFreshness === undefined)) {
    invalid("decision context snapshot and freshness must be present together");
  }
  const workingGraph = normalizeAdmissionWorkingGraph(input.workingGraph, query);
  const admittedAuthority = normalizeAdmissionAuthority(input.authority, query, snapshot, sourceFreshness);
  const authority = admittedAuthority.authority;
  const projection = admittedAuthority.projection;
  const suppliedDiagnostics = normalizeAdmissionCombinedDiagnostics(input.diagnostics);
  const expected = compileDecisionContext(projection, query);
  if (
    input.status !== expected.status
    || input.decisionReady !== expected.decisionReady
    || !isDeepStrictEqual(snapshot, expected.snapshot)
    || !isDeepStrictEqual(sourceFreshness, expected.sourceFreshness)
    || !isDeepStrictEqual(workingGraph, expected.workingGraph)
    || !isDeepStrictEqual(authority, expected.authority)
    || !isDeepStrictEqual(suppliedDiagnostics, expected.diagnostics)
    || receiptInput.receiptId !== expected.receipt.receiptId
    || receiptInput.canonicalJson !== expected.receipt.canonicalJson
  ) invalid("decision context result does not match its full fixed-profile projection replay");
  return expected;
}

function normalizeAdmissionCombinedDiagnostics(value: unknown): AttuneGraphDecisionContextDiagnostics {
  const input = record(value, "decision context result.diagnostics", ["estimatedTokens", "evidenceClosure", "authorityClosure", "conflictClosure", "truncationReasons", "terminalReasons"], ["estimatedTokens", "evidenceClosure", "authorityClosure", "conflictClosure", "truncationReasons", "terminalReasons"]);
  if (input.evidenceClosure !== "complete" && input.evidenceClosure !== "incomplete") invalid("decision context evidence closure is invalid");
  if (input.authorityClosure !== "complete" && input.authorityClosure !== "incomplete") invalid("decision context authority closure is invalid");
  if (input.conflictClosure !== "complete" && input.conflictClosure !== "conflict" && input.conflictClosure !== "incomplete") invalid("decision context conflict closure is invalid");
  const truncationReasons = Object.freeze(array(input.truncationReasons, "decision context truncation reasons", 4).map((reason) => {
    const reasons = ["token-budget", "traversal-budget", "authority-work-budget", "authority-token-budget"];
    if (!reasons.includes(reason as string)) invalid("decision context truncation reason is invalid");
    return reason as "token-budget";
  }));
  const terminalReasons = Object.freeze(array(input.terminalReasons, "decision context terminal reasons", 2).map((reason) => {
    const reasons = ["no-head", "root-unverified", "root-mismatch", "projection-from-future", "freshness-from-future", "source-not-fresh", "authority-conflict", "missing-governance-chain", "missing-evidence-chain", "no-eligible-evidence"];
    if (!reasons.includes(reason as string)) invalid("decision context terminal reason is invalid");
    return reason as "no-head";
  }));
  return Object.freeze({
    estimatedTokens: integer(input.estimatedTokens, "decision context estimated tokens"),
    evidenceClosure: input.evidenceClosure,
    authorityClosure: input.authorityClosure,
    conflictClosure: input.conflictClosure,
    truncationReasons,
    terminalReasons
  });
}

function normalizeAdmissionSnapshot(
  value: unknown,
  query: AttuneGraphDecisionContextQuery
): AttuneGraphStoredProjection["snapshot"] | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "decision context result.snapshot", ["schemaVersion", "scope", "generation", "commitId"], ["schemaVersion", "scope", "generation", "commitId"]);
  if (input.schemaVersion !== 1) invalid("decision context result snapshot schema is invalid");
  const scope = record(input.scope, "decision context result.snapshot.scope", ["sourceId", "threadId"], ["sourceId", "threadId"]);
  const normalized = Object.freeze({
    schemaVersion: 1 as const,
    scope: Object.freeze({
      sourceId: text(scope.sourceId, "decision context result.snapshot.scope.sourceId"),
      threadId: text(scope.threadId, "decision context result.snapshot.scope.threadId")
    }),
    generation: integer(input.generation, "decision context result.snapshot.generation", 1),
    commitId: text(input.commitId, "decision context result.snapshot.commitId")
  });
  if (normalized.scope.sourceId !== query.scope.sourceId || normalized.scope.threadId !== query.scope.threadId) {
    invalid("decision context snapshot scope does not match its query");
  }
  if (query.head.mode === "exact" && (
    query.head.generation !== normalized.generation || query.head.commitId !== normalized.commitId
  )) invalid("decision context exact query does not match its result snapshot");
  return normalized;
}

function normalizeAdmissionFreshness(value: unknown): AttuneGraphStoredProjection["sourceFreshness"] | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "decision context result.sourceFreshness", ["state", "observedAt"], ["state", "observedAt"]);
  if (input.state !== "fresh" && input.state !== "stale" && input.state !== "unknown") {
    invalid("decision context result source freshness state is invalid");
  }
  return Object.freeze({ state: input.state, observedAt: canonicalInstant(input.observedAt, "decision context result.sourceFreshness.observedAt") });
}

function normalizeAdmissionWorkingGraph(
  value: unknown,
  query: AttuneGraphDecisionContextQuery
): AttuneGraphDecisionContextResult["workingGraph"] {
  const input = record(value, "decision context result.workingGraph", ["assertions", "refs", "seed", "diagnostics"], ["assertions", "refs", "seed", "diagnostics"]);
  const assertions = array(input.assertions, "decision context result.workingGraph.assertions", 64).map((entry) => normalizeGraphAssertion(entry));
  const refs = array(input.refs, "decision context result.workingGraph.refs", 65).map((entry, index) => normalizeRef(entry, `decision context result.workingGraph.refs[${index.toString()}]`));
  const seed = normalizeRef(input.seed, "decision context result.workingGraph.seed");
  const diagnosticsInput = record(
    input.diagnostics,
    "decision context result.workingGraph.diagnostics",
    ["consideredAssertions", "estimatedTokens", "maxDepthReached", "visitedRefs", "truncationReasons"],
    ["consideredAssertions", "estimatedTokens", "maxDepthReached", "visitedRefs", "truncationReasons"]
  );
  const truncationReasons = array(diagnosticsInput.truncationReasons, "decision context result evidence truncation reasons", 2).map((reason) => {
    if (reason !== "token-budget" && reason !== "traversal-budget") invalid("decision context evidence truncation reason is invalid");
    return reason;
  });
  return admitSelectedWorkingGraph({
    assertions,
    refs,
    seed,
    querySeed: query.seed,
    asOfEpoch: instantEpoch(query.asOf),
    diagnostics: Object.freeze({
      consideredAssertions: integer(diagnosticsInput.consideredAssertions, "decision context evidence considered assertions"),
      estimatedTokens: integer(diagnosticsInput.estimatedTokens, "decision context evidence estimated tokens"),
      maxDepthReached: integer(diagnosticsInput.maxDepthReached, "decision context evidence max depth"),
      visitedRefs: integer(diagnosticsInput.visitedRefs, "decision context evidence visited refs"),
      truncationReasons: Object.freeze(truncationReasons)
    })
  });
}

function normalizeAdmissionAuthority(
  value: unknown,
  query: AttuneGraphDecisionContextQuery,
  snapshot: AttuneGraphStoredProjection["snapshot"] | undefined,
  sourceFreshness: AttuneGraphStoredProjection["sourceFreshness"] | undefined
): Readonly<{
  readonly authority: AttuneGraphDecisionContextResult["authority"];
  readonly projection: AttuneGraphStoredProjection | undefined;
}> {
  const input = record(value, "decision context result.authority", ["authority", "projection", "frontier", "witnessAssertions", "conflicts", "exclusions", "diagnostics"], ["authority", "projection", "frontier", "witnessAssertions", "conflicts", "exclusions", "diagnostics"]);
  if (input.authority !== "authorized" && input.authority !== "undetermined") invalid("decision context authority state is invalid");
  const evaluationProjection = normalizeAdmissionAuthorityProjection(input.projection);
  const frontier = normalizeAdmissionAuthorityFrontier(input.frontier);
  const witness = Object.freeze(array(input.witnessAssertions, "decision context authority witnesses", 4).map((entry) => normalizeGraphAssertion(entry)));
  const conflicts = normalizeAdmissionConflicts(input.conflicts, query);
  const exclusions = normalizeAdmissionExclusions(input.exclusions);
  const diagnostics = normalizeAdmissionAuthorityDiagnostics(input.diagnostics);
  const claimed = Object.freeze({
    authority: input.authority,
    projection: evaluationProjection,
    frontier,
    witnessAssertions: witness,
    conflicts,
    exclusions,
    diagnostics
  }) as AttuneGraphDecisionContextResult["authority"];
  if (evaluationProjection === null) {
    if (
      snapshot !== undefined
      || sourceFreshness !== undefined
      || frontier.scanClosure !== "not-performed"
      || frontier.evaluatedAssertions !== 0
      || frontier.totalAssertions !== 0
      || frontier.assertions.length !== 0
    ) invalid("no-head authority evaluation posture is inconsistent");
    return Object.freeze({ authority: claimed, projection: undefined });
  }
  if (snapshot === undefined || sourceFreshness === undefined) {
    invalid("authority projection requires snapshot and freshness metadata");
  }
  if (snapshot.commitId !== `attunegraph-commit:${evaluationProjection.observationId}`) {
    invalid("authority projection observation does not match its snapshot commit");
  }
  const canonicalAssertions = admitAuthorityCanonicalProjection(
    evaluationProjection,
    query,
    sourceFreshness
  );
  if (frontier.totalAssertions !== canonicalAssertions.length) {
    invalid("authority frontier total does not match its canonical projection");
  }
  const preScanTerminal = evaluationProjection.profile === "canonical-projection@1"
    || evaluationProjection.threadRoot?.id !== query.threadRoot.id
    || Date.parse(evaluationProjection.observedAt) > Date.parse(query.asOf)
    || Date.parse(sourceFreshness.observedAt) > Date.parse(query.asOf)
    || sourceFreshness.state !== "fresh";
  if (preScanTerminal) {
    if (
      frontier.scanClosure !== "not-performed"
      || frontier.evaluatedAssertions !== 0
      || frontier.assertions.length !== 0
    ) invalid("pre-scan terminal authority posture must not claim evaluated assertions");
  } else if (frontier.totalAssertions > MAX_AUTHORITY_EVALUATED_ASSERTIONS) {
    if (
      frontier.scanClosure !== "work-cut"
      || frontier.evaluatedAssertions !== MAX_AUTHORITY_EVALUATED_ASSERTIONS
      || frontier.assertions.length !== MAX_AUTHORITY_TRANSPORTED_ASSERTIONS
    ) invalid("work-cut authority frontier is incomplete");
    const expected = [...canonicalAssertions]
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      .slice(0, MAX_AUTHORITY_TRANSPORTED_ASSERTIONS);
    if (!isDeepStrictEqual(frontier.assertions, expected)) {
      invalid("work-cut authority frontier content does not match its canonical projection");
    }
  } else if (
    frontier.scanClosure !== "complete"
    || frontier.evaluatedAssertions !== frontier.totalAssertions
    || frontier.assertions.length !== frontier.totalAssertions
  ) {
    invalid("complete authority frontier scan metadata is inconsistent");
  } else {
    const expected = [...canonicalAssertions].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
    if (!isDeepStrictEqual(frontier.assertions, expected)) {
      invalid("complete authority frontier content does not match its canonical projection");
    }
  }
  const projection: AttuneGraphStoredProjection = Object.freeze({
    schemaVersion: 1,
    snapshot,
    observationId: evaluationProjection.observationId,
    canonicalProjection: evaluationProjection.canonicalProjection,
    projectionFingerprint: evaluationProjection.observationId,
    observedAt: evaluationProjection.observedAt,
    sourceFreshness,
    assertions: Object.freeze([...canonicalAssertions].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    ))
  });
  return Object.freeze({ authority: claimed, projection });
}

function admitAuthorityCanonicalProjection(
  projection: NonNullable<AttuneGraphDecisionContextResult["authority"]["projection"]>,
  query: AttuneGraphDecisionContextQuery,
  expectedFreshness: AttuneGraphStoredProjection["sourceFreshness"]
): readonly GraphAssertion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(projection.canonicalProjection);
  } catch (cause) {
    throw new AttuneGraphError("INVALID_INPUT", "authority canonical projection is not JSON", { cause });
  }
  const version = projection.profile === "canonical-projection@1" ? 1 : 2;
  let canonical;
  try {
    canonical = canonicalizeImmutableEnvelope(parsed, "external-mutable", {
      hashDomain: `attunegraph.canonical-projection.v${version.toString()}`,
      idField: "observationId",
      idPrefix: "attunegraph-observation:"
    });
  } catch (cause) {
    throw new AttuneGraphError("INVALID_INPUT", "authority canonical projection envelope is invalid", { cause });
  }
  if (
    canonical.canonicalJson !== projection.canonicalProjection
    || canonical.contentId !== projection.observationId
  ) invalid("authority canonical projection content identity is invalid");
  const input = record(
    parsed,
    "authority canonical projection",
    ["schemaVersion", "observationId", "observationKey", "scope", "threadRoot", "observedAt", "sourceFreshness", "assertions"],
    version === 1
      ? ["schemaVersion", "observationId", "observationKey", "scope", "observedAt", "sourceFreshness", "assertions"]
      : ["schemaVersion", "observationId", "observationKey", "scope", "threadRoot", "observedAt", "sourceFreshness", "assertions"]
  );
  if (input.schemaVersion !== version || (version === 1 && Reflect.has(input, "threadRoot"))) {
    invalid("authority canonical projection profile does not match its envelope");
  }
  text(input.observationKey, "authority canonical projection.observationKey");
  const scope = record(input.scope, "authority canonical projection.scope", ["sourceId", "threadId"], ["sourceId", "threadId"]);
  if (scope.sourceId !== query.scope.sourceId || scope.threadId !== query.scope.threadId) {
    invalid("authority canonical projection scope does not match its query");
  }
  const observedAt = canonicalInstant(input.observedAt, "authority canonical projection.observedAt");
  if (observedAt !== projection.observedAt) invalid("authority projection observedAt metadata is inconsistent");
  const freshness = normalizeAdmissionFreshness(input.sourceFreshness)!;
  if (JSON.stringify(freshness) !== JSON.stringify(expectedFreshness)) {
    invalid("authority canonical projection freshness is inconsistent");
  }
  if (version === 2) {
    const root = normalizeRef(input.threadRoot, "authority canonical projection.threadRoot");
    if (
      root.kind !== "thread"
      || projection.threadRoot === null
      || root.id !== projection.threadRoot.id
    ) invalid("authority canonical projection thread root metadata is inconsistent");
  }
  return Object.freeze(array(input.assertions, "authority canonical projection.assertions", 32_768).map((entry) => normalizeGraphAssertion(entry)));
}

function normalizeAdmissionAuthorityProjection(
  value: unknown
): AttuneGraphDecisionContextResult["authority"]["projection"] {
  if (value === null) return null;
  const input = record(value, "decision context authority projection", ["profile", "observationId", "canonicalProjection", "observedAt", "threadRoot"], ["profile", "observationId", "canonicalProjection", "observedAt", "threadRoot"]);
  if (input.profile !== "canonical-projection@1" && input.profile !== "canonical-projection@2") {
    invalid("decision context authority projection profile is invalid");
  }
  let threadRoot: (GraphRef & { readonly kind: "thread" }) | null = null;
  if (input.profile === "canonical-projection@1") {
    if (input.threadRoot !== null) invalid("V1 authority projection must remain root-unverified");
  } else {
    const normalized = normalizeRef(input.threadRoot, "decision context authority projection.threadRoot");
    if (normalized.kind !== "thread") invalid("V2 authority projection root must be a thread");
    threadRoot = normalized as GraphRef & { readonly kind: "thread" };
  }
  return Object.freeze({
    profile: input.profile,
    observationId: text(input.observationId, "decision context authority projection.observationId"),
    canonicalProjection: text(input.canonicalProjection, "decision context authority projection.canonicalProjection"),
    observedAt: canonicalInstant(input.observedAt, "decision context authority projection.observedAt"),
    threadRoot
  });
}

function normalizeAdmissionAuthorityFrontier(
  value: unknown
): AttuneGraphDecisionContextResult["authority"]["frontier"] {
  const input = record(value, "decision context authority frontier", ["assertions", "evaluatedAssertions", "totalAssertions", "scanClosure"], ["assertions", "evaluatedAssertions", "totalAssertions", "scanClosure"]);
  if (input.scanClosure !== "complete" && input.scanClosure !== "work-cut" && input.scanClosure !== "not-performed") {
    invalid("decision context authority frontier scan closure is invalid");
  }
  const assertions = Object.freeze(array(input.assertions, "decision context authority frontier assertions", MAX_AUTHORITY_TRANSPORTED_ASSERTIONS).map((entry) => normalizeGraphAssertion(entry)));
  const evaluatedAssertions = integer(input.evaluatedAssertions, "decision context authority frontier evaluated assertions");
  const totalAssertions = integer(input.totalAssertions, "decision context authority frontier total assertions");
  if (evaluatedAssertions > MAX_AUTHORITY_EVALUATED_ASSERTIONS || totalAssertions > 32_768) {
    invalid("decision context authority frontier counts exceed bounds");
  }
  return Object.freeze({ assertions, evaluatedAssertions, totalAssertions, scanClosure: input.scanClosure });
}

function normalizeAdmissionConflicts(value: unknown, query: AttuneGraphDecisionContextQuery) {
  return Object.freeze(array(value, "decision context authority conflicts", 1).map((entry) => {
    const input = record(entry, "decision context authority conflict", ["predicate", "subject", "assertionIds", "objectRefs", "sourceRefs"], ["predicate", "subject", "assertionIds", "objectRefs", "sourceRefs"]);
    if (input.predicate !== "GOVERNED_BY") invalid("decision context authority conflict predicate is invalid");
    const subject = normalizeRef(input.subject, "decision context authority conflict.subject");
    if (subject.kind !== "action" || subject.id !== query.action.id) invalid("decision context conflict subject does not match the exact action");
    const assertionIds = Object.freeze(array(input.assertionIds, "decision context conflict assertion ids", 32).map((id) => text(id, "decision context conflict assertion id")));
    const objectRefs = Object.freeze(array(input.objectRefs, "decision context conflict object refs", 32).map((ref) => {
      const normalized = normalizeRef(ref, "decision context conflict object ref");
      if (normalized.kind !== "policy") invalid("decision context conflict object must be a policy");
      return normalized as GraphRef & { readonly kind: "policy" };
    }));
    if (new Set(objectRefs.map((ref) => `${ref.kind}:${ref.id}`)).size < 2) invalid("decision context conflict requires distinct policies");
    const sourceRefs = Object.freeze(array(input.sourceRefs, "decision context conflict source refs", 64).map((ref) => normalizeEvidenceRef(ref, "decision context conflict source ref")));
    return Object.freeze({ predicate: "GOVERNED_BY" as const, subject: subject as GraphRef & { readonly kind: "action" }, assertionIds, objectRefs, sourceRefs });
  }));
}

function normalizeAdmissionExclusions(value: unknown) {
  return Object.freeze(array(value, "decision context authority exclusions", 64).map((entry) => {
    const input = record(entry, "decision context authority exclusion", ["assertionId", "reason"], ["assertionId", "reason"]);
    const reasons = ["temporally-ineligible", "model-hypothesis", "invalid-endpoint-kind", "thread-root-mismatch"];
    if (!reasons.includes(input.reason as string)) invalid("decision context authority exclusion reason is invalid");
    return Object.freeze({ assertionId: text(input.assertionId, "decision context exclusion assertion id"), reason: input.reason as "temporally-ineligible" });
  }));
}

function normalizeAdmissionAuthorityDiagnostics(value: unknown) {
  const input = record(value, "decision context authority diagnostics", ["consideredAssertions", "eligibleFrontierAssertions", "rejectedFrontierAssertions", "estimatedTokens", "maxConsideredAssertions", "truncationReasons", "terminalReasons", "authorityClosure", "conflictClosure"], ["consideredAssertions", "eligibleFrontierAssertions", "rejectedFrontierAssertions", "estimatedTokens", "maxConsideredAssertions", "truncationReasons", "terminalReasons", "authorityClosure", "conflictClosure"]);
  if (input.maxConsideredAssertions !== 32) invalid("decision context authority work limit is invalid");
  if (input.authorityClosure !== "complete" && input.authorityClosure !== "incomplete") invalid("decision context authority closure is invalid");
  if (input.conflictClosure !== "complete" && input.conflictClosure !== "conflict" && input.conflictClosure !== "incomplete") invalid("decision context conflict closure is invalid");
  const truncationReasons = Object.freeze(array(input.truncationReasons, "decision context authority truncation reasons", 1).map((reason) => {
    if (reason !== "work-budget" && reason !== "token-budget") invalid("decision context authority truncation reason is invalid");
    return reason;
  }));
  const terminalReasons = Object.freeze(array(input.terminalReasons, "decision context authority terminal reasons", 1).map((reason) => {
    const reasons = ["no-head", "root-unverified", "root-mismatch", "projection-from-future", "freshness-from-future", "source-not-fresh", "authority-conflict", "missing-governance-chain", "missing-evidence-chain"];
    if (!reasons.includes(reason as string)) invalid("decision context authority terminal reason is invalid");
    return reason as "no-head";
  }));
  return Object.freeze({
    consideredAssertions: integer(input.consideredAssertions, "decision context authority considered assertions"),
    eligibleFrontierAssertions: integer(input.eligibleFrontierAssertions, "decision context authority eligible assertions"),
    rejectedFrontierAssertions: integer(input.rejectedFrontierAssertions, "decision context authority rejected assertions"),
    estimatedTokens: integer(input.estimatedTokens, "decision context authority estimated tokens"),
    maxConsideredAssertions: 32 as const,
    truncationReasons,
    terminalReasons,
    authorityClosure: input.authorityClosure,
    conflictClosure: input.conflictClosure
  });
}
