import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);
let root: string;
let cli: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gp-agent-cli-"));
  cli = join(root, "agent.cjs");
  const result = await build({
    entryPoints: ["packages/agent/cli.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    metafile: true,
  });
  const imports = Object.keys(result.metafile!.inputs).join("\n");
  expect(imports).not.toMatch(
    /packages\/runtime\/(?:worker|maa|device)\.|apps\/desktop\/main\/|maa-node|electron/,
  );
});
afterAll(async () => {
  if (root) {
    const path = relative(resolve(tmpdir()), resolve(root));
    expect(path && !path.startsWith("..") && !isAbsolute(path)).toBeTruthy();
    await rm(root, { recursive: true, force: true });
  }
});
async function run(args: string[]) {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      windowsHide: true,
    });
    return { code: 0, stderr: result.stderr, value: JSON.parse(result.stdout) };
  } catch (error) {
    const e = error as { code: number; stderr: string; stdout: string };
    return { code: e.code, stderr: e.stderr, value: JSON.parse(e.stdout) };
  }
}

it("serves all four tools through a real JSON CLI against explicitly synthetic data", async () => {
  const catalog = await run(["--fixture", "--tool", "list_capabilities"]);
  const env = await run(["--fixture", "--tool", "get_environment"]);
  expect(catalog.code).toBe(0);
  expect(env.value.result.source).toBe("fixture");
  const input = join(root, "draft.json");
  await writeFile(
    input,
    JSON.stringify({
      catalogRevision: catalog.value.result.revision,
      environmentRevision: env.value.result.revision,
      at: "2026-09-26T08:00:00+08:00",
      lanes: [
        {
          laneId: "lane-a",
          games: [
            { gameId: "arknights", parameters: { stage: "LS-6", mail: true } },
            { gameId: "onmyoji" },
          ],
        },
      ],
    }),
  );
  const compiled = await run([
    "--fixture",
    "--tool",
    "compile_plan",
    "--input",
    input,
  ]);
  expect(compiled.code).toBe(0);
  expect(compiled.value.result).toMatchObject({
    status: "valid",
    canExecute: false,
  });
  await writeFile(input, JSON.stringify({ requestId: "fixture:lane-a" }));
  const result = await run([
    "--fixture",
    "--tool",
    "get_run",
    "--input",
    input,
  ]);
  expect(result.value.result.recordedStatus).toBe("unknown");
  expect(result.stderr).toBe("");
});

it("requires an explicit source, rejects writes/unknown args, and emits machine-readable errors", async () => {
  for (const args of [
    ["--tool", "get_environment"],
    ["--fixture", "--data", root, "--tool", "get_environment"],
    ["--fixture", "--tool", "start_run"],
    ["--fixture", "--tool", "list_capabilities", "--execute"],
    ["--fixture", "--tool", "get_environment", "--tool", "get_run"],
  ]) {
    const result = await run(args);
    expect(result.code).not.toBe(0);
    expect(result.value.ok).toBe(false);
    expect(result.value.error.code).toBeTruthy();
  }
});

it("reports missing disk data without creating it and does not echo private input paths", async () => {
  const missing = join(root, "PRIVATE-not-created");
  const before = await readdir(root);
  const result = await run(["--data", missing, "--tool", "get_environment"]);
  expect(result.value.result.complete).toBe(false);
  expect(JSON.stringify(result.value)).not.toContain(missing);
  expect(await readdir(root)).toEqual(before);
  const invalid = join(root, "bad-input.json");
  await writeFile(invalid, "PRIVATE invalid json");
  const bad = await run([
    "--fixture",
    "--tool",
    "compile_plan",
    "--input",
    invalid,
  ]);
  expect(bad.code).not.toBe(0);
  expect(JSON.stringify(bad.value)).not.toContain("PRIVATE");
  expect(await readFile(invalid, "utf8")).toBe("PRIVATE invalid json");
});
