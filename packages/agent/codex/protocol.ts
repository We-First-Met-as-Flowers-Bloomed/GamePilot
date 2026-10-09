import { AgentToolError } from "../../protocol/agent";
import type {
  PlannerProgress,
  PlannerStreamEvent,
  PlannerUsage,
} from "../../protocol/agent-planner";
import type { PlannerRpc } from "./rpc";

const protocolError = () =>
  new AgentToolError("PROTOCOL_ERROR", "Codex 协议消息无效");
// Status and private reasoning notifications carry no executable or public answer content.
const notifications = new Set([
  "error",
  "item/agentMessage/delta",
  "thread/tokenUsage/updated",
  "item/started",
  "item/completed",
  "turn/completed",
  "thread/started",
  "thread/status/changed",
  "thread/name/updated",
  "turn/started",
  "turn/plan/updated",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "account/updated",
  "account/rateLimits/updated",
  "model/rerouted",
  "warning",
  "deprecationNotice",
  "configWarning",
  "windows/worldWritableWarning",
]);
function object(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw protocolError();
  return value as Record<string, unknown>;
}
function usage(value: unknown): PlannerUsage | undefined {
  // Every operation starts an ephemeral thread: total is the actual operation snapshot.
  const raw = object(object(value).total);
  const result: PlannerUsage = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    const count = raw[key];
    if (count === undefined || count === null) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0)
      throw protocolError();
    result[key] = count as number;
  }
  return Object.keys(result).length ? result : undefined;
}
export interface CodexResponseOptions<T> {
  prompt: string;
  cwd: string;
  model?: string;
  instructions: string;
  outputSchema: unknown;
  dynamicTools: unknown[];
  onTool?: (callId: string, tool: string, args: unknown) => unknown;
  finish: (text: string) => T;
  onProgress?: (progress: PlannerProgress) => void;
  onEvent?: (event: PlannerStreamEvent) => void;
  signal?: AbortSignal;
}

