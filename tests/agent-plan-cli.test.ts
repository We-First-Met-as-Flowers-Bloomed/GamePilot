import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
let root: string;
let cli: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "gp-plan-cli-test-"));
  cli = join(root, "cli.cjs");
  const result = await build({
    entryPoints: ["packages/agent/plan-cli.ts"],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "cjs",
    metafile: true,
  });
  expect(Object.keys(result.metafile!.inputs).join("\n")).not.toMatch(
    /snapshot\.ts|packages\/runtime\/(?:worker|device|maa)\.|apps\/desktop\/main|maa-node|electron/,
  );
});
afterAll(async () => {
  const rel = relative(resolve(tmpdir()), resolve(root));
  if (rel && !rel.startsWith("..") && !isAbsolute(rel))
    await rm(root, { recursive: true, force: true });
});
async function run(args: string[]) {
  try {
    const r = await promisify(execFile)(process.execPath, [cli, ...args], {
      windowsHide: true,
    });
    return { code: 0, value: JSON.parse(r.stdout) };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    expect(e.stderr).toBe("");
    return { code: e.code, value: JSON.parse(e.stdout) };
  }
}
it("requires explicit fixture mode and rejects production data flags", async () => {
  for (const args of [[], ["--fixture", "--data", "PRIVATE"]]) {
    expect(await run(args)).toMatchObject({
      code: 1,
      value: {
        ok: false,
        canExecute: false,
        execution: "not-started",
        error: { code: "INVALID_ARGUMENTS" },
      },
    });
  }
});
it("rejects an unsupported executable version without calling a model", async () => {
  const prompt = join(root, "prompt.txt");
  await writeFile(prompt, "查看合成账号");
  const r = await run([
    "--fixture",
    "--codex",
    process.execPath,
    "--prompt-file",
    prompt,
    "--at",
    "2026-09-26T08:00:00+08:00",
  ]);
  expect(r).toMatchObject({
    code: 1,
    value: { error: { code: "UNSUPPORTED_CODEX" } },
  });
  expect(JSON.stringify(r)).not.toContain(root);
});

it.each([
  ["cancel", "CANCELLED", true],
  ["auth", "AUTH_REQUIRED", false],
  ["drift", "ISOLATION_FAILED", false],
])(
  "wrapper cleans up Codex on %s without starting game work",
  async (mode, code, started) => {
    const prompt = join(root, `prompt-${mode}.txt`);
    const report = join(root, `report-${mode}.json`);
    await writeFile(prompt, "查询合成账号");
    let output = "";
    try {
      await promisify(execFile)(
        process.execPath,
        [
          resolve("tests/helpers/codex-wrapper-driver.cjs"),
          resolve("scripts/agent/plan.mjs"),
          resolve("tests/helpers/codex-fixture.cjs"),
          join(root, "fake-codex.exe"),
          prompt,
          report,
          String(mode),
        ],
        { windowsHide: true, timeout: 15000 },
      );
      throw new Error("expected failure");
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      expect(e.code).toBe(1);
      expect(e.stderr).toBe("");
      output = e.stdout;
    }
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      execution: "not-started",
      error: { code },
    });
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      spawned: 2,
      active: [],
      extraCliChildren: 0,
      turnStarted: started,
    });
  },
  20000,
);
