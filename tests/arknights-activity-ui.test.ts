import { beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

let results: { name: string; passed: boolean; error?: string }[];
beforeAll(async () => {
  const evidenceRoot = resolve("artifacts/arknights-activity-ui");
  await mkdir(evidenceRoot, { recursive: true });
  const directory = await mkdtemp(join(evidenceRoot, "run-"));
  const require = createRequire(import.meta.url);
  let axePath: string;
  try {
    axePath = require.resolve("axe-core/axe.min.js");
  } catch {
    axePath = resolve(
      "artifacts/ui-a11y-tools/node_modules/axe-core/axe.min.js",
    );
  }
  await writeFile(join(directory, "axe.min.js"), await readFile(axePath));
  await Promise.all([
    build({
      entryPoints: ["tests/arknights-activity-ui-fixture/renderer.tsx"],
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: join(directory, "renderer.js"),
      jsx: "automatic",
      logLevel: "silent",
    }),
    build({
      entryPoints: ["tests/arknights-activity-ui-fixture/main.ts"],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: join(directory, "main.cjs"),
      logLevel: "silent",
    }),
  ]);
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><title>活动关卡组件测试</title><link rel="stylesheet" href="renderer.css"></head><body><main style="max-width:900px;margin:32px auto;padding:24px"><h1>活动关卡测试</h1><div id="fixture"></div></main><script src="axe.min.js"></script><script src="renderer.js"></script></body></html>',
  );
  const electron = require("electron") as string;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((done, reject) => {
    const child = spawn(electron, [join(directory, "main.cjs")], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(Error(`activity renderer timed out: ${output}`));
    }, 30000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) done();
      else reject(Error(`activity renderer exit ${code}: ${output}`));
    });
  });
  ({ results } = JSON.parse(
    await readFile(join(directory, "result.json"), "utf8"),
  ));
}, 45000);

it.each([
  "does not sync until the user requests it",
  "supports missing and null desktop APIs",
  "shows sync failures and allows retry",
  "disables expired future and incompatible stages",
  "preserves the original stage and deduplicates the fight queue",
  "does not apply late catalog responses to another profile on the same client",
  "clears cached catalog and old callback when switching accounts",
  "ignores stale errors when changing game clients",
  "selects only open compatible official mini-games and preserves other options",
  "rejects a mini-game that expires after the catalogue was rendered",
  "does not apply late mini-game catalogues to another account",
  "edits operator upgrade targets through real React state without granting implicit consent",
  "switches operator upgrade accounts without retaining another account targets or consent",
  "has no serious accessibility violations in operator upgrade settings",
  "edits ordinary copilot queues and explicit potion consent through real React state",
  "does not retain ordinary copilot drafts or potion consent when switching accounts",
  "has no serious accessibility violations in ordinary copilot settings",
  "has no serious accessibility violations",
])("activity stages with real React state: %s", (name) => {
  const result = results.find((item) => item.name === name);
  expect(result, name).toBeDefined();
  expect(result?.passed, result?.error).toBe(true);
});
