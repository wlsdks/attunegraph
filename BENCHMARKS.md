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

Compare a normal update that performs a caller `head()` followed by exact
`project({ expectedSnapshot })` with the additive one-operation
`projectAgainstHead` contract:

```sh
pnpm benchmark:scale -- --scale=10000 \
  --profile=local-session-update-comparison \
  --warmups=1 --repetitions=5 \
  --output=/absolute/non-repository/evidence/local-session-update-10k.json
```

The comparison creates two equivalent scope variants for every shard, seeds
both at generation 1, then measures an exact head-plus-project update on one
and a `projectAgainstHead` update on the other. A separate post-update head
read verifies the latter but is excluded from its operation latency. Reports
retain raw exact-project, caller-head, combined exact-update,
`projectAgainstHead`, seed, and verification-head samples. `speedup` is the
per-repetition ratio of total exact head-plus-project time to total
`projectAgainstHead` time. It remains measurement-only and is never a claim
about all workloads.

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
- Paired exact head-plus-project and `projectAgainstHead` update latency,
  throughput, seed/verification costs, and speedup for the update-comparison
  profile.

Every report currently sets `measurementOnly: true` and `claimEligible: false`,
including a clean run. This is intentional: one size/profile is not the full
90/100 qualification, and a dirty run is additionally revision-ineligible.
Partial and abstained Working Graph results remain explicit counts rather than
being silently treated as successful retrieval.

## External-project performance qualification profiles

`benchmark:performance` adds two reports without changing the measurement-only scale reports
above. `local-session-concurrent` uses a bounded caller Promise pool over one session, one Worker,
and one synchronous SQLite connection, plus an alternating AB/BA same-run sequential baseline on
a separate SQLite database. It measures single-session request pipelining, not independent SQLite
clients or writer contention. Exact reopen verification and new-versus-reused session-open
measurements remain explicit; OS page-cache state is uncontrolled. `portable` times the production
encoder, contiguous `.atgx` materialization, and production decoder separately while verifying
exact terminal convergence.

Process peak RSS comes from `process.resourceUsage().maxRSS` normalized to bytes and is combined
with phase-boundary RSS. Absolute p50/p95/p99 throughput and latency summaries are mandatory and
the qualifier derives ratios and throughputs again from raw samples. The checked-in policy has
absolute RSS ceilings but leaves absolute throughput/latency thresholds pending independent full-
matrix calibration. Until then it can establish evidence integrity and relative-policy status,
not performance qualification. See
[`PERFORMANCE-QUALIFICATION.md`](PERFORMANCE-QUALIFICATION.md) for the six-report matrix and
fail-closed qualifier contract.

## Agent decision-read workload

`agent-decision-read@1` retains the public `working-graph@1` execute lane and
adds a distinct public `decision-query@1` production, JSON transport, and
full-result admission lane on the `in-memory-semantic-reference` profile. It
is not a SQLite, custom-backend, hosted-service, or whole-agent benchmark and
it does not join the performance qualification matrix. Every report is
`measurementOnly: true` and `claimEligible: false`.

Run the fixed workload with evidence outside the repository:

```sh
pnpm benchmark:agent-decision-read -- \
  --workload=agent-decision-read@1 \
  --warmups=1 --repetitions=3 \
  --output=/absolute/non-repository/evidence/agent-decision-read.json
```

The workload creates a fresh isolated in-memory Store for every warmup and
measured repetition, projects each case through generation 8 with
`projectAgainstHead`, then measures the latest-head `execute` calls.
`executeMilliseconds` wraps only each Engine call and
`batchExecuteMilliseconds` is the sum of those per-seed durations.
`batchWallMilliseconds` covers the whole seed loop, including correctness
checks, hashing, serialization, and sample allocation. Preparation latency is
reported separately. The additive lane then queries the exact generation-8
head for the same seed, `asOf`, freshness requirement, and token budget. Its
timers separately wrap producer `graph.query`, JSON stringify-plus-parse,
`admitDecisionQueryResult`, and an independently executed
query-plus-transport-plus-admission path. The second producer run must be
byte-identical to the first. Admission must deep-exactly match the producer and
preserve `receiptId`, `canonicalJson`, and receipt revision 2's
`selectedWorkingGraphId` over normalized ordered assertions plus seed.

Six cases cover this exact matrix:

| Case | Scenario | Seeds | Execute outcome | Decision-query outcome |
| --- | --- | ---: | --- | --- |
| `wide-hot-complete-1` | 32 active hot edges | 1 | complete, fresh | complete |
| `wide-hot-token-partial-4` | 32 active hot edges | 4 | token-budget partial, fresh | token-budget partial |
| `wide-hot-complete-32` | 32 active hot edges | 32 | complete, fresh | complete |
| `deep-cold-complete-1` | bounded cold chain | 1 | complete, fresh | complete |
| `deep-cold-traversal-partial-4` | four over-depth cold chains | 4 | traversal-budget partial, stale | abstained, `source-not-fresh` |
| `deep-cold-valid-time-abstain-32` | expired, future, post-cutoff, and superseded edges | 32 | abstained, stale | abstained, `source-not-fresh` |

The 1/4/32 values are batches of independent single-seed Engine `execute`
calls. They are not one multi-seed query and do not claim the separate data-
store query seed ceiling. The latest generation contains 154 unique assertion
IDs across the six case heads. Preparation submits those case assertion sets
for all eight generations, so the report separately records 1,232 projected
assertion inputs; 154 must not be read as the total preparation work. The
report retains per-seed Engine latency, summed execute duration, whole-loop
wall time, considered/visited/emitted assertions, estimated tokens, maximum
depth, output bytes, status, freshness, truncation reasons, deterministic
semantic hashes, and exact generation/latest-commit invariants. The separate
decision-query fields retain producer, transport, admission, and end-to-end
latency; terminal status and abstention reason; receipt and transported-output
bytes; assertion and source witness counts; admission exactness; and a second
fixed semantic anchor. Repository
commit/tree/clean state, lockfile hash, host, Node, pnpm, arguments, and
workload hash bind the measurement configuration. Non-empty CLI arguments are
parsed again by the strict validator and must agree with the workload, warmup,
and repetition fields. An empty argument list denotes a programmatic run whose
validated options remain authoritative.

The revision-2 receipt wire intentionally changes every decision-query receipt
and transported-output byte anchor. The `@2` report constants bind those new
values; the original Working Graph execute anchors remain unchanged.

The `attunegraph-agent-decision-read-benchmark@2` report schema pins both
lanes' per-case semantic hashes, latest-head commit IDs, and non-timing
counter/output-byte samples while preserving the original execute fields and
anchors. A deliberate Engine semantic change therefore requires a new
workload version rather than silently rewriting the meaning of
`agent-decision-read@1`. `validateAgentDecisionReadReportSchema` checks that
fixed semantic contract and report self-consistency. It does not claim that
self-reported provenance is externally authoritative.
`verifyAgentDecisionReadReportAuthority` additionally requires caller-supplied
expected repository, host, and CLI configuration values. The CLI captures
the initial repository identity and host, uses them to construct the report,
then recaptures the repository identity after measurement. It requires exact
initial/end commit, tree, and lockfile equality through the authority verifier,
and both captures must be clean, before emitting evidence. Git commands and
the lockfile are bound to the canonical script package root, which must itself
be the Git top level; invoking the absolute script from another repository
cannot substitute that caller working directory's provenance.

