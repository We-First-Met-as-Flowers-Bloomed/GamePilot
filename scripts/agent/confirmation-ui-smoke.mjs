import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Public runner: node scripts/agent/confirmation-ui-smoke.mjs
// All bundles, browser data and evidence stay below artifacts; no real engine.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const run = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = join(root, "artifacts/agent-confirmation-ui", run);
const require = createRequire(import.meta.url);
await mkdir(join(evidence, "profile"), { recursive: true });
async function hashes() {
  const directory = join(homedir(), ".gamepilot");
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const result = {};
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      result[entry.name] = createHash("sha256")
        .update(await readFile(join(directory, entry.name)))
        .digest("hex");
    }
  }
  return result;
}
const before = await hashes();
let child;
let timer;
let runnerError;
try {
  await build({
    entryPoints: [
      join(root, "scripts/agent/confirmation-ui-smoke/renderer.tsx"),
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: join(evidence, "renderer.js"),
    jsx: "automatic",
    logLevel: "warning",
  });
  for (const name of ["main", "preload"])
    await build({
      entryPoints: [
        join(root, `scripts/agent/confirmation-ui-smoke/${name}.ts`),
      ],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: join(evidence, `${name}.cjs`),
      logLevel: "warning",
    });
  await writeFile(
    join(evidence, "index.html"),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>Confirmation UI · isolated test</title><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>',
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require("electron"), [join(evidence, "main.cjs")], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let logs = "";
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  const code = await new Promise((resolveExit, reject) => {
    child.on("error", reject);
    child.on("exit", resolveExit);
    timer = setTimeout(
      () => reject(new Error("Confirmation UI timed out after 90 seconds")),
      90000,
    );
  });
  await writeFile(join(evidence, "electron.log"), logs);
  if (code !== 0) throw new Error(`Electron exited ${code}`);
  const result = JSON.parse(
    await readFile(join(evidence, "result.json"), "utf8"),
  );
  if (!result.passed) throw new Error("UI assertions incomplete");
  console.log(
    `Confirmation UI passed ${result.checks.length} checks. Evidence: ${evidence}`,
  );
} catch (error) {
  runnerError = error;
  process.exitCode = 1;
  await writeFile(
    join(evidence, "runner-error.txt"),
    error.stack ?? String(error),
  );
  console.error(
    `Confirmation UI failed: ${error.message}. Evidence: ${evidence}`,
  );
} finally {
  clearTimeout(timer);
  if (child?.pid && child.exitCode === null) {
    // Kill only this owned test process tree; never touch ordinary app sessions.
    if (process.platform === "win32") {
      await new Promise((done) =>
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).on("exit", done),
      );
    } else child.kill("SIGKILL");
  }
  const after = await hashes();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  await writeFile(
    join(evidence, "production-config-hashes.json"),
    JSON.stringify({ before, after, unchanged }, null, 2),
  );
  await writeFile(
    join(evidence, "runner.json"),
    JSON.stringify(
      {
        pid: child?.pid,
        isolatedUserData: join(evidence, "profile"),
        debugPortOpened: false,
        productionConfigurationUnchanged: unchanged,
        failed: Boolean(runnerError),
        endedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (!unchanged) {
    process.exitCode = 1;
    console.error(
      "Production JSON hashes changed during test; inspect evidence.",
    );
  }
}
