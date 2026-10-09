import { AgentToolError } from "../../protocol/agent";
import type {
  PlannerStreamEvent,
  PlannerUsage,
} from "../../protocol/agent-planner";

const protocolError = () =>
  new AgentToolError("PROTOCOL_ERROR", "模型服务响应格式无效");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw protocolError();
  return value as Record<string, unknown>;
}
export function compatibleUsage(value: unknown): PlannerUsage | undefined {
  if (value == null) return;
  const raw = object(value);
  const details =
    raw.prompt_tokens_details == null ? {} : object(raw.prompt_tokens_details);
  const output =
    raw.completion_tokens_details == null
      ? {}
      : object(raw.completion_tokens_details);
  const result: PlannerUsage = {};
  for (const [key, count] of Object.entries({
    inputTokens: raw.prompt_tokens,
    outputTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens,
    cachedInputTokens: details.cached_tokens ?? raw.prompt_cache_hit_tokens,
    reasoningOutputTokens: output.reasoning_tokens,
  })) {
    if (count === undefined || count === null) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0)
      throw protocolError();
    result[key as keyof PlannerUsage] = count as number;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Incremental framing only; callers cannot dispatch tools until finish validates the whole stream. */
export class CompatibleStream {
  private buffer = "";
  private data: string[] = [];
  private done = false;
  private id?: string;
  private model?: string;
  private content = "";
  private reason?: string;
  private usage?: PlannerUsage;
  private calls = new Map<
    number,
    { id: string; type: string; function: { name: string; arguments: string } }
  >();
  constructor(private onEvent?: (event: PlannerStreamEvent) => void) {}
  push(text: string) {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line) this.frame();
      else if (line.startsWith("data:"))
        this.data.push(line.slice(5).replace(/^ /, ""));
      else if (!line.startsWith(":") && !/^(event|id|retry):/.test(line))
        throw protocolError();
    }
  }
  private frame() {
    if (!this.data.length) return;
    const text = this.data.join("\n");
    this.data = [];
    if (this.done) throw protocolError();
    if (text === "[DONE]") {
      this.done = true;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw protocolError();
    }
    const body = object(raw);
    if (body.error)
      throw new AgentToolError(
        "MODEL_FAILED",
        "模型服务未完成请求，请稍后重试",
      );
    if (
      typeof body.model !== "string" ||
      !body.model.trim() ||
      body.model.length > 200 ||
      /[\r\n\0]/.test(body.model)
    )
      throw protocolError();
    if (this.model !== undefined && this.model !== body.model)
      throw protocolError();
    this.model = body.model;
    if (body.id !== undefined) {
      if (
        typeof body.id !== "string" ||
        !body.id ||
        (this.id !== undefined && body.id !== this.id)
      )
        throw protocolError();
      this.id = body.id;
    }
    if (!Array.isArray(body.choices) || body.choices.length > 1)
      throw protocolError();
    const usage = compatibleUsage(body.usage);
    if (usage) this.usage = usage;
    if (!body.choices.length) {
      if (!usage) throw protocolError();
      return;
    }
    if (this.reason !== undefined) throw protocolError();
    const choice = object(body.choices[0]);
    if (choice.index !== 0) throw protocolError();
    const delta = object(choice.delta);
    if (delta.role !== undefined && delta.role !== "assistant")
      throw protocolError();
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== "string") throw protocolError();
      this.content += delta.content;
      if (delta.content)
        this.onEvent?.({ kind: "answer-delta", text: delta.content });
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) throw protocolError();
      for (const value of delta.tool_calls) {
        const fragment = object(value);
        if (
          !Number.isInteger(fragment.index) ||
          (fragment.index as number) < 0 ||
          (fragment.index as number) >= 12
        )
          throw protocolError();
        const call = this.calls.get(fragment.index as number) ?? {
          id: "",
          type: "",
          function: { name: "", arguments: "" },
        };
        for (const key of ["id", "type"] as const)
          if (fragment[key] !== undefined) {
            if (typeof fragment[key] !== "string") throw protocolError();
            call[key] += fragment[key];
          }
        if (fragment.function !== undefined) {
          const fn = object(fragment.function);
          for (const key of ["name", "arguments"] as const)
            if (fn[key] !== undefined) {
              if (typeof fn[key] !== "string") throw protocolError();
              call.function[key] += fn[key];
            }
        }
        this.calls.set(fragment.index as number, call);
      }
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (
        choice.finish_reason !== "stop" &&
        choice.finish_reason !== "tool_calls"
      )
        throw protocolError();
      this.reason = choice.finish_reason;
    }
  }
  finish() {
    if (
      this.buffer ||
      this.data.length ||
      !this.done ||
      !this.reason ||
      !this.model
    )
      throw protocolError();
    const calls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call], i) => {
        if (index !== i) throw protocolError();
        return call;
      });
    return {
      model: this.model,
      choices: [
        {
          index: 0,
          finish_reason: this.reason,
          message: {
            role: "assistant",
            content: this.content || (calls.length ? null : ""),
            ...(calls.length ? { tool_calls: calls } : {}),
          },
        },
      ],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}
