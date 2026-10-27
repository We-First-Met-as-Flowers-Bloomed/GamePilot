/**
 * 锚点审计入口：先构建纯判据包（scripts/anchors/checks.ts），再在子进程里跑审计。
 *
 *   npm run anchors:audit -- <帧目录> [--json]
 *
 * 为什么分两个进程：esbuild 与 onnxruntime（MaaFramework OCR）在同一进程内共存会让
 * 原生层以 0xC0000409 崩溃；实测“父进程构建 + 子进程执行”稳定，与 scripts/agent/run.mjs 同构。
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const outfile = resolve(root, "artifacts/anchors-audit/checks.mjs");
await build({
  absWorkingDir: root,
  entryPoints: ["scripts/anchors/checks.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
const child = spawn(
  process.execPath,
  [resolve(root, "scripts/anchors/run.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit", windowsHide: true },
);
child.on("error", () => {
  console.error("锚点审计进程无法启动");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
