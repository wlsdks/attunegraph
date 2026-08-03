# First-principles performance decisions

Status: accepted method; candidate states are evidence-gated.
Last reviewed: 2026-08-03.

## Decision

AttuneGraph optimizes the number and size of semantic parts required for one
bounded decision before it optimizes implementation language or publishes
wall-clock claims. A faster path is acceptable only when it returns the exact
same assertion bytes, temporal eligibility, ordering, refs, diagnostics,
terminal status, witnesses, and content-addressed receipt.

This document is an architecture audit, not measured speed evidence. The
candidate classifications below authorize investigation or rejection; they do
not claim latency, throughput, memory, or token improvement.

## Part-count method

For one fixed workload, count work at the public semantic boundary:

1. Store/head reads and full projection admissions.
2. Assertion records inspected, normalized, and temporally tested.
3. Endpoint keys and adjacency entries constructed or visited.
4. Full assertion JSON serializations and UTF-8 bytes accounted for tokens.
5. Result objects and arrays materialized.
6. Canonical receipt bodies serialized and content hashes computed.
7. Transport bytes encoded and parsed.
8. Admission descriptors inspected, assertions normalized, closure derived,
   and receipts resealed.

Count each part separately. Do not replace a missing count with elapsed time,
allocation intuition, source line count, or a profiler sample. Record the
input and output byte volumes beside the count so one large serialization is
not described as equivalent to one small ref comparison.

The preferred change removes a whole pass, materialization, or repeated byte
operation while preserving the public contract. A lower constant factor is a
measure-first hypothesis. A representation or persistence change also needs an
explicit format/version and compatibility decision.

Apply reductions in this order:

1. Challenge whether the part is required by a semantic or safety contract.
2. Delete a pass, copy, request, statement, scan, or retained representation
   when no contract requires it.
3. Combine adjacent parts only when their independent failure semantics remain
   observable and fail closed.
4. Precompute or change representation only after the deleted/combined design
   has been measured.
5. Accelerate the remaining isolated part, and automate the benchmark last.

This order deliberately treats proof closure, exact-head identity, temporal
eligibility, provenance, and explicit abstention as irreducible product parts.
Their current implementations may be simplified; their guarantees may not be
priced away.

## Candidate audit

