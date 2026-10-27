/** Legacy launcher: the App owns device admission and lifecycle. */
import { runGameMode } from "../game-mode.mjs";
try {
  process.exitCode = await runGameMode(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
