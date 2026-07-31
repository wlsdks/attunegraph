# AttuneGraph scale benchmark

The scale benchmark is a measurement harness, not a performance verdict. It
never prints a readiness score or PASS result. A separate evidence-gated
qualification process must define and approve thresholds before measurements
can support a readiness claim.

Retrieval correctness is measured separately by the checked-in
`attunegraph-working-graph-golden@1` corpus. Run
`pnpm verify:working-graph-golden` to verify exact ordered results for current
context, bitemporal exclusion, explicit opaque roots, source freshness,
token-budget partials, and true empty-result abstention. A perfect result is
limited to those deterministic cases and does not imply open-world relevance.

## Corpus contract

`attunegraph-benchmark-corpus@1` has three exact sizes: 10,000, 100,000, and
1,000,000 assertions. It is generated in memory and is never checked in as a
large fixture.

Every shard:

- contains at most 32 assertions, fixed by the corpus version rather than the
  machine being measured;
- stays below the Engine's canonical stored-projection text budget as well as
  the public 65,536-assertion append ceiling;
- submits `canonical-projection@2` with an explicit opaque `threadRoot` that is
  not `scope.threadId`;
- has one connected component: up to eight `Artifact LINKED_TO Thread` hot
  relations followed by one deterministic `Artifact REVISION_OF Artifact`
  cold chain;
- uses unique deterministic assertion and evidence IDs with no user data.

The exact shard counts are:

| Corpus | Shards | Final shard |
| ---: | ---: | ---: |
| 10,000 | 313 | 16 assertions |
| 100,000 | 3,125 | 32 assertions |
| 1,000,000 | 31,250 | 32 assertions |

The manifest records every shard's assertion count, serialized input bytes,
and SHA-256. The corpus SHA-256 is stable even when shards are generated in a
different order.

## Run it

Build and measure the dependency-free in-memory profile:

```sh
pnpm benchmark:scale -- --scale=10000 --profile=core \
  --warmups=1 --repetitions=5 \
  --output=/absolute/non-repository/evidence/core-10k.json
```

On a reviewed Linux/macOS filesystem with Node 24.15 or newer, measure the
worker-isolated SQLite profile:

```sh
pnpm benchmark:scale -- --scale=10000 --profile=local \
  --warmups=1 --repetitions=5 \
  --output=/absolute/non-repository/evidence/local-10k.json
```

Measure the separate single-worker, multi-scope session profile with the same
313-shard 10K corpus:

```sh
pnpm benchmark:scale -- --scale=10000 --profile=local-session \
  --warmups=1 --repetitions=5 \
  --output=/absolute/non-repository/evidence/local-session-10k.json
```

`local` remains the cold lifecycle measurement: it starts and stops a Worker
around each writer and reader. `local-session` starts one explicit session,
opens one scope-bound handle for each shard, and stops that single Worker only
after all 313 handles have closed. Neither profile is relabeled as the other.

`--scale` and `--profile` are required. Output is JSON on stdout unless an
output path is supplied. File output must be an absolute normalized path,
outside the repository, under a non-symlink directory, and must not already
exist; the file is created owner-only and never overwritten.

The real 10K lifecycle qualification and the 100K and 1M runs are deliberately
not part of the normal unit-test gate. Run the 10K proof with
`pnpm test:benchmark-qualification`; normal cross-platform tests retain the
deterministic parser, corpus, hashing, percentile, and fail-closed CLI checks.
They are long evidence activities and should run independently from editing or
unrelated verification.

## Evidence document

`attunegraph-scale-benchmark@1` binds:

- exact Git commit/tree, clean or dirty state, and lockfile SHA-256;
- Node, pnpm, SQLite, OS, architecture, CPU, and RAM;
- exact arguments, scale, profile, warmups, repetitions, concurrency, and
  monotonic clock;
- the full corpus manifest and hash;
- raw samples plus nearest-rank p50/p95/p99/max for open, projection, head,
  Working Graph, close, throughput, and lifecycle throughput;
- sampled RSS baseline/peak/final/delta and Working Graph terminal-status
  counts;
- SQLite reopen latency and database/WAL/shared-memory bytes for the local
  profile.
- SQLite session-open/session-close latency and database/WAL/shared-memory
  bytes for the local-session profile.

Every report currently sets `measurementOnly: true` and `claimEligible: false`,
including a clean run. This is intentional: one size/profile is not the full
90/100 qualification, and a dirty run is additionally revision-ineligible.
Partial and abstained Working Graph results remain explicit counts rather than
being silently treated as successful retrieval.
