# Agent decision view and proof bundle

Status: verified-current in this source-changing slice. Focused correctness,
deterministic payload qualification, FULL gates, and independent evaluation
pass. Landing and release integration remain pending.

Last reviewed: 2026-08-04.

## Decision

AttuneGraph separates the bytes an AI model should read from the bytes a host
needs to replay and verify one Decision Context:

- `agent-decision-view@1` is a compact, content-addressed model-facing view;
- `decision-context-proof-bundle@1` is a detached, content-addressed replay
  proof containing the normalized query, exact snapshot posture, one canonical
  projection, and the expected full Decision Context receipt ID;
- `compileAgentDecisionBundle` creates both from one same-process Engine result;
- `admitAgentDecisionBundle` re-admits the proof, reruns the existing full
  Decision Context compiler, regenerates the view, and requires exact equality.

No SQLite schema, persisted format, source observation, authority rule, Working
Graph selection rule, or `decision-context@1` receipt changes in this slice.

## First-principles decomposition

The previous full result served two different consumers:

| Consumer | Irreducible information | Removable cost |
| --- | --- | --- |
| AI model | Decision facts, source references, exact scope/head/time, authority/conflict state, incompleteness, proof handle | Canonical projection, authority scan frontier, canonical receipt JSON, duplicate witnesses |
| Deterministic verifier | Normalized query, exact snapshot posture, canonical source projection | Precomputed Working Graph, witness copies, diagnostics copies, receipt copies |

The full result encoded the same assertion semantics in the canonical
projection, authority frontier, Working Graph, receipt selections, authority
witnesses, and canonical receipt JSON. JSON parsing itself measured near
0.05–0.08 ms p50 in the read-only profile; repeated canonicalization, hashing,
and semantic replay were the larger CPU work. This is a representation problem,
not evidence that SQLite is the bottleneck.

## Agent view contract

The view contains:

- `complete | partial | abstained` and
  `decisionReadyAtDeclaredSnapshot`;
- exact scope, seed, action, thread root, `asOf`, snapshot, and freshness;
- a stable union of Working Graph and authority-witness assertions, with
  `working-evidence` and `authority-witness` roles rather than duplicate rows;
- source references, bitemporal fields, epistemic class, and derivation;
- conflicts, exclusions, closure, truncation, and terminal reasons;
- separate prompt and full-result token estimates;
- an OCI-style proof descriptor with media type, proof ID, byte length, and
  expected Decision Context receipt ID;
- explicit trust posture: content integrity is self-consistent and
  content-addressed; producer authenticity, external source truth, and live
  head currency are not provided.

The view never grants an execution capability.

## Proof and admission algorithm

1. Canonically seal `{ query, snapshot, sourceFreshness, projection,
   expectedDecisionReceiptId }` under a domain-separated proof ID.
2. Create the compact assertion union and seal the view under a separate
   domain-separated context ID.
3. On detached admission, reject proxies, accessors, unknown outer fields,
   malformed envelopes, unsupported operators, and mismatched content IDs.
4. Normalize the query, snapshot, freshness, and canonical projection again.
5. Rebuild the stored projection from its exact canonical bytes.
6. Run the unchanged `compileDecisionContext` implementation.
7. Require the regenerated Decision Context receipt ID to equal the proof's
   expected receipt ID.
8. Regenerate the compact view and require exact equality with the transported
   view.

Admission proves self-consistency at the declared snapshot. It deliberately
does not consult the Store. A later head or source revocation therefore does
not silently change a detached result; the view says `headCurrency:
not-checked`. A host requiring current-world use must compare the declared
snapshot with its current Store head before acting.

## Deterministic payload qualification

Command:

```sh
pnpm benchmark:agent-context
```

Measured on macOS arm64, Node 24.16.0, in-memory Store, 2026-08-04. This is a
deterministic payload-size cell, not SQLite cold/warm or model-quality evidence.