The revision-bound benchmark and qualification scripts are included in the npm
tarball and every module boundary is import-smoked from a clean installation.
Golden-corpus and durable measurement tools execute directly from those packed
bytes. Authoritative scale, performance, and qualification evidence is
supported only from a source checkout because its provenance reads that exact
checkout's Git commit/tree/status and lockfile. Those commands fail with an
explicit source-checkout refusal under `node_modules`; they never borrow the
consumer repository's Git identity. The decision-read tools retain their
narrower import-only package contract and also require a source checkout for
execution. Importability is not evidence authority.

The CLI allows at most 10 independent fresh-Store repetitions. Consequently
p95 and p99 are `null`: the schema requires at least 20 and 100 independent
repetitions respectively. Thirty-two within-batch seed executions cannot
unlock tail eligibility. Per-seed p50 and raw distributions are workload
measurements only, not latency SLOs, production tails, or cross-machine claims.
Invalid, duplicate, unbounded, relative-output, in-repository, symlink-parent,
and overwrite configurations fail before evidence is written. On POSIX, a new
report is created with mode `0600`. Windows still uses exclusive creation and
refuses overwrite, but Node mode bits do not establish Windows ACLs; the host's
ACL policy governs access there.

The report binds its measurement exclusions as part of the exact schema. It
does not measure model inference or a host agent's total token use, and it does
not establish live head currency after the producer returns, external source
truth, permission or action authority, or competitor superiority. The
decision-query receipt remains evidence-only; admission proves closure of the
transported result, not any of those external properties.

## Offline performance regression verifier

`attunegraph-performance-regression@1` is a dependency-free, read-only
comparison contract for exact frozen base/candidate bundles. The CLI always
uses the packaged `performance-regression-policy.json`; a caller-selected
policy is rejected. The manifest must bind exactly five contiguous attempts
in `AB`, `BA`, `AB`, `BA`, `AB` order, the exact SHA-256 of every bundle and
the packaged policy, and expected base/candidate commit, tree, lockfile, and
package identities. Base and candidate commit, tree, and package SHA must each
differ. Every revision remains clean and fixed across its five measurements.

For each pair the verifier divides candidate latency by base latency, computes
candidate-minus-base milliseconds, then takes percentiles over those paired
values. p50 is eligible at five pairs, p95 at 40, and p99 at 200. The packaged
five-pair policy can therefore compute only p50. A dedicated hard threshold
must carry a prior approval plus both a maximum ratio and an absolute delta
floor; the structural policy result fails only when both are exceeded. Shared
GitHub latency is always advisory. Absolute RSS policy math checks both the
packaged byte ceiling and 50% of reported host memory.

```sh
# Qualification gate: current local evidence is unattested, so this exits nonzero.
pnpm performance:regression -- \
  --manifest=/absolute/evidence/performance-regression-manifest.json

# Explicit shared-runner structural/resource advisory gate only.
pnpm performance:regression:advisory -- \
  --manifest=/absolute/evidence/performance-regression-manifest.json
```

Both commands emit the same honest result. Offline evidence is always
`evidenceAuthority: "unattested"`, `claimEligible: false`,
`measurementOnly: true`, `latencyAuthoritative: false`,
`resourceAuthoritative: false`, `resourceQualified: false`, and
`regressionQualified: false`. `latencyPolicySatisfied` and
`resourcePolicySatisfied` expose recomputed policy math without upgrading its
authority. The default qualification command consequently exits 1. The
explicit advisory command exits 0 only for the packaged shared-GitHub class
when strict evidence integrity and the self-reported RSS policy both pass.

The current contract deliberately records the remaining limits instead of implying attestation:
the AB/BA plan and attempt ledger, artifact/output identities, host/runtime/
harness/corpus identities, and scalar RSS are self-reported. There is no
signature, append-only precommit service, dedicated-runner attestation, raw
process-tree RSS trace, or performance SLA. Those gaps keep qualification
closed even when all structural and policy calculations pass.

## Portable decoder framing hygiene evidence (2026-08-01)

This slice replaces per-byte `number[]` accumulation and `Uint8Array.from`
materialization with a bounded chunk-aware LF scanner and reusable segment
buffer. The caller chunk is still detached at `write` entry; removing that
whole-chunk copy would weaken caller-mutation safety. Captured `Uint8Array`
`indexOf`, `set`, `slice`, and `subarray` primordials keep the scanner
independent of later prototype mutation.

The valid baseline is main
`623d6cfe246af957d22c8a36e25765f936198723` on Node 24.15.0, Apple M2 Max
arm64 (12 CPUs, 64 GiB), under
`/private/tmp/attunegraph-portable-10k-valid.C7bYxI`. Its three fresh-process
10K portable reports used `--scale=10000 --profile=portable --concurrency=1
--warmups=1 --repetitions=1` and have SHA-256 values
`a8b33dc40f5c7fdce079292963eae67428069dc5c3c7ec1beb07af65eb749ab9`,
`ae9210015ac9041d0daad1b6212ca0ffda9a41b6a05f1552280dab032bb75f0f`,
and `4e4812e162e53fd5d93046ca82dc4a78d7a93995dd9bd1f29bfb89292944f229`.
The n=3 p50 was 1,367.788 ms preparation, 6,214.140 ms encode, 7,501.015
ms decode, 394,133,504 bytes peak RSS, and a 10,046,693-byte artifact. Decode
ranged from 7,458.643 to 7,881.862 ms. Earlier overlapped samples are invalid
and discarded.

A separate CPU profile report and `.cpuprofile` SHA-256 values are
`cd5a461792dcbe930fb72a19037f25184610fdb73888aedc6b7888450826c560`
and `dd0c61c857ecf845865d8a543caacc2accf00b29e83c0b9386eed1ff3f12aa58`.
Direct framing-loop self time was only 0.584% of the whole profile (1.17% of
decoder time); canonicalization descendants were 95.37% of decoder time and
92.8% of the whole profile. This makes the scanner an allocation and streaming
hygiene change, not a material speed claim.

