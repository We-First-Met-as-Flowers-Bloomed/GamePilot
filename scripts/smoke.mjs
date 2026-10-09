import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await mkdir("artifacts", { recursive: true });
for (const file of ["artifacts/smoke-result.json", "artifacts/smoke-error.txt"])
  await rm(file, { force: true });
const child = spawn(require("electron"), [".", "--smoke"], {
  stdio: "inherit",
  windowsHide: true,
});
const timer = setTimeout(() => {
  child.kill();
  console.error("Desktop smoke timed out");
  process.exitCode = 1;
}, 90000);
child.on("error", (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  clearTimeout(timer);
  try {
    if (code !== 0) throw new Error(`Electron exited: ${code}`);
    const result = JSON.parse(
      await readFile("artifacts/smoke-result.json", "utf8"),
    );
    if (
      !result.onmyojiDailyReady ||
      !result.arkDailyReady ||
      result.taskRuns?.length !== 2 ||
      !result.replayRejected ||
      !result.cancelledBeforeStart ||
      !result.rehearsalInspectionRejected ||
      !result.continuationRejected ||
      result.mergedProgress?.wholePlanComplete !== false ||
      result.mergedProgress?.outcome !== "unconfirmed" ||
      result.continuationPreview?.canContinue !== false ||
      !result.resolution?.resolution ||
      result.review?.canResume !== false ||
      result.execution?.status !== "cancelled" ||
      !result.events.some((event) => event.status === "cancelled")
    )
      throw new Error("Smoke assertions incomplete");
    console.log(
      `Desktop smoke passed. MaaFramework ${result.engine.version}; cancellation acknowledged; validated Onmyoji and Arknights daily plans registered.`,
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
