import { build as bundle } from "esbuild";
import { build as renderer } from "vite";
import { cp } from "node:fs/promises";
await cp("games/onmyoji/resources", "dist/resources/onmyoji", {
  recursive: true,
});
await import("./build-bridge.mjs");
await renderer();
for (const [entry, outfile] of [
  ["apps/desktop/main/index.ts", "dist/main/index.cjs"],
  ["apps/desktop/preload/index.ts", "dist/preload/index.cjs"],
  ["packages/runtime/worker.ts", "dist/worker/index.cjs"],
]) {
  await bundle({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron", "@maaxyz/maa-node"],
    sourcemap: true,
  });
}
