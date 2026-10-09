import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outfile = resolve(root, "artifacts/agent-tools/cli.cjs");
await build({
  absWorkingDir: root,
  entryPoints: ["packages/agent/cli.ts"],
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
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: { code: "CLI_START_FAILED", message: "工具进程无法启动" },
    }) + "\n",
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