One fresh-process post-change sanity report is retained at
`/private/tmp/attunegraph-decoder-sanity.VsbW5C/portable-10k-post.json`, SHA-256
`73d4eea11324b0ac51accca1bfdebbe3fee13afc2098a61549cc8c892c00193e`.
It is a dirty-tree, one-repetition `measurementOnly: true`,
`claimEligible: false` report produced with `--scale=10000 --profile=portable
--concurrency=1 --warmups=0 --repetitions=1`: 1,263.824 ms preparation,
6,057.446 ms encode,
7,468.571 ms decode, 311,279,616 bytes peak RSS, and the same 10,046,693-byte
artifact with exact 313-head/313-projection convergence. The baseline used one
warmup while this sanity run used none, so the approximately 0.43% lower decode
time is directional and non-comparable, not a paired estimate or speed claim.
It remained inside the baseline's observed range and shows no material
improvement. The single RSS sample is not a population claim. The next measured
optimization target is canonicalization and UTF-8 charging reuse, not further
scanner tuning.

## Canonical byte-length allocation evidence (2026-08-01)

This slice preserves canonical input-string UTF-16 validation and aggregate
UTF-8 charging, serialization, hashing, freezing, post-verification, portable
decoding, and admission. It changes only the `encodedBytes` helper used for
bounded error paths, ASCII contract-field checks, and canonical JSON
fragment/body-envelope limit accounting: a module-initialization capture of
Node `Buffer.byteLength` is invoked through the captured `Reflect.apply`,
replacing the allocating `TextEncoder.encode(value).byteLength` operation at
those call sites. Generated UTF-16, boundary, lone-surrogate precedence, exact
portable identity, budget, and primordial-poisoning tests pin the unchanged
contract.

Three sequential fresh-process post-change reports were captured from clean
commit `d3137c71c1bbc9f9d31a461439ae51226c473b80` with no competing benchmark
process. Each used Node 24.15.0 on the same Apple M2 Max arm64 host described
above and `--scale=10000 --profile=portable --concurrency=1 --warmups=1
--repetitions=1`. The reports are under
`/private/tmp/attunegraph-canonical-byte-length-post.J4OcMJ` and have SHA-256
values `6e1d3251e10196c5417a07757e2e0963407f56a6b0e8b9d58e344b7dcb45f137`,
`f3432b4813fbb882af1df21b3eb809a8f80adf7a4f760442416117ef7ea74c4e`,
and `20e600dab50c73e73b07251ecd4af7593e0d2d4485f2011456c805a816d7ec88`.

The n=3 post-change results were:

| Metric | Minimum | p50 | Maximum | Documented baseline p50 | Observed p50 reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Preparation | 551.404 ms | 552.686 ms | 571.989 ms | 1,367.788 ms | 59.6% |
| Encode | 2,353.889 ms | 2,356.128 ms | 2,357.096 ms | 6,214.140 ms | 62.1% |
| Decode | 2,776.374 ms | 2,785.210 ms | 2,792.046 ms | 7,501.015 ms | 62.9% |
| Peak RSS | 306,200,576 bytes | 328,761,344 bytes | 372,162,560 bytes | 394,133,504 bytes | 16.6% |

Every sample retained the exact 10,046,693-byte artifact and converged to 313
heads and 313 projections with `summaryMatches: true`. Every report remains
`measurementOnly: true` and `claimEligible: false`. The baseline is clean main
`623d6cfe246af957d22c8a36e25765f936198723`, while the post reports are the
clean commit above, so this is a controlled cross-revision observation, not a
paired exact-base attribution. Three repetitions cannot characterize p95/p99
tails, cross-machine behavior, or production workload variance.

### Fixed exact-base paired checkpoint

The later exact-base checkpoint froze both sides before measurement rather
than reading a mutable live `main` worktree. The base was clean commit
`33538c5de1d1fbebe2a01ffe6f7deec9dcb17580`, tree
`c8aa6879a942380cf6691ee77f8e12cedfdcceac`. The feature was clean docs commit
`2e2ed6de24f2d0efadcfcf1a37a3e2914ec64476`, tree
`35ed9c194c90aad8f9720347e8289ab4fd07e5d8`; its only changes after the code
commit `d3137c71c1bbc9f9d31a461439ae51226c473b80` were `BENCHMARKS.md` and
`CHANGELOG.md`. Both detached checkouts used the same lockfile SHA-256,
`c696e0cdde9b5e21ee598af9101b4611b5e60e4b75b14c5f5a36e47f8a6338c4`.

Five fresh-process pairs ran sequentially in the fixed order AB, BA, AB, BA,
AB with no competing benchmark process. Every process used Node 24.15.0 and
pnpm 10.18.0 on macOS arm64, Apple M2 Max, 12 logical CPUs, and
68,719,476,736 bytes of memory. Every report used
`--scale=10000 --profile=portable --concurrency=1 --warmups=1
--repetitions=1`. The deterministic corpus SHA-256 was
`d559ae4167c89b9b8ac782df5e493c17d4f6755dc6b0b8baebdb2a87984417e1`.

The table takes the median of the five base samples and five feature samples
for each side. The paired ratio and delta are calculated inside each adjacent
pair first and then take the median of those five values; they are not a ratio
or subtraction of the two side medians.

| Metric | Base median [range] | Feature median [range] | Paired feature/base median | Paired feature-base median |
| --- | ---: | ---: | ---: | ---: |
| Preparation | 1,326.803 ms [1,279.338, 1,347.445] | 535.779 ms [534.375, 541.705] | 0.4067 (59.33% lower) | -786.077 ms |
| Encode | 6,155.440 ms [6,077.802, 6,271.708] | 2,293.645 ms [2,273.935, 2,298.209] | 0.3727 (62.73% lower) | -3,861.222 ms |
| Decode | 7,438.446 ms [7,228.441, 7,506.205] | 2,719.524 ms [2,681.227, 2,769.952] | 0.3690 (63.10% lower) | -4,724.436 ms |
| Peak RSS | 390,791,168 bytes [352,731,136, 400,179,200] | 372,326,400 bytes [315,146,240, 372,916,224] | 0.9314 (6.86% lower) | -27,361,280 bytes |
| Artifact | 10,046,693 bytes [same for all samples] | 10,046,693 bytes [same for all samples] | 1.0000 | 0 bytes |

Every value in the table is recomputed from the hash-bound producer report
samples. All ten reports record `repository.clean: true`, retain the
exact 10,046,693-byte artifact, and converge to 313 decoded heads and 313
decoded projections with `summaryMatches: true`.

The ten report SHA-256 values are:

| Pair order | Base report SHA-256 | Feature report SHA-256 |
| --- | --- | --- |
| AB | `8e956b6e880f15d905626d9628c9cd19de3e3a2ff34967bc5d8ccc554dd3035b` | `60d3e6a6ecae55e298b845f66d8c3e50cc35fc70930a1d277540253d64643b6f` |
| BA | `8ecc6036bb9d920ef9be71fefc0d877e18ab73f441708297a65217adbb47ad1a` | `e68a60bd5ad7df21df730a5bd9409c21338dcd7c111e44e6d7dc308b595d31e0` |
| AB | `87708d3d11fe55459abb8ffb898cd23540e072c0b9b57e796b90ce0f139a2452` | `b82917b6051a936b6aa62d8656085acc4bc95da453d53e496740a3e8ce17985a` |
| BA | `f81e1aad86e6a036dce6c85f7baacb542fc991e802b495cae85ac5b68f8df702` | `d48a3b097a96029dca353db3ab2d78353c1eed3a59d8c9424992b0df78c03815` |
| AB | `1dd92440d08f9ff346fd7c9785558d748975444f7cfa388e21c892b97faf4a9c` | `83cfae132d010adff7f87146ab2671182694ee22a6dd21d530ce94ecbb91a8b5` |

