import { types as nodeTypes } from "node:util";

import {
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import { MAX_ACTIVATION_ESTIMATED_TOKENS } from "./constants.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import type {
  AttuneGraphDecisionQuery,
  AttuneGraphDecisionQueryReceipt,
  AttuneGraphSnapshot,
  AttuneGraphSourceFreshness,
  AttuneGraphWorkingGraph
} from "./attunegraph-contracts.js";
import { GRAPH_NODE_KINDS, type GraphEvidenceRef, type GraphRef } from "./types.js";

const DECISION_QUERY_RECEIPT_SPEC = Object.freeze({
  hashDomain: "attunegraph.decision-query-receipt.v1",
  idField: "receiptId",
  idPrefix: "attunegraph-decision-query:"
} as const);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

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

function normalizeRef(value: unknown): GraphRef {
  const input = record(value, "decision query.seed", ["id", "kind"], ["id", "kind"]);
  if (!GRAPH_NODE_KINDS.includes(input.kind as never)) {
    invalid("decision query.seed.kind is invalid");
  }
  return Object.freeze({
    id: boundedText(input.id, "decision query.seed.id"),
    kind: input.kind as GraphRef["kind"]
  });
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
  const unsigned = Object.freeze({
    contractRevision: 1 as const,
    use: "evidence-only" as const,
    query: input.query,
    snapshot: input.snapshot,
    sourceFreshness: input.sourceFreshness,
    status: input.status,
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
  try {
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
