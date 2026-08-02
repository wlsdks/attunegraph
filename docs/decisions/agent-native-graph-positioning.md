# Agent-native graph positioning

Status: accepted direction; implementation claims remain evidence-gated.
Last reviewed: 2026-08-02.

## Decision

AttuneGraph remains a dependency-free, embedded temporal and provenance graph
engine for agents. It does not become a compatibility layer over Neo4j, a
vector-memory wrapper, or a generic property-graph query service.

The next product wedge is semantic before it is mechanical: exact-head,
bitemporal, source-bound, fail-closed decision evidence with explicit
authority, conflict, and abstention. Profiling and scale qualification remain
mandatory, but no Rust or external graph server is justified until the
TypeScript/SQLite profile identifies a boundary-cost-inclusive bottleneck.

## Why a dedicated engine

General graph databases own graph storage, traversal, indexing, and query
languages. They do not, by themselves, make proximity true, a similarity match
authoritative, a source fresh, a policy applicable, or an action permitted.
AttuneGraph's differentiating contract is the combination of:

- daemon-free embedded startup and deterministic local replay;
- exact source, scope, current head, recorded time, valid time, and provenance;
- bounded agent-facing results with explicit `complete | partial | abstained`;
- conflict and authority closure that never promotes proximity to permission;
- content-addressed receipts explaining witnesses, exclusions, and truncation;
- portable recovery without an external Graph DB control plane.

Vector retrieval remains useful for candidate discovery, but nearest-neighbor
ranking cannot prove which fact was current at an exact time, whether a source
was revoked, why a claim was derived, whether policies conflict, or whether an
action is authorized. AttuneGraph may consume host-selected vector candidates;
it does not treat similarity as truth or action authority.

For personal projects, the expected benefit is less repeated reconstruction:
an agent can receive a small, exact decision context instead of reloading raw
notes and re-deriving time, source, and policy relationships on every turn.
That should reduce input tokens, stale-state errors, and recovery work, but the
repository does not yet have organic-use evidence quantifying those savings.

## Primary-source assessment

