import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import {
  canonicalizeImmutableEnvelope,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import {
  ACTIVATION_PREDICATES,
  MAX_ACTIVATION_ESTIMATED_TOKENS
} from "./constants.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import type {
  AttuneGraphDecisionQuery,
  AttuneGraphDecisionQueryReceipt,
  AttuneGraphDecisionQueryResult,
  AttuneGraphSnapshot,
  AttuneGraphSourceFreshness,
  AttuneGraphWorkingGraph
} from "./attunegraph-contracts.js";
import {
  GRAPH_NODE_KINDS,
  type GraphEvidenceRef,
  type GraphRef
} from "./types.js";
import { instantEpoch, normalizeGraphAssertion } from "./validation.js";
import {
  admitSelectedWorkingGraph,
  selectedWorkingGraphContentId,
  WORKING_GRAPH_LIMITS
} from "./working-graph.js";

const DECISION_QUERY_RECEIPT_SPEC = Object.freeze({
  hashDomain: "attunegraph.decision-query-receipt.v2",
  idField: "receiptId",
  idPrefix: "attunegraph-decision-query:"
} as const);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;
const MAX_SAFE_JSON_DESCRIPTORS = 32_768;

type DataRecord = Record<string, unknown>;

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

function invalid(message: string): never {
  throw new AttuneGraphError("INVALID_INPUT", message);
}

function inspectSafeJsonData(value: unknown): void {
  const seen = new WeakSet<object>();
  let descriptors = 0;
  let aggregateStringBytes = 0;
  const visit = (current: unknown, depth: number, label: string): void => {
    if (depth > 12) invalid(`${label} exceeds the safe JSON depth cap`);
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "string") {
      if (!isWellFormedUnicode(current)) invalid(`${label} contains malformed Unicode`);
      aggregateStringBytes += Buffer.byteLength(current, "utf8");
      if (
        current.length > 1_048_576
        || aggregateStringBytes > 2_000_000
      ) invalid(`${label} exceeds the safe JSON string cap`);
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        invalid(`${label} must be a finite JSON number`);
      }
      return;
    }
    if (typeof current !== "object" || nodeTypes.isProxy(current)) {
      invalid(`${label} must contain only safe JSON data`);
    }
    if (seen.has(current)) invalid(`${label} must not contain aliases or cycles`);
    seen.add(current);
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype) {
        invalid(`${label} must be a plain array`);
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(current, "length");
      const length = lengthDescriptor?.value;
      if (!Number.isSafeInteger(length) || (length as number) < 0) {
        invalid(`${label} has an invalid length`);
      }
      const arrayLength = length as number;
      if (arrayLength > MAX_SAFE_JSON_DESCRIPTORS - descriptors) {
        invalid(`${label} exceeds the safe JSON descriptor cap`);
      }
      const keys = Reflect.ownKeys(current);
      if (
        keys.length !== arrayLength + 1
        || keys.some((key) => {
          if (key === "length") return false;
          if (typeof key !== "string") return true;
          const index = Number(key);
          return !Number.isSafeInteger(index)
            || index < 0
            || index >= arrayLength
            || index.toString() !== key;
        })
      ) invalid(`${label} must not contain hidden, symbol, or extra fields`);
      descriptors += arrayLength;
      for (let index = 0; index < arrayLength; index += 1) {
        const key = index.toString();
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || descriptor.enumerable !== true
        ) invalid(`${label} must be dense and contain only visible data properties`);
        visit(descriptor.value, depth + 1, `${label}[${key}]`);
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        invalid(`${label} must be a plain object`);
      }
      const keys = Reflect.ownKeys(current);
      if (keys.length > MAX_SAFE_JSON_DESCRIPTORS - descriptors) {
        invalid(`${label} exceeds the safe JSON descriptor cap`);
      }
      if (keys.some((key) => typeof key !== "string")) {
        invalid(`${label} must not contain symbol fields`);
      }
      const properties = Object.getOwnPropertyDescriptors(current);
      descriptors += keys.length;
      for (const key of keys) {
        if (typeof key !== "string") invalid(`${label} must not contain symbol fields`);
        const descriptor = properties[key];
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || descriptor.enumerable !== true
        ) invalid(`${label} must contain only visible data properties`);
        visit(descriptor.value, depth + 1, `${label}.${key}`);
      }
    }
  };
  visit(value, 1, "decision query result");
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalid(`${label} must be an array with at most ${maximum.toString()} items`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    invalid(`${label} must be an integer from 0 to ${maximum.toString()}`);
  }
  return value as number;
}

