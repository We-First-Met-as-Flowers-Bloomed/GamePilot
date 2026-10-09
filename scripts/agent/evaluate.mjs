import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../../", import.meta.url));
process.chdir(root);
const outfile = resolve(root, "artifacts/agent-evaluations/cli.cjs");
await build({
  absWorkingDir: root,
  entryPoints: ["packages/agent/evaluation/cli.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
});
await import(pathToFileURL(outfile).href);
