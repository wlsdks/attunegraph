import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectEntrypoint } from "./direct-entrypoint.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_RUNTIME_FILES = Object.freeze([
  "dist/index.js",
  "dist/testing.js",
  "dist/local.js",
  "dist/attunegraph-backend.js",
  "dist/source-adapter.js",
  "dist/admin.js",
  "dist/readonly-working-graph.js",
  "dist/extension-kit.js",
  "dist/attunegraph-portable-encoder.js",
  "dist/attunegraph-portable-decoder.js"
]);

function escapesRoot(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(path) === resolve(root);
}

function requireRegularRuntimeFile(packageRoot, relativePath) {
  const lexical = resolve(packageRoot, ...relativePath.split("/"));
  let stat;
  let canonical;
  try {
    stat = lstatSync(lexical);
    canonical = realpathSync(lexical);
  } catch {
    throw new Error(`AttuneGraph runtime is incomplete: ${relativePath} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`AttuneGraph runtime is incomplete: ${relativePath} must be a regular non-symlink file`);
  }
  if (escapesRoot(realpathSync(packageRoot), canonical)) {
    throw new Error(`AttuneGraph runtime is incomplete: ${relativePath} escapes the package root`);
  }
}

function runCheckedInBuild(packageRoot) {
  const buildScript = join(packageRoot, "scripts", "build.mjs");
  if (!existsSync(buildScript)) {
    throw new Error("AttuneGraph source checkout is missing scripts/build.mjs");
  }
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: packageRoot,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`AttuneGraph source build failed with status ${String(result.status)}`);
  }
}

export function prepareAttuneGraphRuntime({
  packageRoot = PACKAGE_ROOT,
  runSourceBuild = runCheckedInBuild
} = {}) {
  const canonicalRoot = realpathSync(packageRoot);
  const sourceCheckout = existsSync(join(canonicalRoot, "src"))
    && existsSync(join(canonicalRoot, "tsconfig.build.json"));
  if (sourceCheckout) runSourceBuild(canonicalRoot);
  for (const relativePath of REQUIRED_RUNTIME_FILES) {
    requireRegularRuntimeFile(canonicalRoot, relativePath);
  }
  return Object.freeze({
    mode: sourceCheckout ? "source-build" : "installed-artifact",
    runtimeFiles: REQUIRED_RUNTIME_FILES
  });
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  try {
    prepareAttuneGraphRuntime();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
