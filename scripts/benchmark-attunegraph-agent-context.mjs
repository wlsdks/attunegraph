import { fileURLToPath } from "node:url";

import {
  admitAgentDecisionBundle,
  compileAgentDecisionBundle,
  openAttuneGraph
} from "../dist/index.js";
import { createAttuneGraphStore } from "../dist/attunegraph-backend.js";
import { InMemoryAttuneGraphStoreBackend } from "../dist/attunegraph-in-memory-store.js";

const NOW = "2026-08-03T09:00:00.000Z";
const BEFORE = "2026-08-03T08:00:00.000Z";
const ROOT = { kind: "thread", id: "thread:release" };
const ACTION = { kind: "action", id: "action:publish" };
const POLICY = { kind: "policy", id: "policy:reviewed-release" };
const EVIDENCE = { kind: "evidence", id: "evidence:approval" };

function assertion(id, subject, predicate, object, sourceNamespace = "decision-context-test") {
  return {
    schemaVersion: 1,
    id,
    subject: { ...subject },
    predicate,
    object: { ...object },
    epistemicClass: "source-observed",
    sourceRefs: [{ namespace: sourceNamespace, id: `source:${id}` }],
    recordedAt: BEFORE,
    derivation: { kind: "projection", version: "decision-context-test" }
  };
}

function completeAssertions() {
  return [
    assertion("context", { kind: "artifact", id: "release-notes" }, "CONTEXT_FOR", ROOT),
    assertion("governed", ACTION, "GOVERNED_BY", POLICY),
    assertion("policy-scope", POLICY, "SCOPED_TO", ROOT),
    assertion("authorized", ACTION, "AUTHORIZED_BY", EVIDENCE),
    assertion("evidence-scope", EVIDENCE, "OBSERVED_DURING", ROOT)
  ];
}

function scenarios() {
  const evidenceTokenCut = Array.from({ length: 10 }, (_, index) => assertion(
    `large-context-${index.toString().padStart(2, "0")}-${"x".repeat(40)}`,
    { kind: "artifact", id: `artifact:${index.toString()}:${"y".repeat(40)}` },
    "CONTEXT_FOR",
    ROOT
  ));
  const byteHeavy = completeAssertions().map((entry) => ({
    ...entry,
    id: `${entry.id}:${"q".repeat(480)}`,
    sourceRefs: [{
      namespace: "authority-token-cut",
      id: `${entry.id}:${"z".repeat(480)}`
    }]
  }));
  const authorityWorkCut = Array.from({ length: 33 }, (_, index) => assertion(
    `filler-${index.toString().padStart(2, "0")}`,
    { kind: "artifact", id: `artifact:${index.toString()}` },
    "CONTEXT_FOR",
    ROOT
  ));
  return [
    { name: "small-complete", assertions: completeAssertions(), budget: 16_000 },
    { name: "evidence-token-cut", assertions: [...completeAssertions(), ...evidenceTokenCut], budget: 8_000 },
    { name: "byte-heavy-floor", assertions: byteHeavy, budget: 8_827 },
    { name: "authority-work-cut", assertions: [...completeAssertions(), ...authorityWorkCut], budget: 16_000 }
  ];
}

async function measureScenario(definition) {
  const scope = {
    sourceId: "decision-context-test",
    threadId: "release"
  };
  const graph = await openAttuneGraph({
    scope,
    store: createAttuneGraphStore(new InMemoryAttuneGraphStoreBackend())
  });
  try {
    await graph.project({
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        observationKey: definition.name,
        scope,
        threadRoot: ROOT,
        observedAt: NOW,
        sourceFreshness: { state: "fresh", observedAt: NOW },
        assertions: definition.assertions
      }
    });
    const fullProof = await graph.queryDecisionContext({
      operator: "decision-context@1",
      scope,
      seed: ROOT,
      action: ACTION,
      threadRoot: ROOT,
      asOf: NOW,
      head: { mode: "current" },
      freshness: { require: "fresh" },
      budget: { maxEstimatedTokens: definition.budget }
    });
    const bundle = compileAgentDecisionBundle(fullProof);
    const agentContext = bundle.context;
    const admitted = admitAgentDecisionBundle(JSON.parse(JSON.stringify(bundle)));
    const fullProofBytes = Buffer.byteLength(JSON.stringify(fullProof), "utf8");
    const agentBytes = Buffer.byteLength(JSON.stringify(agentContext), "utf8");
    const proofBundleBytes = Buffer.byteLength(JSON.stringify(bundle.proof), "utf8");
    const totalBundleBytes = agentBytes + proofBundleBytes;
    return Object.freeze({
      name: definition.name,
      status: agentContext.status,
      decisionReady: agentContext.decisionReadyAtDeclaredSnapshot,
      fullProofBytes,
      fullProofEstimatedTokens: fullProof.diagnostics.estimatedTokens,
      agentBytes,
      agentEstimatedTokens: agentContext.diagnostics.estimatedTokens,
      promptByteReductionPercent: Number(
        (((fullProofBytes - agentBytes) / fullProofBytes) * 100).toFixed(1)
      ),
      proofBundleBytes,
      totalBundleBytes,
      totalByteReductionPercent: Number(
        (((fullProofBytes - totalBundleBytes) / fullProofBytes) * 100).toFixed(1)
      ),
      admissionVerified: admitted.context.contextId === agentContext.contextId
    });
  } finally {
    await graph.close();
  }
}

export async function runAgentContextBenchmark() {
  const measured = [];
  for (const definition of scenarios()) measured.push(await measureScenario(definition));
  return Object.freeze({
    schemaVersion: 1,
    measurement: "deterministic-payload-size",
    environment: Object.freeze({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      store: "in-memory"
    }),
    scenarios: Object.freeze(measured)
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${JSON.stringify(await runAgentContextBenchmark(), null, 2)}\n`);
}
