import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Public runner: node scripts/agent/goal-ui-smoke.mjs
// No production main or configuration is loaded. Every IPC response is an owned fixture.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = join(
  root,
  "artifacts/agent-goal-ui",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
await mkdir(join(directory, "profile"), { recursive: true });
const require = createRequire(import.meta.url);
const audit = process.argv.slice(2).includes("--a11y");
if (process.argv.slice(2).some((arg) => arg !== "--a11y"))
  throw new Error("Unsupported goal smoke argument");
let axePath;
if (audit) {
  try {
    axePath = require.resolve("axe-core/axe.min.js");
  } catch {
    axePath = join(
      root,
      "artifacts/ui-a11y-tools/node_modules/axe-core/axe.min.js",
    );
  }
  const metadata = JSON.parse(
    await readFile(join(dirname(axePath), "package.json"), "utf8"),
  );
  if (metadata.name !== "axe-core" || metadata.version !== "4.10.3")
    throw new Error("Use fixed axe-core 4.10.3 for reproducible UI checks");
}
let child, timeout, error;
let logs = "";
try {
  const bundles = [];
  for (const name of ["renderer", "main", "preload"]) {
    const renderer = name === "renderer";
    const result = await build({
      entryPoints: [
        join(
          root,
          `scripts/agent/goal-ui-smoke/${name}.${renderer ? "tsx" : "ts"}`,
        ),
      ],
      bundle: true,
      platform: renderer ? "browser" : "node",
      format: renderer ? "iife" : "cjs",
      external: renderer ? [] : ["electron"],
      outfile: join(directory, `${name}.${renderer ? "js" : "cjs"}`),
      jsx: "automatic",
      logLevel: "warning",
      metafile: true,
    });
    bundles.push({ name, inputs: Object.keys(result.metafile.inputs) });
  }
  await writeFile(
    join(directory, "bundle-inputs.json"),
    JSON.stringify(bundles, null, 2),
  );
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; img-src \'self\' data:; script-src \'self\'; style-src \'self\'; connect-src \'self\'; object-src \'none\'; base-uri \'self\'"><title>GamePilot goals · isolated verification</title><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>',
  );
  const env = { ...process.env };
  if (axePath) env.GAMEPILOT_UI_AXE = axePath;
  else delete env.GAMEPILOT_UI_AXE;
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(require("electron"), [join(directory, "main.cjs")], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    logs += data;
  });
  child.stderr.on("data", (data) => {
    logs += data;
  });
  const code = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("exit", done);
    timeout = setTimeout(
      () => reject(Error("Goal UI verification timed out")),
      audit ? 300000 : 90000,
    );
  });
  if (code !== 0) throw Error(`Electron exited ${code}`);
  const result = JSON.parse(
    await readFile(join(directory, "result.json"), "utf8"),
  );
  if (!result.passed) throw Error("Goal UI assertions incomplete");
  console.log(
    `Goal UI passed ${result.checks.length} checks. Evidence: ${directory}`,
  );
} catch (failure) {
  error = failure;
  process.exitCode = 1;
  await writeFile(
    join(directory, "runner-error.txt"),
    failure.stack ?? String(failure),
  );
  console.error(`Goal UI failed: ${failure.message}. Evidence: ${directory}`);
} finally {
  clearTimeout(timeout);
  if (child?.pid && child.exitCode === null) {
    if (process.platform === "win32")
      await new Promise((done) =>
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).on("exit", done),
      );
    else child.kill("SIGKILL");
  }
  await writeFile(join(directory, "electron.log"), logs);
  await writeFile(
    join(directory, "runner.json"),
    JSON.stringify(
      {
        pid: child?.pid,
        isolatedUserData: join(directory, "profile"),
        debugPortOpened: false,
        productionMainLoaded: false,
        productionConfigurationOpened: false,
        scope:
          "Production renderer App, Chat and GoalCards in Electron with fixed synthetic IPC; component integration only, no real main backend, model or game execution.",
        failed: !!error,
        endedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
