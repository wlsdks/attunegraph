# SQLite normalized current-head index v3

Status: superseded for fresh databases by physical v4; retained as the exact v3
compatibility profile and historical decision. Not a migration or
query-performance result.
Last reviewed: 2026-08-02.

## Decision

This decision introduced physical schema v3 for new empty local SQLite
databases. Fresh databases now select v4; existing v3 databases continue to
open and write this exact profile without automatic migration. V3 retains the
v2 immutable compressed projection journal and exact-head CAS contract, and
adds a rebuildable normalized index for only the current head of each scope. No
public AttuneGraph method, Worker request, query path, or Engine fast path uses
v3 as a completeness-proven read path. It therefore makes no query-latency
claim.

One `BEGIN IMMEDIATE` transaction activates the compressed journal row, exact
head, exact-head manifest, and all current assertion and source-reference rows,
or none of them. Endpoint adjacency is inline in each assertion row and indexed
in both directions. Before head replacement it deletes that
scope's old derived rows in dependency order. A stale CAS writes nothing. A
crash before commit preserves the complete old state; a crash after commit but
before acknowledgement reopens to the complete, duplicate-free new state.

## Physical layout

The v3 journal columns, compression codec, payload hash, uncompressed byte
length, semantic fingerprint, uniqueness, and immutability are identical to v2.
The v3 head adds exact four-column uniqueness so the manifest can reference the
complete `(source, thread, generation, commit)` identity.

- `attunegraph_current_manifest` owns a storage-local `index_id`, scope,
  generation, commit,
  `projection_fingerprint`, `normalized-current-head@1`, exact child counts, and
  a domain-separated deterministic digest. Foreign keys bind it to both the
  current head and immutable journal row.
- `attunegraph_current_assertion` is keyed by `(index_id,
  assertion_ordinal)` and owns assertion ID, inline subject/object kind and ID,
  predicate, epistemic class,
  recorded/valid intervals, `supersededAt`, and derivation kind/version/run ID.
  Separate subject and object composite indexes are the future bidirectional
  bounded-frontier substrate; no current query uses them.
- `attunegraph_current_source_ref` repeats only `(index_id,
  assertion_ordinal, source_ref_ordinal)` before ordered namespace/ID/version
  provenance atoms.

The surrogate is physical ownership only. It is excluded from the manifest
digest and every portable or semantic identity.

Authority and invalidation are not invented as separate truth columns. They are
retained through predicates such as `AUTHORIZED_BY`, `GOVERNED_BY`,
`SUPERSEDES`, and `REVISION_OF`, endpoints, epistemic class, temporal fields,
and existing source/derivation atoms. Together with constant assertion schema
version 1, the normalized rows preserve every `GraphAssertion` field.
Deterministic reconstruction is strict-admitted and canonicalized in
GraphAssertion key order; focused tests prove byte identity with the original
canonical assertion JSON. The complete canonical projection remains in the v2
journal, so v3 stores neither a duplicate assertion BLOB nor a second raw hash.

## Integrity and compatibility

Store open verifies exact schema, foreign keys, `quick_check`, and the
head-to-journal-to-manifest structural identity in O(current scopes). It checks
missing/extra manifests and admitted count/digest metadata, but does not scan
assertion/source-ref rows or decode any compressed projection payload.

Admin `verifyIntegrity()` explicitly performs the full normalized-row scan:
strict assertion reconstruction, ordered source-reference equality, exact
counts, and a domain-separated digest recomputed from normalized rows. The
package-private per-scope verifier performs the same checks for one scope so a
future fast path can fail closed immediately before using that scope. Structural
drift is rejected at open and by Admin; row semantic, count, or digest drift is
rejected by Admin and the per-scope verifier. V3 is never retried as v2, and
versions greater than 3 remain `FUTURE_STORE_STATE`.

The digest is a deterministic coherence check, not tamper evidence. An attacker
who can rewrite normalized rows and recompute the unkeyed digest can create a
self-consistent derived index without changing the authoritative journal. This
slice gives the index no public-read authority: existing queries still decode
and validate the compressed journal, so corrupt unused derived rows cannot
produce an unsafe public result. A future index consumer must verify its exact
scope first and retain this trusted-local-store boundary or add a separately
justified content binding.

Physical v1 and v2 databases remain exact legacy profiles. They retain their
own statements and `user_version`; ordinary open never migrates, probes for v3
columns, or fallback-reads another profile. No public v1/v2-to-v3 migration or
portable rebuild application is shipped by this candidate.

## Measured materialization cost

The exact 10K values retained in this section are a historical non-claim. The
original dirty-candidate report omitted repository commit, HEAD tree, lockfile
SHA-256, dirty source-state identity, executed runtime identity, and report-body
identity. Therefore these numbers are not revision-bound evidence for the
current candidate. A current `@2` paired report is admissible only when each
strict-admitted child independently matches the parent-requested scale, the
parent-captured runtime, and the versioned official workload's expected
semantic aggregate. Equal forged children are not sufficient. Both children
must also match current content-addressed checkout provenance and runtime
artifact identity; an untracked symlink makes provenance capture fail closed.
The parent and each child recapture unchanged source/runtime identity before
and after execution, and the paired report-body SHA-256 verifies.