function record(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[]
): DataRecord {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    invalid(`${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) {
    invalid(`${label} has invalid fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => {
    if (typeof key !== "string") return true;
    const descriptor = descriptors[key];
    return descriptor === undefined || !("value" in descriptor);
  })) {
    invalid(`${label} fields must be data properties`);
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key as string]!.value])
  );
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Array.from(value).length > 512
    || CONTROL_CHARACTERS.test(value)
    || !isWellFormedUnicode(value)
  ) {
    invalid(`${label} must be bounded well-formed non-empty text without control characters`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = boundedText(value, label);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) {
    invalid(`${label} must be a canonical ISO instant`);
  }
  return text;
}

function positiveInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalid(`${label} must be an integer from 1 to ${maximum.toString()}`);
  }
  return value as number;
}

function normalizeGraphRef(value: unknown, label: string): GraphRef {
  const input = record(value, label, ["id", "kind"], ["id", "kind"]);
  if (!GRAPH_NODE_KINDS.includes(input.kind as never)) {
    invalid(`${label}.kind is invalid`);
  }
  return Object.freeze({
    id: boundedText(input.id, `${label}.id`),
    kind: input.kind as GraphRef["kind"]
  });
}

function normalizeRef(value: unknown): GraphRef {
  return normalizeGraphRef(value, "decision query.seed");
}

export function normalizeDecisionQuery(value: AttuneGraphDecisionQuery): AttuneGraphDecisionQuery {
  const input = record(
    value,
    "decision query",
    ["operator", "scope", "seed", "asOf", "head", "freshness", "budget"],
    ["operator", "scope", "seed", "asOf", "head", "freshness", "budget"]
  );
  if (input.operator !== "decision-query@1") {
    throw new AttuneGraphError("UNSUPPORTED_OPERATOR", "query supports only decision-query@1");
  }
  const scope = record(
    input.scope,
    "decision query.scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"]
  );
  const head = record(
    input.head,
    "decision query.head",
    ["mode", "generation", "commitId"],
    ["mode"]
  );
  let normalizedHead: AttuneGraphDecisionQuery["head"];
  if (head.mode === "current") {
    if (Reflect.ownKeys(head).length !== 1) invalid("current decision query head has extra fields");
    normalizedHead = Object.freeze({ mode: "current" as const });
  } else if (head.mode === "exact") {
    if (!Reflect.has(head, "generation") || !Reflect.has(head, "commitId")) {
      invalid("exact decision query head is incomplete");
    }
    normalizedHead = Object.freeze({
      mode: "exact" as const,
      generation: positiveInteger(head.generation, "decision query.head.generation", Number.MAX_SAFE_INTEGER),
      commitId: boundedText(head.commitId, "decision query.head.commitId")
    });
  } else {
    invalid("decision query.head.mode is invalid");
  }
  const freshness = record(
    input.freshness,
    "decision query.freshness",
    ["require"],
    ["require"]
  );
  if (freshness.require !== "fresh") {
    invalid("decision query.freshness.require must be fresh");
  }
  const budget = record(
    input.budget,
    "decision query.budget",
    ["maxEstimatedTokens"],
    ["maxEstimatedTokens"]
  );
  return Object.freeze({
    operator: "decision-query@1" as const,
    scope: Object.freeze({
      sourceId: boundedText(scope.sourceId, "decision query.scope.sourceId"),
      threadId: boundedText(scope.threadId, "decision query.scope.threadId")
    }),
    seed: normalizeRef(input.seed),
    asOf: canonicalInstant(input.asOf, "decision query.asOf"),
    head: normalizedHead,
    freshness: Object.freeze({ require: "fresh" as const }),
    budget: Object.freeze({
      maxEstimatedTokens: positiveInteger(
        budget.maxEstimatedTokens,
        "decision query.budget.maxEstimatedTokens",
        MAX_ACTIVATION_ESTIMATED_TOKENS
      )
    })
  });
}

