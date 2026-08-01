import { spawn } from "node:child_process";
import { createWriteStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";

import {
  createReadinessToolchain,
  inspectReadinessConsumerSubject,
  inspectReadinessSubject,
  READINESS_CAPTURE_SCHEMA,
  READINESS_CAPTURE_SCHEMA_V2,
  READINESS_CHECK_SCHEMA,
  READINESS_CHECK_SCHEMA_V2,
  READINESS_EVIDENCE_SCHEMA,
  READINESS_EVIDENCE_SCHEMA_V2,
  READINESS_GATES,
  READINESS_GATES_V2,
  sha256
} from "./score-attunegraph-readiness.mjs";
import { isDirectEntrypoint } from "./direct-entrypoint.mjs";
import {
  readinessCheckContract,
  readinessContractSnapshot,
  READINESS_CONTRACT_SCHEMA,
  READINESS_CONTRACT_SCHEMA_V2,
  validateReadinessCommandOutput
} from "./readiness-check-contracts.mjs";

const CHECKS_BY_NAME_V1 = new Map(
  READINESS_GATES.flatMap((gate) => gate.checks.map((name) => [name, gate.name]))
);
const CHECKS_BY_NAME_V2 = new Map(
  READINESS_GATES_V2.flatMap((gate) => gate.checks.map((name) => [name, gate.name]))
);
const CAPTURE_PROFILES = Object.freeze({
  [READINESS_EVIDENCE_SCHEMA]: Object.freeze({
    captureSchema: READINESS_CAPTURE_SCHEMA,
    checkSchema: READINESS_CHECK_SCHEMA,
    checksByName: CHECKS_BY_NAME_V1,
    consumerRole: "muse",
    consumerRoot: "museRoot",
    contractSchema: READINESS_CONTRACT_SCHEMA,
    inspector: inspectReadinessSubject,
    producer: "capture-attunegraph-readiness@1",
    provenanceSchema: "attunegraph-readiness-provenance@1",
    version: 1
  }),
  [READINESS_EVIDENCE_SCHEMA_V2]: Object.freeze({
    captureSchema: READINESS_CAPTURE_SCHEMA_V2,
    checkSchema: READINESS_CHECK_SCHEMA_V2,
    checksByName: CHECKS_BY_NAME_V2,
    consumerRole: "consumer",
    consumerRoot: "consumerRoot",
    contractSchema: READINESS_CONTRACT_SCHEMA_V2,
    inspector: inspectReadinessConsumerSubject,
    producer: "capture-attunegraph-readiness@2",
    provenanceSchema: "attunegraph-readiness-provenance@2",
    version: 2
  })
});
const CAPTURE_ARGUMENTS = new Set([
  "attunegraph-repository",
  "consumer-gitlink",
  "consumer-repository",
  "cwd",
  "evidence-schema",
  "muse-gitlink",
  "muse-repository",
  "name",
  "output-directory",
  "producer-mode"
]);
const REQUIRED_ARGUMENTS = new Set([
  "attunegraph-repository",
  "cwd",
  "name",
  "output-directory"
]);

function captureError(message) {
  throw new Error(`readiness capture refused: ${message}`);
}

export function parseReadinessCaptureArguments(args) {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const separator = normalized.indexOf("--");
  if (separator < 0) captureError("a -- separator is required");
  const optionArguments = normalized.slice(0, separator);
  const argv = normalized.slice(separator + 1);
  if (argv.some((argument) => argument.includes("\0"))) {
    captureError("command argv must not contain NUL bytes");
  }
  const values = new Map();
  for (const argument of optionArguments) {
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
  const gate = profile.checksByName.get(name);
  if (!gate) captureError(`unknown readiness check: ${name}`);
  const contract = readinessCheckContract(name, profile.contractSchema);
  if (!contract || contract.gate !== gate) captureError(`missing fixed contract for check: ${name}`);
  const producerMode = values.get("producer-mode") ?? "local-unattested";
  if (producerMode !== "local-unattested") {
    captureError("only local-unattested production is supported; attested status requires external cryptographic verification");
  }
  if (contract.availability === "unavailable" && argv.length !== 0) {
    captureError(`check ${name} is unavailable and cannot accept substitute argv`);
  }
  if (contract.availability === "available") {
    if (JSON.stringify(argv) !== JSON.stringify(contract.argv)) {
      captureError(`argv does not match the fixed contract for check ${name}`);
    }
  }
  const common = {
    argv: Object.freeze(argv),
    attunegraphRepository: values.get("attunegraph-repository"),
    cwd: values.get("cwd"),
    gate,
    name,
    outputDirectory: values.get("output-directory"),
    producerMode
  };
  return Object.freeze(profile.version === 1 ? {
    argv: common.argv,
    attunegraphRepository: common.attunegraphRepository,
    cwd: common.cwd,
    gate: common.gate,
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
    captureError("V1 capture requires a Muse repository");
  }
  if (
    profile.version === 2
    && (options.consumerRepository === undefined || options.consumerGitlinkPath === undefined)
  ) {
    captureError("V2 capture requires a consumer repository and gitlink");
  }
  return profile;
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

async function ensureOutputRoot(path) {
  const lexical = resolve(path);
  await mkdir(lexical, { mode: 0o700, recursive: true });
  const stat = lstatSync(lexical);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    captureError("output directory must be a regular non-symlink directory");
  }
  return realpathSync(lexical);
}

async function executeToFiles(executablePath, args, cwd, stdoutPath, stderrPath) {
  const stdoutStream = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderrStream = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const startedAt = new Date().toISOString();
  let spawnError = null;
  const outcome = await new Promise((resolveOutcome) => {
    const child = spawn(executablePath, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.pipe(stdoutStream);
    child.stderr.pipe(stderrStream);
    child.once("error", (error) => {
      spawnError = `${error.code ?? error.name}: ${error.message}`;
    });
    child.once("close", (exitCode, signal) => resolveOutcome({ exitCode, signal }));
  });
  await Promise.all([finished(stdoutStream), finished(stderrStream)]);
  return { ...outcome, endedAt: new Date().toISOString(), spawnError, startedAt };
}

export async function captureReadinessCheck(options) {
  const profile = captureProfile(options);
  const before = profile.inspector(options);
  const lexicalCwd = resolve(options.cwd);
  let cwd;
  try {
    if (lstatSync(lexicalCwd).isSymbolicLink()) captureError("cwd must not be a symlink");
    cwd = realpathSync(lexicalCwd);
    if (!lstatSync(cwd).isDirectory()) captureError("cwd must be a directory");
  } catch (error) {
    captureError(`cwd cannot be resolved: ${error.message}`);
  }
  const contract = readinessCheckContract(options.name, profile.contractSchema);
  if (!contract || contract.gate !== options.gate) captureError(`missing fixed contract for check: ${options.name}`);
  const expectedCwd = contract.cwdRole === profile.consumerRole
    ? before[profile.consumerRoot]
    : before.attunegraphRoot;
  if (cwd !== expectedCwd) {
    captureError(`cwd must be the canonical ${contract.cwdRole} repository root for check ${options.name}`);
  }
  if (JSON.stringify(options.argv) !== JSON.stringify(contract.argv ?? [])) {
    captureError(`argv does not match the fixed contract for check ${options.name}`);
  }
  const outputRoot = await ensureOutputRoot(options.outputDirectory);
  const checksRoot = join(outputRoot, "checks");
  await mkdir(checksRoot, { mode: 0o700, recursive: true });
  if (lstatSync(checksRoot).isSymbolicLink()) captureError("checks directory must not be a symlink");
  const checkDirectory = join(checksRoot, options.name);
  try {
    await mkdir(checkDirectory, { mode: 0o700, recursive: false });
  } catch (error) {
    captureError(`check output already exists or cannot be created: ${error.message}`);
  }
  const stdoutPath = join(checkDirectory, "stdout.bin");
  const stderrPath = join(checkDirectory, "stderr.bin");
  const resultPath = join(checkDirectory, "result.json");
  let executable = null;
  let outcome;
  if (contract.availability === "available") {
    if (contract.argv[0] !== "node") captureError(`unsupported executable contract for check ${options.name}`);
    const executablePath = realpathSync(process.execPath);
    executable = {
      path: executablePath,
      sha256: sha256(readFileSync(executablePath)),
      version: process.version
    };
    outcome = await executeToFiles(executablePath, contract.argv.slice(1), cwd, stdoutPath, stderrPath);
  } else {
    await Promise.all([
      writeFile(stdoutPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 }),
      writeFile(stderrPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 })
    ]);
    const observedAt = new Date().toISOString();
    outcome = {
      endedAt: observedAt,
      exitCode: null,
      signal: null,
      spawnError: null,
      startedAt: observedAt
    };
  }
  const after = profile.inspector(options);
  if (!sameSubject(before.subject, after.subject)) {
    captureError("repository subjects changed while the command was running");
  }
  const stdoutBytes = await readFile(stdoutPath);
  const stderrBytes = await readFile(stderrPath);
  let semanticError = null;
  if (
    contract.availability === "available"
    && outcome.exitCode === 0
    && outcome.signal === null
    && outcome.spawnError === null
  ) {
    try {
      validateReadinessCommandOutput(stdoutBytes, contract);
    } catch (error) {
      semanticError = error.message;
    }
  }
  const state = contract.availability === "unavailable"
    ? "not-run"
    : outcome.exitCode === 0
      && outcome.signal === null
      && outcome.spawnError === null
      && semanticError === null
      ? "pass"
      : "fail";
  const captureScriptSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const result = {
    command: readinessContractSnapshot(contract),
    cwd,
    endedAt: outcome.endedAt,
    executable,
    exitCode: outcome.exitCode,
    gate: options.gate,
    name: options.name,
    provenance: {
      captureScriptSha256,
      kind: "local-unattested",
      producer: profile.producer,
      schema: profile.provenanceSchema
    },
    schema: profile.checkSchema,
    signal: outcome.signal,
    spawnError: semanticError === null ? outcome.spawnError : `INVALID_OUTPUT: ${semanticError}`,
    startedAt: outcome.startedAt,
    state,
    stderr: {
      path: relativeArtifactPath(outputRoot, stderrPath),
      sha256: sha256(stderrBytes)
    },
    stdout: {
      path: relativeArtifactPath(outputRoot, stdoutPath),
      sha256: sha256(stdoutBytes)
    },
    subject: before.subject,
    toolchain: createReadinessToolchain()
  };
  const resultBody = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(resultPath, resultBody, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return Object.freeze({
    check: Object.freeze({
      gate: options.gate,
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
    const capture = await captureReadinessCheck(
      parseReadinessCaptureArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
