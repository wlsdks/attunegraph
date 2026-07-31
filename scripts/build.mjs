import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const compilerRoot = dirname(require.resolve("@typescript/native/package.json"));
const compilerEntrypoint = join(compilerRoot, "bin", "tsc");

/**
 * Build into a same-filesystem staging directory and publish only a complete
 * result. A failed compiler invocation leaves the previous dist untouched.
 */
export function publishBuild({
  stagingParent,
  distRoot,
  runCompiler
}) {
  mkdirSync(stagingParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(stagingParent, ".attunegraph-dist-stage-"));
  const backupRoot = join(stagingParent, `.attunegraph-dist-backup-${randomUUID()}`);
  let previousMoved = false;
  let stagingPublished = false;

  try {
    const result = runCompiler(stagingRoot);
    if (result.status !== 0) {
      throw new Error(`TypeScript build failed with status ${String(result.status)}`);
    }

    if (existsSync(distRoot)) {
      renameSync(distRoot, backupRoot);
      previousMoved = true;
    }

    try {
      renameSync(stagingRoot, distRoot);
      stagingPublished = true;
    } catch (cause) {
      if (previousMoved) {
        renameSync(backupRoot, distRoot);
        previousMoved = false;
      }
      throw cause;
    }

    if (previousMoved) {
      rmSync(backupRoot, { force: true, recursive: true });
      previousMoved = false;
    }
  } finally {
    if (!stagingPublished) {
      rmSync(stagingRoot, { force: true, recursive: true });
    }
    if (previousMoved && !existsSync(distRoot)) {
      renameSync(backupRoot, distRoot);
    }
  }
}

export function compilerInvocation(stagingRoot) {
  return {
    args: [
      compilerEntrypoint,
      "-p",
      "tsconfig.build.json",
      "--pretty",
      "false",
      "--outDir",
      stagingRoot
    ],
    command: process.execPath
  };
}

function runCompiler(stagingRoot) {
  const invocation = compilerInvocation(stagingRoot);
  const result = spawnSync(
    invocation.command,
    invocation.args,
    {
      cwd: packageRoot,
      stdio: "inherit"
    }
  );
  if (result.error) throw result.error;
  return { status: result.status ?? 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    publishBuild({
      distRoot: join(packageRoot, "dist"),
      stagingParent: packageRoot,
      runCompiler
    });
  } catch (cause) {
    console.error(cause);
    process.exitCode = 1;
  }
}
