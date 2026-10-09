import type { AgentEventInput } from "../../../packages/protocol/agent-events";
import type {
  PlannerStreamEvent,
  PlannerViewState,
} from "../../../packages/protocol/agent-planner";

export function modelEventReceipt(
  requestId: string,
  event: PlannerStreamEvent,
): AgentEventInput | undefined {
  const base = { requestId };
  switch (event.kind) {
    case "answer-delta":
      return; // Partial prose is transient; final answers live in the chat store.
    case "tool-requested":
      return {
        ...base,
        kind: event.kind,
        status: "running",
        callId: event.callId,
        tool: event.tool,
        text: `模型请求 ${event.tool}`,
      };
    case "tool-started":
      return {
        ...base,
        kind: event.kind,
        status: "running",
        callId: event.callId,
        tool: event.tool,
        text: `宿主开始调用 ${event.tool}`,
        ...(event.details === undefined ? {} : { details: event.details }),
      };
    case "tool-result":
      return {
        ...base,
        kind: event.kind,
        status:
          event.code === "TOOL_RESPONSE_UNCONFIRMED"
            ? "unknown"
            : event.success
              ? "succeeded"
              : "failed",
        ...(event.details === undefined ? {} : { details: event.details }),
        callId: event.callId,
        tool: event.tool,
        text:
          event.code === "TOOL_RESPONSE_UNCONFIRMED"
            ? `工具 ${event.tool} 的响应未确认；游戏是否受理、停止或完成以原执行账本为准`
            : event.success
              ? `工具 ${event.tool} 已返回`
              : `工具 ${event.tool} 未完成${event.code ? `（${event.code}）` : ""}`,
      };
    case "usage":
      return {
        ...base,
        kind: "model-usage",
        status: "succeeded",
        text: "模型用量已更新（输入包含缓存命中）",
        usage: event.usage,
      };
    case "attempt":
      return {
        ...base,
        kind: "model-attempt",
        status:
          event.status === "started"
            ? "running"
            : event.status === "completed"
              ? "succeeded"
              : event.status,
        text: `模型第 ${event.attempt} 次请求：${event.status}`,
      };
    case "finished":
      return {
        ...base,
        kind: "model-finished",
        status: "succeeded",
        text: "模型响应已结束；游戏执行结果另行核对",
      };
    case "error":
      return {
        ...base,
        kind: "model-error",
        status: "failed",
        text: `模型响应失败（${event.code}）`,
      };
  }
}

export function plannerStateReceipt(
  state: PlannerViewState,
): AgentEventInput | undefined {
  if (!state.requestId) return;
  const result = state.result?.status;
  return {
    requestId: state.requestId,
    kind: "planner-state",
    status:
      state.status === "completed"
        ? result === "blocked"
          ? "blocked"
          : "succeeded"
        : state.status === "idle" || state.status === "cancelling"
          ? "running"
          : state.status,
    text:
      state.status === "completed"
        ? result === "draft"
          ? "计划草稿已校验，等待执行检查与确认"
          : result === "question"
            ? "需要补充信息"
            : result === "blocked"
              ? "当前请求无法执行"
              : "宿主记录查询已完成"
        : state.status === "failed"
          ? "模型请求未完成；游戏完成情况以执行账本为准"
          : state.status === "cancelled"
            ? "模型请求已取消"
            : "模型正在处理需求",
  };
}
