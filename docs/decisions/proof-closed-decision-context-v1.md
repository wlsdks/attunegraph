# Same-head fixed-profile replay Decision Context v1

Status: implemented, focused qualification pending independent evaluation

## Decision

AttuneGraph exposes `decision-context@1` as one fixed-profile Engine operation.
It reads and admits one projection head, compiles a bounded Working Graph and a
bounded action-authority evaluation from that same immutable projection, and
returns a domain-separated content-addressed receipt. The caller supplies
scope, evidence seed, exact action, exact V2 thread root, canonical `asOf`,
`current` or `exact` head posture, required-fresh posture, and one bounded token
budget. The caller cannot select predicates or relax authority closure.

`complete` means all of the following are true: evidence closure is complete,
authority is `authorized`, authority closure is complete, and conflict closure
is complete. Otherwise the operation abstains, except that authorized authority
paired with a budget-cut evidence frontier may be `partial`. Both `partial` and
`abstained` have `decisionReady: false`. Every result has
`executionCapability: "none"`; neither graph proximity nor the receipt grants
permission or performs an action.

The authority component transports projection posture once, including the full
canonical projection, and the complete bounded evaluation frontier as assertion
bytes: at most 32 evaluated assertions and, for a work cut, one lookahead
assertion. It also records evaluated, total, and scan-closure metadata. The four
authorized witness assertions remain full assertions rather than identifier-only
claims. A domain-separated `authorityEvaluationId` binds the projection posture
and frontier into the v1 receipt, which also binds the normalized query, exact
snapshot, freshness, selected Working Graph identity and assertions, conflicts,
exclusions, closure, truncation/terminal reasons, and overall status.

`admitDecisionContextResult` admits detached JSON, re-normalizes the supplied
content, reconstructs the full stored projection from the transported canonical
projection, and reruns `compileDecisionContext` with the normalized query.
Supplied evidence assertions, refs, diagnostics, authority outputs, status,
readiness, token estimate, and receipt must match that fixed-profile replay.
The replay also regenerates the bounded 32-plus-one authority frontier rather
than treating a supplied selected graph as an independent semantic source.

The closure claim is deliberately narrow: full same-head fixed-profile replay
closure over the transported canonical projection, under the documented
Working Graph and authority bounds. It is transport integrity, not producer
authenticity or generic provenance/derivation proof closure. Source references,
epistemic class, temporal fields, and derivation records are transported and
normalized bytes; admission does not prove their external truth or that the
producer head remains current after transport. The full canonical projection
and bounded frontier are mandatory transport costs, so some small token budgets
fail closed instead of returning a result.

This is not arbitrary AttuneQL, ranking, similarity, policy execution, action
execution, generic causal inference, or multi-source snapshot composition.
Existing query contracts, grammar, durable schemas, and portable formats are
unchanged.

## Research decision record

A general database can emulate this contract with sufficient application code.
AttuneGraph's narrower claim is that safe composition is an embedded default
with an independently testable receipt and fail-closed terminal semantics.

