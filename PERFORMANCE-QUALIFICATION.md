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

`local-session-concurrent` compares a bounded four-operation pool with a sequential pool using
separate new SQLite databases. Repetitions alternate baseline-first and candidate-first order.
Each side closes its first session, reopens the same database, and verifies every exact generation
and commit. The report preserves pairwise throughput/latency ratios, cold and warm session-open
latency, raw projection samples, pair order, and process peak RSS.

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