| Candidate | Class | Part-count reason | Exact falsification boundary |
| --- | --- | --- | --- |
| Keep producer and admission Working Graph semantics in one internal module | `now` | Prevents two implementations of eligibility, refs, ordering, traversal, and exact token bytes while retaining independent producer and admission traversals | Reject the consolidation if producer golden anchors change, a transported producer result is not deep-exact after admission, or hostile/reminted results pass admission |
| Serialize each selected assertion once and accumulate exact JSON bytes | `now` | Removes repeated prefix serialization without changing the byte-defined estimator | Reject if any generated exact-budget boundary differs at the limit or one token below it, including multibyte refs |
| Build bounded endpoint adjacency once per prepared head | `now` | Replaces repeated whole-assertion filtering for each visited ref with one bounded index construction | Reject if any Working Graph semantic/golden anchor changes or a 1/4/32-seed cell visits or emits different refs/assertions |
| Reuse a prepared Working Graph plan only under exact-head equality | `now` | Avoids repeated full projection admission on an unchanged handle while retaining query-time temporal and budget work | Reject on any mixed-generation result, missed invalidation, changed temporal-boundary result, or extra cache authority |
| Fuse admission safe-JSON inspection with normalization | `measure-first` | Could remove one object-graph walk, but descriptor, proxy, alias, sparse-array, hidden-field, and malformed-Unicode rejection must remain exact | First add per-phase descriptor/normalization counters; reject if any hostile-input case changes or paired admission measurements do not isolate a consistent reduction |
| Reduce duplicate canonical receipt parsing, serialization, or hashing during admission | `measure-first` | The supplied receipt is canonicalized and the normalized result is independently resealed; a safe implementation may share immutable intermediate bytes | Reject unless receipt ID/canonical JSON remain exact for every remint test and paired `decision-query@1` admission/end-to-end evidence isolates fewer canonical byte passes without moving work outside the timer |
| Derive the selected Working Graph content ID without materializing an unused envelope | `verified-current` | The caller needs only the domain-separated digest. Reusing the same frozen-input inspection and canonical-body encoder removes two full-envelope encodes plus detached-tree freeze/reverification without changing the ID contract. | Reject on any content-ID, Working Graph golden anchor, hostile-input, Unicode, numeric, budget, result, or admission differential, or if alternating paired evidence does not improve the 32-witness end-to-end boundary. |
| Add package-private phase counters for decision-query production and admission | `measure-first` | Attribution is required before choosing another optimization; wall time alone cannot identify traversal, serialization, hashing, or transport | Reject the counter design if it changes public output, observes secret/source payloads, is unbounded, or cannot be recomputed from a deterministic fixture |
| Seed the prepared Working Graph plan from the already admitted projection after a successful CAS or exact replay/winner convergence | `now` | Deletes the first post-commit full projection read and repeat admission while retaining one exact-head check before every reuse | Reject on any mixed-generation cache use, missed epoch invalidation, or result/receipt byte drift; the deterministic part-count cell must remain at zero full reads for the seeded first query and one for the equivalent cold-handle query |
| Remove the SQLite parent backend's extra JSON stringify/parse detachment | `now` | Worker structured clone plus `parseWorkerResponse -> parseWorkerResult -> parseProjection` already descriptor-admit, rebuild, and deeply freeze a new parent-side projection, so the parent copy was one duplicate stringify/parse pass | Reject unless malformed-worker/protocol fail-stop, direct-backend mutation isolation, deep freezing, and Engine canonical Store admission remain exact; the deterministic intrinsic counter must retain the two protocol-size stringifications and remove exactly one stringify plus one parse |
| Add an optional atomic head-pinned projection read backend primitive | `measure-first` | SQLite can observe the current head and its journal row in one statement, potentially replacing two worker requests; generic backends can retain the retry fallback | Reject on any writer/reader interleaving divergence, changed snapshot conflict, or weakened current-head semantics; falsify if cold preparation does not fall from two requests to one |
| Replace indexed portable validation's per-projection lookup plus write with a conditional UPSERT | `measure-first` | One statement may encode new-scope generation one and exact next-generation advancement without changing the transaction boundary | Reject on any replay, generation-gap, interleaving, error-code, abort, or rollback difference; falsify if a 10K one-scope matrix does not reduce statement executions or improve the boundary by at least 15% |
| Lazily cache decision-code-unit-sorted adjacency buckets per prepared exact head | `measure-first` | Repeated queries currently copy and sort the same bounded bucket even though its head and comparator are immutable | Reject unless results and receipts are byte-identical and exact-head invalidation remains complete; falsify if warm comparator work does not approach zero, one-query latency regresses over 5%, or retained heap grows over 15% |
| Index temporal eligibility inside high-degree adjacency buckets | `measure-first` | One active edge can currently require inspecting many future, expired, post-recorded, or superseded neighbors, so work is not always proportional to the eligible bounded frontier | Reject on any half-open time-boundary, duplicate-reachability, ordering, truncation, or receipt difference; falsify if inspected candidates remain linear in inactive decoys or build cost is not amortized by 32 repeated queries |
| Carry an internal canonical-byte capability through portable encode/decode proof stages | `measure-first` | May fuse repeated nested projection inspect/encode/hash passes without trusting caller-owned bytes | Reject if store, record, state, or projection identities change, or if abort and transactional sink behavior diverge; falsify if isolated pass counts or peak subprocess memory do not fall by at least 10% |
| Persist normalized adjacency or token-byte metadata | `defer` | It may remove preparation work but introduces stored representation, invalidation, migration, corruption, and compatibility costs | Reconsider only after counters show preparation dominates an approved durable workload and a versioned format preserves byte-identical public results across reopen |
| Persist a normalized current-head decision index | `measure-first (v4 built-unverified; no public consumer)` | Physical v4 adds assertion-local source-ref witnesses, digest-gated admission, and a non-authoritative O(1) endpoint-degree routing hint. The routing hint can only abstain early; complete results still require the exact assertion-set and selected-tail proofs. Local dirty-tree measurements falsified strict re-admission of every metadata row, then observed a sparse win after deleting that redundant work, but no Worker/Engine/receipt or revision-bound storage qualification exists. | Before a public read path, prove one-transaction exact-head/source-freshness admission, full Working Graph/receipt byte identity, and bounded fallback. Reject the layer if public-boundary benefit does not offset v4 page/write/reopen/Admin cost. Authenticated fanout endpoint buckets remain a replacement candidate, not shipped functionality. |
| Increase the canonical projection envelope to reach the structural assertion cap | `defer` | Larger inputs change memory, hostile-input, transport, and portable-format risk; reaching a nominal cap is not itself user value | Reconsider only with a named live workload, explicit new limits, adversarial memory evidence, and unchanged fail-closed semantics |
| Move traversal, validation, or hashing to Rust/native code | `defer` | A language boundary adds packaging, ABI, cross-platform, and duplicate-semantics costs before a measured bottleneck exists | Reconsider only when clean paired evidence shows an accepted target is blocked by one isolated TypeScript part after boundary and transport costs are included |
| Admit only the receipt or trust claimed diagnostics, refs, witnesses, or estimated tokens | `reject` | It removes the evidence whose closure the admission boundary exists to verify | Any result/receipt drift, assertion-byte change, temporal remint, ref injection, or diagnostic forgery must continue to fail closed |
| Weaken exact token accounting, bitemporal checks, canonical ordering, or receipt resealing for speed | `reject` | These are decision semantics, not optional validation overhead | Any semantic differential is immediate falsification regardless of elapsed time |
| Use an unbounded cache, unbounded traversal, or proximity as truth/authority | `reject` | It violates bounded local adoption and evidence-before-proximity | Resource growth, stale reuse, or inferred permission is sufficient rejection; no speed result can override it |

