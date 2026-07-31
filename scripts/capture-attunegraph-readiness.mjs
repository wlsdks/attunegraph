import { spawn } from "node:child_process";
import { createWriteStream, lstatSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  createReadinessToolchain,
  inspectReadinessSubject,
  READINESS_CAPTURE_SCHEMA,
  READINESS_CHECK_SCHEMA,
  READINESS_GATES,
  sha256
} from "./score-attunegraph-readiness.mjs";

const CHECKS_BY_NAME = new Map(
  READINESS_GATES.flatMap((gate) => gate.checks.map((name) => [name, gate.name]))
);
const CAPTURE_ARGUMENTS = new Set([
  "attunegraph-repository",
  "cwd",
  "muse-gitlink",
  "muse-repository",
  "name",
  "output-directory"
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
  if (separator < 0) captureError("a -- separator and exact command argv are required");
  const optionArguments = args.slice(0, separator);
  const argv = args.slice(separator + 1);
  if (argv.length === 0 || argv[0].length === 0 || argv.some((argument) => argument.includes("\0"))) {
    captureError("exact command argv must contain a non-empty executable and no NUL bytes");
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
  return Object.freeze({
    argv: Object.freeze(argv),
    attunegraphRepository: values.get("attunegraph-repository"),
    cwd: values.get("cwd"),
    gate,
    museGitlinkPath: values.get("muse-gitlink") ?? "packages/attunegraph",
    museRepository: values.get("muse-repository"),
    name,
    outputDirectory: values.get("output-directory")
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

async function executeToFiles(argv, cwd, stdoutPath, stderrPath) {
  const stdoutStream = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderrStream = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const startedAt = new Date().toISOString();
  let spawnError = null;
  const outcome = await new Promise((resolveOutcome) => {
    const child = spawn(argv[0], argv.slice(1), {
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
  return {
    ...outcome,
    endedAt: new Date().toISOString(),
    spawnError,
    startedAt
  };
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
  const outcome = await executeToFiles(options.argv, cwd, stdoutPath, stderrPath);
  const after = inspectReadinessSubject(options);
  if (!sameSubject(before.subject, after.subject)) {
    captureError("repository subjects changed while the command was running");
  }
  const stdoutBytes = await readFile(stdoutPath);
  const stderrBytes = await readFile(stderrPath);
  const state = outcome.exitCode === 0 && outcome.signal === null && outcome.spawnError === null
    ? "pass"
    : "fail";
  const result = {
    argv: [...options.argv],
    cwd,
    endedAt: outcome.endedAt,
    exitCode: outcome.exitCode,
    gate: options.gate,
    name: options.name,
    schema: READINESS_CHECK_SCHEMA,
    signal: outcome.signal,
    spawnError: outcome.spawnError,
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
