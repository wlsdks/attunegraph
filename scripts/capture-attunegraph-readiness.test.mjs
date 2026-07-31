import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CAPTURE_ENTRYPOINT = fileURLToPath(new URL("./capture-attunegraph-readiness.mjs", import.meta.url));

function git(repository, arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" }).trim();
}

async function initializeRepository(path, filename) {
  git(path, ["init", "-q"]);
  git(path, ["config", "user.email", "capture@example.test"]);
  git(path, ["config", "user.name", "Capture Test"]);
  await writeFile(join(path, filename), `${filename}\n`);
  git(path, ["add", filename]);
  git(path, ["commit", "-qm", `add ${filename}`]);
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "attunegraph-capture-v2-"));
  const attunegraph = join(directory, "attunegraph");
  const muse = join(directory, "muse");
  const output = join(directory, "evidence");
  await Promise.all([mkdir(attunegraph), mkdir(muse)]);
  await initializeRepository(attunegraph, "attunegraph.txt");
  await initializeRepository(muse, "muse.txt");
  git(muse, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", attunegraph, "packages/attunegraph"]);
  git(muse, ["add", ".gitmodules", "packages/attunegraph"]);
  git(muse, ["commit", "-qm", "bind AttuneGraph gitlink"]);
  return { attunegraph, directory, muse, output };
}

function capture(fixture, argv, overrides = {}) {
  return spawnSync(process.execPath, [
    CAPTURE_ENTRYPOINT,
    `--name=${overrides.name ?? "inspect"}`,
    `--output-directory=${overrides.output ?? fixture.output}`,
    `--attunegraph-repository=${fixture.attunegraph}`,
    `--muse-repository=${fixture.muse}`,
    `--cwd=${fixture.attunegraph}`,
    "--",
    ...argv
  ], { encoding: "utf8", timeout: 20_000 });
}

async function withFixture(callback) {
  const fixture = await createFixture();
  try {
    await callback(fixture);
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
}

describe("AttuneGraph readiness evidence capture v2", () => {
  it("spawns exact argv without a shell and captures immutable process streams", async () => {
    await withFixture(async (fixture) => {
      const shellToken = "$(touch shell-was-used);literal";
      const result = capture(fixture, [
        process.execPath,
        "-e",
        "process.stdout.write(process.argv[1]); process.stderr.write('diagnostic')",
        shellToken
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const descriptor = JSON.parse(result.stdout);
      expect(descriptor).toMatchObject({
        schema: "attunegraph-readiness-capture@2",
        check: { gate: "operability", name: "inspect" }
      });
      const captured = JSON.parse(await readFile(
        join(fixture.output, descriptor.check.result.path),
        "utf8"
      ));
      expect(captured).toMatchObject({
        argv: [process.execPath, "-e", expect.any(String), shellToken],
        cwd: realpathSync(fixture.attunegraph),
        exitCode: 0,
        schema: "attunegraph-readiness-check@2",
        signal: null,
        spawnError: null,
        state: "pass"
      });
      expect(await readFile(join(fixture.output, captured.stdout.path), "utf8")).toBe(shellToken);
      expect(await readFile(join(fixture.output, captured.stderr.path), "utf8")).toBe("diagnostic");
      await expect(readFile(join(fixture.attunegraph, "shell-was-used"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(Date.parse(captured.endedAt)).toBeGreaterThanOrEqual(Date.parse(captured.startedAt));
      expect(captured.toolchain.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(captured.subject.attunegraph.sha).toBe(captured.subject.muse.attunegraphGitlink.sha);
    });
  });

  it("captures nonzero commands as fail evidence without claiming producer failure", async () => {
    await withFixture(async (fixture) => {
      const result = capture(fixture, [process.execPath, "-e", "process.exit(7)"]);
      expect(result.status).toBe(0);
      const descriptor = JSON.parse(result.stdout);
      const captured = JSON.parse(await readFile(join(fixture.output, descriptor.check.result.path), "utf8"));
      expect(captured).toMatchObject({ exitCode: 7, state: "fail" });
    });
  });

  it("refuses dirty subjects before spawning", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.attunegraph, "dirty.txt"), "dirty\n");
      const sentinel = join(fixture.directory, "spawned.txt");
      const result = capture(fixture, [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'yes')`]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/repository is dirty/u);
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses to issue a result when a command changes a repository subject", async () => {
    await withFixture(async (fixture) => {
      const dirtyPath = join(fixture.attunegraph, "command-dirty.txt");
      const result = capture(fixture, [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(dirtyPath)}, 'dirty')`
      ]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/repository is dirty/u);
      await expect(readFile(join(fixture.output, "checks/inspect/result.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses path reuse before a second command can spawn", async () => {
    await withFixture(async (fixture) => {
      expect(capture(fixture, [process.execPath, "--version"]).status).toBe(0);
      const sentinel = join(fixture.directory, "second-spawn.txt");
      const second = capture(fixture, [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'yes')`
      ]);
      expect(second.status).toBe(1);
      expect(second.stderr).toMatch(/already exists/u);
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a symlinked output root", async () => {
    await withFixture(async (fixture) => {
      const outside = join(fixture.directory, "outside");
      const linked = join(fixture.directory, "linked");
      await mkdir(outside);
      await symlink(outside, linked);
      const result = capture(fixture, [process.execPath, "--version"], { output: linked });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/non-symlink/u);
    });
  });

  it("refuses a Muse gitlink that is not the current AttuneGraph subject", async () => {
    await withFixture(async (fixture) => {
      await writeFile(join(fixture.attunegraph, "new.txt"), "new\n");
      git(fixture.attunegraph, ["add", "new.txt"]);
      git(fixture.attunegraph, ["commit", "-qm", "advance AttuneGraph"]);
      const result = capture(fixture, [process.execPath, "--version"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/gitlink does not equal/u);
    });
  });
});
