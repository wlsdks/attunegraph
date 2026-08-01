import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  READINESS_MEASUREMENT_CAPTURE_SCHEMA,
  READINESS_MEASUREMENT_CAPTURE_SCHEMA_V2,
  READINESS_MEASUREMENT_PROVENANCE_SCHEMA,
  READINESS_MEASUREMENT_PROVENANCE_SCHEMA_V2,
  READINESS_MEASUREMENT_RESULT_SCHEMA,
  READINESS_MEASUREMENT_RESULT_SCHEMA_V2,
  readinessMeasurementContract,
  readinessMeasurementContractSnapshot,
  validateReadinessMeasurementOutput
} from "./readiness-measurement-contracts.mjs";
import {
  createReadinessToolchain,
  inspectReadinessConsumerSubject,
  inspectReadinessSubject,
  READINESS_EVIDENCE_SCHEMA,
  READINESS_EVIDENCE_SCHEMA_V2,
  sha256
} from "./score-attunegraph-readiness.mjs";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
export const DEFAULT_MEASUREMENT_LIMITS = Object.freeze({
  maxStderrBytes: 65_536,
  maxStdoutBytes: 2_097_152,
  timeoutMilliseconds: 30_000
});

const REQUIRED_ARGUMENTS = Object.freeze([
  "name",
  "output-directory",
  "attunegraph-repository",
  "cwd"
]);
const CAPTURE_ARGUMENTS = new Set([
  ...REQUIRED_ARGUMENTS,
  "consumer-gitlink",
  "consumer-repository",
  "evidence-schema",
  "muse-gitlink",
  "muse-repository",
  "producer-mode"
]);
const CAPTURE_PROFILES = Object.freeze({
  [READINESS_EVIDENCE_SCHEMA]: Object.freeze({
    captureSchema: READINESS_MEASUREMENT_CAPTURE_SCHEMA,
    inspector: inspectReadinessSubject,
    producer: "capture-attunegraph-measurement@1",
    provenanceSchema: READINESS_MEASUREMENT_PROVENANCE_SCHEMA,
    resultSchema: READINESS_MEASUREMENT_RESULT_SCHEMA,
    version: 1
  }),
  [READINESS_EVIDENCE_SCHEMA_V2]: Object.freeze({
    captureSchema: READINESS_MEASUREMENT_CAPTURE_SCHEMA_V2,
    inspector: inspectReadinessConsumerSubject,
    producer: "capture-attunegraph-measurement@2",
    provenanceSchema: READINESS_MEASUREMENT_PROVENANCE_SCHEMA_V2,
    resultSchema: READINESS_MEASUREMENT_RESULT_SCHEMA_V2,
    version: 2
  })
});

function captureError(message) {
  throw new Error(`readiness measurement capture refused: ${message}`);
}

export function parseReadinessMeasurementCaptureArguments(args) {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const separator = normalized.indexOf("--");
  if (separator < 0) captureError("a -- separator is required");
  const values = new Map();
  for (const argument of normalized.slice(0, separator)) {
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (!match || !CAPTURE_ARGUMENTS.has(match[1])) {
      captureError(`unsupported argument: ${argument}`);
    }
    if (values.has(match[1])) captureError(`duplicate argument: --${match[1]}`);
    values.set(match[1], match[2]);
  }
  for (const required of REQUIRED_ARGUMENTS) {
    if (!values.has(required)) captureError(`--${required} is required`);
  }
  const evidenceSchema = values.get("evidence-schema") ?? READINESS_EVIDENCE_SCHEMA;
  const profile = CAPTURE_PROFILES[evidenceSchema];
  if (!profile) captureError(`unsupported readiness evidence schema: ${evidenceSchema}`);
  if (profile.version === 1) {
    if (values.has("consumer-repository") || values.has("consumer-gitlink")) {
      captureError("must not mix V1 Muse and V2 consumer arguments");
    }
    if (!values.has("muse-repository")) captureError("--muse-repository is required");
  } else {
    if (values.has("muse-repository") || values.has("muse-gitlink")) {
      captureError("must not mix V1 Muse and V2 consumer arguments");
    }
    for (const required of ["consumer-repository", "consumer-gitlink"]) {
      if (!values.has(required)) captureError(`--${required} is required`);
    }
  }
  const name = values.get("name");
  const contract = readinessMeasurementContract(name);
  if (!contract) captureError(`unknown measurement contract: ${name}`);
  const argv = normalized.slice(separator + 1);
  if (argv.some((argument) => argument.includes("\0"))) {
    captureError("command argv must not contain NUL bytes");
  }
  if (JSON.stringify(argv) !== JSON.stringify(contract.argv)) {
    captureError(`argv does not match the fixed contract for measurement ${name}`);
  }
  const producerMode = values.get("producer-mode") ?? "local-unattested";
  if (producerMode !== "local-unattested") {
    captureError("only local-unattested measurement production is supported");
  }
  const common = {
    argv: Object.freeze(argv),
    attunegraphRepository: values.get("attunegraph-repository"),
    cwd: values.get("cwd"),
    name,
    outputDirectory: values.get("output-directory"),
    producerMode
  };
  return Object.freeze(profile.version === 1 ? {
    argv: common.argv,
    attunegraphRepository: common.attunegraphRepository,
    cwd: common.cwd,
    museGitlinkPath: values.get("muse-gitlink") ?? "packages/attunegraph",
    museRepository: values.get("muse-repository"),
    name: common.name,
    outputDirectory: common.outputDirectory,
    producerMode: common.producerMode
  } : {
    ...common,
    consumerGitlinkPath: values.get("consumer-gitlink"),
    consumerRepository: values.get("consumer-repository"),
    evidenceSchema
  });
}