function evidenceRefKey(ref: GraphEvidenceRef): string {
  return `${ref.namespace}\u0000${ref.id}\u0000${ref.version ?? ""}`;
}

function compareEvidenceRefs(left: GraphEvidenceRef, right: GraphEvidenceRef): number {
  const leftKey = evidenceRefKey(left);
  const rightKey = evidenceRefKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function sealDecisionQueryReceipt(input: Readonly<{
  readonly query: AttuneGraphDecisionQuery;
  readonly snapshot: AttuneGraphSnapshot | null;
  readonly sourceFreshness: AttuneGraphSourceFreshness | null;
  readonly status: "complete" | "partial" | "abstained";
  readonly workingGraph: AttuneGraphWorkingGraph;
  readonly abstentionReasons: readonly (
    | "no-head"
    | "source-not-fresh"
    | "no-eligible-evidence"
  )[];
}>): AttuneGraphDecisionQueryReceipt {
  const sourceRefs = [...new Map(
    input.workingGraph.assertions.flatMap((assertion) => assertion.sourceRefs)
      .map((ref) => [evidenceRefKey(ref), ref])
  ).values()].sort(compareEvidenceRefs);
  try {
    const unsigned = Object.freeze({
      contractRevision: 2 as const,
      use: "evidence-only" as const,
      query: input.query,
      snapshot: input.snapshot,
      sourceFreshness: input.sourceFreshness,
      status: input.status,
      selectedWorkingGraphId: selectedWorkingGraphContentId(
        input.workingGraph.assertions,
        input.workingGraph.seed
      ),
      witness: Object.freeze({
        assertionIds: Object.freeze(input.workingGraph.assertions.map((assertion) => assertion.id).sort()),
        sourceRefs: Object.freeze(sourceRefs.map((ref) => Object.freeze({ ...ref })))
      }),
      diagnostics: Object.freeze({
        consideredAssertions: input.workingGraph.diagnostics.consideredAssertions,
        estimatedTokens: input.workingGraph.diagnostics.estimatedTokens,
        maxDepthReached: input.workingGraph.diagnostics.maxDepthReached,
        visitedRefs: input.workingGraph.diagnostics.visitedRefs,
        truncationReasons: Object.freeze([...input.workingGraph.diagnostics.truncationReasons]),
        abstentionReasons: Object.freeze([...input.abstentionReasons]),
        authorityEvaluation: "not-performed" as const,
        conflictClosure: "not-performed" as const
      })
    });
    const minted = mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      unsigned,
      DECISION_QUERY_RECEIPT_SPEC
    );
    return Object.freeze({
      ...minted.envelope,
      canonicalJson: minted.canonicalJson
    }) as unknown as AttuneGraphDecisionQueryReceipt;
  } catch (cause) {
    throw new AttuneGraphError(
      "CORRUPT_STORE",
      "decision query receipt could not be sealed",
      { cause }
    );
  }
}

