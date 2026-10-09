// Exercise the actual wrapper, replacing ONLY the designated fake executable.
const cp = require("node:child_process");
const fs = require("node:fs");
const util = require("node:util");
const { pathToFileURL } = require("node:url");
const [wrapper, fixture, fakeExecutable, prompt, report, mode] =
  process.argv.slice(2);
const originalSpawn = cp.spawn;
const originalExec = cp.execFile;
const processes = [];
let extraCliChildren = 0;
let turnStarted = false;
cp.execFile = function (exe, args, options, callback) {
  if (exe !== fakeExecutable) return originalExec(exe, args, options, callback);
  callback(null, "codex-cli 0.155.0-alpha.16.4", "");
};
cp.execFile[util.promisify.custom] = async function (exe, args, options) {
  if (exe === fakeExecutable)
    return { stdout: "codex-cli 0.155.0-alpha.16.4", stderr: "" };
  return util.promisify(originalExec)(exe, args, options);
};
cp.spawn = function (exe, args, options) {
  if (exe !== fakeExecutable) {
    if (exe === process.execPath && args[0]?.endsWith("cli.cjs"))
      extraCliChildren++;
    return originalSpawn(exe, args, options);
  }
  const config = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c") continue;
    const raw = args[++i];
    const split = raw.indexOf("=");
    const parts = raw.slice(0, split).split(".");
    let target = config;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = JSON.parse(raw.slice(split + 1));
  }
  const child = originalSpawn(process.execPath, [fixture], {
    ...options,
    env: {
      ...process.env,
      GP_TEST_CONFIG: JSON.stringify(config),
      GP_TEST_MODE: mode,
    },
  });
  processes.push(child.pid);
  child.stdout.on("data", (chunk) => {
    if (!turnStarted && chunk.toString().includes("turn/started")) {
      turnStarted = true;
      setTimeout(() => process.emit("SIGINT"), 20);
    }
  });
  return child;
};
process.on("exit", () => {
  const active = processes.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  fs.writeFileSync(
    report,
    JSON.stringify({
      spawned: processes.length,
      active,
      extraCliChildren,
      turnStarted,
    }),
  );
});
process.argv = [
  process.execPath,
  wrapper,
  "--fixture",
  "--codex",
  fakeExecutable,
  "--prompt-file",
  prompt,
  "--at",
  "2026-09-26T08:00:00+08:00",
];
import(pathToFileURL(wrapper).href);