function captureProfile(options) {
  const evidenceSchema = options.evidenceSchema ?? READINESS_EVIDENCE_SCHEMA;
  const profile = CAPTURE_PROFILES[evidenceSchema];
  if (!profile) captureError(`unsupported readiness evidence schema: ${evidenceSchema}`);
  if (
    (profile.version === 1 && (
      options.consumerRepository !== undefined || options.consumerGitlinkPath !== undefined
    ))
    || (profile.version === 2 && (
      options.museRepository !== undefined || options.museGitlinkPath !== undefined
    ))
  ) {
    captureError("must not mix V1 Muse and V2 consumer arguments");
  }
  if (profile.version === 1 && options.museRepository === undefined) {
    captureError("V1 measurement capture requires a Muse repository");
  }
  if (
    profile.version === 2
    && (options.consumerRepository === undefined || options.consumerGitlinkPath === undefined)
  ) {
    captureError("V2 measurement capture requires a consumer repository and gitlink");
  }
  return profile;
}

function sanitizedEnvironment(executablePath) {
  const environment = {
    NODE_ENV: "production",
    PATH: dirname(executablePath),
    TZ: "UTC"
  };
  if (process.platform === "win32") {
    for (const name of ["ComSpec", "PATHEXT", "SystemRoot", "TEMP", "TMP"]) {
      if (typeof process.env[name] === "string") environment[name] = process.env[name];
    }
  }
  return environment;
}

function boundedLimits(limits) {
  const value = { ...DEFAULT_MEASUREMENT_LIMITS, ...limits };
  for (const [name, amount] of Object.entries(value)) {
    if (!Number.isSafeInteger(amount) || amount < 1) {
      throw new Error(`measurement ${name} must be a positive safe integer`);
    }
  }
  return value;
}

export async function executeBoundedMeasurement(
  executablePath,
  args,
  cwd,
  requestedLimits = DEFAULT_MEASUREMENT_LIMITS
) {
  const limits = boundedLimits(requestedLimits);
  const startedAt = new Date().toISOString();
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let spawnError = null;
  let terminalReason = null;
  const outcome = await new Promise((resolveOutcome) => {
    const child = spawn(executablePath, args, {
      cwd,
      env: sanitizedEnvironment(executablePath),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stop = (reason) => {
      if (terminalReason === null) {
        terminalReason = reason;
        child.kill("SIGKILL");
      }
    };
    const collect = (chunk, chunks, currentBytes, maximum, streamName) => {
      const available = Math.max(0, maximum - currentBytes);
      if (available > 0) chunks.push(chunk.subarray(0, available));
      if (chunk.length > available) stop(`OUTPUT_LIMIT: ${streamName} exceeded ${maximum.toString()} bytes`);
      return currentBytes + Math.min(chunk.length, available);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(
        Buffer.from(chunk),
        stdoutChunks,
        stdoutBytes,
        limits.maxStdoutBytes,
        "stdout"
      );
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(
        Buffer.from(chunk),
        stderrChunks,
        stderrBytes,
        limits.maxStderrBytes,
        "stderr"
      );
    });
    child.once("error", (error) => {
      spawnError = `${error.code ?? error.name}: ${error.message}`;
    });
    const timer = setTimeout(() => {
      stop(`TIMEOUT: measurement exceeded ${limits.timeoutMilliseconds.toString()}ms`);
    }, limits.timeoutMilliseconds);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveOutcome({ exitCode, signal });
    });
  });
  return Object.freeze({
    ...outcome,
    endedAt: new Date().toISOString(),
    spawnError: terminalReason ?? spawnError,
    startedAt,
    stderr: Buffer.concat(stderrChunks),
    stdout: Buffer.concat(stdoutChunks)
  });
}

