import { isDeepStrictEqual, types as nodeTypes } from "node:util";

import type {
  AttuneGraphAgentDecisionBundle,
  AttuneGraphAgentDecisionContext,
  AttuneGraphDecisionContextProofBundle,
  AttuneGraphDecisionContextResult
} from "./attunegraph-contracts.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import {
  canonicalizeImmutableEnvelope,
  mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse
} from "./canonical-immutable-envelope.js";
import { replayDecisionContextProofBundle } from "./decision-context.js";
import type { GraphAssertion } from "./types.js";

const AGENT_CONTEXT_SPEC = Object.freeze({
  hashDomain: "attunegraph.agent-decision-view.v1",
  idField: "contextId",
  idPrefix: "attunegraph-agent-context:"
});
const PROOF_BUNDLE_SPEC = Object.freeze({
  hashDomain: "attunegraph.decision-context-proof-bundle.v1",
  idField: "proofId",
  idPrefix: "attunegraph-decision-proof:"
});
const PROOF_MEDIA_TYPE = "application/vnd.attunegraph.decision-context-proof+json;version=1" as const;
type DataRecord = Record<string, unknown>;

function invalid(message: string, cause?: unknown): never {
  throw new AttuneGraphError("INVALID_INPUT", message, cause === undefined ? undefined : { cause });
}

