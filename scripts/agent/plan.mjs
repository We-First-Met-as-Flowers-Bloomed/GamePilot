import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "gamepilot-planner-cli-"));
const outfile = join(directory, "cli.cjs");
try {
  await build({
    absWorkingDir: root,
    entryPoints: ["packages/agent/plan-cli.ts"],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
  });
  // Keep signal handlers and Codex lifecycle in the same process. On Windows,
  // child.kill('SIGINT') force-terminates Node and bypasses its finally cleanup.
  await import(pathToFileURL(outfile).href);
} finally {
  // Import loads the whole bundled module before its asynchronous CLI operation finishes.
  if (
    dirname(resolve(directory)) === temporaryRoot &&
    basename(directory).startsWith("gamepilot-planner-cli-")
  )
    await rm(directory, { recursive: true, force: true });
}
