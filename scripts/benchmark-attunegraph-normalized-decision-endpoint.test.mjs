import { expect, it } from "vitest";

import {
  runNormalizedDecisionEndpointBenchmark
} from "./benchmark-attunegraph-normalized-decision-endpoint.mjs";

it("pairs full projection decode with exact sparse and hub normalized endpoint reads", async () => {
  const report = await runNormalizedDecisionEndpointBenchmark({
    assertionCount: 32,
    samples: 3,
    warmup: 0
  });
  expect(report).toMatchObject({
    schema: "attunegraph-normalized-decision-endpoint-benchmark@1",
    measurementOnly: true,
    claimEligible: false,
    scenarios: {
      sparse: {
        endpointAssertions: 1,
        semanticByteIdentity: true,
        normalizedCompleteness: "built-unverified",
        adaptivePath: "normalized-candidate"
      },
      hub: {
        endpointAssertions: 32,
        semanticByteIdentity: true,
        normalizedCompleteness: "built-unverified",
        adaptivePath: "canonical-fallback"
      }
    }
  });
  expect(report.scenarios.degreeSweep.map((cell) => cell.endpointAssertions))
    .toEqual([1, 2, 4, 8, 12, 16, 24, 32]);
  expect(report.artifactIdentity).toMatch(/^sha256:[0-9a-f]{64}$/u);
});