An earlier attempt allowed the live base checkout to advance after the first
pair. Its later nominal base reports therefore bound commit
`5872b2a838eca2b719422897affdb6807e92ae46` and the feature tree rather than
the fixed base above. Those eight files are quarantined under
`/private/tmp/attunegraph-exact-base-attribution.GfB4ng/discarded-live-base-moved`
and are excluded from every value and report hash in this checkpoint.

Every included report remains `measurementOnly: true` and
`claimEligible: false`. Five pairs support this one-host paired median
observation only. They do not make p95 or p99 eligible and do not establish an
SLA, an absolute performance qualification, a production-workload result, or
a general macOS, arm64, Apple Silicon, or other-hardware claim.

## Durable agent decision-read tracer

`generation-churn-8x40@1` is the first durable public-API decision tracer. On
a reviewed Linux/macOS host with Node 24.15 or newer, run:

```sh
pnpm --silent benchmark:agent-decision-read-durable
```

It creates a private temporary SQLite database through
`@attunegraph/core/local`, projects eight generation-specific heads, and then
gracefully closes the Engine, session, and Worker. Every head has 16 active
assertions plus 24 temporal decoys: six expired, six future-valid, six recorded
after the decision cutoff, and six superseded. That is 320 projected assertion
inputs. The final canonical observation is measured against the Engine's fixed
15,500-byte envelope before the report is returned.

The tracer opens a new Worker in the same process and performs exactly one
`working-graph@1` decision read. It pins generation 8, the exact head commit,
ordered assertion and graph-reference IDs, source references, derivations,
freshness, diagnostics, and the complete public result before and after reopen.
Any divergence fails instead of emitting a report.

`reopenAfterGracefulCloseMilliseconds` and
`executeAfterReopenMilliseconds` are the only timed phases. Eight-generation
preparation and the pre-close reference read are excluded. OS page-cache state
is uncontrolled. The temporary database is deleted after output.

Every report is permanently `measurementOnly: true` and
`claimEligible: false`. This profile does not measure cold-disk start, process
restart, crash or power-loss recovery, multiple SQLite clients, writer
contention, 48/256 active assertions, 48 temporal decoys, long-run storage
growth, tail percentiles, or an SLA. It does not join the performance
qualification matrix yet.

## Four-session mixed durable tracer

`four-session-mixed-80r20w@1` is the first public-API multi-session SQLite
vertical. On a reviewed Linux/macOS host with Node 24.15 or newer, run:

```sh
pnpm --silent benchmark:agent-decision-mixed-durable
```

The command owns a mode-0700 temporary directory, rejects a pre-existing
database or DB/WAL/SHM sidecar, opens four independent public sessions and
Workers over one SQLite file, prints one JSON report, and removes the temporary
database after output. Each client uses a distinct scope and advances from
generation 1 to 6 with 16 active assertions plus 24 temporal decoys per head.
The standalone programmatic function instead receives one caller-owned new
absolute database path.

The timed window contains exactly 100 public agent data operations: an initial
four-write wave, 16 waves containing three reads and one rotating writer, then
eight four-read waves. This is 80 reads and 20 writes in aggregate only. It is
not a random, steady-state, or per-wave 80/20 workload. Four preparation writes,
four pre-close verification reads, and four reopen verification reads are
explicitly excluded, so the complete run performs 88 reads and 24 writes.
Report counts are recomputed from the operation ledger before emission.

Each operation records monotonic harness-task start and settlement offsets.
Four outstanding tasks means only four async workload tasks were active from
one Node main thread; it does not prove that four public-call promises or four
SQLite operations overlapped. The public API does not expose when SQLite work
overlaps, so the report does not claim concurrent DB execution, lock
contention, four processes, four machines, four users, or same-scope conflicts.
Operation timing includes workload construction, cloning, the public call, and
exact validation; mixed wall time also includes wave bookkeeping. It is not
pure SQLite or API latency.

Every read is compared with a complete expected `working-graph@1` result,
including the current commit, ordered assertions and refs, source provenance,
freshness timestamp, token estimate, and diagnostics. Generation-6 results are
also pinned to a fixed golden commit manifest before and after graceful
close and same-process new-Worker reopen. Existing-but-safe orphan sidecars are
rejected rather than admitted into a nominal fresh run.

DB, WAL, and shared-memory files are sampled with `lstat` only at settled phase
boundaries. The report distinguishes absent files from zero-byte files and
requires owner-only regular files. Values are logical lengths, not allocated
bytes or continuously observed peaks. Sequential public session closes trigger
the adapter's PASSIVE checkpoint attempt, but the public API exposes no result;
therefore checkpoint effectiveness, compaction, monotonic growth, retention,
true peak size, RSS, and leak slope are not claimed.

Reports remain `measurementOnly: true`, `claimEligible: false`, and
`unattested-local-process`. They record the runtime/host, harness and workload
hashes, but intentionally mark repository commit, tree, lockfile, and SQLite
version as unrecorded or unavailable. A single run is not throughput or latency
qualification, p95/p99 evidence, an SLA, a production/cross-host result, cold
disk/process restart, crash/power-loss recovery, or sustained-load evidence.
Those remain separate qualification work.

The same raw tracer can be admitted to readiness evidence only through
`pnpm readiness:capture-measurement`. That bounded producer binds one clean
AttuneGraph revision, an exact clean consumer gitlink subject, canonical cwd,
Node executable bytes, runtime identity, raw artifact hashes, and the
checked-out tracer hash. The scorer revalidates the complete 100-entry ledger
and semantic output. This is an unscored observation lane: success never
changes the eight readiness gates, fills the separate `concurrency` contract,
or creates a performance qualification.

## Worker resource lifecycle tracer

`worker-resource-lifecycle@1` is a bounded local diagnostic for the public
session/Worker lifecycle. On a reviewed Linux/macOS host with Node 24.15 or
newer, run:

```sh
pnpm --silent benchmark:worker-resource-lifecycle
```

The command owns a mode-0700 temporary directory, requires a new canonical
database path with no DB/WAL/SHM entry, prints at most 128 KiB of JSON, and
removes its database after output. The same tool is shipped in the npm tarball
and runs from a clean offline installation without a TypeScript compiler or a
source checkout.

One excluded preparation session writes generation 1 and verifies the fixed
16-active/8-expired result. Four measured cycles then open independent public
sessions and Workers over that prepared database and perform only `head()` plus
one `working-graph@1` read. Every cycle requires byte-exact head stability and
the same ordered semantic result. A graph-handle close is followed by another
Worker-isolate heap sample, proving the handle did not own the Worker; session
close then resolves only after the adapter's close acknowledgement and Worker
exit contract.