```sh
PATH=/path/to/node-24.15-or-newer/bin:$PATH \
  corepack pnpm benchmark:current-head-materialization -- --scale=10000
```

The harness supports `10000`, `100000`, and `1000000`; only 10K was run for
this candidate. V2 and v3 run in separate child processes. The report records
Node/SQLite/host/corpus identity and requires the official-scale semantic aggregate SHA
over scope, generation, commit, projection fingerprint, and canonical assertion
bytes after exact reads following every CAS.

The final harness binds a 27-file prepared runtime closure: the five direct
`dist/` roots imported by this benchmark plus recursive relative static
import/export dependencies and the Worker URL target. Its runtime aggregate is
`sha256:9299f6d3c350cd824574fb6719e668ad28175df686d01c891da99f6458f48d4f`.
The exact 10K corpus SHA-256 is
`2716fc73982702842d8eaa26aef36511ea174f6eccb5319aa08fbfbffc3f31aa` and
the semantic aggregate remains
`a64896a4375ab7aaa6fce8b94c825ddbc16aa5c5a16771e85a33e58c0d6fa0e4`.
The source-state and paired-report hashes remain run artifacts because editing
the source checkout or retaining different measurements must change them.

In the unbound 2026-08-02 Apple M2 Max / Node 24.16.0 / SQLite 3.53.0 dirty
candidate run, both profiles produced semantic aggregate
`a64896a4375ab7aaa6fce8b94c825ddbc16aa5c5a16771e85a33e58c0d6fa0e4`.
V2 used 389 settled pages and 1,593,344 database bytes; compact v3 used 1,375
pages and 5,632,000 bytes (3.535x). V3 materialized 20,939 final rows versus
v2's 626 (33.449x), or 2.094 physical rows per input assertion: 313 manifests,
10,000 assertions, and 10,000 source refs, plus the unchanged journal/head.
One fixed-order run observed 1,330.91 ms v2 versus 1,395.87 ms v3 project-write
duration (1.049x). Store reopen was 26.02 ms versus 38.64 ms (1.485x) after
separating structural admission from the explicit full scan. Admin full
integrity validation was 2.21 ms versus 206.28 ms (93.130x); that ratio has a
near-empty v2 baseline, while the absolute v3 time is the more useful warning.
These historical values are neither current materialization evidence nor
thresholds or query-latency qualification. If repeated by a revision-bound
report, the 3.535x settled-size ratio, 1.485x reopen ratio, and 206.28 ms
full-scan observation remain acceptance warnings.

Process lifetime max RSS was recorded separately from checkpoint heap:
151,896,064 versus 151,764,992 bytes max RSS for v2/v3; checkpoint main heap was
25,240,952 versus 26,747,464 bytes, and Worker checkpoint used heap was
21,183,520 versus 17,933,960 bytes. One run cannot classify memory efficiency.
Production WAL values are point-in-time snapshots, not cumulative write
amplification, because auto-checkpointing remains enabled. Such a claim requires
a separate `wal_autocheckpoint=0` controlled cell.

## Rejected alternatives and revisit triggers

- Repeating scope text on every assertion/source-ref leaf and materializing two
  endpoint rows per assertion were rejected after the first 10K prototype used
  8.923x settled bytes and 65.398x rows. The compact candidate uses one manifest
  surrogate, inline endpoints, and two lookup indexes instead.
- Retaining canonical assertion BLOBs in the compact layout was rejected after
  an intermediate 10K run still used 6.062x settled bytes. Normalized
  reconstruction reduced the candidate to 3.535x; 6.062x is not the final
  candidate result.
- Running full normalized reconstruction on every store open was rejected after
  an intermediate 10K run measured 237.41 ms v3 versus 25.33 ms v2 (9.372x).
  Store open now performs structural admission; the explicit Admin full scan
  and future per-scope use-before-read verification retain semantic checks.
- Persisting parsed authority, invalidation, or truth verdicts was rejected;
  those would create storage-owned semantics beyond `GraphAssertion`.
- Indexing every historical generation was rejected; immutable history remains
  in the compressed journal.
- Trigger-driven JSON extraction and exception-driven schema fallback were
  rejected because they blur admission and compatibility failures.
- A query/Worker/API fast path is deferred. Revisit it only in a separate slice
  with exact-head pinning, bounded page/row reads, byte-identical receipts and
  errors, stale invalidation, and paired query evidence.
- Compact integer dictionaries/postings are deferred until 100K/1M or skewed
  measurements show that text endpoints or page count justify another revision.
- Cumulative WAL claims require the controlled cell above. Any threshold needs
  independent evidence and is not inherited from the v2 compression gate.
