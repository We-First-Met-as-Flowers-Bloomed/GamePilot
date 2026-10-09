import type { PlannerViewState } from "../../../packages/protocol/agent-planner";
import type { AgentExecutionTarget } from "../../../packages/protocol/agent-execution";
import type { ChatTurn } from "../../../packages/protocol/agent-chat";

/** A saved intent only requests a host review; it is never a game admission. */
export function chatIntentTarget(
  turn: ChatTurn,
  latest: ChatTurn | undefined,
  live: PlannerViewState,
): { turnId: string; requestId: string } | undefined {
  const state = turn.planner;
  if (
    turn.id !== latest?.id ||
    turn.source === "fixture" ||
    state.source === "fixture" ||
    live.source === "fixture" ||
    state.result?.source === "fixture" ||
    live.result?.source === "fixture" ||
    state.status !== "completed" ||
    live.status !== "completed" ||
    !state.requestId ||
    state.requestId !== live.requestId ||
    !["saved-daily", "saved-both-games"].includes(state.result?.status ?? "") ||
    state.result?.status !== live.result?.status
  )
    return;
  return { turnId: turn.id, requestId: state.requestId };
}

/** Persisted answers are conversation history, never execution authorization. */
export function chatExecutionTarget(
  turn: PlannerViewState,
  live: PlannerViewState,
): AgentExecutionTarget | undefined {
  const hash = turn.result?.draft?.planHash;
  if (
    turn.status !== "completed" ||
    live.status !== "completed" ||
    turn.source === "fixture" ||
    live.source === "fixture" ||
    turn.result?.status !== "draft" ||
    live.result?.status !== "draft" ||
    !turn.requestId ||
    turn.requestId !== live.requestId ||
    !hash ||
    hash !== live.result.draft?.planHash
  )
    return;
  return { requestId: turn.requestId, planHash: hash };
}

export function chatTurnLabel(turn: PlannerViewState): string {
  if (
    turn.status === "completed" &&
    turn.result?.execution === "managed-by-goal"
  )
    return "目标已关联";
  if (turn.status === "completed")
    return {
      draft: "计划已生成",
      answer: "查询已完成",
      question: "需要补充信息",
      blocked: "当前无法执行",
      "saved-daily": "等待日常检查",
      "saved-both-games": "等待双游戏检查",
    }[turn.result?.status ?? "answer"];
  return {
    idle: "等待处理",
    running: "正在处理",
    cancelling: "正在取消",
    cancelled: "已取消规划",
    failed: "请求未完成",
  }[turn.status];
}

/** Only explicit standalone controls are local commands; other text goes to planning. */
export function chatCommand(
  text: string,
):
  | "stop"
  | "daily"
  | "devices"
  | "settings"
  | "saved-daily"
  | "continue"
  | "pause"
  | undefined {
  return (
    {
      "/stop": "stop",
      停止全部任务: "stop",
      "/daily": "daily",
      "/devices": "devices",
      "/settings": "settings",
      运行保存的日常: "saved-daily",
      运行每日任务: "saved-daily",
      运行双游戏日常: "saved-daily",
      "/run-daily": "saved-daily",
      继续原失败: "continue",
      继续原请求: "continue",
      "/continue": "continue",
      当前步骤结束后暂停: "pause",
      "/pause-after-step": "pause",
    } as const
  )[text.trim() as "/stop"];
}

export const chatProgressLabel = (state: PlannerViewState): string => {
  if (state.status === "cancelling") return "正在停止模型请求…";
  const progress = state.progress;
  if (progress?.phase === "tool")
    return (
      {
        list_capabilities: "查询可用游戏与技能",
        read_skill: "读取内置技能",
        get_environment: "读取账号与任务配置",
        compile_plan: "检查计划与资源限制",
        get_run: "核对实际执行记录",
        get_incident: "读取故障证据",
      }[progress.tool!] ?? "调用应用工具"
    );
  return {
    discovering: "准备模型服务",
    connecting: "连接模型",
    checking: "检查工具权限",
    thinking: "分析需求",
  }[progress?.phase ?? "discovering"];
};