Memory scopes are deliberately separate. `wholeProcess` contains RSS and peak
RSS for the Node process, including any active Worker. `mainThread` contains
the non-RSS fields returned by `process.memoryUsage()` on the calling thread.
`workerHeap` comes from `Worker.getHeapStatistics()` for the active Worker V8
isolate. There is no post-session-close Worker sample because that Worker has
terminated. The report binds exact harness/workload hashes and runtime identity
but remains `unattested-local-process`, `measurementOnly: true`, and
`claimEligible: false`.

This diagnostic does not measure or infer per-Worker RSS, native SQLite total
allocation, forced-GC recovery, allocator fragmentation/release, OS page-cache
effects, leak slope, cold-process behavior, sustained load, production hosts,
latency/throughput qualification, tails, or an SLA. It is intentionally not a
readiness score input yet.

## SQLite generation-growth tracer

`attunegraph-sqlite-generation-growth@1` isolates the file-level effect of
bounded single-scope generation churn from the four-session mixed workload. On
a reviewed Linux/macOS host with Node 24.15 or newer, run:

```sh
pnpm --silent benchmark:sqlite-generation-growth
```

The command owns a mode-0700 temporary directory and refuses a non-canonical
path or any pre-existing DB/WAL/SHM entry. It uses one public writer session and
one later public verifier session. The writer commits 32 exact generations of
40 assertions each: 16 active and 24 expired. Fixed-width generation IDs keep
the six sampled observation envelopes at the same 13,957 JSON bytes. Samples
are taken after generations 1, 2, 4, 8, 16, and 32, then across pre-close
verification, handle close, session close, reopen verification, and verifier
close. The full report has exactly 15 ordered phase boundaries.

Every write uses `projectAgainstHead`; the pre-close and reopened Worker each
perform an exact `head()` plus `working-graph@1` decision read. Generation
sequence, unique commit identities, the fixed final commit, ordered decision
semantics, workload hash, two successful session-close resolutions, and reopen
equality fail closed before a report is emitted. The installed npm tool runs
without a source checkout or TypeScript compiler and its emitted JSON is capped
at 128 KiB. It is not part of readiness scoring.

File observations use `lstat` logical lengths for owner-only regular files at
settled harness boundaries. “Settled” means the awaited public operation has
resolved; it does not mean OS flush or page-cache settlement. Session close
success proves that the built-in PASSIVE checkpoint attempt returned a valid
row and that the connection and Worker terminated. The public API does not
expose `busy`, `log`, or `checkpointed`, and post-close size changes cannot be
attributed separately to the PASSIVE attempt versus final-connection close.

Reports remain `unattested-local-process`, `measurementOnly: true`, and
`claimEligible: false`. Raw logical sizes do not establish allocated disk
blocks, database page reuse, monotonic or production growth, checkpoint
effectiveness, compaction, retention fitness, leak slope, sustained operation,
tails, an SLA, or cross-host qualification.

## Agent decision-read active scale

`agent-decision-read-scale@1` is a separate, in-memory public
`working-graph@1` measurement workload. It fixes active scales at 16, 32, and
48 for focused resumption and thread frontier reads, plus unique single-seed
frontier batches of 1, 4, and 32. Each measured cold head is unprimed; each
warm head is separately rebuilt and receives one excluded prime. Every
repetition rebuilds both heads.

Run it only from a clean checkout and write evidence outside the repository:

```sh
pnpm benchmark:agent-decision-read-scale -- \
  --workload=agent-decision-read-scale@1 \
  --warmups=1 --repetitions=5 \
  --output=/absolute/non-repository/evidence/agent-decision-read-scale.json
```

The default cross-platform suite keeps a one-repetition smoke and every strict
schema/adversarial check. The real five-repetition p50 eligibility exercise is
kept in the slower qualification lane so it does not stall ordinary edit/test
loops:

```sh
pnpm test:benchmark-qualification
```

The command accepts only absolute, normalized, non-existing paths beneath a
non-symlink external directory. On POSIX it requests mode `0600`; on Windows,
Node's mode is not an ACL guarantee, so the containing directory's ACL remains
the security boundary. The evidence envelope binds the report to exact argv,
host identity, and one unchanged clean repository commit/tree/lockfile.

Reports separate public `working-graph@1` execute time from batch wall time,
projection preparation, and the excluded warm prime. They retain raw
cold/warm timings and only publish p50 at five or more independent repetitions;
p95 and p99 are always null (maximum ten repetitions). Process memory
checkpoints use bytes and are explicitly observational: they are neither
per-operation deltas nor resource qualification. Exact stored
`canonical-projection@2` output remains at or below 15,500 bytes and uses an
opaque thread root distinct from the scope key. Checked-in workload,
projection, semantic, and authority hashes force a workload-version bump on
drift instead of learning anchors from the first repetition. A compact
same-store authority sentinel records explicit `AUTHORIZED_BY` source
references, refuses to infer authority for a different governed action, and
proves that a stale, expired generation-two authorization abstains after its
head changes and that colliding refs cannot cross scopes.

Each cell labels its deterministic comparison-work proxy twice:
`assertionVisitedPairsPerRead` describes one seed read, while
`batchAssertionVisitedPairs` is the exact per-read value multiplied by the
batch size. The strict validator enforces that relationship so aggregate batch
latency cannot be compared accidentally with a single-read work count.

Every report is permanently `measurementOnly: true`, `claimEligible: false`,
`resourceAuthoritative: false`, and `resourceQualified: false`. The harness is
observational performance evidence only; it does not qualify resources or
grant an action any authority. Its active maximum is 48 assertions and 32
single-seed reads; larger scale claims belong to the separate revision-bound
10K/100K/1M harness.

### Head-pinned Working Graph plan contract (2026-08-01)

The Engine may reuse one prepared Working Graph plan per open handle only when
an optional Store Adapter exact-head read returns the same scope, generation,
and commit ID. The cached work is limited to semantically admitted activation
assertions, their exact JSON byte counts, and ordered endpoint adjacency. It
does not cache command time, active-at-time selection, seed traversal, token
budget decisions, diagnostics, or final results.

The deterministic acceptance surface requires:

- a cold handle performs one full projection admission plus one exact-head
  check, while a handle that just committed or exactly converged on a replay
  or CAS winner seeds that admitted projection and performs only the exact-head
  check on its first and repeated reads;
- a successful local write invalidates older local preparation before seeding
  the admitted commit, while a different handle's committed write forces the
  next execute to reload and rebuild exactly once;
- the same prepared head produces different correct results across validity
  boundaries and token budgets;
- a head that never matches the admitted projection retries once and returns
  `SNAPSHOT_CONFLICT` without a mixed-generation result;
- adapters without the optional capability preserve full-read behavior;
- every existing semantic, authority, projection, and workload anchor remains
  byte-identical.