/** Same isolated app-server protocol for planning and evidence-only diagnosis. */
export async function runCodexResponseProtocol<T>(
  rpc: PlannerRpc,
  options: CodexResponseOptions<T>,
) {
  let attempt = 1;
  const check = () => {
    if (options.signal?.aborted)
      throw new AgentToolError("CANCELLED", "模型请求已取消，未执行游戏任务");
  };
  try {
    check();
    options.onEvent?.({ kind: "attempt", attempt, status: "started" });
    const started = await rpc.request<{
      thread: { id: string };
      model: string;
    }>("thread/start", {
      cwd: options.cwd,
      model: options.model,
      ephemeral: true,
      environments: [],
      approvalPolicy: "never",
      sandbox: "read-only",
      selectedCapabilityRoots: [],
      baseInstructions: options.instructions,
      developerInstructions:
        "任何游戏执行状态以宿主字段为准，模型不能执行游戏。",
      dynamicTools: options.dynamicTools,
    });
    check();
    if (
      typeof started.thread?.id !== "string" ||
      !started.thread.id ||
      typeof started.model !== "string" ||
      !started.model.trim() ||
      started.model.length > 200 ||
      /[\r\n\0]/.test(started.model)
    )
      throw protocolError();
    options.onProgress?.({ phase: "thinking" });
    const startedTurn = await rpc.request<{ turn: { id: string } }>(
      "turn/start",
      {
        threadId: started.thread.id,
        environments: [],
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
        outputSchema: options.outputSchema,
      },
    );
    check();
    const turnId = startedTurn.turn?.id;
    if (typeof turnId !== "string" || !turnId) throw protocolError();
    let final = "";
    let textBytes = 0;
    let lastUsage = "";
    const items = new Map<
      string,
      { type: string; phase?: string; delta: string; completed: boolean }
    >();
    for (let count = 0; count < 4096; count++) {
      const event = await rpc.next();
      check();
      const p = event.params ?? {};
      if (event.id !== undefined) {
        if (event.method !== "item/tool/call" || !options.onTool)
          throw new AgentToolError(
            "UNEXPECTED_REQUEST",
            "Codex 请求了授权范围以外的能力，会话已停止",
          );
        if (
          p.threadId !== started.thread.id ||
          p.turnId !== turnId ||
          p.namespace != null ||
          typeof p.callId !== "string" ||
          !/^[A-Za-z0-9_-]{1,200}$/.test(p.callId) ||
          typeof p.tool !== "string"
        )
          throw new AgentToolError("CALL_SCOPE", "工具调用的会话或轮次不符");
        const response = options.onTool(p.callId, p.tool, p.arguments);
        check();
        rpc.respond(event.id, response);
        continue;
      }
      if (!notifications.has(event.method)) throw protocolError();
      if (
        (p.threadId !== undefined && p.threadId !== started.thread.id) ||
        (p.turnId !== undefined && p.turnId !== turnId)
      )
        throw new AgentToolError("EVENT_SCOPE", "收到其他会话或轮次事件");
      if (
        (event.method === "thread/started" &&
          object(p.thread).id !== started.thread.id) ||
        (event.method === "turn/started" &&
          (p.threadId !== started.thread.id || object(p.turn).id !== turnId))
      )
        throw new AgentToolError("EVENT_SCOPE", "状态事件的会话或轮次不符");
      const scoped = () => {
        if (p.threadId !== started.thread.id || p.turnId !== turnId)
          throw new AgentToolError("EVENT_SCOPE", "事件缺少精确会话或轮次关联");
      };
      if (event.method === "error") {
        scoped();
        const error = object(p.error);
        if (typeof p.willRetry !== "boolean") throw protocolError();
        const code =
          error.codexErrorInfo === "usageLimitExceeded" ||
          error.codexErrorInfo === "rateLimitExceeded"
            ? "QUOTA_EXCEEDED"
            : error.codexErrorInfo === "unauthorized"
              ? "AUTH_FAILED"
              : "MODEL_FAILED";
        if (!p.willRetry)
          throw new AgentToolError(
            code,
            "Codex 未完成模型请求，未执行游戏任务",
          );
        options.onEvent?.({ kind: "attempt", attempt, status: "failed", code });
        if (++attempt > 4)
          throw new AgentToolError("ATTEMPT_BUDGET", "Codex 重试超过预算");
        // Failed attempt text cannot become a later final answer. Host tool receipts stay in the session.
        for (const item of items.values())
          if (!item.completed) item.completed = true;
        final = "";
        options.onEvent?.({ kind: "attempt", attempt, status: "started" });
        continue;
      }
      if (event.method === "item/agentMessage/delta") {
        scoped();
        const item =
          typeof p.itemId === "string" ? items.get(p.itemId) : undefined;
        if (
          !item ||
          item.type !== "agentMessage" ||
          item.completed ||
          typeof p.delta !== "string"
        )
          throw new AgentToolError("ITEM_SCOPE", "文字增量未关联当前消息");
        textBytes += Buffer.byteLength(p.delta);
        if (textBytes > 1024 * 1024)
          throw new AgentToolError(
            "RESPONSE_TOO_LARGE",
            "Codex 响应超过大小限制",
          );
        item.delta += p.delta;
        if (item.phase !== "commentary" && p.delta)
          options.onEvent?.({ kind: "answer-delta", text: p.delta });
      }
      if (event.method === "thread/tokenUsage/updated") {
        scoped();
        const current = usage(p.tokenUsage);
        const fingerprint = JSON.stringify(current);
        if (current && fingerprint !== lastUsage) {
          options.onEvent?.({ kind: "usage", usage: current });
          lastUsage = fingerprint;
        }
      }
      if (
        event.method === "item/started" ||
        event.method === "item/completed"
      ) {
        scoped();
        const item = object(p.item);
        if (
          item.type === "agentMessage" &&
          item.phase != null &&
          !["commentary", "final_answer"].includes(item.phase as string)
        )
          throw protocolError();
        if (
          ![
            "userMessage",
            "agentMessage",
            "reasoning",
            "dynamicToolCall",
            "plan",
          ].includes(item.type as string) ||
          (item.type === "dynamicToolCall" && !options.onTool)
        )
          throw new AgentToolError(
            "UNEXPECTED_TOOL",
            "发现非授权工具活动，会话已停止",
          );
        const itemId =
          typeof item.id === "string" && item.id ? item.id : undefined;
        const prior = itemId ? items.get(itemId) : undefined;
        if (event.method === "item/started") {
          if (!itemId || prior)
            throw new AgentToolError("ITEM_SCOPE", "消息编号重复或缺失");
          items.set(itemId, {
            type: item.type as string,
            phase: item.phase == null ? undefined : (item.phase as string),
            delta: "",
            completed: false,
          });
        } else {
          if (
            prior &&
            (prior.completed ||
              prior.type !== item.type ||
              prior.phase !== (item.phase ?? undefined))
          )
            throw new AgentToolError("ITEM_SCOPE", "消息终态不符");
          if (prior) prior.completed = true;
          if (item.type === "agentMessage" && item.phase !== "commentary") {
            if (
              typeof item.text !== "string" ||
              (prior?.delta && prior.delta !== item.text)
            )
              throw protocolError();
            if (Buffer.byteLength(item.text) > 1024 * 1024)
              throw new AgentToolError(
                "RESPONSE_TOO_LARGE",
                "Codex 响应超过大小限制",
              );
            final = item.text;
            if (!prior?.delta && final)
              options.onEvent?.({ kind: "answer-delta", text: final });
          }
        }
      }
      if (event.method === "turn/completed") {
        const turn = object(p.turn);
        if (p.threadId !== started.thread.id || turn.id !== turnId)
          throw new AgentToolError("EVENT_SCOPE", "完成事件轮次不符");
        if (turn.status !== "completed") {
          const quota =
            (turn.error as { codexErrorInfo?: unknown } | undefined)
              ?.codexErrorInfo === "usageLimitExceeded";
          throw new AgentToolError(
            turn.status === "interrupted"
              ? "CANCELLED"
              : quota
                ? "QUOTA_EXCEEDED"
                : "MODEL_FAILED",
            quota
              ? "Codex 配额已耗尽，未执行游戏任务"
              : "模型调用未完成，未执行游戏任务",
          );
        }
        if (
          [...items.values()].some(
            (item) => item.type === "agentMessage" && !item.completed,
          )
        )
          throw protocolError();
        check();
        const result = options.finish(final);
        options.onEvent?.({ kind: "attempt", attempt, status: "completed" });
        options.onEvent?.({ kind: "finished" });
        return { result, model: started.model };
      }
    }
    throw new AgentToolError("EVENT_BUDGET", "Codex 事件超过预算");
  } catch (failure) {
    const error =
      failure instanceof AgentToolError
        ? failure
        : new AgentToolError("MODEL_FAILED", "模型调用未完成，未执行游戏任务");
    try {
      options.onEvent?.({
        kind: "attempt",
        attempt,
        status: error.code === "CANCELLED" ? "cancelled" : "failed",
        code: error.code,
      });
      options.onEvent?.({
        kind: "error",
        code: error.code,
        message: error.message,
      });
    } catch {}
    throw error;
  }
}
