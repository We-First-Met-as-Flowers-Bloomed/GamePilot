import type { AgentEvent } from "../../../packages/protocol/agent-events";

export const toolKinds = ["tool-requested", "tool-started", "tool-result"];
export interface TraceGroup {
  key: string;
  events: AgentEvent[];
  callId?: string;
}
export function groupTraceEvents(events: AgentEvent[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  const calls = new Map<string, TraceGroup>();
  const unique = new Map(
    events.map((event) => [`${event.requestId}:${event.seq}`, event]),
  );
  for (const event of [...unique.values()].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === "model-usage") continue;
    const isCall = toolKinds.includes(event.kind) && event.callId;
    const key = isCall
      ? JSON.stringify([event.requestId, event.callId])
      : `event-${event.requestId}-${event.seq}`;
    const previous = isCall ? calls.get(key) : undefined;
    if (previous) previous.events.push(event);
    else {
      const group = {
        key,
        events: [event],
        callId: isCall ? event.callId : undefined,
      };
      groups.push(group);
      if (isCall) calls.set(key, group);
    }
  }
  return groups;
}
export function measuredDuration(value?: number) {
  return value === undefined || !Number.isFinite(value) || value < 0
    ? "耗时未记录"
    : value > 0 && value < 1
      ? "小于 1 毫秒"
      : value < 1000
        ? `${Math.round(value)} 毫秒`
        : `${Number((value / 1000).toFixed(2))} 秒`;
}
export function callDuration(group: TraceGroup) {
  return [...group.events]
    .reverse()
    .find((event) => event.details?.durationMs !== undefined)?.details
    ?.durationMs;
}
export function traceSummary(events: AgentEvent[]) {
  const calls = groupTraceEvents(events).filter((group) =>
    toolKinds.includes(group.events[0].kind),
  );
  const durations = calls.map(callDuration);
  const total =
    calls.length > 0 &&
    durations.every(
      (value) => value !== undefined && Number.isFinite(value) && value >= 0,
    )
      ? `工具耗时合计 ${measuredDuration(durations.reduce<number>((sum, value) => sum + value!, 0))}`
      : "耗时未记录";
  return `调用 ${calls.length} 个工具 · ${total}`;
}
export function traceStatusLabel(status: AgentEvent["status"]) {
  return {
    running: "进行中",
    succeeded: "已返回",
    failed: "失败",
    blocked: "受阻",
    cancelled: "已取消",
    unknown: "未确认",
  }[status];
}
const toolLabels: Record<string, string> = {
  list_capabilities: "查询可用任务",
  read_skill: "读取内置技能",
  get_environment: "查询账号配置",
  compile_plan: "校验计划草稿",
  get_run: "查询任务记录",
  get_incident: "查询故障证据",
  run_saved_daily: "提交已保存日常",
  run_plan: "提交计划执行",
  read_goal: "读取目标记录",
  inspect_goal: "核对目标现场",
  wait_goal: "等待目标记录",
  cancel_goal: "请求停止目标",
  resume_goal: "请求继续目标",
  resume_daily: "请求续跑日常",
  save_daily_preference: "保存日常偏好",
  submit_result: "提交模型说明",
  search_copilot: "查询社区作业",
  prepare_copilot: "检查临时作业清单",
};
export function toolLabel(tool?: string) {
  return tool ? (toolLabels[tool] ?? tool) : "工具调用";
}