Run `pnpm benchmark:prepared-plan-seed-parts` for the reproducible operation
counts. Its `attunegraph-prepared-plan-seed-part-count@1` report is permanently
measurement-only and claim-ineligible: it proves the seeded boundary removes
one full backend read relative to an equivalent cold handle, and it makes no
wall-clock speed claim.

The relevant performance cell is a batch of agent decisions against one
unchanged head. Cold and warm results are reported separately. A single-seed
speedup does not establish large-graph scalability, and a batch speedup does
not establish Neo4j superiority or inferiority. General database comparison
also requires equivalent semantics, durability, warm-up, process-tree memory,
and operational boundaries.

### Incremental Working Graph token-byte checkpoint (2026-08-01)

The Working Graph compiler previously serialized the complete candidate
assertion prefix again for every token-budget decision. The candidate retains
exact UTF-8 JSON byte accounting but serializes each usable assertion at most
once, accumulates selected assertion bytes, and accounts for commas, the seed,
and the fixed envelope incrementally. A generated boundary test pins every
one- through 48-assertion prefix, including multibyte source references, at
the exact token limit and one token below it.

The base was clean commit
`05f44c9aa6f0bf7105ef2493b5fecb0f96c89012`, tree
`cb35c79c9fe0b2540e14628cc5f34a3c97d96735`. The measured candidate source was
clean commit `3ae9baa1388889b6b6478ae44ee67cc1f95af157`, tree
`26072b523dcf16934f2ce8890a71167d3b151172`. Both used lockfile SHA-256
`c696e0cdde9b5e21ee598af9101b4611b5e60e4b75b14c5f5a36e47f8a6338c4`.

Five sequential fresh-process pairs ran in AB, BA, AB, BA, AB order after a
fresh build of each checkout. Each report used Node 22.22.0 and pnpm 10.18.0
on macOS arm64, Apple M2 Max, 12 logical CPUs, and 68,719,476,736 bytes of
memory with `--workload=agent-decision-read-scale@1 --warmups=1
--repetitions=5`. All ten strict evidence envelopes validate, bind the same
measurement/workload hashes, and retain byte-identical semantic, authority,
scope-isolation, work-count, and canonical projection anchors.

Each side value below is the median of the five report p50 values. Each paired
ratio divides candidate p50 by its adjacent base p50 first, then takes the
median of those five ratios; it is not a ratio of the side medians.

| Cell | Base cold p50 median | Candidate cold p50 median | Paired cold ratio | Paired warm ratio |
| --- | ---: | ---: | ---: | ---: |
| `focused-resumption-16` | 1.603 ms | 1.598 ms | 1.0274 | 1.0241 |
| `focused-resumption-32` | 3.047 ms | 3.025 ms | 0.9991 | 1.0461 |
| `focused-resumption-48` | 4.499 ms | 4.448 ms | 0.9947 | 1.0079 |
| `thread-frontier-16` | 1.685 ms | 1.631 ms | 0.9683 | 0.9528 |
| `thread-frontier-32` | 3.476 ms | 3.222 ms | 0.9273 | 0.9331 |
| `thread-frontier-48` | 5.414 ms | 4.810 ms | 0.8892 | 0.9052 |
| `thread-frontier-48-batch-1` | 5.570 ms | 4.815 ms | 0.8553 | 0.8785 |
| `thread-frontier-48-batch-4` | 21.730 ms | 19.158 ms | 0.8895 | 0.8870 |
| `thread-frontier-48-batch-32` | 179.985 ms | 153.920 ms | 0.8645 | 0.8718 |

All five cold pair ratios were below 1.0 for frontier 32, frontier 48, and the
three frontier-48 batch cells. Their paired median reductions were 7.3% to
14.5% cold and 6.7% to 12.8% warm. Focused-resumption ratios remained near
1.0 and include small regressions as well as small improvements, so this
checkpoint makes no focused-read speed claim.

The ten evidence SHA-256 values are:

| Pair order | Base report SHA-256 | Candidate report SHA-256 |
| --- | --- | --- |
| AB | `28d97eceb5c281016956e356ed8267b1d53f6ac2ee01e8dcb45e7f676db03494` | `1793bb3b6e43a8add4492b70be458188247b77b1777183685dae2b921e7b46dd` |
| BA | `cb9f09ee2d77c25ba7fa37bd7224a563e20dd413336414da27c93480fc503b97` | `8ac95226dd5ea8427ac2d45f0ab6a117f3705937473c9157107284e7bdbb9f4a` |
| AB | `4e17b29e7923775b044e9326e3d259b441dd4e229ba65095653a3a62f76b7ff9` | `46370cf986538da4c3afdce42d6ee27a2e61039f1e6aa9b1649349502f923570` |
| BA | `4668c5d15f57610ff8e6c37a885f0d8a771c7c63f5ac88d4f9cb11c060ef1d77` | `384a6363d4e1bbb9b660564163f1c2ce22fc72dadbca5da38c5c722fbd4c9c33` |
| AB | `a5874b0cfcbbd064a41143c1089972c5fc4661b3844f3cc31669a2ee1c0db59c` | `3ec493e53f069e09ed9329ff6845301c0748ab18f85d1a996df1f759f62f3860` |

An earlier direct-Node attempt is excluded because the base checkout's ignored
`dist/` did not match its source revision. Rebuilding both sides before the
paired run removed that attribution error. This also records a second harness-revision
requirement: authoritative performance evidence must bind built runtime bytes,
not only source revision and lockfile identity.

A separate candidate CPU profile report and `.cpuprofile` have SHA-256 values
`33b82a439f101071979b7932ef40c8e2ad2777331078520c11f8d3ce7684f7a0`
and `62670ced50292b1682e61cdec5226f72b76e1cc654ac9e0d84146eb975a6c9d0`.
The old `estimateTokens` frame is absent; replacement `jsonBytes` accounts for
24.833 ms self time, and `estimateWorkingGraphTokens` is unsampled. A baseline
profile from ancestor `f093276ea58bf4fff612349c607d2c0ba9d5de4a` has report
and profile hashes
`fa7b8266000a0ca46cc8781a56694606597517eb104f2d121483c3f0373ab44d`
and `38d9741daec69749d6aba3e58d5995682ae334c0b5c73192f011b964a7aa096c`.
Its Engine source is byte-identical to the exact paired base, but its harness
predates the per-read/aggregate work-count naming fix, so this non-interleaved
profile comparison is hotspot-shape evidence only, not another speedup claim.
The next measured Engine-local target is repeated `graphRefKey`; full-read time
is still dominated by stored-projection validation and canonical-envelope
passes.

Every report remains `measurementOnly: true` and `claimEligible: false`. Five
pairs on one host support this bounded hot-path observation only; they do not
establish p95/p99 tails, a production SLA, cross-machine behavior, or a general
graph-database performance claim.

