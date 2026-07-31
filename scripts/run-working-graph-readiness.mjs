import { fileURLToPath } from "node:url";

import { verifyWorkingGraphGoldenCorpus } from "./verify-working-graph-golden-corpus.mjs";

import {
  readinessCheckContract,
  READINESS_COMMAND_OUTPUT_SCHEMA
} from "./readiness-check-contracts.mjs";

const SUPPORTED_CHECKS = new Set(["abstention", "working-graph-golden-corpus"]);

export async function runWorkingGraphReadiness(check) {
  if (!SUPPORTED_CHECKS.has(check)) throw new Error("unsupported Working Graph readiness check");
  const contract = readinessCheckContract(check);
  const report = await verifyWorkingGraphGoldenCorpus();
  if (check === "abstention" && report.abstentionCases < 1) {
    throw new Error("Working Graph readiness requires an exact abstention case");
  }
  return {
    check,
    contractId: contract.id,
    parameters: contract.parameters,
    passed: true,
    result: report,
    schema: READINESS_COMMAND_OUTPUT_SCHEMA
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const match = /^--check=(.+)$/u.exec(process.argv[2] ?? "");
  if (process.argv.length !== 3 || !match) {
    process.stderr.write("Working Graph readiness runner requires exactly --check=<name>\n");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await runWorkingGraphReadiness(match[1]))}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
