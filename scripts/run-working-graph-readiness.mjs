import { verifyWorkingGraphGoldenCorpus } from "./verify-working-graph-golden-corpus.mjs";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";

import {
  readinessCheckContract,
  READINESS_COMMAND_OUTPUT_SCHEMA,
  READINESS_CONTRACT_SCHEMA,
  READINESS_CONTRACT_SCHEMA_V2
} from "./readiness-check-contracts.mjs";

const SUPPORTED_CHECKS = new Set(["abstention", "working-graph-golden-corpus"]);

export async function runWorkingGraphReadiness(check, contractSchema = READINESS_CONTRACT_SCHEMA) {
  if (!SUPPORTED_CHECKS.has(check)) throw new Error("unsupported Working Graph readiness check");
  const contract = readinessCheckContract(check, contractSchema);
  if (!contract) throw new Error("unsupported Working Graph readiness contract schema");
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

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  const match = /^--check=(.+)$/u.exec(process.argv[2] ?? "");
  const schemaMatch = /^--contract-schema=(.+)$/u.exec(process.argv[3] ?? "");
  const contractSchema = process.argv.length === 3
    ? READINESS_CONTRACT_SCHEMA
    : process.argv.length === 4 && schemaMatch?.[1] === READINESS_CONTRACT_SCHEMA_V2
      ? schemaMatch[1]
      : null;
  if (!match || contractSchema === null) {
    process.stderr.write("Working Graph readiness runner requires --check=<name> and optional supported --contract-schema=<schema>\n");
    process.exitCode = 1;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await runWorkingGraphReadiness(match[1], contractSchema))}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
