# SQLite exact-witness current-head index v4

Status: built-unverified core candidate; no Engine or public-query fast path.
Last reviewed: 2026-08-02.

## Decision

Fresh local databases use physical schema v4 and
`normalized-current-head@2`. V4 keeps the v2 compressed journal and the v3
normalized current-head rows, and adds two kinds of derived evidence:

- every assertion row records the exact count and domain-separated digest of
  its ordered source-reference tail; and
- a narrow endpoint-degree table records raw incident activation-edge counts
  for deterministic sparse-versus-dense routing.

The manifest digest commits the complete ordered assertion metadata including
the source-reference witnesses. A package-private measurement reader returns
`complete` only after it has matched that exact assertion-set digest, checked
the endpoint routing row against the authenticated metadata, checked every
selected source-reference count/digest, reconstructed the selected assertions,
and reverse-materialized their canonical rows. It abstains on metadata,
candidate, or source-reference bounds. V3 remains explicitly
`built-unverified` because it has no assertion-local source-reference witness.

This is not a public Decision Context or Working Graph path. It does not change
AttuneQL, the Engine backend interface, receipts, `.atgx`, or Muse. New empty
databases write v4; v1, v2, and v3 databases continue to open and write their
exact existing profile without automatic migration.

## First-principles reduction

The first physical implementation strictly re-admitted every semantic field of
all 32 metadata rows before hashing them. Five 200-sample runs showed only
1.02-1.09x sparse p50 speedup over full canonical projection decode, and the
candidate was slower from degree 8 upward. That implementation was falsified.

The accepted candidate removes that redundant work. Before the digest matches,
it admits only the integers needed for bounds and arithmetic plus at most 1 MiB
of aggregate UTF-8 metadata needed for resource safety, then constructs the
fixed-order witness body. The code-unit check rejects an obviously oversized
field before UTF-8 traversal. A matching content digest authenticates the exact
unselected metadata bytes that the writer already admitted. Only selected rows
pay semantic instant, provenance, and canonical reconstruction cost. This does
not skip the proof; it uses the proof to avoid repeating the work the proof
already establishes.

Dense fallback initially ran the whole witness scan before discovering the
candidate bound, making fallback about 2x slower than full decode. V4 therefore
materializes a narrow endpoint-degree routing hint. The hint is never evidence
for a complete result:

- a high count may only cause an early abstention/fallback;
- a missing or low count must still agree with the fully authenticated metadata
  before `complete`; and
- Admin full verification independently rebuilds every expected endpoint count
  from assertion rows.

Prepared statement reuse removes repeated SQL compilation from this hot path.
It is scoped by the SQLite connection object and cannot cross databases or
heads.

## Complexity and bounds

For the current candidate, a sparse exact read is:

```text
O(current-scope assertion metadata + selected source refs)
```

with at most 64 metadata rows, 1 MiB aggregate metadata text, 128 selected
assertions, and 128 source refs per assertion under the package-private
measurement contract. The O(1) routing hint lets a known dense endpoint abstain
before the metadata proof. The row and byte bounds are deliberate: the live
canonical projection envelope is currently 16 KiB, so
10K assertions in one production scope cannot be constructed through the
public projection contract. This candidate is not a 10K/100K/1M single-scope
index claim.

An authenticated endpoint bucket tree could reduce a positive read toward
`O(raw degree + log buckets)`, but it would add bucket entries, tree nodes,
versioned digest bodies, rebuild logic, and migration/storage cost before a
legal live workload can exercise that scale. Fanout-32 Merkle buckets remain a
replacement candidate, not shipped functionality. Reconsider them only after
the projection envelope and a named workload justify the scale, and require
same-head canonical fallback for absent buckets.

## Measurement evidence

On the current dirty candidate, Apple M2 Max, Node 24.16.0, SQLite 3.53.0, the
existing measurement-only 32-assertion degree sweep was run five independent
times with 20 warmups and 200 samples per operation. After digest-gated
admission and prepared statement reuse:

- degree 1 adaptive p50 full-decode speedup was 2.60-2.75x;
- degree 8 adaptive p50 speedup was 1.29-1.32x; and
- degree 32 canonical fallback p50 overhead was about 4.8-6.0%.

These are local dirty-tree measurements, not revision-bound release evidence,
cross-host tails, a public fast-path result, or a competitor comparison. P95
was noisy across the five runs; no SLA or tail claim is made. The checked-in
benchmark remains `measurementOnly: true` and `claimEligible: false`.

V4 also writes one endpoint-degree row for each distinct activation endpoint.
`pnpm benchmark:v4-storage-cost -- --scale=10000` now captures a separate
v3-to-v4 paired contract without changing the historical v2-to-v3 report. It
records write, settled bytes/pages, physical rows, reopen, Admin full
integrity, and per-profile resource observations under exact semantic-byte
identity. It deliberately does not ratio RSS/heap, treat the production WAL
snapshot as cumulative write evidence, measure a query path, or compare a
competitor.

Five clean revision-bound 10K runs at `587ae7bf09e247c6a84d05fe74a496cc2a847f7d`
on Apple M2 Max, Node 24.16.0, and SQLite 3.53.0 preserved one exact semantic
aggregate. The median per-run v4/v3 ratios were 1.030 write duration, 1.213
settled bytes/pages, 1.493 physical rows, 1.053 reopen validation, and 1.833
Admin full integrity. The median absolute v3/v4 write durations were
1,384/1,422 ms and Admin durations were 253/468 ms. V4 wrote 10,313 endpoint
rows for 10,000 assertions in 313 scopes.

This is repeated clean evidence, but it still runs v3 before v4 on one host,
does not control thermal or OS page-cache state, and does not qualify tails,
query speed, or a public path. It exposes Admin full verification as the
largest measured v4 cost and cannot establish efficiency or a release
threshold. Alternating-order evidence is required before a timing claim;
cumulative WAL remains a separate controlled risk boundary.

## Integrity boundary

Compare-and-swap writes journal, head, manifest, assertions, source refs, and
endpoint-degree rows in one `BEGIN IMMEDIATE` transaction. Store open admits
the exact physical profile and head/journal/manifest structure. Admin full
verification additionally checks:

- contiguous assertion and source-reference ordinals;
- strict canonical assertion reconstruction;
- every assertion-local source-reference witness;
- the assertion-set digest;
- the exact endpoint-degree map; and
- orphan derived rows.

The hashes are deterministic coherence checks for a trusted local store, not
signatures against a coordinated writer that can rewrite rows and reseal
unkeyed hashes. The immutable compressed projection remains the canonical
fallback and portable source for rebuild.

## Promotion and rejection gates

Do not connect this reader to the Engine unless a separate source-changing
slice proves all of the following:

- exact current/exact-head pinning and source freshness in one Worker-owned
  SQLite read transaction;
- byte-identical Working Graph results and proof-closed receipts against the
  canonical path, including temporal decoys and all abstention reasons;
- no extra request or SQL on the existing warm prepared-cache hit;
- deterministic sparse/fallback selection from a versioned measured threshold;
- corruption faults never become `complete` or a silent fallback; and
- paired cold sparse benefit offsets write, page, reopen, and Admin costs.

Reject v4 as a read-path foundation if revision-bound paired evidence cannot
keep dense fallback within its declared budget, if sparse benefit disappears
at the public boundary, or if the extra physical rows are not justified by a
named agent workload. In that case retain v3/canonical decode and optimize
prepared-cache lifecycle instead of adding another index layer.