`now` means the design belongs in the current bounded TypeScript engine and
must remain under semantic tests. `measure-first` means no implementation
should land before the named attribution evidence exists. `defer` requires the
stated trigger and a new design review. `reject` is outside the product
contract.

## Exact falsification benchmarks

### Transported decision-result admission

Use the production `decision-query@1` result, transport it through
`JSON.stringify` plus `JSON.parse`, and admit the full value through
`admitDecisionQueryResult`. The benchmark or test must fail unless:

- the admitted value deep-exactly matches the producer result;
- `receiptId`, `canonicalJson`, and receipt revision 2's domain-separated
  ordered assertion-content-plus-seed ID are unchanged;
- assertion and source witness counts, refs, terminal status, abstention and
  truncation reasons, and full assertion-byte token estimates converge;
- hostile JSON shapes and receipt/result drift remain rejected; and
- future-recorded, future-valid, expired, and superseded assertion remints
  remain rejected.

`attunegraph-agent-decision-read-benchmark@2` records producer, JSON transport,
admission, and independently rerun end-to-end boundaries separately. A
candidate is falsified if existing execute or decision-query semantic anchors
change. Timing samples remain measurement-only and claim-ineligible.

### Working Graph preparation and traversal

Use the checked-in Working Graph golden corpus and the 1/4/32-seed cells in
`agent-decision-read@1` and `agent-decision-read-scale@1`. Before accepting a
part-count reduction, require byte-identical projection, semantic, authority,
scope-isolation, output-byte, token, ref, visit, truncation, and terminal-state
anchors. Add counters for the exact part being removed; a wall-time change
without its corresponding count change does not validate the hypothesis.

`pnpm benchmark:prepared-plan-seed-parts` is the deterministic measurement-only
cell for `projectAgainstHead -> first exact-head decision-query@1`. It records
one full projection read plus one CAS for projection, then one `readHead` and
zero full projection reads for both the seeded first query and repeated query.
The equivalent cold-handle first query records one `readHead` plus one full
projection read. The harness fails unless cold, seeded, and repeated results
and receipts are byte-identical. These operation counts validate the deleted
part; they are not elapsed-time or speed evidence.

### SQLite parent read detachment

The narrow `local.test.ts` intrinsic-counter cell scopes `JSON.stringify` and
`JSON.parse` replacement to one parent-side direct SQLite backend read and
restores both intrinsics in `finally`. Before the deletion it observes three
parent stringifications and one parent parse. After deletion it requires two
stringifications and zero parses: the request and response protocol-envelope
size checks remain, while exactly one projection stringify/parse detachment is
gone. Worker transport still incurs structured-clone/protocol serialization;
this counter neither measures that work nor supports a latency claim.

The returned projection is not trusted as authoritative merely because it is
frozen. Worker response parsing has already reconstructed it through the
closed projection grammar, and the Engine remains the canonical Store
admission boundary before graph semantics use persisted state. Direct-backend
tests additionally require new object identities across reads, deep freezing,
mutation rejection, and unchanged bytes after the rejected mutation.

### Paired performance evidence

Only compare a candidate with its base using clean revision-bound artifacts,
the same host/runtime/lockfile/workload, alternating order, identical semantic
anchors, and the same timer boundary. State the candidate as unsupported when
the target phase is mixed/noisy, when an adjacent phase regresses enough to
erase the boundary reduction, or when the part counter does not move as
predicted. The existing qualification policy, tail-eligibility rules, and
independent calibration requirements still apply.

### Selected Working Graph content-ID specialization (2026-08-03)

Accepted as a bounded TypeScript optimization. The pre-change path called the
general frozen-unsigned envelope minter although `selectedWorkingGraphContentId`
discarded the envelope and retained only `contentId`. That path performed one
canonical-body encode, two full-envelope encodes, detached-tree freezing, and
full frozen-output traversal. The specialized package-private path preserves
the same frozen-input inspection, canonical-body ceiling, UTF-16 code-unit key
ordering, UTF-8 bytes, hash domain, NUL separator, SHA-256 digest, and ID prefix,
then returns the ID after the single required canonical-body encode.

