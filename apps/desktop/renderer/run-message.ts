import type { RunEvent } from "../../../packages/protocol";
const chains: Record<string, string> = {
  StartUp: "启动与上号",
  Recruit: "公开招募",
  Fight: "理智作战",
  Infrast: "基建",
  Mall: "好友与信用",
  Award: "奖励领取",
  CloseDown: "退出游戏",
};
// Keep native diagnostic payloads in history; the daily view shows milestones.
export function runMessage(event: RunEvent): string | null {
  const match = /^MAA (\d+): (.+)$/s.exec(event.message);
  if (!match) return event.message.replace(/全部任务已完成$/, "本次请求已完成");
  try {
    const details = JSON.parse(match[2]);
    const title = chains[details.taskchain];
    if (!title) return null;
    if (match[1] === "10001") return `正在执行 · ${title}`;
    if (match[1] === "10002") return `步骤完成 · ${title}`;
    if (match[1] === "10000")
      return `步骤失败 · ${title}，请检查游戏画面；原始诊断保留在执行记录中`;
  } catch {
    /* Unknown native payloads remain available in detailed history. */
  }
  return null;
}
