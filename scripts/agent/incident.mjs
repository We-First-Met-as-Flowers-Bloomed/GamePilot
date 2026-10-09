import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
const outfile = resolve(root, "artifacts/agent-incidents/cli.cjs");
await build({
  absWorkingDir: root,
  entryPoints: ["packages/agent/incident-cli.ts"],
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
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