The change does not alter a public export, schema, wire format, persistence
format, hash domain, receipt, or admission rule. It is not a shortcut for code
that needs canonical envelope bytes; those callers remain on the full minter.
The focused differential matrix covers nested values, unordered keys, Korean
and astral Unicode, hostile signed roots, negative zero, and the canonical-body
byte ceiling. Existing golden and transported-admission gates remain the
semantic authority.

Clean-revision paired evidence used Node 24.16.0 on an Apple M2 Max with two
warmups and ten repetitions per artifact. Three base/candidate pairs ran in
alternating order with exact anchors and admissions required in every artifact:

| `agent-decision-read@1` p50 median of three artifacts | Base `ecaa1e6` | Candidate `a7b7909` | Delta |
| --- | ---: | ---: | ---: |
| 32-witness producer | 1.435 ms | 0.910 ms | -36.6% |
| 32-witness admission | 2.283 ms | 1.739 ms | -23.8% |
| 32-witness end to end | 3.860 ms | 2.757 ms | -28.6% |
| 1-witness producer | 1.462 ms | 0.951 ms | -35.0% |
| 1-witness admission | 2.250 ms | 1.719 ms | -23.6% |
| 1-witness end to end | 3.796 ms | 2.699 ms | -28.9% |

Reproduction command for each clean revision:

```sh
pnpm benchmark:agent-decision-read -- \
  --workload=agent-decision-read@1 \
  --warmups=2 \
  --repetitions=10 \
  --output=/absolute/non-symlinked/path/result.json
```

These are local measurement-only medians, not cross-host tails or a competitor
claim. Ten repetitions do not qualify p95 or p99 under the repository policy.
The benchmark exercises the in-memory semantic reference path; it does not
measure SQLite open, worker lifecycle, journal growth, or durable recovery.

One narrower precursor was rejected and deleted. A package-private fast path
that avoided cloning an already frozen decision receipt passed focused tests,
but the critical 32-witness admission p50 changed from 2.218 ms to 2.225 ms
(+0.3%) and end to end regressed by about 0.7% in the paired artifact. It did
not remove the dominant proof-assembly parts and was not retained.

Research classification for this decision:

| Source or technique | Class | Consequence |
| --- | --- | --- |
| RFC 8785 JSON Canonicalization Scheme | `adopt` | Keep invariant JSON serialization, code-unit ordering, UTF-8 generation, and invalid-Unicode rejection; optimize around the canonical representation, not through a second encoding. |
| W3C Verifiable Credential Data Integrity 1.0 | `adopt` | Treat canonicalization correctness as an integrity boundary and choose the simplest transformation that satisfies the JSON-only security contract. |
| Zep/Graphiti temporal knowledge graph paper | `reference-only` | Temporal agent memory supports the product direction, but its published retrieval results do not justify changing AttuneGraph's proof-ID algorithm or claiming parity. |
| SQLite NGQP and plan-stability guidance | `reference-only` | Preserve the embedded storage direction and revision-bound plan evidence; it does not address this in-memory proof-assembly bottleneck. |
| Replace SQLite or add a graph server for this slice | `unnecessary` | The measured cost was above the storage boundary, so a storage-engine replacement would add deployment and semantic risk without removing the observed work. |

Primary sources: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html),
[W3C Data Integrity 1.0](https://www.w3.org/TR/vc-data-integrity/),
[Zep/Graphiti paper](https://arxiv.org/abs/2501.13956), and
[SQLite NGQP](https://www.sqlite.org/queryplanner-ng.html). The Zep benchmark
numbers are author-reported and not comparable to AttuneGraph's local semantic
boundary; no raw superiority claim is made from them.

## Current structural limit

Full-result admission defensively caps a Working Graph at 64 assertions and 65
returned refs. The current canonical projection envelope caps one stored
projection string at 16 KiB, while a valid assertion must carry its schema,
refs, epistemic class, source refs, recorded time, and derivation. The nominal
64-assertion/65-ref structural cap is therefore currently unreachable through
live projection. It is an input-safety ceiling, not a throughput, capacity, or
scale feature, and increasing the envelope is not an optimization by itself.

## Claim boundary

Part counts and these falsification tests can establish semantic equivalence
and attribute implementation work. They do not prove post-query live-head
currency, external source truth, action authority, a whole-agent token bound,
cross-host tails, production scale, or superiority over another system. See
[Benchmarks](../../BENCHMARKS.md) and
[Performance qualification](../../PERFORMANCE-QUALIFICATION.md) for the
revision-bound evidence rules.
