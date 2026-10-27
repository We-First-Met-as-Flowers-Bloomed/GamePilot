/** Compatibility entry: routine execution is managed by the App. */
import { runGameMode } from "./game-mode.mjs";
const args = process.argv.slice(2);
if (args.includes("--step") || args.includes("--tap"))
  throw Error("执行步骤统一在App保存；请在每日任务页选择计划后运行");
if (!args.length || args.includes("--list") || args.includes("--dry")) {
  console.log("请在App每日任务页查看阴阳师技能和计划；本入口不直接操作游戏。");
} else {
  if (args.includes("--game")) throw Error("阴阳师入口不接受游戏覆盖");
  process.exitCode = await runGameMode([...args, "--game", "onmyoji"]);
}