| Scenario | Full result | Agent view | Prompt reduction | Proof bundle | View + proof reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| small complete | 20,615 B / 5,154 tokens | 3,829 B / 958 tokens | 81.4% | 3,951 B | 62.3% |
| evidence token cut | 25,282 B / 6,321 tokens | 3,369 B / 843 tokens | 86.7% | 9,714 B | 48.3% |
| byte-heavy floor | 35,302 B / 8,826 tokens | 9,106 B / 2,277 tokens | 74.2% | 8,717 B | 49.5% |
| authority work cut | 34,660 B / 8,665 tokens | 1,684 B / 421 tokens | 95.1% | 18,465 B | 41.9% |

The executable gate requires at least 70% prompt-byte reduction and 35% total
view-plus-proof reduction for every fixed scenario, plus successful detached
semantic admission. These thresholds were fixed below the measured minima;
they are regression gates, not general product SLAs.

## Research disposition

Only mechanisms and public specifications were studied; no third-party source
code is copied into the runtime.

| Source or idea | Classification | Decision use and limit |
| --- | --- | --- |
| [OCI descriptor](https://github.com/opencontainers/image-spec/blob/main/descriptor.md) | `adopt` | Use the media type + digest + byte-length descriptor pattern. AttuneGraph retains its own canonical JSON and hash domains. |
| [MCP resource links](https://modelcontextprotocol.io/specification/draft/server/tools) | `reference-only` | A future Adapter may keep proof bytes outside a model tool result. This slice does not ship an MCP Adapter. |
| [RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.html) | `reference-only` | Inclusion and consistency proofs inform future append-log verification; they do not prove graph-query completeness. |
| [RFC 9942](https://www.rfc-editor.org/info/rfc9942/) | `reference-only` | Detached receipt structure is relevant, but signatures and key trust are outside the current producer-authenticity contract. |
| [Compact Merkle multiproofs](https://arxiv.org/abs/2002.07648) | `deferred` | Membership does not prove complete adjacency, hidden-conflict absence, or index-to-projection equivalence. Revisit only after 100K/1M proof bytes or replay are measured bottlenecks. |
| [Database provenance semirings](https://www.cs.ucdavis.edu/~green/papers/pods07.pdf) | `reference-only` | Derivation provenance informs minimal witnesses; symbolic provenance can exceed an agent context budget. |
| [Proof-Carrying Data](https://projects.csail.mit.edu/pcd/) | `replacement candidate` | Succinct recursive proofs could eventually verify derived indexes, but dependency, audit, and implementation cost are unjustified today. |
| Model-based prompt compression | `rejected` for proof | Lossy summaries cannot replace exact evidence, conflict, authority, or abstention semantics. |

## Roadmap classification

| Delta | State after focused implementation |
| --- | --- |
| Full proof-closed `decision-context@1` replay | `verified-current` baseline |
| Compact model-facing decision view | `verified-current` in this evaluated slice |
| Minimal portable proof bundle and exact view replay | `verified-current` in this evaluated slice |
| Prompt and total deterministic payload regression gate | `verified-current` in this evaluated slice |
| Producer authentication or signatures | `deferred` until a trust/key contract exists |
| Store-current proof resolution | `missing`; host must compare current head |
| 100K/1M replay and model-quality evaluation | `missing` |
| Merkle/succinct proof | `deferred` pending measured replacement trigger |

## Limits and falsification

- The proof is deterministic and content-addressed, not signed. A malicious
  producer can create a different self-consistent observation and proof.
- Detached admission proves the declared snapshot, not that it is still the
  Store head or that the source remains true.
- Canonical projection replay remains linear in projection bytes. The slice
  removes repeated transport and prompt bytes; it does not make replay
  sublinear.
- The payload benchmark does not prove lower model error, latency, or cost.
  Same-model full-result versus compact-view evaluation remains required.
- Merkle, SNARK, Rust, and a different storage engine are rejected for this
  slice unless 100K/1M boundary-inclusive measurements cross a recorded
  replacement trigger.
