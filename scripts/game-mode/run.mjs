/** Legacy child entry; App owns the engine and device lifecycle. */
import { runGameMode } from "../game-mode.mjs";
const args = process.argv.slice(2);
if (!args.includes("--game")) args.push("--game", "onmyoji");
if (!args.includes("--lane")) args.push("--lane", "lane-a");
try {
  process.exitCode = await runGameMode(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
