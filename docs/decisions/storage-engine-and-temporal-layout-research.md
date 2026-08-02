# Storage engine and temporal layout research

Status: accepted direction; physical schema v2 shipped in `d61a172`, and the
v3 current-head index is a built candidate without a query consumer.
Last reviewed: 2026-08-02.

## Decision

AttuneGraph keeps SQLite as its authoritative embedded durability, compare-and-
swap, recovery, and exact-head plane for now. SQLite is not the identified root
cause of current storage amplification. The dominant physical-model problem is
that each generation stores a complete canonical projection, repeating mostly
unchanged JSON and requiring whole-projection decode and admission on a cold
read.

The target architecture separates irreducible truth from rebuildable query
acceleration:

1. An immutable, source-bound observation and derivation journal remains the
   exact replay and proof authority.
2. The current head is a small exact manifest advanced atomically with journal
   admission.
3. A normalized current-head index stores only the atoms required by bounded
   decision queries: assertion identity, endpoint identity, recorded and valid
   intervals, provenance, derivation, invalidation, authority, and compact
   adjacency postings.
4. The index is derived state. It must be rebuildable from the journal, bound to
   an exact head and schema version, and fail closed when absent, stale, corrupt,
   or only partially activated.
5. Historical growth may use object-level anchors plus deltas and periodic
   checkpoints after a measured reconstruction/storage trade-off establishes an
   anchor policy. It must not infer deltas by comparing untrusted projections.
6. A different storage engine is considered only after the normalized SQLite
   design is measured and the remaining bottleneck is attributed to SQLite's
   page, lock, or write path rather than serialization, validation, worker
   lifecycle, traversal, or index design.

Physical schema v2 compression is the immediate density correction, not the
final query architecture. It reduces repeated bytes while preserving the
existing full-projection contract; it does not make cold query work
frontier-proportional.

## First-principles decomposition

The performance problem is evaluated as independent atoms rather than as a
choice between database brands:

| Atom | Irreducible contract | Removable or replaceable cost |
| --- | --- | --- |
| Source observation | Exact bytes/anchor, identity, source, recorded time | Host-owned raw document duplication |
| Semantic assertion | Canonical identity, valid time, epistemic class | Repeating every unchanged assertion in every generation |
| Derivation/provenance | Exact witnesses and alternative derivations | Recomputing the full derivation surface for every bounded query |
| Head transition | Atomic exact-head CAS and crash recovery | Storing the head only inside a large opaque snapshot |
| Current query | Exact scope/head/time, deterministic order, explicit truncation and abstention | Whole-corpus JSON decode, admission, sort, and adjacency reconstruction |
| History query | Exact past state with bounded reconstruction | One complete snapshot for every generation or an unbounded delta chain |
| Agent context | Proof-closed, token-bounded evidence | Passing raw graph neighborhoods or generated summaries as truth |

This decomposition means a faster graph traversal library cannot replace the
temporal, provenance, authority, and abstention contracts. Conversely, those
contracts do not require storing one repeated JSON projection per generation.

## Product and engine assessment

The classifications describe design use, not benchmark winners. Public source
availability and software licensing are separate: this document references and
paraphrases public primary materials but does not import third-party code.

