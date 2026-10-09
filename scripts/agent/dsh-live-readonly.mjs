import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const directory = resolve("artifacts/dsh-live-readonly");
await mkdir(directory, { recursive: true });
await build({
  entryPoints: ["scripts/agent/dsh-live-readonly.ts"],
  outfile: `${directory}/main.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
const require = createRequire(import.meta.url);
const child = spawn(require("electron"), [directory + "/main.cjs"], {
  windowsHide: true,
  stdio: "inherit",
});
const timer = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 270000);
child.on("error", () => {
  clearTimeout(timer);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timer);
  process.exitCode = code ?? 1;
});
