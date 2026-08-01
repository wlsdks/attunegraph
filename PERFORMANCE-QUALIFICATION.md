# Performance qualification

AttuneGraph performance qualification is a revision-bound engineering gate, not a universal
speed claim. The checked-in [`performance-thresholds.json`](performance-thresholds.json) is the
only approved policy consumed by `performance:qualify`. It requires six clean reports: the 10K,
100K, and 1M corpora for both `local-session-concurrent` and `portable`.

The reference class is explicit in the policy. Resource ceilings are absolute. Latency and
throughput comparisons are same-run relative measurements, while their absolute p50, p95, and p99
summaries remain required report fields. Approved absolute throughput and latency thresholds need
independent 10K/100K/1M calibration and are deliberately still marked pending in the policy; the
qualifier cannot claim full performance qualification until that calibration is checked in.

## Measurement contracts

`local-session-concurrent` compares a bounded four-operation caller pool with a sequential pool
using separate new SQLite databases. Each side still owns one session, one Worker, and one
synchronous SQLite connection, so this is a single-session pipelining comparison rather than
multi-client SQLite concurrency or contention evidence. Repetitions alternate baseline-first and
candidate-first order. Each side closes its first session, reopens the same database, and verifies
every exact generation and commit. The report preserves pairwise throughput/latency ratios,
new-worker and reused-database session-open latency, raw projection samples, pair order, and
process peak RSS. OS page-cache state is uncontrolled.

`portable` builds the deterministic corpus through the Engine, encodes it with the production
package-private `.atgx` encoder, materializes one contiguous artifact, and decodes that artifact
with the production streaming decoder. Encoder-core and materialization latency are separate;
reported total encode throughput includes both. Exact footer summary, projection count, and head
count must converge. This profile does not claim the not-yet-public filesystem transfer API.

RSS uses the larger of phase-boundary `process.memoryUsage().rss` and the process-lifetime high
water mark from `process.resourceUsage().maxRSS`, normalized from KiB to bytes. The method is
recorded in every run. It is not an interval-sampled allocation trace.

Concurrent reports require at least two repetitions and the exact baseline-first, candidate-first
alternation for every pair. The qualifier recomputes assertion throughput from ingestion latency,
portable byte and assertion throughput from artifact size and encode/decode latency, and every
relative ratio from those raw samples. It does not trust claimed ratios. Throughput uses the p50
of pairwise ratios. Concurrent latency, warm/cold open, and portable decode/encode latency use p95;
a good median cannot hide a regressed tail. Resource ceilings are 512 MiB, 1 GiB, and 4 GiB for
10K, 100K, and 1M respectively, additionally capped at half of host RAM.

## Produce the matrix

Run 10K interactively. Run 100K and 1M separately; they are intentionally absent from normal CI.

```sh
pnpm benchmark:performance -- --scale=10000 \
  --profile=local-session-concurrent --concurrency=4 \
  --warmups=1 --repetitions=3 --output=/absolute/outside-repo/local-10k.json

pnpm benchmark:performance -- --scale=10000 \
  --profile=portable --warmups=1 --repetitions=3 \
  --concurrency=1 \
  --output=/absolute/outside-repo/portable-10k.json
```

Repeat both commands for `100000` and `1000000`, then pass the six unique report paths:

```sh
pnpm performance:qualify -- --as-of=2026-08-02T00:00:00.000Z \
  --report=/absolute/outside-repo/local-10k.json \
  --report=/absolute/outside-repo/local-100k.json \
  --report=/absolute/outside-repo/local-1m.json \
  --report=/absolute/outside-repo/portable-10k.json \
  --report=/absolute/outside-repo/portable-100k.json \
  --report=/absolute/outside-repo/portable-1m.json
```

The qualifier rejects malformed, stale, duplicate, cross-host, dirty, SHA/tree/lockfile-mismatched,
wrong-corpus, wrong-concurrency, incomplete, inconsistent, or non-producer-shaped evidence. Host,
RSS, correctness, configuration, metric, and raw-summary objects use exact schemas. Correctness
counts must equal the deterministic corpus shard count. A structurally valid matrix can report
`integrityQualified: true`; that means internal evidence integrity only, not provenance or speed.
`relativePolicyQualified` records the existing relative/resource policy result.

`performanceQualified` remains `false` and the command exits nonzero while the checked-in policy
states `pending-independent-calibration` for absolute throughput and latency thresholds. This
fail-closed state prevents two equally slow implementations from passing on ratios alone without
inventing unmeasured 100K/1M limits.

The local hashes make a report revision-bound and tamper-evident within its evidence set; they do
not authenticate who executed it. A hand-authored file that perfectly reproduces the strict
producer schema can still only establish internal integrity, never independent provenance.
Release/readiness evidence must ultimately bind these reports to trusted CI artifact provenance or
an independent evaluator before making a public qualification claim.

## External-product performance roadmap

Performance is part of the public engine contract now that AttuneGraph is a
standalone project. Optimizations are admitted only when they preserve exact
semantic, temporal, provenance, authority, abstention, ordering, and budget
results. A plausible CPU or allocation reduction is not enough: the candidate
must improve a fixed public workload in paired clean-revision measurements. A
mixed or noisy result is rejected instead of being merged on intuition.

The current harnesses prove less than their largest number may suggest:

- `generation-churn-8x40@1` is now the first durable SQLite decision vertical:
  16 active plus 24 inactive assertions per head, eight generations, and one
  exact read after a same-process new-Worker graceful reopen;
- the 1M scale workload distributes one million assertions across many bounded
  scopes; it is not a one-million-edge graph query;
- `agent-decision-read-scale@1` measures in-memory scopes with at most 48
  active assertions and batches of independent single-seed reads;
- portable evidence materializes one contiguous artifact and does not prove a
  bounded-memory filesystem transfer;
- RSS is a process-lifetime high-water observation, not heap, allocation,
  Worker process-tree, GC-pause, or leak-slope evidence;
- p95, p99, SLA, cross-host, and general graph-database claims remain
  unavailable where the report contract says they are unavailable.

The 90-level qualification stage targets the workload an AI agent actually
puts on the engine:

1. Extend the shipped versioned durable decision vertical from its current
   16-active/24-inactive, generation-8, single-client graceful-reopen cell to
   48 and 256 active assertions, larger inactive sets, generations 1 and 64,
   paired in-memory/SQLite profiles, 1/4/16 real sessions, 80/20 read/write
   phases, and exact cross-process restart/reopen verification.
2. Bind verified projection and query-index reuse to an exact commit identity,
   or prove an equivalent incremental design, so an unchanged head does not
   require avoidable full admission and index reconstruction.
3. Record interval memory for the main process and Worker, heap/external/
   array-buffer peaks, GC pauses where observable, and repeated-run slope.
4. Measure SQLite database and WAL growth, checkpoint cost, contention,
   retention, compaction, and reopen latency over generation churn.
5. Connect the fixed performance checks in the readiness inventory to real
   versioned evidence producers instead of accepting substitute commands.
6. Run the full six-report matrix on dedicated runners, calibrate absolute
   thresholds independently, attest the raw artifacts, and keep ordinary PR
   CI on short semantic and performance smoke gates.
7. Add installed-package cold start, import, tarball-size, and public streaming
   export/import measurements before making external packaging claims.

The later 99-level gate requires enough independent samples for supported tail
percentiles, reference classes for supported OS/architecture/Node combinations,
long-running memory and database-growth evidence, one real Muse trace replay,
and at least one independent non-Muse agent workload. Rust or another native
component is introduced only when a measured approved workload shows that the
TypeScript implementation prevents an accepted target; language choice itself
is not a performance result.