| System or reference | Decision | Relevant evidence and boundary | Falsifiable replacement or adoption criterion |
| --- | --- | --- | --- |
| [Graphiti OSS 0.29.3](https://github.com/getzep/graphiti), inspected commit `899cb40d043b3f085917a69d95f26ed5ea24f411` | `reference-only` | Temporal validity, episode provenance, and hybrid search are relevant. It uses a third-party graph backend plus LLM/embedding providers; public search returns top-k edges, nodes, episodes, and scores rather than exact-head action proof with explicit partial/abstained closure. | Reconsider integration if a dependency-free adapter demonstrates exact-head, source-bound, fail-closed authority receipts on this corpus without transferring authority to model scores. |
| [Mem0 OSS](https://github.com/mem0ai/mem0), inspected commit `c90bdbdce078f46d768c44031ce77a1b93dbc3f6`; [paper](https://arxiv.org/abs/2504.19413) | `unnecessary` | Its easy memory UX is relevant to hosts, but inspected v3 removes graph-store traversal for entity-link boosting and does not provide this decision-authority contract. | Reconsider if an independently testable API exposes same-head temporal evidence and action-authority closure with bounded abstention receipts. |
| [Cognee](https://github.com/topoteretes/cognee), inspected commit `38eece5bbb0cb9f5706fed908abd16dba0f5505e`; [paper](https://arxiv.org/abs/2505.24478) | `reference-only` | Broad three-store and LLM pipeline, temporal/provenance, and ACL mechanisms are useful references, but inspected surfaces do not establish exact-head action authority with this fail-closed context receipt. | Reconsider an adapter when the same corpus passes without provider/model authority and with byte-stable receipt admission. |
| [Remnic](https://github.com/joshuaswarren/remnic), inspected commit `7e2ad26aecd2f7ce1fafe17fc424879149bc9e74` | `reference-only` | Local-first Markdown/YAML ownership, scoped provenance, correction lineage, budgeted recall, and reproducible mission receipts are strong host-memory references. The inspected public contract does not establish one fixed database operation that closes same-head temporal evidence, action authority, and the conflict frontier before returning decision readiness. | Reconsider composition or replacement when a provider-free, detached admission test passes this slice's omission, fabrication, exact-head, and tight-budget corpus without relying on human approval or host-specific mission code. |
| [Memoria](https://github.com/matrixorigin/Memoria), inspected commit `54c9114fd6888e11821edc2ee9acd570c17c5ee3` | `reference-only` | Copy-on-write memory branches, rollback, mutation audit trails, contradiction detection, and quarantine are useful lifecycle references. Its self-hosted product boundary includes MatrixOne and service infrastructure, and the inspected retrieval/governance surfaces do not establish this same-head decision-authority receipt. | Adopt branch/merge mechanisms only if a concrete agent workflow needs them and a portable, daemon-free implementation preserves exact-head replay, revocation, and receipt admission under measured resource bounds. |
| [SurrealDB](https://github.com/surrealdb/surrealdb), inspected `main` at `9d9a5b0693e499e0d030cac6b618062ec02cd2bc` | `replacement candidate` | Embedded multi-model graph storage, transactions, row permissions, and MCP support make it a serious general storage/API candidate. Those features are not by themselves valid/recorded-time evidence admission, authority/conflict closure, token-bounded context, or explicit abstention. | Replace only a measured physical boundary, and only if 10K/100K/1M same-contract trials preserve canonical bytes, cold-start independence, deterministic failure states, and total resource budgets. |
| LadybugDB and Grafeo | `replacement candidate` | They are storage-kernel candidates only; this slice adds neither dependency. | Replace the current kernel only if 10K/100K/1M same-contract trials preserve exact bytes and closure while meeting approved ingest, query, settled-byte, and peak-RSS thresholds. |
| [GEM](https://arxiv.org/abs/2605.26252) | `adopt` | Treat memory correctness as a state-trajectory property spanning ingestion, revision, forgetting, and retrieval rather than record storage alone. | Remove the derived trajectory cases if they fail to distinguish a known stale/revoked-state defect from a correct run. |
| [LongMemEval-V2](https://arxiv.org/abs/2605.12493) | `adopt` | Motivates compact evidence gathering over dynamic state, workflows, failures, and premise awareness. Reported author results are preprint evidence, not transferable product results. | Retain only if a same-model study shows the corpus predicts task failures beyond token count alone. |
| [Scale-conditioned memory evaluation](https://arxiv.org/abs/2605.07313) | `adopt` | Report usable-scale boundaries and budget-compliant reliability rather than one fixed-snapshot score. | Replace when a stronger protocol measures the same correctness and budget axes over increasing scale with reproducible thresholds. |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) and [PROV constraints](https://www.w3.org/TR/prov-constraints/) | `reference-only` | Provenance mechanism and constraint references, not evidence of a shipped AttuneGraph feature. | Adopt a mapping only if round-trip source and derivation identity stays lossless on the portable corpus. |
| [Kuzu CIDR paper](https://www.cidrdb.org/cidr2023/papers/p48-jin.pdf) | `reference-only` | Storage/layout mechanism reference, not shipped-feature evidence. | Promote to a replacement experiment only after profiling identifies a matching physical bottleneck. |

## Measured storage-only baseline retained without product equivalence

At base `12e9ebe`, Node 24.16 on macOS arm64, M2 Max, 64 GiB, five rotating
fresh-process 10K trials and all 313 scope oracles produced:

| Engine | Ingest ms | Adjacency p50 ms | Proof assembly p50 ms | Settled bytes | Peak RSS bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| AttuneGraph v4 | 1387.95 | 0.0154 | 0.981 | 6,148,096 | 144,834,560 |
| Cozo 0.7.6 | 25.60 | 0.0832 | not measured | 1,748,992 | 103,514,112 |
| Ladybug 0.19.0 | 159.20 | 0.619 | not measured | 3,092,480 | 491,339,776 |

Artifact: `/private/tmp/attunegraph-competitor-parity-current-12e9ebe.json`.
These are native-storage-only and product-boundary-unequal observations. They
do not establish an overall winner or an agent-quality result.

## Qualification corpus and reporting

The deterministic corpus is listed in
`fixtures/decision-context-v1/corpus.json` and executed through the public API
by `src/decision-context.test.ts`. It covers contradictory/backfilled evidence,
revoked or stale source posture, stale exact head, authority injection, and a
tight budget. For each case, qualification reports these axes separately:

- correctness against the declared expected status;
- terminal state and truncation reasons;
- authority witness and conflict closure;
- serialized output bytes and `diagnostics.estimatedTokens`;
- wall-clock latency as an observation, never as a correctness score.

The corpus qualifies deterministic contract behavior only. No agent-quality
claim is made until a same-model study exists.
