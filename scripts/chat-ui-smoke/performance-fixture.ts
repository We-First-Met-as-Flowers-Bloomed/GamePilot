import type { ChatSession } from "../../packages/protocol/agent-chat";
import type {
  AgentEvent,
  AgentEventPage,
  AgentEventQuery,
} from "../../packages/protocol/agent-events";

/** Synthetic historical read-only workload; no executable plans or game actions. */
export function createChatPerformanceFixture(at: string) {
  const session: ChatSession = {
    id: "ui-performance-session",
    title: "隔离性能夹具 · 64轮",
    createdAt: at,
    updatedAt: at,
    turns: [],
  };
  const events = new Map<string, AgentEvent[]>();
  for (let turn = 0; turn < 64; turn++) {
    const requestId = `ui-performance-request-${turn + 1}`,
      turnId = `ui-performance-turn-${turn + 1}`;
    const journal: AgentEvent[] = [];
    const append = (
      event: Omit<
        AgentEvent,
        "seq" | "at" | "requestId" | "sessionId" | "turnId"
      >,
    ) =>
      journal.push({
        ...event,
        seq: turn * 64 + journal.length + 1,
        at,
        requestId,
        sessionId: session.id,
        turnId,
      });
    for (let tool = 0; tool < 12; tool++) {
      const callId = `${requestId}:call-${tool + 1}`;
      append({
        kind: "tool-started",
        callId,
        tool: "get_run",
        status: "running",
        text: "隔离历史记录查询；不操作设备",
        details: {
          arguments: JSON.stringify({
            requestId: `synthetic-history-${turn}-${tool}`,
          }),
        },
      });
      append({
        kind: "tool-result",
        callId,
        tool: "get_run",
        status: tool === 9 ? "failed" : tool === 10 ? "unknown" : "succeeded",
        text: "只读工具记录；游戏结果仍需宿主证据",
        details: {
          result: JSON.stringify({
            recordedStatus: tool === 10 ? "unknown" : "failed",
          }),
          durationMs: 10 + tool,
        },
      });
    }
    for (let lifecycle = 0; lifecycle < 40; lifecycle++)
      append({
        kind:
          lifecycle === 39
            ? "model-finished"
            : lifecycle % 2
              ? "model-attempt"
              : "planner-state",
        status: lifecycle === 39 ? "succeeded" : "running",
        text: `合成模型生命周期记录 ${lifecycle + 1}；不代表游戏完成`,
      });
    events.set(requestId, journal);
    session.turns.push({
      id: turnId,
      prompt: `隔离性能轮次 ${turn + 1}：查询历史任务记录，保留失败与未确认事实，不启动游戏，不重跑，不授予执行权限。`,
      source: "fixture",
      at,
      createdAt: at,
      planner: {
        revision: turn + 1,
        status: "completed",
        requestId,
        source: "fixture",
        at,
        startedAt: at,
        finishedAt: at,
        result: {
          status: "answer",
          source: "fixture",
          modelText: `第 ${turn + 1} 轮合成说明：当前只展示历史只读查询。工具返回、模型回复结束与游戏结果分别核对；失败及未确认记录不能作为再次启动依据。没有实际游戏操作或真实模型调用。`,
          execution: "not-started",
          canExecute: false,
          trace: [],
          model: "synthetic-performance-fixture",
          codexVersion: "synthetic-no-runtime",
          elapsedMs: 0,
        },
      },
    });
  }
  return { session, events };
}

export function performanceEventPage(
  events: Map<string, AgentEvent[]>,
  input: AgentEventQuery,
): AgentEventPage {
  const requestEvents = events.get(input.requestId ?? "") ?? [];
  const remaining = requestEvents.filter(
    (event) => event.seq > (input.afterSeq ?? 0),
  );
  const page = remaining.slice(0, Math.max(1, Math.min(input.limit ?? 32, 32)));
  return {
    version: 1,
    events: page,
    cursor: page.at(-1)?.seq ?? input.afterSeq ?? 0,
    latestSeq: requestEvents.at(-1)?.seq ?? 0,
    hasMore: remaining.length > page.length,
  };
}
