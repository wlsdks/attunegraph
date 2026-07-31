import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  verifyWorkingGraphGoldenBytes,
  verifyWorkingGraphGoldenCorpus,
  verifyWorkingGraphGoldenDocument
} from "./verify-working-graph-golden-corpus.mjs";
import { runWorkingGraphReadiness } from "./run-working-graph-readiness.mjs";

const ENTRYPOINT = fileURLToPath(
  new URL("./verify-working-graph-golden-corpus.mjs", import.meta.url)
);
const FIXTURE_URL = new URL(
  "../fixtures/working-graph-v1/corpus.json",
  import.meta.url
);
const MANIFEST_URL = new URL(
  "../fixtures/working-graph-v1/manifest.json",
  import.meta.url
);

async function fixture() {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

describe("Working Graph golden corpus", () => {
  it("matches every temporal, root, budget, and abstention expectation exactly", async () => {
    await expect(verifyWorkingGraphGoldenCorpus()).resolves.toMatchObject({
      abstentionCases: 1,
      caseCount: 3,
      exactMatches: 5,
      partialCases: 1,
      passed: true,
      precision: 1,
      queryCount: 5,
      recall: 1,
      schema: "attunegraph-working-graph-golden-report@1",
      corpusSha256: "sha256:904b4ef03d680c4fc4338a679699cf794a37ef95b03ea87017ad15d0e012177a"
    });
  });

  it("fails before execution when the pinned corpus bytes drift", async () => {
    const [bytes, manifest] = await Promise.all([
      readFile(FIXTURE_URL),
      readFile(MANIFEST_URL, "utf8").then(JSON.parse)
    ]);
    const drifted = Buffer.concat([bytes, Buffer.from("\n")]);
    await expect(
      verifyWorkingGraphGoldenBytes(drifted, manifest)
    ).rejects.toThrow(/corpus byte digest mismatch/u);
  });

  it("fails closed when an expected retrieval or corpus field drifts", async () => {
    const retrievalDrift = await fixture();
    retrievalDrift.cases[0].queries[0].expected.assertionIds = ["wrong"];
    await expect(
      verifyWorkingGraphGoldenDocument(retrievalDrift)
    ).rejects.toThrow(/golden mismatch/u);

    const schemaDrift = await fixture();
    schemaDrift.extra = true;
    await expect(
      verifyWorkingGraphGoldenDocument(schemaDrift)
    ).rejects.toThrow(/invalid field set/u);
  });

  it("provides a strict black-box verifier entrypoint", () => {
    const valid = spawnSync(process.execPath, [ENTRYPOINT], {
      encoding: "utf8",
      timeout: 10_000
    });
    expect(valid.status).toBe(0);
    expect(valid.stderr).toBe("");
    expect(JSON.parse(valid.stdout)).toMatchObject({
      passed: true,
      precision: 1,
      recall: 1
    });

    const invalid = spawnSync(process.execPath, [ENTRYPOINT, "unexpected"], {
      encoding: "utf8",
      timeout: 10_000
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toMatch(/accepts no arguments/u);
  });

  it.each(["working-graph-golden-corpus", "abstention"])(
    "adapts %s into its distinct readiness envelope",
    async (check) => {
      await expect(runWorkingGraphReadiness(check)).resolves.toMatchObject({
        check,
        contractId: `attunegraph-readiness-check-contract@1:${check}`,
        passed: true,
        result: { corpusSha256: "sha256:904b4ef03d680c4fc4338a679699cf794a37ef95b03ea87017ad15d0e012177a" },
        schema: "attunegraph-readiness-command-output@1"
      });
    }
  );
});
