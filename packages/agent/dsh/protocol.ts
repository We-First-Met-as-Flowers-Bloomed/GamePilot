import { AgentToolError } from "../../protocol/agent";
import type { PlannerUsage } from "../../protocol/agent-planner";
import { compatibleUsage } from "../openai-compatible/stream";

export type DshEvent =
  | { kind: "answer-delta"; text: string }
  | { kind: "tool-requested" | "tool-started"; callId: string; tool: string }
  | {
      kind: "tool-result";
      callId: string;
      tool: string;
      success: boolean;
      code?: string;
    }
  | { kind: "usage"; usage: PlannerUsage }
  | {
      kind: "attempt";
      attempt: number;
      status: "started" | "completed" | "failed" | "cancelled";
      code?: string;
    }
  | { kind: "finished" }
  | { kind: "error"; code: string; message: string };

export interface DshHistoryEvent {
  type: string;
  seq: number;
  time?: number;
  data: Record<string, unknown>;
}

const invalid = () =>
  new AgentToolError("PROTOCOL_ERROR", "DSH 模型或运行协议格式无效");
export const DSH_MODEL_REQUEST_BYTES = 4 * 1024 * 1024;

// The SDK persists bridge errors in turn/end. Only expose known codes with
// host-owned wording: SDK/provider messages and stacks are not public output.
const terminalErrors: Record<string, string> = {
  DSH_CONTEXT_TOO_LARGE:
    "DSH 会话上下文超过 4 MiB 桥接上限，本次模型请求未发送；游戏状态请以原执行记录为准",
  INVALID_CONNECTION: "请检查模型地址、模型名称和密钥",
  AUTH_FAILED: "模型服务鉴权失败，请检查密钥和权限",
  QUOTA_EXCEEDED: "模型服务限流或额度不足，请稍后重试",
  NETWORK_FAILED: "无法完成模型服务通信，请检查地址和网络",
  TIMEOUT: "模型请求超时；游戏状态以目标和原执行记录为准",
  CANCELLED: "DSH 模型轮次已取消",
  RESPONSE_TOO_LARGE: "DSH 模型响应或桥接请求超过大小限制",
  ROUND_BUDGET: "DSH 模型轮次超过预算",
  PROTOCOL_ERROR: "DSH 模型或运行协议格式无效",
  MODEL_FAILED: "模型服务未完成请求，请稍后重试",
  DSH_BRIDGE_FAILED: "DSH 宿主操作未完成",
};
export function dshEndReasonError(
  reason: Record<string, unknown>,
): AgentToolError {
  const error = reason.error;
  if (
    reason.kind === "error" &&
    error &&
    typeof error === "object" &&
    !Array.isArray(error)
  ) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === "string" && Object.hasOwn(terminalErrors, code))
      return new AgentToolError(code, terminalErrors[code]);
  }
  return new AgentToolError("MODEL_FAILED", "DSH 模型未形成有效最终回复");
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim())) throw invalid();
  return value;
}
function visibleContent(value: unknown): string {
  if (!Array.isArray(value)) throw invalid();
  return value
    .map((raw) => {
      const block = record(raw);
      if (block.type === "text") return text(block.text, true);
      if (
        ["reasoning", "tool-call", "tool-addition", "tool-removal"].includes(
          String(block.type),
        )
      )
        return "";
      throw new AgentToolError(
        "DSH_ATTACHMENT_UNSUPPORTED",
        "当前 DSH 兼容桥仅支持文本",
      );
    })
    .join("");
}

/** Translate DSH's provider-neutral request; the host retains endpoint/auth ownership. */
export function compatibleRequest(value: unknown): Record<string, unknown> {
  const raw = record(value);
  if (!Array.isArray(raw.messages) || raw.messages.length > 2000)
    throw invalid();
  const messages: Record<string, unknown>[] = [];
  if (raw.system !== undefined)
    messages.push({ role: "system", content: text(raw.system, true) });
  for (const item of raw.messages) {
    const message = record(item);
    const content = visibleContent(message.content);
    if (message.role === "assistant") {
      const calls = (message.content as unknown[])
        .map(record)
        .filter((block) => block.type === "tool-call")
        .map((block) => ({
          id: text(block.id),
          type: "function",
          function: {
            name: text(block.name),
            arguments: text(block.arguments, true),
          },
        }));
      messages.push({
        role: "assistant",
        content: content || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: text(message.toolCallId),
        content,
      });
    } else if (["system", "developer", "user"].includes(String(message.role))) {
      messages.push({
        role: message.role === "developer" ? "system" : message.role,
        content,
      });
    } else throw invalid();
  }
  const tools = raw.tools === undefined ? [] : raw.tools;
  if (!Array.isArray(tools) || tools.length > 100) throw invalid();
  const maxTokens = raw.maxTokens ?? 4096;
  if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) <= 0)
    throw invalid();
  return {
    messages,
    stream: true,
    max_tokens: maxTokens,
    ...(tools.length
      ? {
          tools: tools.map((value) => {
            const tool = record(value);
            return {
              type: "function",
              function: {
                name: text(tool.name),
                description: text(tool.description, true),
                parameters: record(tool.parameters),
              },
            };
          }),
          tool_choice: "auto",
        }
      : {}),
  };
}

