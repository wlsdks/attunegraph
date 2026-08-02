import { expect, it } from "vitest";

import { runPreparedPlanSeedPartCountBenchmark } from "./benchmark-attunegraph-prepared-plan-seed.mjs";

it("counts the removed post-project full read without making a speed claim", async () => {
  await expect(runPreparedPlanSeedPartCountBenchmark()).resolves.toEqual({
    claimEligible: false,
    equivalence: {
      firstEqualsCold: true,
      repeatedEqualsFirst: true
    },
    measurementOnly: true,
    parts: {
      coldFirstQuery: {
        compareAndSwaps: 0,
        fullProjectionReads: 1,
        headReads: 1
      },
      projectAgainstHead: {
        compareAndSwaps: 1,
        fullProjectionReads: 1,
        headReads: 0
      },
      seededFirstQuery: {
        compareAndSwaps: 0,
        fullProjectionReads: 0,
        headReads: 1
      },
      seededRepeatedQuery: {
        compareAndSwaps: 0,
        fullProjectionReads: 0,
        headReads: 1
      }
    },
    schema: "attunegraph-prepared-plan-seed-part-count@1",
    workload: "projectAgainstHead -> first exact-head decision-query@1 -> repeated query"
  });
});
