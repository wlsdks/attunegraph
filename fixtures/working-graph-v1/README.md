# Working Graph golden corpus v1

`corpus.json` is the fixed deterministic retrieval contract for
`working-graph@1`. `manifest.json` independently pins its exact bytes; the
verifier rejects a digest mismatch before parsing or executing the corpus. It
covers:

- exact ordered retrieval from an explicit v2 `threadRoot`;
- world-time and record-time exclusion;
- freshness propagation without promotion to truth;
- abstention when an exact seed has no evidence;
- `partial`, not `abstained`, when evidence exists but the token budget rejects
  it.

Run `pnpm verify:working-graph-golden`. The verifier rejects byte, schema, or
expected-result drift and reports the pinned fixture SHA-256. Any intentional
corpus revision must update both files in one reviewed change. Precision and
recall apply only to these declared cases; the corpus is not organic relevance
evidence.