function normalizeSnapshot(value: unknown): AttuneGraphSnapshot {
  const input = record(
    value,
    "decision query result.snapshot",
    ["schemaVersion", "scope", "generation", "commitId"],
    ["schemaVersion", "scope", "generation", "commitId"]
  );
  if (input.schemaVersion !== 1) invalid("decision query result.snapshot.schemaVersion must be 1");
  const scope = record(
    input.scope,
    "decision query result.snapshot.scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"]
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    scope: Object.freeze({
      sourceId: boundedText(scope.sourceId, "decision query result.snapshot.scope.sourceId"),
      threadId: boundedText(scope.threadId, "decision query result.snapshot.scope.threadId")
    }),
    generation: positiveInteger(
      input.generation,
      "decision query result.snapshot.generation",
      Number.MAX_SAFE_INTEGER
    ),
    commitId: boundedText(input.commitId, "decision query result.snapshot.commitId")
  });
}

function normalizeSourceFreshness(value: unknown): AttuneGraphSourceFreshness {
  const input = record(
    value,
    "decision query result.sourceFreshness",
    ["state", "observedAt"],
    ["state", "observedAt"]
  );
  if (input.state !== "fresh" && input.state !== "stale" && input.state !== "unknown") {
    invalid("decision query result.sourceFreshness.state is invalid");
  }
  return Object.freeze({
    state: input.state,
    observedAt: canonicalInstant(
      input.observedAt,
      "decision query result.sourceFreshness.observedAt"
    )
  });
}

function sameScope(
  left: AttuneGraphDecisionQuery["scope"],
  right: AttuneGraphDecisionQuery["scope"]
): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

function normalizeWorkingGraph(value: unknown, query: AttuneGraphDecisionQuery): AttuneGraphWorkingGraph {
  const input = record(
    value,
    "decision query result.workingGraph",
    ["assertions", "refs", "seed", "diagnostics"],
    ["assertions", "refs", "seed", "diagnostics"]
  );
  const rawAssertions = array(
    input.assertions,
    "decision query result.workingGraph.assertions",
    WORKING_GRAPH_LIMITS.maxAssertions
  );
  const assertions = rawAssertions.map((assertion) => {
    try {
      const normalized = normalizeGraphAssertion(assertion);
      if (!ACTIVATION_PREDICATES.includes(normalized.predicate)) {
        invalid("decision query result Working Graph assertion predicate is ineligible");
      }
      return normalized;
    } catch (cause) {
      if (cause instanceof AttuneGraphError) throw cause;
      throw new AttuneGraphError(
        "INVALID_INPUT",
        "decision query result Working Graph assertion is invalid",
        { cause }
      );
    }
  });
  const seed = normalizeGraphRef(input.seed, "decision query result.workingGraph.seed");
  const refs = array(
    input.refs,
    "decision query result.workingGraph.refs",
    WORKING_GRAPH_LIMITS.maxReturnedRefs
  ).map((ref, index) => normalizeGraphRef(
    ref,
    `decision query result.workingGraph.refs[${index.toString()}]`
  ));
  const diagnosticsInput = record(
    input.diagnostics,
    "decision query result.workingGraph.diagnostics",
    [
      "consideredAssertions",
      "estimatedTokens",
      "maxDepthReached",
      "visitedRefs",
      "truncationReasons"
    ],
    [
      "consideredAssertions",
      "estimatedTokens",
      "maxDepthReached",
      "visitedRefs",
      "truncationReasons"
    ]
  );
  const consideredAssertions = nonNegativeInteger(
    diagnosticsInput.consideredAssertions,
    "decision query result.workingGraph.diagnostics.consideredAssertions",
    WORKING_GRAPH_LIMITS.maxConsideredAssertions
  );
  const estimatedTokens = nonNegativeInteger(
    diagnosticsInput.estimatedTokens,
    "decision query result.workingGraph.diagnostics.estimatedTokens",
    MAX_ACTIVATION_ESTIMATED_TOKENS
  );
  const maxDepthReached = nonNegativeInteger(
    diagnosticsInput.maxDepthReached,
    "decision query result.workingGraph.diagnostics.maxDepthReached",
    WORKING_GRAPH_LIMITS.maxDepth
  );
  const visitedRefs = nonNegativeInteger(
    diagnosticsInput.visitedRefs,
    "decision query result.workingGraph.diagnostics.visitedRefs",
    WORKING_GRAPH_LIMITS.maxVisitedRefs
  );
  const truncationReasons = array(
    diagnosticsInput.truncationReasons,
    "decision query result.workingGraph.diagnostics.truncationReasons",
    2
  ).map((reason) => {
    if (reason !== "token-budget" && reason !== "traversal-budget") {
      invalid("decision query result Working Graph truncation reason is invalid");
    }
    return reason;
  });
  return admitSelectedWorkingGraph({
    assertions,
    refs,
    seed,
    querySeed: query.seed,
    asOfEpoch: instantEpoch(query.asOf),
    diagnostics: Object.freeze({
      consideredAssertions,
      estimatedTokens,
      maxDepthReached,
      visitedRefs,
      truncationReasons: Object.freeze(truncationReasons)
    })
  });
}