export interface DshCompletion {
  model: string;
  blocks: Record<string, unknown>[];
  reason: { kind: "stop" | "tool-calls" | "max-tokens" };
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  };
}

export function compatibleResponse(value: unknown): DshCompletion {
  const raw = record(value);
  const model = text(raw.model);
  if (
    model.length > 200 ||
    /[\r\n\0]/.test(model) ||
    !Array.isArray(raw.choices) ||
    raw.choices.length !== 1
  )
    throw invalid();
  const choice = record(raw.choices[0]);
  const message = record(choice.message);
  const blocks: Record<string, unknown>[] = [];
  if (message.content != null) {
    const content = text(message.content, true);
    if (content) blocks.push({ type: "text", text: content });
  }
  const calls = message.tool_calls ?? [];
  if (!Array.isArray(calls) || calls.length > 12) throw invalid();
  const ids = new Set<string>();
  for (const value of calls) {
    const call = record(value);
    const fn = record(call.function);
    const id = text(call.id);
    const name = text(fn.name);
    const args = text(fn.arguments);
    if (call.type !== "function" || ids.has(id)) throw invalid();
    ids.add(id);
    try {
      record(JSON.parse(args));
    } catch {
      throw invalid();
    }
    blocks.push({ type: "tool-call", id, name, arguments: args });
  }
  if (
    !blocks.length ||
    !["stop", "tool_calls", "length"].includes(String(choice.finish_reason))
  )
    throw invalid();
  const counts = compatibleUsage(raw.usage);
  let usage: DshCompletion["usage"];
  if (counts?.inputTokens !== undefined && counts.outputTokens !== undefined) {
    const cached = counts.cachedInputTokens ?? 0;
    if (cached > counts.inputTokens) throw invalid();
    usage = {
      inputTokens: counts.inputTokens - cached,
      outputTokens: counts.outputTokens,
      ...(counts.totalTokens !== undefined
        ? { totalTokens: counts.totalTokens }
        : {}),
      ...(counts.cachedInputTokens !== undefined
        ? { cacheReadTokens: cached }
        : {}),
      ...(counts.reasoningOutputTokens !== undefined
        ? { reasoningTokens: counts.reasoningOutputTokens }
        : {}),
    };
  }
  return {
    model,
    blocks,
    reason: {
      kind:
        choice.finish_reason === "length"
          ? "max-tokens"
          : calls.length
            ? "tool-calls"
            : "stop",
    },
    ...(usage ? { usage } : {}),
  };
}

/** Public facts only. Never publish reasoning, request headers or system prompt logs. */
export function publicDshEvents(
  value: unknown,
  toolNames?: ReadonlyMap<string, string>,
): DshEvent[] {
  const event = record(value);
  const data = record(event.data ?? {});
  if (event.type === "assistant/message") {
    const message = record(data.message);
    if (!Array.isArray(message.content)) throw invalid();
    return message.content.flatMap((value): DshEvent[] => {
      const block = record(value);
      if (block.type === "text")
        return block.text
          ? [{ kind: "answer-delta", text: text(block.text) }]
          : [];
      if (block.type === "tool-call")
        return [
          {
            kind: "tool-requested",
            callId: text(block.id),
            tool: text(block.name),
          },
        ];
      return [];
    });
  }
  if (event.type === "tool/result") {
    const message = record(data.message ?? data);
    const callId = text(message.toolCallId ?? data.callId);
    return [
      {
        kind: "tool-result",
        callId,
        tool:
          typeof data.name === "string"
            ? data.name
            : (toolNames?.get(callId) ?? "unknown"),
        success: message.isError !== true,
        ...(record(data.error ?? {}).code
          ? { code: text(record(data.error).code) }
          : {}),
      },
    ];
  }
  return [];
}

export function publicHistoryEvents(value: unknown): DshHistoryEvent[] {
  if (!Array.isArray(value)) throw invalid();
  return value.flatMap((item) => {
    const event = record(item);
    if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0)
      throw invalid();
    const data = record(event.data ?? {});
    const content = (value: unknown) =>
      Array.isArray(value)
        ? value.map(record).flatMap((block) => {
            if (block.type === "text")
              return [
                { type: "text", text: text(block.text, true) } as Record<
                  string,
                  unknown
                >,
              ];
            if (block.type === "tool-call")
              return [
                {
                  type: "tool-call",
                  id: text(block.id),
                  name: text(block.name),
                  arguments: text(block.arguments, true),
                },
              ];
            return [];
          })
        : [];
    let safe: Record<string, unknown>;
    if (event.type === "assistant/message" || event.type === "user/message")
      safe = {
        message: { content: content(record(data.message ?? data).content) },
      };
    else if (event.type === "tool/result") {
      const message = record(data.message ?? data);
      safe = {
        callId: message.toolCallId ?? data.callId,
        isError: message.isError,
        content: content(message.content),
      };
    } else if (event.type === "turn/start" || event.type === "turn/end")
      safe = {
        turn: data.turn,
        ...(data.reason ? { reason: { kind: record(data.reason).kind } } : {}),
      };
    else return [];
    return [
      {
        type: text(event.type),
        seq: event.seq as number,
        ...(typeof event.time === "number" ? { time: event.time } : {}),
        data: safe,
      },
    ];
  });
}
