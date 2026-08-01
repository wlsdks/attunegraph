import { spawn } from "node:child_process";
import { createWriteStream, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";

import {
  createReadinessToolchain,
  inspectReadinessSubject,
  READINESS_CAPTURE_SCHEMA,
  READINESS_CHECK_SCHEMA,
  READINESS_GATES,
  sha256
} from "./score-attunegraph-readiness.mjs";
import {
  readinessCheckContract,
  readinessContractSnapshot,
  validateReadinessCommandOutput
} from "./readiness-check-contracts.mjs";

const CHECKS_BY_NAME = new Map(
  READINESS_GATES.flatMap((gate) => gate.checks.map((name) => [name, gate.name]))
);
const CAPTURE_ARGUMENTS = new Set([
  "attunegraph-repository",
  "cwd",
  "muse-gitlink",
  "muse-repository",
  "name",
  "output-directory",
  "producer-mode"
]);
const REQUIRED_ARGUMENTS = new Set([
  "attunegraph-repository",
  "cwd",
  "muse-repository",
  "name",
  "output-directory"
]);

function captureError(message) {
  throw new Error(`readiness capture refused: ${message}`);
}

export function parseReadinessCaptureArguments(args) {
  const separator = args.indexOf("--");
  if (separator < 0) captureError("a -- separator is required");
  const optionArguments = args.slice(0, separator);
  const argv = args.slice(separator + 1);
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
  const name = values.get("name");
  const gate = CHECKS_BY_NAME.get(name);
  if (!gate) captureError(`unknown readiness check: ${name}`);
  const contract = readinessCheckContract(name);
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
  return Object.freeze({
    argv: Object.freeze(argv),
    attunegraphRepository: values.get("attunegraph-repository"),
    cwd: values.get("cwd"),
    gate,
    museGitlinkPath: values.get("muse-gitlink") ?? "packages/attunegraph",
    museRepository: values.get("muse-repository"),
    name,
    outputDirectory: values.get("output-directory"),
    producerMode
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
  const before = inspectReadinessSubject(options);
  const lexicalCwd = resolve(options.cwd);
  let cwd;
  try {
    if (lstatSync(lexicalCwd).isSymbolicLink()) captureError("cwd must not be a symlink");
    cwd = realpathSync(lexicalCwd);
    if (!lstatSync(cwd).isDirectory()) captureError("cwd must be a directory");
  } catch (error) {
    captureError(`cwd cannot be resolved: ${error.message}`);
  }
  const contract = readinessCheckContract(options.name);
  if (!contract || contract.gate !== options.gate) captureError(`missing fixed contract for check: ${options.name}`);
  const expectedCwd = contract.cwdRole === "muse" ? before.museRoot : before.attunegraphRoot;
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
  const after = inspectReadinessSubject(options);
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
      producer: "capture-attunegraph-readiness@1",
      schema: "attunegraph-readiness-provenance@1"
    },
    schema: READINESS_CHECK_SCHEMA,
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
    schema: READINESS_CAPTURE_SCHEMA,
    subject: before.subject
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