const DECISION_RECEIPT_FIELDS = Object.freeze([
    "contractRevision",
    "receiptId",
    "canonicalJson",
    "selectedWorkingGraphId",
    "use",
    "query",
    "snapshot",
    "sourceFreshness",
    "status",
    "witness",
    "diagnostics"
] as const);

function canonicalizeSuppliedReceipt(value: unknown): ReturnType<typeof canonicalizeImmutableEnvelope> {
  const supplied = record(
    value,
    "decision query result.receipt",
    DECISION_RECEIPT_FIELDS,
    DECISION_RECEIPT_FIELDS
  );
  if (
    typeof supplied.canonicalJson !== "string"
    || supplied.canonicalJson.length === 0
    || supplied.canonicalJson.length > 1_048_576
  ) invalid("decision query result.receipt.canonicalJson is invalid");
  const publicFields = Object.fromEntries(
    DECISION_RECEIPT_FIELDS
      .filter((field) => field !== "canonicalJson")
      .map((field) => [field, supplied[field]])
  );
  try {
    const detachedPublicFields = JSON.parse(JSON.stringify(publicFields)) as Record<string, unknown>;
    const canonical = canonicalizeImmutableEnvelope(
      detachedPublicFields,
      "external-mutable",
      DECISION_QUERY_RECEIPT_SPEC
    );
    if (
      canonical.canonicalJson !== supplied.canonicalJson
      || canonical.contentId !== supplied.receiptId
    ) invalid("decision query result receipt canonical JSON does not exactly admit its public fields");
    return canonical;
  } catch (cause) {
    if (cause instanceof AttuneGraphError) throw cause;
    throw new AttuneGraphError(
      "INVALID_INPUT",
      "decision query result receipt is not a safe canonical envelope",
      { cause }
    );
  }
}

function requireEmptyTerminalGraph(workingGraph: AttuneGraphWorkingGraph): void {
  if (
    workingGraph.assertions.length !== 0
    || workingGraph.diagnostics.consideredAssertions !== 0
    || workingGraph.diagnostics.maxDepthReached !== 0
    || workingGraph.diagnostics.visitedRefs !== 1
    || workingGraph.diagnostics.truncationReasons.length !== 0
  ) invalid("decision query result terminal abstention must contain the exact empty Working Graph");
}

/**
 * Admits a complete evidence-only decision result transported as untrusted JSON
 * data. Receipt integrity is evidence-only; this does not prove head currency,
 * source truth, permission, feedback, or action authority.
 */
