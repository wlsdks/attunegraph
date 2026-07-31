import { execFileSync, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
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

function capture(fixture, argv = [], overrides = {}) {
  return spawnSync(process.execPath, [
    CAPTURE_ENTRYPOINT,
    `--name=${overrides.name ?? "inspect"}`,
    `--output-directory=${overrides.output ?? fixture.output}`,
    `--attunegraph-repository=${fixture.attunegraph}`,
    `--muse-repository=${fixture.muse}`,
    `--cwd=${overrides.cwd ?? fixture.attunegraph}`,
    ...(overrides.producerMode ? [`--producer-mode=${overrides.producerMode}`] : []),
    "--",
    ...argv
  ], { encoding: "utf8", timeout: 20_000, env: overrides.env ?? process.env });
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
  it("captures an unavailable fixed contract only as local-unattested not-run", async () => {
    await withFixture(async (fixture) => {
      const result = capture(fixture);
      expect(result.status).toBe(0);
      const descriptor = JSON.parse(result.stdout);
      const captured = JSON.parse(await readFile(join(fixture.output, descriptor.check.result.path), "utf8"));
      expect(captured).toMatchObject({
        command: {
          availability: "unavailable",
          cwdRole: "attunegraph",
          id: "attunegraph-readiness-check-contract@1:inspect",
          parameters: {}
        },
        executable: null,
        exitCode: null,
        provenance: { kind: "local-unattested" },
        state: "not-run"
      });
      expect(Buffer.from(await readFile(join(fixture.output, captured.stdout.path)))).toHaveLength(0);
      expect(Buffer.from(await readFile(join(fixture.output, captured.stderr.path)))).toHaveLength(0);
      expect(isAbsolute(captured.cwd)).toBe(true);
      expect(await readFile(join(captured.cwd, "attunegraph.txt"), "utf8")).toBe("attunegraph.txt\n");
      expect(statSync(captured.cwd).isDirectory()).toBe(true);
    });
  });

  it.each([
    ["node --version", [process.execPath, "--version"]],
    ["node synthetic pass", [process.execPath, "-e", "process.exit(0)"]]
  ])("refuses substitute argv: %s", async (_label, argv) => {
    await withFixture(async (fixture) => {
      const result = capture(fixture, argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/unavailable.*substitute argv/u);
    });
  });

  it("refuses /usr/bin/true when present", async () => {
    if (process.platform === "win32") return;
    await withFixture(async (fixture) => {
      const result = capture(fixture, ["/usr/bin/true"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/substitute argv/u);
    });
  });

  it("ignores a fake PATH executable and records the actual fixed child identity", async () => {
    await withFixture(async (fixture) => {
      const fakeBin = join(fixture.directory, "fake-bin");
      await mkdir(fakeBin);
      await writeFile(join(fakeBin, process.platform === "win32" ? "node.cmd" : "node"), "fake\n");
      const result = capture(fixture, [
        "node",
        "scripts/run-working-graph-readiness.mjs",
        "--check=working-graph-golden-corpus"
      ], {
        name: "working-graph-golden-corpus",
        env: { ...process.env, PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` }
      });
      expect(result.status).toBe(0);
      const descriptor = JSON.parse(result.stdout);
      const captured = JSON.parse(await readFile(join(fixture.output, descriptor.check.result.path), "utf8"));
      expect(captured.state).toBe("fail");
      expect(captured.executable).toMatchObject({ path: expect.any(String), version: process.version });
      expect(captured.executable.path).not.toContain("fake-bin");
    });
  });

  it("refuses self-asserted GitHub attestation producer mode", async () => {
    await withFixture(async (fixture) => {
      const result = capture(fixture, [], { producerMode: "github-actions-attested" });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/external cryptographic verification/u);
    });
  });

  it("requires the contract's canonical repository role", async () => {
    await withFixture(async (fixture) => {
      const result = capture(fixture, [], { cwd: fixture.muse });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/canonical attunegraph repository root/u);
    });
  });
});
