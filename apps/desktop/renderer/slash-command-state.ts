import { chatCommand } from "./chat-state";

export const slashCommands = [
  { command: "/daily", label: "打开每日计划", detail: "查看保存的任务开关" },
  {
    command: "/devices",
    label: "打开设备与账号",
    detail: "查看设备连接与账号",
  },
  { command: "/settings", label: "打开设置", detail: "定时、外观与连接设置" },
  {
    command: "/stop",
    label: "停止全部任务",
    detail: "发送宿主停止请求，以实际状态为准",
  },
  {
    command: "/run-daily",
    label: "运行保存日常",
    detail: "先核对宿主清单，再确认运行",
  },
  {
    command: "/continue",
    label: "继续原失败请求",
    detail: "选择原请求并核对续跑范围",
  },
  {
    command: "/pause-after-step",
    label: "当前步骤后暂停",
    detail: "通过宿主检查暂停范围",
  },
] as const;

export function slashSuggestions(text: string) {
  if (!/^\/[\w-]*$/.test(text)) return [];
  return slashCommands.filter((item) => item.command.startsWith(text));
}

export function slashEnterAction(text: string, selectedCommand: string) {
  return text === selectedCommand ? "send" : "fill";
}

export function localChatCommand(text: string, goalsAvailable: boolean) {
  const command = chatCommand(text);
  return goalsAvailable &&
    !text.trim().startsWith("/") &&
    (command === "saved-daily" || command === "continue")
    ? undefined
    : command;
}

export function nextCommandIndex(index: number, count: number, key: string) {
  if (!count) return 0;
  return (index + (key === "ArrowUp" ? -1 : 1) + count) % count;
}

export function commandMatches(text: string, query: string) {
  const haystack = text.toLocaleLowerCase();
  let cursor = 0;
  for (const char of query.toLocaleLowerCase().replace(/\s/g, "")) {
    const index = haystack.indexOf(char, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

export function isComposingKey(event: {
  isComposing?: boolean;
  keyCode?: number;
}) {
  return event.isComposing === true || event.keyCode === 229;
}
