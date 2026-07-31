export const READINESS_COMMAND_OUTPUT_SCHEMA = "attunegraph-readiness-command-output@1";
export const READINESS_CONTRACT_SCHEMA = "attunegraph-readiness-check-contract@1";

const CHECK_NAMES_BY_GATE = Object.freeze({
  "independent-clean-room": ["install", "build", "test", "example", "pack", "consumer-install"],
  "muse-integration": [
    "submodule-pinned",
    "narrow-public-port",
    "no-duplicate-engine-source",
    "v2-durable-path"
  ],
  "semantic-safety": ["conformance", "adversarial", "property", "fault", "authority-fail-closed"],
  "persistence-portable": ["sqlite-crash-cas", "atgx-streaming-round-trip"],
  "retrieval-quality": ["working-graph-golden-corpus", "abstention"],
  "performance-resources": [
    "corpus-10k",
    "corpus-100k",
    "corpus-1m",
    "projection-latency",
    "working-graph-latency",
    "throughput",
    "peak-rss",
    "sqlite-cold-open",
    "sqlite-warm-open",
    "concurrency",
    "portable-encode-decode"
  ],
  operability: ["inspect", "verify", "diagnose", "zero-hidden-mutation"],
  "public-adoption": ["api-reference", "migration-notes", "independent-example"]
});

const PERFORMANCE_PARAMETERS = Object.freeze({
  "corpus-10k": { profile: "core", repetitions: 5, scale: 10_000, warmups: 1 },
  "corpus-100k": { profile: "core", repetitions: 5, scale: 100_000, warmups: 1 },
  "corpus-1m": { profile: "core", repetitions: 5, scale: 1_000_000, warmups: 1 },
  "projection-latency": { metric: "projectionMilliseconds", profile: "core", repetitions: 5, scale: 100_000, warmups: 1 },
  "working-graph-latency": { metric: "workingGraphMilliseconds", profile: "core", repetitions: 5, scale: 100_000, warmups: 1 },
  throughput: { metric: "assertionsPerSecond", profile: "core", repetitions: 5, scale: 100_000, warmups: 1 },
  "peak-rss": { metric: "peakRssBytes", profile: "core", repetitions: 5, scale: 100_000, warmups: 1 },
  "sqlite-cold-open": { metric: "coldOpenMilliseconds", profile: "local", repetitions: 5, scale: 100_000, warmups: 1 },
  "sqlite-warm-open": { metric: "warmOpenMilliseconds", profile: "local", repetitions: 5, scale: 100_000, warmups: 1 },
  concurrency: { metric: "concurrentOperations", profile: "local", repetitions: 5, scale: 100_000, warmups: 1, workers: 8 },
  "portable-encode-decode": { metric: "portableEncodeDecodeMilliseconds", profile: "core", repetitions: 5, scale: 100_000, warmups: 1 }
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const READINESS_CHECK_CONTRACTS = deepFreeze(Object.fromEntries(
  Object.entries(CHECK_NAMES_BY_GATE).flatMap(([gate, names]) => names.map((name) => [name, {
    argv: null,
    availability: "unavailable",
    cwdRole: gate === "muse-integration" ? "muse" : "attunegraph",
    gate,
    id: `${READINESS_CONTRACT_SCHEMA}:${name}`,
    output: {
      schema: READINESS_COMMAND_OUTPUT_SCHEMA,
      semantics: name
    },
    parameters: PERFORMANCE_PARAMETERS[name] ?? {},
    unavailableReason: "No fixed semantic verifier is registered for this check."
  }]))
));

export function readinessCheckContract(name) {
  return READINESS_CHECK_CONTRACTS[name] ?? null;
}

export function readinessContractSnapshot(contract) {
  return {
    argv: contract.argv,
    availability: contract.availability,
    cwdRole: contract.cwdRole,
    id: contract.id,
    output: contract.output,
    parameters: contract.parameters,
    unavailableReason: contract.unavailableReason
  };
}

export function readinessContractsMatchInventory(gates) {
  const gateEntries = gates.flatMap((gate) => gate.checks.map((name) => [name, gate.name]));
  const contractEntries = Object.entries(READINESS_CHECK_CONTRACTS);
  return gateEntries.length === contractEntries.length
    && gateEntries.every(([name, gate]) => READINESS_CHECK_CONTRACTS[name]?.gate === gate)
    && contractEntries.every(([name, contract]) => gateEntries.some(([entryName, gate]) => (
      entryName === name && gate === contract.gate
    )));
}

function plainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

export function validateReadinessCommandOutput(bytes, contract) {
  let output;
  try {
    output = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("readiness command output must be one valid JSON envelope");
  }
  if (!exactKeys(output, ["check", "contractId", "parameters", "passed", "result", "schema"])) {
    throw new Error("readiness command output has unknown or missing fields");
  }
  if (
    output.schema !== READINESS_COMMAND_OUTPUT_SCHEMA
    || output.check !== contract.output.semantics
    || output.contractId !== contract.id
    || output.passed !== true
    || !plainObject(output.result)
    || JSON.stringify(output.parameters) !== JSON.stringify(contract.parameters)
  ) {
    throw new Error("readiness command output does not match its fixed semantic contract");
  }
  return output;
}