function sameSubject(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function relativeArtifactPath(root, path) {
  const result = relative(root, path);
  if (result === "" || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    captureError("artifact path escaped the evidence directory");
  }
  return result.split(sep).join("/");
}

async function ensurePrivateOutputRoot(path) {
  const lexical = resolve(path);
  await mkdir(lexical, { mode: 0o700, recursive: true });
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    captureError("output directory must be a regular non-symlink directory");
  }
  if (process.geteuid && (stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0)) {
    captureError("output directory must be owner-only");
  }
  return realpathSync(lexical);
}

export async function captureReadinessMeasurement(options) {
  const profile = captureProfile(options);
  const before = profile.inspector(options);
  const contract = readinessMeasurementContract(options.name);
  if (!contract) captureError(`unknown measurement contract: ${options.name}`);
  const lexicalCwd = resolve(options.cwd);
  let cwd;
  try {
    if (lstatSync(lexicalCwd).isSymbolicLink()) captureError("cwd must not be a symlink");
    cwd = realpathSync(lexicalCwd);
    if (!lstatSync(cwd).isDirectory()) captureError("cwd must be a directory");
  } catch (error) {
    captureError(`cwd cannot be resolved: ${error.message}`);
  }
  if (cwd !== before.attunegraphRoot) {
    captureError(`cwd must be the canonical attunegraph repository root for measurement ${options.name}`);
  }
  if (JSON.stringify(options.argv) !== JSON.stringify(contract.argv)) {
    captureError(`argv does not match the fixed contract for measurement ${options.name}`);
  }
  const outputRoot = await ensurePrivateOutputRoot(options.outputDirectory);
  const measurementsRoot = join(outputRoot, "measurements");
  await mkdir(measurementsRoot, { mode: 0o700, recursive: true });
  if (lstatSync(measurementsRoot).isSymbolicLink()) {
    captureError("measurements directory must not be a symlink");
  }
  const measurementDirectory = join(measurementsRoot, options.name);
  try {
    await mkdir(measurementDirectory, { mode: 0o700, recursive: false });
  } catch (error) {
    captureError(`measurement output already exists or cannot be created: ${error.message}`);
  }
  const stdoutPath = join(measurementDirectory, "stdout.bin");
  const stderrPath = join(measurementDirectory, "stderr.bin");
  const resultPath = join(measurementDirectory, "result.json");
  const executablePath = realpathSync(process.execPath);
  const executable = {
    path: executablePath,
    sha256: sha256(readFileSync(executablePath)),
    version: process.version
  };
  const outcome = await executeBoundedMeasurement(
    executablePath,
    contract.argv.slice(1),
    cwd,
    DEFAULT_MEASUREMENT_LIMITS
  );
  await Promise.all([
    writeFile(stdoutPath, outcome.stdout, { flag: "wx", mode: 0o600 }),
    writeFile(stderrPath, outcome.stderr, { flag: "wx", mode: 0o600 })
  ]);
  const after = profile.inspector(options);
  if (!sameSubject(before.subject, after.subject)) {
    captureError("repository subjects changed while the measurement was running");
  }
  let semanticError = null;
  if (
    outcome.exitCode === 0
    && outcome.signal === null
    && outcome.spawnError === null
  ) {
    try {
      validateReadinessMeasurementOutput(outcome.stdout, contract);
    } catch (error) {
      semanticError = error.message;
    }
  }
  const state = outcome.exitCode === 0
    && outcome.signal === null
    && outcome.spawnError === null
    && semanticError === null
    ? "observed"
    : "failed";
  const result = {
    command: readinessMeasurementContractSnapshot(contract),
    cwd,
    endedAt: outcome.endedAt,
    executable,
    exitCode: outcome.exitCode,
    limits: {
      ...DEFAULT_MEASUREMENT_LIMITS,
      environment: "sanitized-minimal"
    },
    measurement: options.name,
    provenance: {
      captureScriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      kind: "local-unattested",
      producer: profile.producer,
      schema: profile.provenanceSchema
    },
    schema: profile.resultSchema,
    signal: outcome.signal,
    spawnError: semanticError === null ? outcome.spawnError : `INVALID_OUTPUT: ${semanticError}`,
    startedAt: outcome.startedAt,
    state,
    stderr: {
      path: relativeArtifactPath(outputRoot, stderrPath),
      sha256: sha256(outcome.stderr)
    },
    stdout: {
      path: relativeArtifactPath(outputRoot, stdoutPath),
      sha256: sha256(outcome.stdout)
    },
    subject: before.subject,
    toolchain: createReadinessToolchain()
  };
  const resultBody = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(resultPath, resultBody, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return Object.freeze({
    measurement: Object.freeze({
      name: options.name,
      result: Object.freeze({
        path: relativeArtifactPath(outputRoot, resultPath),
        sha256: sha256(resultBody)
      })
    }),
    schema: profile.captureSchema,
    subject: before.subject
  });
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  try {
    const capture = await captureReadinessMeasurement(
      parseReadinessMeasurementCaptureArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