| Source | Classification | Decision use | Limitation |
| --- | --- | --- | --- |
| [Graphiti paper](https://arxiv.org/html/2501.13956) and [official repository](https://github.com/getzep/graphiti) | `reference-only` | Retain bitemporal facts and explicit source linkage as comparison points. | Its architecture and benchmark do not prove AttuneGraph's exact-head, authority, abstention, or daemon-free contracts. |
| [Microsoft GraphRAG paper](https://arxiv.org/html/2404.16130), [repository](https://github.com/microsoft/graphrag), and [official overview](https://microsoft.github.io/graphrag/index/overview/) | `reference-only` | Use global/local graph retrieval as a retrieval-quality comparison. | Community summaries and LLM-generated graphs are not current-world authority proofs. |
| [Mem0 paper](https://arxiv.org/html/2504.19413), [repository](https://github.com/mem0ai/mem0), and [open-source quickstart](https://docs.mem0.ai/open-source/python-quickstart) | `reference-only` | Compare agent-memory ingestion and retrieval ergonomics. | Managed-service results must not be attributed to the open-source package without matching evidence. |
| [Cognee paper](https://arxiv.org/html/2505.24478) and [repository](https://github.com/topoteretes/cognee) | `reference-only` | Compare modular memory pipelines and graph enrichment. | This review could not retrieve every linked concept page; no parity claim is made. |
| [MAGMA paper](https://arxiv.org/html/2601.03236) and [repository](https://github.com/FredJiang0324/MAGMA) | `adopt` | Adopt the idea of separately inspectable semantic, temporal, causal, and entity views. | LLM-produced causal edges remain uncertain evidence and require source-bound witnesses; the full architecture is not adopted. |
| [A-Mem paper](https://arxiv.org/html/2502.12110) and [repository](https://github.com/WujiangXu/A-mem) | `reference-only` | Compare dynamic note linking and memory evolution. | Link formation is not a permission or truth mechanism. |
| [MemoTime paper](https://arxiv.org/html/2510.13614) | `reference-only` | Compare temporal-memory evaluation questions. | A paper task does not establish a production persistence or authority contract. |
| [Neo4j agent-memory repository](https://github.com/neo4j-labs/agent-memory) | `replacement candidate` | Consider when a host explicitly wants a managed/external graph service and accepts its operations boundary. | It is not a replacement under AttuneGraph's offline, embedded, exact-head, fail-closed requirements. |
| [Kuzu repository](https://github.com/kuzudb/kuzu) | `unnecessary` | Do not add it to the core. | The repository is archived; another embedded graph engine would add a compatibility and lifecycle boundary without supplying agent-native semantics. |
| [SQLite serverless architecture](https://www.sqlite.org/serverless.html), [WAL](https://www.sqlite.org/wal.html), and [FTS5](https://www.sqlite.org/fts5.html) | `adopt` | Keep SQLite as the durable local profile and measure cold/warm open, WAL growth, worker lifecycle, and indexed lookup. | SQLite supplies storage primitives, not AttuneGraph's graph or authority semantics. |
| [W3C PROV-O](https://www.w3.org/TR/prov-o/) | `adopt` | Maintain a narrow conceptual mapping for entities, activities, agents, derivation, and attribution. | Do not widen the runtime into a complete PROV reasoner without a demonstrated agent need. |
| [OpenFGA concepts](https://openfga.dev/docs/concepts) and [conditions](https://openfga.dev/docs/modeling/conditions) | `adopt` | Adopt explicit relationship direction, contextual conditions, and fail-closed authorization vocabulary. | AttuneGraph does not embed OpenFGA or claim Zanzibar compatibility. |
| [OPA decision logs](https://www.openpolicyagent.org/docs/management-decision-logs) | `adopt` | Use decision identifiers, inputs, outcomes, and explanation posture as receipt-design references. | AttuneGraph receipts remain local content-addressed evidence, not OPA decision logs. |
| [Letta stateful-agent concepts](https://docs.letta.com/v1-sdk/concepts/stateful-agents) | `reference-only` | Compare stateful-agent integration ergonomics. | Stateful agent storage alone does not provide temporal/provenance closure. |
| [LongMemEval repository](https://github.com/xiaowu0162/LongMemEval), [BEAM paper](https://arxiv.org/html/2504.06254) and [repository](https://github.com/beam-evaluation/beam), [MemBench paper](https://aclanthology.org/2025.findings-acl.989/) | `adopt` | Build retrieval, abstention, temporal, and long-horizon evaluation corpora inspired by their task categories. | Scores are not comparable until data, hardware, models, and semantic contracts match. |

Public GitHub issue and discussion surfaces for these repositories are useful
signals for integration pain and operational expectations, but this review did
not perform a statistically representative community-demand study. Individual
issues therefore do not become product requirements without a reproducible
AttuneGraph case.

## Evidence state

| Capability | State on this branch | Evidence boundary |
| --- | --- | --- |
| Existing `decision-query@1` evidence retrieval | `shipped` on the baseline | Existing focused tests; authority and conflict remain explicitly not performed. |
| `authority-query@1` current-world four-edge proof | `shipped` on the current baseline | Public-interface tests cover explicit witnesses, conflict, V1 root abstention, future posture, temporal exclusion, hypotheses, token truncation, exact-current-head replay, hostile input, and memory/SQLite byte parity. |
| Transported full `decision-query@1` result admission | `built, focused-verified` | Root-public `admitDecisionQueryResult` closes safe detached JSON, full assertion-byte tokens, bitemporal eligibility, diagnostics, refs, status, witnesses, and receipt revision 2's domain-separated ordered assertion-content-plus-seed ID. It remains pending FULL gates, independent evaluation, landing, and release integration. |
| Historical-head query | `roadmap` | The current Store Adapter exposes the current projection only; exact mode checks current-head equality and is not retention. |
| Causal proof beyond explicit authority witness ordering | `roadmap` | No shipped causal-closure semantics. |
| 10K current exact-head measurement | `evidence missing for qualification` | A local measurement exists, but it is not attested qualification or a cross-system comparison. |
| 100K/1M authority-query qualification | `evidence missing` | No current-head six-report qualification matrix. |
| Token, error, and reconstruction-time savings in Muse or other agents | `evidence missing` | Requires instrumented clean-room and organic-use studies. |

## Consequences

1. Strengthen semantics before optimizing raw traversal throughput.
2. Measure the actual current-world authority workload at 10K/100K/1M after
   this contract lands, including token envelope, abstention, SQLite cold/warm
   open, worker lifecycle, RSS/heap, WAL growth, and exact-current-head replay.
3. Compare external systems only under the same semantic contract, hardware,
   scale, and source posture; do not publish raw-number superiority otherwise.
4. Keep Muse integration narrow: the host owns raw documents and adapters;
   AttuneGraph owns exact anchors, temporal validity, provenance, derivation,
   invalidation, conflict, and authority evidence.
