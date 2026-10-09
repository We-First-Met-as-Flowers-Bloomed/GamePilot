import { build } from "esbuild";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const outfile = resolve("artifacts/acceptance-tool/audit.cjs");
await build({
  entryPoints: ["packages/acceptance/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
});
const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (e) => {
  console.error(e);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
