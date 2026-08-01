import { expect, it } from "vitest";

import {
  READINESS_MEASUREMENT_CONTRACTS,
  readinessMeasurementContract,
  readinessMeasurementContractSnapshot,
  validateReadinessMeasurementOutput
} from "./readiness-measurement-contracts.mjs";

it("keeps the unscored measurement registry separate and immutable", () => {
  const contract = readinessMeasurementContract("mixed-durable-agent-decision-observation");
  expect(Object.keys(READINESS_MEASUREMENT_CONTRACTS)).toEqual([
    "mixed-durable-agent-decision-observation"
  ]);
  expect(Object.isFrozen(READINESS_MEASUREMENT_CONTRACTS)).toBe(true);
  expect(Object.isFrozen(contract.parameters)).toBe(true);
  expect(readinessMeasurementContractSnapshot(contract)).toEqual({
    argv: ["node", "scripts/benchmark-attunegraph-agent-decision-mixed-durable.mjs"],
    authority: "local-unattested",
    cwdRole: "attunegraph",
    id: "attunegraph-readiness-measurement-contract@1:mixed-durable-agent-decision-observation",
    output: {
      schema: "attunegraph-agent-decision-mixed-durable-tracer@1",
      semantics: "mixed-durable-agent-decision-observation"
    },
    parameters: {
      clients: 4,
      measuredLogicalOperations: 100,
      profile: "local",
      readOperations: 80,
      repetitions: 1,
      totalDataOperations: 112,
      warmups: 0,
      workloadId: "four-session-mixed-80r20w@1",
      writeOperations: 20
    },
    scoring: "excluded"
  });
  expect(readinessMeasurementContract("concurrency")).toBeNull();
  expect(() => validateReadinessMeasurementOutput("{}", contract))
    .toThrow(/unknown or missing fields/u);
});