function record(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[]
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be a plain object`);
  if (nodeTypes.isProxy(value)) invalid(`${label} must be a non-proxy plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) invalid(`${label} has unknown fields`);
  if (required.some((key) => !keys.includes(key))) invalid(`${label} has missing fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== "string" || !descriptors[key] || !("value" in descriptors[key]!))) {
    invalid(`${label} must have data properties`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key as string]!.value]));
}

function deeplyFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Reflect.ownKeys(value)) deeplyFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function detachedFrozen<T>(value: T): T {
  return deeplyFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function compileProofBundle(
  result: AttuneGraphDecisionContextResult
): AttuneGraphDecisionContextProofBundle {
  const unsigned = deeplyFreeze({
    operator: "decision-context-proof-bundle@1" as const,
    query: detachedFrozen(result.receipt.query),
    snapshot: result.snapshot === undefined ? null : detachedFrozen(result.snapshot),
    sourceFreshness: result.sourceFreshness === undefined
      ? null
      : detachedFrozen(result.sourceFreshness),
    projection: detachedFrozen(result.authority.projection),
    expectedDecisionReceiptId: result.receipt.receiptId
  });
  try {
    return mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      unsigned,
      PROOF_BUNDLE_SPEC
    ).envelope as unknown as AttuneGraphDecisionContextProofBundle;
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "decision context proof bundle could not be sealed", { cause });
  }
}

function evidenceUnion(result: AttuneGraphDecisionContextResult) {
  const entries: Array<{ assertion: GraphAssertion; roles: Array<"working-evidence" | "authority-witness"> }> = [];
  const byId = new Map<string, (typeof entries)[number]>();
  const include = (assertion: GraphAssertion, role: "working-evidence" | "authority-witness") => {
    const previous = byId.get(assertion.id);
    if (previous) {
      if (!isDeepStrictEqual(previous.assertion, assertion)) {
        throw new AttuneGraphError("CORRUPT_STORE", "decision evidence identity has inconsistent content");
      }
      if (!previous.roles.includes(role)) previous.roles.push(role);
      return;
    }
    const entry = { assertion, roles: [role] };
    byId.set(assertion.id, entry);
    entries.push(entry);
  };
  for (const assertion of result.workingGraph.assertions) include(assertion, "working-evidence");
  for (const assertion of result.authority.witnessAssertions) include(assertion, "authority-witness");
  return entries.map(({ assertion, roles }) => detachedFrozen({
    assertionId: assertion.id,
    roles,
    subject: assertion.subject,
    predicate: assertion.predicate,
    object: assertion.object,
    epistemicClass: assertion.epistemicClass,
    sourceRefs: assertion.sourceRefs,
    ...(assertion.validFrom === undefined ? {} : { validFrom: assertion.validFrom }),
    ...(assertion.validTo === undefined ? {} : { validTo: assertion.validTo }),
    recordedAt: assertion.recordedAt,
    ...(assertion.supersededAt === undefined ? {} : { supersededAt: assertion.supersededAt }),
    derivation: assertion.derivation
  }));
}

function buildAgentContext(
  result: AttuneGraphDecisionContextResult,
  proof: AttuneGraphDecisionContextProofBundle,
  estimatedTokens: number
): AttuneGraphAgentDecisionContext {
  const query = result.receipt.query;
  const unsigned = deeplyFreeze({
    operator: "agent-decision-view@1" as const,
    status: result.status,
    decisionReadyAtDeclaredSnapshot: result.decisionReady,
    executionCapability: "none" as const,
    decision: {
      scope: detachedFrozen(query.scope),
      seed: detachedFrozen(query.seed),
      action: detachedFrozen(query.action),
      threadRoot: detachedFrozen(query.threadRoot),
      asOf: query.asOf,
      head: result.snapshot === undefined ? null : detachedFrozen(result.snapshot),
      sourceFreshness: result.sourceFreshness === undefined
        ? null
        : detachedFrozen(result.sourceFreshness)
    },
    evidence: evidenceUnion(result),
    authority: {
      state: result.authority.authority,
      witnessAssertionIds: result.authority.witnessAssertions.map((assertion) => assertion.id),
      conflicts: detachedFrozen(result.authority.conflicts),
      exclusions: detachedFrozen(result.authority.exclusions)
    },
    diagnostics: {
      estimatedTokens,
      fullProofEstimatedTokens: result.diagnostics.estimatedTokens,
      evidenceClosure: result.diagnostics.evidenceClosure,
      authorityClosure: result.diagnostics.authorityClosure,
      conflictClosure: result.diagnostics.conflictClosure,
      truncationReasons: detachedFrozen(result.diagnostics.truncationReasons),
      terminalReasons: detachedFrozen(result.diagnostics.terminalReasons)
    },
    proof: {
      mediaType: PROOF_MEDIA_TYPE,
      proofId: proof.proofId,
      byteLength: Buffer.byteLength(JSON.stringify(proof), "utf8"),
      decisionReceiptId: result.receipt.receiptId,
      admission: "proof-bundle-replay-required" as const
    },
    trust: {
      contentIntegrity: "self-consistent-content-addressed" as const,
      producerAuthenticity: "not-provided" as const,
      sourceTruth: "not-provided" as const,
      headCurrency: "not-checked" as const
    }
  });
  try {
    return mintCanonicalImmutableEnvelopeFromFrozenUnsignedForInternalUse(
      unsigned,
      AGENT_CONTEXT_SPEC
    ).envelope as unknown as AttuneGraphAgentDecisionContext;
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "agent decision view could not be sealed", { cause });
  }
}

function converge(
  result: AttuneGraphDecisionContextResult,
  proof: AttuneGraphDecisionContextProofBundle
): AttuneGraphAgentDecisionContext {
  let estimatedTokens = 0;
  let context = buildAgentContext(result, proof, estimatedTokens);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const next = Math.ceil(Buffer.byteLength(JSON.stringify(context), "utf8") / 4);
    if (next === estimatedTokens) return context;
    estimatedTokens = next;
    context = buildAgentContext(result, proof, estimatedTokens);
  }
  return context;
}

/** Split one same-process Engine result into a prompt view and replay proof. */
export function compileAgentDecisionBundle(
  result: AttuneGraphDecisionContextResult
): AttuneGraphAgentDecisionBundle {
  const proof = compileProofBundle(result);
  const context = converge(result, proof);
  return deeplyFreeze({ context, proof });
}

/** Admit detached bytes by replaying the proof and exact-comparing the view. */
export function admitAgentDecisionBundle(value: unknown): AttuneGraphAgentDecisionBundle {
  const input = record(value, "agent decision bundle", ["context", "proof"], ["context", "proof"]);
  let proof: AttuneGraphDecisionContextProofBundle;
  try {
    proof = canonicalizeImmutableEnvelope(
      input.proof,
      "external-mutable",
      PROOF_BUNDLE_SPEC
    ).envelope as unknown as AttuneGraphDecisionContextProofBundle;
  } catch (cause) {
    invalid("agent decision proof bundle is unsafe or mismatched", cause);
  }
  record(
    proof,
    "agent decision proof bundle",
    [
      "operator", "proofId", "query", "snapshot", "sourceFreshness",
      "projection", "expectedDecisionReceiptId"
    ],
    [
      "operator", "proofId", "query", "snapshot", "sourceFreshness",
      "projection", "expectedDecisionReceiptId"
    ]
  );
  if (proof.operator !== "decision-context-proof-bundle@1") {
    invalid("agent decision proof bundle operator is unsupported");
  }
  const replayed = replayDecisionContextProofBundle(proof);
  const expected = deeplyFreeze({ context: converge(replayed, proof), proof });
  let suppliedContext: AttuneGraphAgentDecisionContext;
  try {
    suppliedContext = canonicalizeImmutableEnvelope(
      input.context,
      "external-mutable",
      AGENT_CONTEXT_SPEC
    ).envelope as unknown as AttuneGraphAgentDecisionContext;
  } catch (cause) {
    invalid("agent decision view is unsafe or mismatched", cause);
  }
  if (!isDeepStrictEqual(suppliedContext, expected.context)) {
    invalid("agent decision view does not match its proof bundle replay");
  }
  return expected;
}