The separate profiled report and `.cpuprofile` have SHA-256 values
`2c6fbac01e8a416cc2959ce1dbabf840a40c7767d315cc7a0c78560e8f642927`
and `7bef59dcb65f09676ac5bc6316445807fdde0b43bcdc850edf75b46bc58b0cc2`.
Using the same ancestor-inclusive analysis as the decoder evidence,
canonical-envelope descendants occupied 84.07% of the 11,911.042 ms profile,
down from 92.8% in the documented baseline profile. The new byte-length path
had 1.02% direct `node:buffer` self time. Samples below `encodedBytes` call-tree
roots accounted for 13.37% ancestor-inclusive time; this deliberately excludes
unrelated `Buffer.byteLength` ancestry outside the canonical module. No frame
named `TextEncoder` appeared, and garbage collection had 1.02% self time. The
hottest direct frames are now canonical traversal `visit` (23.68%),
`sortedRecordKeys` (7.38%), `boundedPath` (7.33%), and `inspectValue` (5.49%).
That makes traversal, key sorting, and path construction the next measured
canonicalization targets; they are deliberately outside this slice.

### Post-freeze canonical verification checkpoint (2026-08-01)

Canonical-envelope admission previously encoded and hashed the unsigned body,
encoded the complete signed envelope, froze and recursively verified the
detached result, and then repeated both encodes and the SHA-256 calculation.
The candidate retains the initial unsigned encode and domain-separated digest,
deep frozen-output inspection, an exact frozen content-ID check, and an exact
byte-for-byte complete-envelope re-encode. It removes only the second unsigned
encode and digest: if the complete signed envelope and its unique content-ID
field are unchanged, the same envelope with that field omitted is necessarily
unchanged as well.

The base was clean commit
`2b238d8032b602e20555992e10eb7584e4ba0f6d`, tree
`fbd8723820fe39f9d75fa75e17c1b405148b3ee5`. The candidate source was clean
commit `026c83c824c4d31ad5d1f5676746588d4e0bba42`, tree
`a47808290e5fc18a9c592504c8a51a2d54017657`. Both used lockfile SHA-256
`c696e0cdde9b5e21ee598af9101b4611b5e60e4b75b14c5f5a36e47f8a6338c4`.

Five fresh-process pairs ran in AB, BA, AB, BA, AB order after rebuilding both
checkouts. All reports used Node 22.22.0 and pnpm 10.18.0 on macOS arm64,
Apple M2 Max, 12 logical CPUs, and 68,719,476,736 bytes of memory with
`--workload=agent-decision-read-scale@1 --warmups=1 --repetitions=5`. The ten
reports bind the same workload, authority sentinel, per-cell semantic,
canonical-projection, scope-isolation, assertion-count, and work anchors.

Each percentage is the median of five adjacent candidate-versus-base p50
reductions, calculated inside each pair before taking the median.

| Cell | Paired cold median reduction | Paired warm median reduction |
| --- | ---: | ---: |
| `focused-resumption-16` | 8.5% | 8.4% |
| `focused-resumption-32` | 9.3% | 7.8% |
| `focused-resumption-48` | 13.9% | 14.7% |
| `thread-frontier-16` | 8.9% | 9.1% |
| `thread-frontier-32` | 11.2% | 11.4% |
| `thread-frontier-48` | 10.3% | 9.1% |
| `thread-frontier-48-batch-1` | 9.8% | 11.2% |
| `thread-frontier-48-batch-4` | 8.8% | 9.0% |
| `thread-frontier-48-batch-32` | 10.7% | 9.2% |

One of the five `focused-resumption-16` cold pairs regressed by 6.6%; the other
four improved. The table reports paired medians rather than hiding that noise.
The evidence SHA-256 values are:

| Pair order | Base report SHA-256 | Candidate report SHA-256 |
| --- | --- | --- |
| AB | `80ee0dc037e44da1b77a7a17bc8b000072ab056a87e43162d4c9a8bd27b7957c` | `44d911c88ef7986085e25bde77be70253a61666ea732aaacee83583ae9d9ee0f` |
| BA | `bda887ba0ce0507fdf9ecc3addadf47f9f8ca5e407784708c0d6b7c598b93441` | `7316553be52cf0ad4b149f01d7bd9e9fb6530f5faa9ff713934fd51c0163c4f5` |
| AB | `0d2d255d3c0800fa14d146bc8c25fb47341288d0f7183e500bc99e00f472536b` | `57b1168136854fa9f205157a2b80e9a494db0c3ca9d644cf7999dbab70416c58` |
| BA | `78ec25459d8a0523c2bd18b81feb6ddf65c67eb56e6f6696c7047db5249807e3` | `efb7752559d61cd82998e0aa6bf6f2704e0401d1c6b04753d259c6e43e728a95` |
| AB | `3b76ecfefc9c0452e02909787f8495c0598e1ecb302bd9e2cda52a94e50de4e9` | `792e93fe7552e266dd185908fe8c7a1aad119f76150191223c30f0379edaa364` |

Every report remains `measurementOnly: true` and `claimEligible: false`. This
checkpoint supports a bounded hot-path observation on one host. It does not
establish p95/p99 tails, a production SLA, cross-machine behavior, or a general
graph-database performance claim.

### Working Graph adjacency checkpoint (2026-08-01)

The Working Graph compiler previously filtered the complete validated active
assertion array for every visited ref. The candidate builds one execute-local
adjacency index from that same sorted array, registers each admitted assertion
under both distinct endpoint keys, and performs direct lookups during traversal.
The index is discarded after the decision read. Store re-admission, canonical
verification, temporal filtering, ordering, token and traversal budgets,
diagnostics, provenance, authority non-inference, and abstention remain on the
same paths. A regression test pins bidirectional endpoint lookup without
double-counting one edge.

The base was clean commit
`ac0c725ce053fd7c71f4d8c494371567d1416f74`, tree
`4c4caa4855168d8eefca966532c1748a37ed9bdc`. The candidate source was clean
commit `83042dcdcfdce909dcc24d60728ca1deded1e641`, tree
`abe689b6698695a2a7d2d56e9d1f995809d52be6`. Both used lockfile SHA-256
`c696e0cdde9b5e21ee598af9101b4611b5e60e4b75b14c5f5a36e47f8a6338c4`.

Five fresh-process pairs ran in AB, BA, AB, BA, AB order after the benchmark
rebuilt each checkout. All reports used Node 22.22.0 and pnpm 10.18.0 on macOS
arm64, Apple M2 Max, 12 logical CPUs, and 68,719,476,736 bytes of memory with
`--workload=agent-decision-read-scale@1 --warmups=1 --repetitions=5`. Every
workload, authority sentinel, semantic, canonical-projection, scope-isolation,
assertion-count, and work anchor matched exactly.

Each percentage is the median of five adjacent candidate-versus-base p50
reductions, calculated inside each pair before taking the median.