| System | Verified storage shape | Classification | Decision use and boundary |
| --- | --- | --- | --- |
| [SQLite](https://www.sqlite.org/whentouse.html) | Embedded B-tree pages with rollback journal or WAL; one concurrent writer | `adopt` | Keep the small durable authority/CAS plane. SQLite does not require full graph snapshots; AttuneGraph chose that row shape. |
| [LadybugDB](https://github.com/LadybugDB/ladybug) | MIT-licensed embedded columnar node/relationship tables, compressed adjacency indexes, WAL/checkpoint | `replacement candidate` | Prototype only as an optional derived read plane if normalized SQLite still misses measured read/RSS budgets. Native packaging and single read-write database-object limits remain costs. |
| [Kuzu](https://github.com/kuzudb/kuzu) | Archived predecessor of LadybugDB | `unnecessary` | Do not start a new dependency comparison against an archived engine; use its paper and current Ladybug implementation as separate evidence. |
| [CozoDB](https://github.com/cozodb/cozo) | Embedded Datalog over ordered key/value stored relations; SQLite and RocksDB backends | `replacement candidate` | Its storage trait and temporal-key design are useful prototypes. It also demonstrates that SQLite can underlie a graph/relational engine. It does not supply AttuneGraph authority semantics. |
| [Neo4j Community](https://neo4j.com/docs/operations-manual/current/database-internals/store-formats/) | Native record stores, page cache, and transaction logs | `reference-only` | Study record locality and dense relationship layout. JVM deployment, licensing, and missing agent-native proof contracts prevent default adoption. |
| [FalkorDB](https://github.com/FalkorDB/FalkorDB) | Redis module using GraphBLAS sparse matrices; memory-first with RDB/AOF durability | `reference-only` | Study matrix traversal only. Daemon/RAM posture and SSPL licensing do not match the core boundary. |
| [Memgraph](https://memgraph.com/blog/memgraph-storage-modes-explained) | Native in-memory graph, transaction deltas, WAL and snapshots; optional RocksDB mode | `reference-only` | Study delta/MVCC behavior and its costs. Daemon/RAM posture and source-license boundaries prevent default adoption. |
| [SurrealDB](https://surrealdb.com/docs/architecture) | Query layer over versioned key/value engines including RocksDB and SurrealKV | `reference-only` | Study storage abstraction and versioned keys. A general multi-model engine does not close AttuneGraph proofs. |
| [Graphiti](https://github.com/getzep/graphiti) | Incremental temporal graph semantics over external graph backends | `reference-only` | Compare episode provenance and temporal fact modeling. Its storage dependency and published Zep results cannot be treated as an embedded AttuneGraph comparison. |
| [Mem0](https://docs.mem0.ai/open-source/features/graph-memory) | Vector memory plus optional external graph store | `reference-only` | Compare agent integration and hybrid retrieval. Similarity and extracted triplets do not establish truth or action authority. |
| [Cognee](https://github.com/topoteretes/cognee) | Separate graph, vector, and relational stores | `reference-only` | Compare adapter separation. The three-store consistency and operations surface is intentionally outside AttuneGraph's core. |

## Research lineage and disposition

Only directly retrieved public papers or official project/database documents are
listed. The classification applies to the idea, not to source-code reuse.

| Year | Primary source | Classification | AttuneGraph consequence | Limitation |
| --- | --- | --- | --- | --- |
| 1996 | [The Log-Structured Merge-Tree](https://db.cs.berkeley.edu/cs286/papers/lsm-acta1996.pdf) | `replacement candidate` | Consider sorted-run/LSM storage only for a measured sustained-write bottleneck. | Compaction and read amplification may be worse for bounded point/frontier reads. |
| 2004-current | [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html), [WAL](https://www.sqlite.org/wal.html), and [file format](https://www.sqlite.org/fileformat.html) | `adopt` | Retain tested atomic commit, crash recovery, and single-file portability as the durable floor. | Filesystem flush behavior and one-writer concurrency remain explicit operating assumptions. |
| 2005 | [C-Store](https://www.cs.umd.edu/~abadi/papers/vldb.pdf) | `adopt` | Separate the write/replay journal from compressed, query-oriented projections and read only required columns. | AttuneGraph is not an analytical column store; only the separation principle transfers. |
| 2007 | [Update Exchange with Mappings and Provenance](https://www.vldb.org/conf/2007/papers/research/p675-green.pdf) | `adopt` | Preserve derivation paths and source-specific trust/authority decisions through updates and invalidations. | Its relational peer-exchange semantics are a reference, not AttuneGraph's public model. |
| 2020 | [LiveGraph](https://www.vldb.org/pvldb/vol13/p1020-zhu.pdf) | `reference-only` | Test append-oriented, timestamped adjacency postings with sequential scans under skew. | Transactional Edge Logs and graph concurrency control are too large to adopt before high-degree evidence exists. |
| 2021 | [Columnar Storage and List-based Processing for Graph DBMSs](https://arxiv.org/abs/2103.02284) | `adopt` | Use compact list/posting representations and avoid materializing unused properties during bounded traversal. | Physical layout must still preserve deterministic ordering and exact assertion bytes. |
| 2023 | [Kuzu graph DBMS](https://www.cidrdb.org/cidr2023/papers/p48-jin.pdf) | `adopt` | Use compressed adjacency/list layout and factorized intermediates as derived-index principles. | Paper throughput is not comparable to AttuneGraph's durability and proof contract. |
| 2024 | [AeonG](https://www.vldb.org/pvldb/vol17/p1515-lu.pdf) | `adopt` | Separate current and historical storage; evaluate object-level anchor+delta reconstruction with explicit checkpoint policy. | Its adaptive anchor results do not select AttuneGraph's interval without a matching workload. |
| 2024 | [Microsoft GraphRAG](https://arxiv.org/abs/2404.16130) | `reference-only` | Compare global sensemaking retrieval and summary budgets. | LLM-generated entity/community summaries are not exact source, current-world, or authority proof. |
| 2024 | [LongMemEval](https://arxiv.org/abs/2410.10813) | `adopt` | Evaluate extraction, multi-session reasoning, temporal reasoning, updates, and abstention independently of raw DB speed. | Benchmark scores depend on model, prompts, and corpus; they are not storage-engine scores. |
| 2025 | [Zep temporal KG](https://arxiv.org/abs/2501.13956) | `reference-only` | Compare episode provenance, validity, retrieval latency, and long-horizon accuracy. | Published Zep results do not establish current OSS Graphiti or backend performance. |
| 2025 | [Mem0](https://arxiv.org/abs/2504.19413) | `reference-only` | Measure token/latency/quality with the same model and retrieval budget before adopting consolidation or graph augmentation. | Paper claims cannot be transferred to AttuneGraph or to a different open-source deployment. |
| 2025 | [Dynamic graph storage revisited](https://arxiv.org/abs/2502.10959) | `adopt` | Treat fine-grained per-edge versioning, CSR rebuild cost, and high-degree contention as falsification risks. | A new preprint is directional evidence, not a production result. |
| 2026 | [LongMemEval-V2](https://arxiv.org/abs/2605.12493) | `adopt` | Add context-gathering evaluation where large histories must yield compact, sufficient evidence for an agent. | High-latency coding-agent baselines show an accuracy/latency trade-off rather than a universal architecture. |
| 2026 | [Efficient Temporal Subgraph Management](https://www.vldb.org/pvldb/vol19/p1170-wen.pdf) | `reference-only` | Use its output-sensitive interval-index criteria when AttuneGraph has a matching window/subgraph workload. | Current decision queries are primarily point-validity over a bounded adjacency frontier, so direct adoption would overbuild. |

## Rejected shortcuts

- Do not replace SQLite because another engine reports higher raw TPS under a
  different durability, hardware, graph schema, or query contract.
- Do not adopt RocksDB or another LSM engine before sustained write throughput,
  lock wait, WAL/page write amplification, or compaction is the measured limit.
- Do not move the semantic kernel to Rust before one isolated TypeScript phase
  consumes more than half of an accepted end-to-end workload and a boundary-
  inclusive prototype improves it by at least 2x with byte-identical results,
  receipts, errors, and portable artifacts.
- Do not promote vector similarity, graph proximity, community summaries, or
  LLM-generated causal links into source truth, feedback, permission, or action
  authority.
- Do not keep both a full snapshot per generation and an unbounded normalized
  history indefinitely. Every retained representation needs a named query,
  recovery, or compatibility obligation.

## Measurement and replacement triggers

The next storage-layout prototype is accepted only if it keeps semantic output
and exact receipts byte-identical and measures all of:

- 10K, 100K, 1M, then 10M skewed corpora with fixed seeds;
- projection/admission latency and query p50/p95/p99;
- warm and cold SQLite open/read, worker lifecycle, and operation counts;
- pages read/written, WAL and journal growth, database bytes, peak RSS and heap;
- current-head and historical reconstruction work;
- corruption, stale-index, interrupted-build, and atomic-activation recovery;
- returned evidence bytes/tokens, truncation reason, and abstention correctness.

LadybugDB or CozoDB becomes a serious read-plane replacement candidate only if
the normalized SQLite prototype still misses an approved budget and the
alternative produces at least a 2x boundary-inclusive improvement on the same
host, corpus, durability posture, and semantic output. Replacement of SQLite as
the durable authority needs an additional proof of crash recovery, exact-head
CAS, portable rebuild, no-daemon clean-room consumption, and supported-package
lifecycle. Until then, a competitor may be an experimental derived read index
but not the source of truth.

## Current evidence and gaps

| Claim | State | Evidence or next requirement |
| --- | --- | --- |
| Removing the parent duplicate JSON detachment | `shipped` on baseline | Deterministic intrinsic part count and existing full gates on the landed revision. |
| Reusing a post-CAS prepared plan | `shipped` on baseline | Exact operation-count benchmark and byte-identical receipts on the landed revision. |
| Physical schema v2 compression | `verified-current` | Shipped in `d61a172` after independent evaluation; 17.18x representative payload density, 7.19x 313-row DB density, 101-sample p50/p95 gate, and separate 10K/100K/1M settled-size runs. |
| Normalized current-head index | `built-unverified query candidate` | Physical v3, atomic journal/head/index activation, structural store-open admission, explicit full Admin plus per-scope normalized validation, and crash recovery are built. A package-private endpoint and degree-sweep harness now show where normalized reconstruction can remove canonical decode work. No Engine/public fast path, full Working Graph result, 100K/1M query qualification, or latency claim exists. |
| Anchor+delta history | `roadmap` | Requires a workload-derived checkpoint policy, bounded reconstruction, exact replay, revocation propagation, and portable rebuild tests. |
| Ladybug/Cozo measured comparison | `verified-current 10K measurement lane` | Clean commit `35f87868` completed five isolated rotating trials for AttuneGraph v4, Ladybug 0.19.0, and Cozo 0.7.6 and verified all 313 adjacency/degree oracles. Native APIs and product semantics are not boundary-equivalent; 100K/1M, controlled cold-cache, equivalent durability, update/delete, and crash-recovery evidence remain missing. |
| Lower agent token cost or fewer errors | `evidence missing` | Same-model, same-budget LongMemEval-style and clean-room agent studies with exact evidence sufficiency and abstention. |

The reviewed papers and product docs support the direction, not a superiority
claim. AttuneGraph does not currently claim to be faster than a general graph
database, to exceed a readiness score, or to improve an agent until the named
reproducible gates pass.

## Competitor parity decision (2026-08-02)

The executable comparison decomposes “graph database performance” into two
atoms. The generic atom is native scope-local adjacency plus degree over one
10,000-edge oracle. The AttuneGraph-only atom is exact-head and assertion/source
witness reconstruction with digest proof. Combining them would hide the cost
of AttuneGraph's agent-native contract or credit a generic store with semantics
it does not provide, so the report forbids product ratios and labels both lanes.

The clean revision-bound 10K run shows SQLite is not the raw lookup bottleneck
at this corpus shape: v4 indexed adjacency and endpoint degree were materially
below one millisecond. Proof assembly and canonical reconstruction cost more,
while projection ingestion and settled bytes trail the lighter competitor
schemas. Proof-work reduction, write amplification, and representation density
therefore precede replacing SQLite solely for a 32-edge lookup. This is a
storage-primitive selection result, not product-equivalent evidence; the
replacement trigger above stays unchanged.

Native dependency installations remain under `benchmarks/competitor-parity/`
and never enter the runtime dependency graph or package bundle. The tarball
does intentionally publish the optional benchmark manifest, lockfile,
orchestrator, and child harness; `npm pack` reports no bundled dependencies or
native binaries. The harness binds source/lockfile/script hashes plus the full
generated AttuneGraph JavaScript runtime-closure digest, rotates order, isolates
processes/databases, and cleans validated temp roots. Gaps include controlled
cold cache, equivalent durability/checkpoint
posture, update/delete and recovery, larger corpora, and an end-to-end agent
result with identical temporal, provenance, authority, abstention, and receipt
semantics.

## Normalized endpoint algorithm decision (2026-08-02)

The query atom is not “a 100K graph.” It is one exact scope and one endpoint.
The current legal corpus shards 100K assertions into 3,125 scopes of at most
32 assertions because the canonical projection envelope remains 16 KiB. On
that shape SQLite 3.53 selected the `(index_id, assertion_ordinal)` primary key
instead of the subject/object indexes. A read-only forced-index prototype was
slower on both a one-edge endpoint and a 32-edge hub, so plan appearance is not
an optimization authority. The forced layout remains a conditional prototype
only if a future legal per-scope envelope establishes a different crossover.

The repository benchmark compares three byte-identical endpoint results on one
read-only connection: full canonical projection decode, strict normalized-row
reconstruction, and an adaptive measurement that allows eight candidates
before falling back to canonical decode. It sweeps endpoint degrees
1/2/4/8/12/16/24/32 in rotating measurement order. Development measurements
put the normalized/full p50 crossover near degree 16; this is a workload
observation, not a shipped threshold. Always-normalized is rejected because
dense source-ref reconstruction and reverse materialization cost more than one
small projection decode. Always-full also leaves a repeatable sparse advantage
unused.

The next candidate is therefore an exact-head-pinned sparse-to-dense reader:
read bounded endpoint buckets lazily, then reconstruct the full projection at
most once when cumulative work crosses an evidence-derived bound. It may ship
only after the same traversal, temporal eligibility, provenance, token bytes,
status, abstention, and receipt are byte-identical to the canonical path. The
current v3 manifest does not independently prove selected-bucket or selected
source-ref tail completeness and does not carry source freshness for an Engine
query. The primitive therefore reports `built-unverified`, and this slice
remains measurement-only rather than pretending that a partial fast path is
shipped.