export function admitDecisionQueryResult(value: unknown): AttuneGraphDecisionQueryResult {
  inspectSafeJsonData(value);
  const input = record(
    value,
    "decision query result",
    ["operator", "use", "status", "snapshot", "sourceFreshness", "workingGraph", "receipt"],
    ["operator", "use", "status", "workingGraph", "receipt"]
  );
  if (input.operator !== "decision-query@1" || input.use !== "evidence-only") {
    invalid("decision query result contract is invalid");
  }
  if (input.status !== "complete" && input.status !== "partial" && input.status !== "abstained") {
    invalid("decision query result.status is invalid");
  }
  const status = input.status;
  const suppliedReceipt = canonicalizeSuppliedReceipt(input.receipt);
  const query = normalizeDecisionQuery(
    suppliedReceipt.envelope.query as AttuneGraphDecisionQuery
  );
  const hasSnapshot = Object.hasOwn(input, "snapshot");
  const hasFreshness = Object.hasOwn(input, "sourceFreshness");
  if (hasSnapshot !== hasFreshness) {
    invalid("decision query result snapshot and source freshness must be present together");
  }
  const snapshot = hasSnapshot ? normalizeSnapshot(input.snapshot) : undefined;
  const sourceFreshness = hasFreshness
    ? normalizeSourceFreshness(input.sourceFreshness)
    : undefined;
  const workingGraph = normalizeWorkingGraph(input.workingGraph, query);
  let abstentionReasons: readonly (
    | "no-head"
    | "source-not-fresh"
    | "no-eligible-evidence"
  )[];
  if (snapshot === undefined || sourceFreshness === undefined) {
    if (query.head.mode !== "current" || status !== "abstained") {
      invalid("decision query result no-head closure is invalid");
    }
    requireEmptyTerminalGraph(workingGraph);
    abstentionReasons = Object.freeze(["no-head"]);
  } else {
    if (!sameScope(query.scope, snapshot.scope)) {
      invalid("decision query result query scope does not match its snapshot");
    }
    if (
      query.head.mode === "exact"
      && (
        query.head.generation !== snapshot.generation
        || query.head.commitId !== snapshot.commitId
      )
    ) invalid("decision query result exact head does not match its snapshot");
    if (sourceFreshness.state !== "fresh") {
      if (status !== "abstained") invalid("decision query result non-fresh source must abstain");
      requireEmptyTerminalGraph(workingGraph);
      abstentionReasons = Object.freeze(["source-not-fresh"]);
    } else if (workingGraph.diagnostics.truncationReasons.length > 0) {
      if (status !== "partial") invalid("decision query result truncated graph must be partial");
      if (
        workingGraph.assertions.length > 0
        && workingGraph.diagnostics.estimatedTokens > query.budget.maxEstimatedTokens
      ) invalid("decision query result selected evidence exceeds the query token budget");
      abstentionReasons = Object.freeze([]);
    } else if (workingGraph.assertions.length === 0) {
      if (status !== "abstained" || workingGraph.diagnostics.consideredAssertions !== 0) {
        invalid("decision query result empty fresh graph must abstain without eligible evidence");
      }
      abstentionReasons = Object.freeze(["no-eligible-evidence"]);
    } else {
      if (status !== "complete") invalid("decision query result untruncated evidence must be complete");
      if (workingGraph.diagnostics.estimatedTokens > query.budget.maxEstimatedTokens) {
        invalid("decision query result complete evidence exceeds the query token budget");
      }
      abstentionReasons = Object.freeze([]);
    }
  }
  const sealedReceipt = sealDecisionQueryReceipt({
    query,
    snapshot: snapshot ?? null,
    sourceFreshness: sourceFreshness ?? null,
    status,
    workingGraph,
    abstentionReasons
  });
  if (
    suppliedReceipt.canonicalJson !== sealedReceipt.canonicalJson
    || suppliedReceipt.contentId !== sealedReceipt.receiptId
  ) invalid("decision query result receipt does not exactly match the normalized full result");
  return Object.freeze({
    operator: "decision-query@1" as const,
    use: "evidence-only" as const,
    status,
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(sourceFreshness === undefined ? {} : { sourceFreshness }),
    workingGraph,
    receipt: sealedReceipt
  });
}
