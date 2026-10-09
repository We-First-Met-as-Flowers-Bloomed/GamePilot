import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm } from "node:fs/promises";
const require = createRequire(import.meta.url);
const liveModel = process.argv.includes("--model");
const configured = process.argv.includes("--configured");
const recorded = process.argv.includes("--recorded");
if (configured && recorded) throw Error("choose one data source");
const evidence =
  (liveModel ? "artifacts/agent-ui" : "artifacts/agent-ui-replay") +
  (recorded ? "-recorded" : configured ? "-configured" : "");
await mkdir(evidence, { recursive: true });
for (const file of ["result.json", "error.txt", "planner-result.json"])
  await rm(`${evidence}/${file}`, { force: true });
const child = spawn(
  require("electron"),
  [
    ".",
    "--planner-ui-test",
    "--hidden",
    ...(liveModel ? ["--planner-model-test"] : []),
    ...(configured ? ["--planner-configured-test"] : []),
    ...(recorded ? ["--planner-recorded-test"] : []),
  ],
  { stdio: "inherit", windowsHide: true },
);
const timer = setTimeout(() => {
  console.error("Planner UI test timed out");
  child.kill();
  process.exitCode = 1;
}, 270000);
child.on("error", () => {
  clearTimeout(timer);
  process.exitCode = 1;
});
child.on("exit", async (code) => {
  clearTimeout(timer);
  try {
    if (code !== 0) throw new Error(`Electron exited ${code}`);
    const result = JSON.parse(
      await readFile(`${evidence}/result.json`, "utf8"),
    );
    if (
      !result.gameRejected ||
      !result.confirmationRejected ||
      !result.cancelVerified ||
      !result.navigationVerified ||
      !result.staleHidden ||
      !result.keyboardFocus ||
      !result.sourceSwitchVerified
    )
      throw new Error("UI assertions incomplete");
    console.log(
      `Planner UI passed: ${result.cards} result cards; model ${result.state.result.model}; no game execution; cancellation and navigation verified.`,
    );
  } catch (error) {
    process.exitCode = 1;
    console.error(
      await readFile(`${evidence}/error.txt`, "utf8").catch(() =>
        String(error),
      ),
    );
  }
});
