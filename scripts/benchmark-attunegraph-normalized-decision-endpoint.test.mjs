import { expect, it } from "vitest";

import {
  runNormalizedDecisionEndpointBenchmark,
  runSimulatedV4WitnessFalsification
} from "./benchmark-attunegraph-normalized-decision-endpoint.mjs";

it("fails closed for witness corruption, scan bounds, and temporal decoys", async () => {
  const result = await runSimulatedV4WitnessFalsification();
  expect(result).toMatchObject({
    schema: "attunegraph-simulated-v4-witness-falsification@1",
    temporalSelectedAssertionIds: ["assertion:temporal:hub:0000"]
  });
  expect(Object.values(result.faults).every((fault) =>
    fault.detected && typeof fault.message === "string" && fault.message.length > 0
  )).toBe(true);
  expect(result.faults.selectedSourceRefCount.message)
    .toBe("simulated witness selected source-ref witness is invalid");
  expect(result.faults.selectedSourceRefDigest.message)
    .toBe("simulated witness selected source-ref witness is invalid");
  expect(result.faults.selectedSourceRefOrdinal.message)
    .toBe("simulated witness source-ref ordinals are invalid");
  expect(result.faults.metadataScanBound.message)
    .toBe("simulated witness assertion metadata bound is invalid");
  expect(result.faults.selectedSourceRefScanBound.message)
    .toBe("simulated witness selected source-ref bound is invalid");
});

it("pairs full projection decode with exact sparse and hub normalized endpoint reads", async () => {
  const report = await runNormalizedDecisionEndpointBenchmark({
    assertionCount: 32,
    samples: 3,
    warmup: 0
  });
  expect(report).toMatchObject({
    schema: "attunegraph-normalized-decision-endpoint-benchmark@2",
    measurementOnly: true,
    claimEligible: false,
    workload: {
      measurementOrder: "rotating-four-cell-round-robin",
      simulatedWitnessMetadataScanLimit: 64,
      simulatedWitnessSourceRefScanLimit: 64
    },
    scenarios: {
      sparse: {
        endpointAssertions: 1,
        semanticByteIdentity: true,
        normalizedCompleteness: "built-unverified",
        witnessedCompleteness: "simulated-v4-two-level-witness",
        witnessedEndpoint: { samples: 3 },
        witnessedPhases: {
          exactHead: { samples: 3 },
          metadataProof: { samples: 3 },
          endpointFilter: { samples: 3 },
          selectedSourceRefProof: { samples: 3 },
          canonicalReconstruction: { samples: 3 }
        },
        adaptivePath: "normalized-candidate"
      },
      hub: {
        endpointAssertions: 32,
        semanticByteIdentity: true,
        normalizedCompleteness: "built-unverified",
        witnessedCompleteness: "simulated-v4-two-level-witness",
        witnessedEndpoint: { samples: 3 },
        adaptivePath: "canonical-fallback"
      }
    }
  });
  expect(report.scenarios.degreeSweep.map((cell) => cell.endpointAssertions))
    .toEqual([1, 2, 4, 8, 12, 16, 24, 32]);
  expect(report.scenarios.sourceRefSweep.map((cell) => cell.requestedSourceRefs))
    .toEqual([1, 4, 8, 16, 32]);
  expect(report.scenarios.sourceRefSweep.map((cell) => cell.status))
    .toEqual(["measured", "measured", "measured", "blocked-by-production-projection-budget", "blocked-by-production-projection-budget"]);
  expect(report.scenarios.sourceRefSweep.filter((cell) => cell.status === "measured").every((cell) =>
    cell.semanticByteIdentity && cell.witnessedCompleteness === "simulated-v4-two-level-witness"
  )).toBe(true);
  for (const cell of report.scenarios.degreeSweep) {
    expect(cell.sqliteAllocation.delta.pages).toBeGreaterThan(0);
    expect(cell.sqliteAllocation.delta.bytes)
      .toBe(cell.sqliteAllocation.delta.pages * cell.sqliteAllocation.baseline.pageSize);
    expect(cell.sqliteAllocation.simulatedWitness.pageSize)
      .toBe(cell.sqliteAllocation.baseline.pageSize);
    expect(cell.p50SpeedupFullOverWitnessed).toBeGreaterThan(0);
  }
  expect(report.artifactIdentity).toMatch(/^sha256:[0-9a-f]{64}$/u);
});
