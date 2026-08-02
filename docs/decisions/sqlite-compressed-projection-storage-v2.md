# SQLite compressed projection storage v2

Status: shipped in `d61a172` (2026-08-02)

## Decision

Physical schema v2 introduced the compressed AttuneGraph journal. Each journal row
stores the exact canonical stored-projection JSON bytes using the dependency-free
Node built-in `deflateRaw` codec at level 1. The row binds:

- `projection_encoding = 'deflate-raw@1'`;
- the compressed BLOB and its `sha256:` fingerprint;
- the exact uncompressed UTF-8 byte length;
- the existing semantic `projection_fingerprint`.

Reads verify the compressed fingerprint before decoding, bound inflate output to
the declared uncompressed length, require the inflate engine to consume every
compressed byte, require the exact declared output length and exact UTF-8
roundtrip, then retain the existing canonical JSON, projection structure,
snapshot, commit and semantic fingerprint verification. Unknown encodings,
corruption, bombs, truncation and trailing bytes fail closed.

The physical compressed bound is 1,048,909 bytes, the conservative zlib
`deflateBound` for the existing 1,048,576-byte uncompressed capacity. Thus an
incompressible v1-admissible projection is not rejected merely because deflate
adds framing/block overhead.

## Compatibility and upgrade status

Physical schemas v1 and v2 remain supported exact legacy profiles. Opening one
selects only its declared statements and leaves its `user_version` unchanged.
There is no automatic migration or unbounded rewrite during open. New empty
databases now atomically bootstrap as v3; see
[SQLite normalized current-head index v3](sqlite-normalized-current-head-index-v3.md).
Unknown future versions still fail with `FUTURE_STORE_STATE`.

No public in-place or cross-file v1-to-v2 upgrade is shipped in this unit. The
portable format defines transport and validation semantics, but its public
export/rebuild application API remains future design; it is not a currently
supported upgrade path. Existing state therefore stays on its supported v1 or
v2 legacy read/write profile, while only new empty databases select v3. A public
upgrade workflow, atomic switch procedure, and end-to-end recovery evidence are
roadmap work and evidence missing.

This choice preserves journal history, head foreign keys, CAS transaction and
crash boundaries, admin classification, and exact replay within each physical
profile. It does not claim a shipped physical-profile migration or recovery
workflow.

## Qualification

Run on a reviewed local profile:

```sh
PATH=/path/to/node-24.15-or-newer/bin:$PATH \
  corepack pnpm benchmark:sqlite-compression-qualification

# Full bounded raw samples for external evidence capture:
PATH=/path/to/node-24.15-or-newer/bin:$PATH \
  corepack pnpm --silent benchmark:sqlite-compression-qualification -- --json \
  > /absolute/non-repository/evidence/sqlite-compression.json

# Reproduce the normal settled storage cells (10K and 100K):
PATH=/path/to/node-24.15-or-newer/bin:$PATH \
  corepack pnpm --silent benchmark:sqlite-compression-qualification -- \
  --scale-evidence=standard --json \
  > /absolute/non-repository/evidence/sqlite-compression-scale-standard.json

# Explicit opt-in long run, adding the separate 1M cell:
PATH=/path/to/node-24.15-or-newer/bin:$PATH \
  corepack pnpm --silent benchmark:sqlite-compression-qualification -- \
  --scale-evidence=all --json \
  > /absolute/non-repository/evidence/sqlite-compression-scale-all.json
```

The 2026-08-02 arm64 macOS run used Node 24.16.0, SQLite 3.53.0, zlib
1.3.1-e00f703, base commit `2d95f300fda5c066412fafc38f5e5f3f588bd500`,
tree `dc611c0c5f0cd7818763ca46f821c1470542e51f`, and an explicitly dirty candidate
worktree. On the real 32-assertion scale shard, 30,964 raw bytes became 1,802
bytes (17.18x). A 313-row SQLite density cell was 10,424,320 raw bytes versus
1,449,984 compressed bytes (7.19x).

The selected codec measured 27.96 microseconds compression p50 and 17.46
microseconds decompression p50. In the 101-sample same-corpus run, end-to-end
v2/v1 p50 ratios were 0.994 projection, 1.034 warm backend read, and 0.941 cold
reopen plus read; p95 ratios were 0.940, 1.048, and 0.955. The selected integration gate requires
p50 and p95 to remain at or below 1.20. The 101-sample nearest-rank p99 ratios
(0.881, 1.003, and 0.922) are retained as monitoring evidence rather than a gate.
The engine-admitted semantic-bound fixture was 16,373 of 16,384 canonical
projection bytes; it is not described as a near-1-MiB engine payload.

This is AttuneGraph-specific density and cost evidence. It does not claim
LadybugDB parity because the storage and journal semantics differ.

Separate one-repetition local-session scale runs retained exact semantics and
settled with WAL/SHM at zero: 10K used 1,597,440 database bytes (390 4-KiB
pages, 313 journal rows), 100K used 15,773,696 bytes (3,851 pages, 3,125 rows),
and the separately run 1M corpus used 157,450,240 bytes (38,440 pages, 31,250
rows). These are measurement-only single-run file observations, not latency or
tail claims. The opt-in qualification-harness path generated every checked-in
cell and binds its corpus seed/hash, exact args, observed time, dirty base
revision/tree, host/runtime, rows/pages/files, and a bounded SHA-256 provenance
record for the full underlying scale report. Missing or incoherent provenance
fails closed.

## Decision log

### 2026-08-02: preserve explicit physical-profile reads

The admin read-only Working Graph path must select its SQL statement from the
validated `user_version` returned by the read-only inspector. Physical v1 reads
the legacy TEXT column exactly; physical v2 reads the five declared compressed
projection fields and passes them through the shared bounded codec before the
existing semantic projection admission.

Column probing, exception-driven fallback, and opportunistic migration were
rejected. They can blur an unknown or corrupt store into a different profile,
make damage look like compatibility, and weaken the guarantee that a result is
bound to the exact physical schema already admitted by the inspector. A v2
payload with an unknown encoding, invalid length or hash, corrupt compressed
bytes, trailing input, invalid UTF-8, or mismatched semantic fingerprint remains
`CORRUPT_STORE`; it is never retried as v1.

This decision should be revisited only when a versioned public migration or
portable rebuild workflow is implemented. Such a workflow must still perform
an explicit source-profile admission and atomic target activation rather than
turning the ordinary read path into a heuristic migrator.
