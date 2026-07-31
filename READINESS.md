# AttuneGraph readiness evidence

AttuneGraph uses a fail-closed executable-evidence score. The score answers
whether one clean AttuneGraph revision and its exact Muse consumer pin have
fresh command evidence for the declared engineering contracts. It does not
score product usefulness, personal attunement, or user delight.

## Gates

| Gate | Weight | Required evidence |
| --- | ---: | --- |
| Independent clean room | 15 | install, build, test, example, pack, consumer install |
| Muse integration | 20 | exact submodule pin, narrow public port, no copied Engine, durable v2 path |
| Semantic safety | 20 | conformance, adversarial, property, fault, authority fail-closed |
| Persistence and portability | 10 | SQLite crash/CAS, `.atgx` streaming round trip |
| Retrieval quality | 10 | Working Graph golden corpus, abstention |
| Performance and resources | 15 | 10K/100K/1M corpora, latency, throughput, RSS, cold/warm SQLite open, concurrency, portable encode/decode |
| Operability | 5 | inspect, verify, diagnose, zero hidden mutation |
| Public adoption | 5 | API reference, migration notes, independent example |

All 37 check names remain fixed. Umbrella, duplicate, missing, and unknown
names are rejected. A gate contributes its full weight only when every check
passes. A failed, not-run, or stale check contributes zero for that gate.

`eligible: true` additionally requires a score of at least 90 and passing Muse
integration, semantic safety, and persistence/portability. Semantic safety
always includes `authority-fail-closed`.

## Evidence v2 contract

`attunegraph-readiness-evidence@2` contains the clean exact AttuneGraph and Muse
commit/tree subject plus 37 `{ name, gate, result }` descriptors. A descriptor
does not repeat an outcome. It points by relative path and SHA-256 to one
`attunegraph-readiness-check@2` result.

Each result binds:

- the exact argv and canonical cwd used by the process;
- UTC start and end timestamps;
- exit code, signal, and spawn error, with state derived from that outcome;
- the exact Node, package-manager, platform, and architecture identity plus a
  digest recomputed by the scorer;
- the clean AttuneGraph and Muse SHA/tree identities and exact Muse gitlink;
- separate raw stdout and stderr files by relative path and SHA-256.

Every result, stdout, and stderr path must resolve to a unique regular
non-symlink file below a non-symlink evidence root. Hash mismatch, path reuse,
traversal, symlink escape, malformed process state, future timestamps, dirty or
mismatched repositories, and gitlink mismatch are hard errors. The scorer
never reads the wall clock. The caller supplies `--as-of`; evidence is fresh
through exactly 168 hours after command completion.

## Capture a check

Keep the evidence directory outside both repositories so capture output cannot
make a subject dirty. The capture command inspects both subjects and their
gitlink before spawning, launches the argv after `--` directly with
`shell: false`, streams stdout/stderr to new mode-0600 files, and inspects the
subjects again after completion. It refuses an existing check directory rather
than replacing evidence.

```sh
pnpm readiness:capture -- \
  --name=verify \
  --output-directory=/absolute/path/readiness-evidence \
  --attunegraph-repository=/absolute/path/attunegraph \
  --muse-repository=/absolute/path/Muse \
  --cwd=/absolute/path/attunegraph -- pnpm verify:local
```

The capture CLI writes one `attunegraph-readiness-capture@2` descriptor to its
own stdout. Command stdout and stderr are never mixed into that descriptor.
A nonzero command is captured as `state: fail`; the producer exits successfully
because it recorded the outcome. Producer refusal exits nonzero and emits no
descriptor. Collect exactly one descriptor per fixed check, require the same
subject in all descriptors, and construct the v2 manifest from their `check`
members and shared `subject`. Capture does not invent absent pass evidence and
does not update a manifest in place.

## Score a complete manifest

```sh
pnpm readiness:score -- \
  --as-of=2026-07-31T00:00:00.000Z \
  --evidence=/absolute/path/readiness-evidence/readiness-evidence.json \
  --attunegraph-repository=/absolute/path/attunegraph \
  --muse-repository=/absolute/path/Muse
```

The scorer writes `attunegraph-readiness-score@2` JSON to stdout and mutates
nothing. A nonzero exit means the evidence cannot be trusted; it is never
converted into a partial readiness claim.

## Migration from v1

V1 artifacts only restated caller-supplied command metadata. They did not carry
immutable process output and cannot be upgraded safely. The v2 scorer rejects
`attunegraph-readiness-evidence@1` and `attunegraph-readiness-check@1`.

Re-capture every check from clean exact repositories with `readiness:capture`,
assemble a new v2 manifest from the emitted descriptors, and score that
manifest with an explicit `--as-of`. Do not copy a v1 pass state into v2, do not
reuse an output path, and do not treat the synthetic scorer fixtures as
qualification evidence. Until all 37 real descriptors exist, no v2 readiness
score is available.
