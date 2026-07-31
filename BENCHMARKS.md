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
above. `local-session-concurrent` uses a bounded pool and an alternating AB/BA same-run sequential
baseline, separate SQLite databases, exact reopen verification, and cold/warm session-open
measurements. `portable` times the production encoder, contiguous `.atgx` materialization, and
production decoder separately while verifying exact terminal convergence.

Process peak RSS comes from `process.resourceUsage().maxRSS` normalized to bytes and is combined
with phase-boundary RSS. Absolute p50/p95/p99 throughput and latency summaries are mandatory and
the qualifier derives ratios and throughputs again from raw samples. The checked-in policy has
absolute RSS ceilings but leaves absolute throughput/latency thresholds pending independent full-
matrix calibration. Until then it can establish evidence integrity and relative-policy status,
not performance qualification. See
[`PERFORMANCE-QUALIFICATION.md`](PERFORMANCE-QUALIFICATION.md) for the six-report matrix and
fail-closed qualifier contract.

## Agent decision-read workload

`agent-decision-read@1` measures the public `working-graph@1` execute path on
the `in-memory-semantic-reference` profile. It is not a SQLite, custom-backend,
or hosted-service benchmark and it does not join the performance qualification
matrix. Every report is `measurementOnly: true` and `claimEligible: false`.

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
reported separately. Six cases cover this exact matrix:

| Case | Scenario | Independent executes | Expected outcome |
| --- | --- | ---: | --- |
| `wide-hot-complete-1` | 32 active hot edges | 1 | complete, fresh |
| `wide-hot-token-partial-4` | 32 active hot edges | 4 | token-budget partial, fresh |
| `wide-hot-complete-32` | 32 active hot edges | 32 | complete, fresh |
| `deep-cold-complete-1` | bounded cold chain | 1 | complete, fresh |
| `deep-cold-traversal-partial-4` | four over-depth cold chains | 4 | traversal-budget partial, stale |
| `deep-cold-valid-time-abstain-32` | expired, future, post-cutoff, and superseded edges | 32 | abstained, stale |

The 1/4/32 values are batches of independent single-seed Engine `execute`
calls. They are not one multi-seed query and do not claim the separate data-
store query seed ceiling. The latest generation contains 154 unique assertion
IDs across the six case heads. Preparation submits those case assertion sets
for all eight generations, so the report separately records 1,232 projected
assertion inputs; 154 must not be read as the total preparation work. The
report retains per-seed Engine latency, summed execute duration, whole-loop
wall time, considered/visited/emitted assertions, estimated tokens, maximum
depth, output bytes, status, freshness, truncation reasons, deterministic
semantic hashes, and exact generation/latest-commit invariants. Repository
commit/tree/clean state, lockfile hash, host, Node, pnpm, arguments, and
workload hash bind the measurement configuration. Non-empty CLI arguments are
parsed again by the strict validator and must agree with the workload, warmup,
and repetition fields. An empty argument list denotes a programmatic run whose
validated options remain authoritative.

The `agent-decision-read@1` schema pins every case's semantic hash, latest-head
commit ID, and non-timing counter/output-byte samples. A deliberate Engine
semantic change therefore requires a new workload version rather than silently
rewriting the meaning of `@1`. `validateAgentDecisionReadReportSchema` checks
that fixed semantic contract and report self-consistency. It does not claim
that self-reported provenance is externally authoritative.
`verifyAgentDecisionReadReportAuthority` additionally requires caller-supplied
expected repository, host, and CLI configuration values. The CLI captures
the initial repository identity and host, uses them to construct the report,
then recaptures the repository identity after measurement. It requires exact
initial/end commit, tree, and lockfile equality through the authority verifier,
and both captures must be clean, before emitting evidence. Git commands and
the lockfile are bound to the canonical script package root, which must itself
be the Git top level; invoking the absolute script from another repository
cannot substitute that caller working directory's provenance.

The decision-read script is included in the npm tarball and its module boundary
is import-smoked from an installed package. Authoritative benchmark execution
is supported only from a clean source checkout because revision provenance
reads that checkout's Git commit/tree/status and lockfile. Importability must
not be read as support for producing authoritative evidence from `node_modules`.

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
# Qualification gate: v1 local evidence is unattested, so this exits nonzero.
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

V1 deliberately records the remaining limits instead of implying attestation:
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

The command accepts only absolute, normalized, non-existing paths beneath a
non-symlink external directory and creates an owner-only file. Reports retain
raw cold/warm timings and only publish p50 at five or more independent
repetitions; p95 and p99 are always null (maximum ten repetitions). Exact
stored `canonical-projection@2` bytes remain at or below 15,500 bytes and use
an opaque thread root distinct from the scope key. A compact same-store
authority sentinel records explicit `AUTHORIZED_BY` source references, refuses
to infer authority for a different governed action, and proves that a stale,
expired generation-two authorization abstains after its head changes.

Every report is permanently `measurementOnly: true`, `claimEligible: false`,
`resourceAuthoritative: false`, and `resourceQualified: false`. The harness is
observational performance evidence only; it does not qualify resources or
grant an action any authority.

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