| Cell | Paired cold median reduction | Paired warm median reduction |
| --- | ---: | ---: |
| `focused-resumption-16` | 2.1% | 2.2% |
| `focused-resumption-32` | -1.5% | -0.1% |
| `focused-resumption-48` | 2.2% | 0.3% |
| `thread-frontier-16` | 0.8% | 3.5% |
| `thread-frontier-32` | 4.4% | 0.7% |
| `thread-frontier-48` | 9.5% | 9.8% |
| `thread-frontier-48-batch-1` | 6.6% | 6.8% |
| `thread-frontier-48-batch-4` | 9.6% | 6.4% |
| `thread-frontier-48-batch-32` | 8.0% | 9.1% |

Every one of the five `thread-frontier-48` pairs improved in both phases. The
focused cells remain near noise and this checkpoint makes no focused-read speed
claim: individual pairs included a 6.7% cold and 7.1% warm regression in
`focused-resumption-48`, while their paired medians remained close to neutral.

The evidence SHA-256 values are:

| Pair order | Base report SHA-256 | Candidate report SHA-256 |
| --- | --- | --- |
| AB | `12d099351d459211f991ac6edc432e1cf676521e44e49c7212e8af74cdca3765` | `aebdbdeab71e5deb7d74f6facbf21c779dc4c66477ad61e2995d870a2872b3eb` |
| BA | `b06fe7d7d5201b88f58c0040635fd17f2e2535cf46f1f1d973114e56a95eb92c` | `ab6b71086c5893b486e1b1107c41f418348541eb98f82361eaef6161e458e24b` |
| AB | `e1bf1f11ae93c57cdbbb6930e95f59b1bc7244821592a7c9dc547e05f03352b6` | `05ee4893f7c6d17991bf275398503dc5c13332bcbc1e42408e6c3ce6aabfd4ba` |
| BA | `8e16283ae2db7464b4319bcd3629cd1488d639851aeb1793c0ebb01651e2e8a7` | `1d4800deb0f3f7588039504e4e955ccf238ebd2bfdaf2b45426a0ca19f741419` |
| AB | `f4a5509215e98aa81fb972fcad7473b4689e8dfa2ed2d3c32454cea93dbf623f` | `235af0c3e9e71945654edd6a91a6f56e662d7596c4823d905fe636d4da0a6b89` |

Every report remains `measurementOnly: true` and `claimEligible: false`. This
checkpoint supports a bounded one-host frontier hot-path observation only. It
does not establish p95/p99 tails, a production SLA, cross-machine behavior,
SQLite/backend performance, or a general graph-database performance claim.

### Portable decoder admission checkpoint (2026-08-01)

The portable decoder already detached, canonicalized, hashed, and deeply froze
each projection record before exact Engine admission. The old admission path
then independently canonicalized the nested stored projection multiple more
times to recover the same store identity. The candidate passes the first
canonicalizer's immutable result into semantic normalization, re-mints the
normalized projection once, and exact-matches its content ID, canonical JSON,
and byte length before returning the identity. It retains the independent
stored-projection content hash, canonical observation and assertion checks,
wire bytes, ordering, budgets, typed corruption behavior, sink reentry and
abort semantics, and exact terminal convergence.

The base was clean commit
`5b0e63923215a929d2d401670cad1ada78f48ed5`, tree
`ef40d3b9d37841a86984bea856bb79fc43531f1c`. The candidate source was clean
commit `c028ca7974d6a41d75e4f1e3622d4e64d25939ed`, tree
`f4b2dd129831128aed1c8ae790d0fd0b133b1fc4`. Both used lockfile SHA-256
`c696e0cdde9b5e21ee598af9101b4611b5e60e4b75b14c5f5a36e47f8a6338c4`.

Five fresh-process pairs ran in AB, BA, AB, BA, AB order. All reports used
Node 24.16.0 and pnpm 10.18.0 on macOS arm64, Apple M2 Max, 12 logical CPUs,
and 68,719,476,736 bytes of memory with `--scale=10000 --profile=portable
--concurrency=1 --warmups=1 --repetitions=3`. Every report bound the same
10,000-assertion, 313-shard corpus and 10,046,693-byte artifact. All 30 measured
decodes produced exactly 313 projections, 313 heads, and a matching summary.

Each percentage is the median of five adjacent candidate-versus-base p50
changes, calculated inside each pair before taking the median.

| Metric | Median report p50, base | Median report p50, candidate | Paired median change |
| --- | ---: | ---: | ---: |
| Decode latency | 2,366.14 ms | 1,660.82 ms | 29.89% reduction |
| Decode throughput | 4,226.29 assertions/s | 6,021.11 assertions/s | 42.64% increase |
| Encode latency | 1,990.95 ms | 1,986.81 ms | 0.33% regression |
| Process high-water RSS | 346.7 MiB | 326.8 MiB | 3.36% regression |

The last column is calculated within each adjacent pair before taking its
median, so it is not the ratio of the two independently listed report-p50
medians.

Every pair improved decode latency by 28.85% to 31.66% and throughput by
40.56% to 46.32%. Encode remained near noise. RSS is not classifiable: its
paired median says the candidate was 3.36% higher, while the independently
listed report-p50 medians point in the opposite direction. Observed maxima were
358.9 MiB for the base and 359.0 MiB for the candidate, and the candidate
sequence did not rise monotonically. A process-lifetime high-water mark is not
a heap, interval-allocation, or leak measurement, so this checkpoint makes no
memory-efficiency claim.

The evidence SHA-256 values are:

| Pair order | Base report SHA-256 | Candidate report SHA-256 |
| --- | --- | --- |
| AB | `d4a44365738770cc59dbe93c5855abcac33316b5fbdba7b2d0444568daa01147` | `7a83d0c87905d54dfee176306f99d9aba53fef2d7de6cf03fa62a25440506667` |
| BA | `738fefbd5a596f618df9248147ac30c63c2eaf14874a37f5130c342f800f55d9` | `57ab38336cde48014e79bbb299dd6ab195707ba46afd959f0581a39c054e2165` |
| AB | `641ef72171698426ee1212a9ddcc5c311076e683c6be334d4ce3269dd82a26bf` | `e588f7faa4dd5c458ba3207b4c5b0ea0de762c6454e32766b29c7f4d5ffaf253` |
| BA | `f7b42c479b3d68d75420d5ae217eeb1548cd7b38ae216a2101675b20c805dfc5` | `ce28b2c50945fffc45f3ded1649c08eb97fe6b225b1bfa6d51287b0531755b77` |
| AB | `fb3001b310678e198b73783ae0b47798ddcd5435def3fa86dce4c3563976f8b6` | `debf70a3fa46ee2c17d0cd745dd25a8fea18894aa826b285b7fc3575de5475d9` |

Every report remains `measurementOnly: true` and `claimEligible: false`. Three
samples per report cannot characterize p95/p99 tails. This checkpoint supports
one bounded decoder hot-path observation on one host; it does not establish a
production SLA, cross-machine behavior, memory safety, leak freedom, filesystem
transfer performance, or a general graph-database performance claim.
