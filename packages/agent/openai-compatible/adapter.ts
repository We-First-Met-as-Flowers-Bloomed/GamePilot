import {
  AgentToolError,
  agentToolNames,
  type AgentToolName,
} from "../../protocol/agent";
import type {
  PlannerProgress,
  PlannerStreamEvent,
} from "../../protocol/agent-planner";
import { PlannerSession, plannerInstructions } from "../planner";
import { agentToolSpecs } from "../tool-specs";
import type { createAgentTools } from "../tools";
import { withCompatibleHttp, type CompatibleConnection } from "./http";

export type { CompatibleConnection } from "./http";
// Transport-only result submission. It is not a game tool and cannot execute a plan.
const resultTool = {
  type: "function",
  function: {
    name: "submit_result",
    description:
      "提交最终答案、本会话已编译的草稿引用或无附加条件的保存日常检查意图；不执行游戏。必须单独调用，不与其他工具同批提交。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text", "planHash"],
      properties: {
        kind: {
          type: "string",
          enum: [
            "draft",
            "question",
            "answer",
            "blocked",
            "saved-daily",
            "saved-both-games",
          ],
        },
        text: { type: "string", minLength: 1, maxLength: 8000 },
        planHash: {
          type: ["string", "null"],
          description:
            "仅draft引用本会话最后成功compile_plan的planHash，其他必须为null",
        },
      },
    },
  },
};
const protocolError = () =>
  new AgentToolError("PROTOCOL_ERROR", "模型服务响应格式无效");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw protocolError();
  return value as Record<string, unknown>;
}
function completion(value: unknown) {
  const body = object(value);
  if (
    typeof body.model !== "string" ||
    !body.model.trim() ||
    body.model.length > 200 ||
    !Array.isArray(body.choices) ||
    body.choices.length !== 1
  )
    throw protocolError();
  const choice = object(body.choices[0]);
  const message = object(choice.message);
  if (
    message.role !== "assistant" ||
    (message.content !== null && typeof message.content !== "string") ||
    (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls")
  )
    throw protocolError();
  const rawCalls = message.tool_calls ?? [];
  if (
    !Array.isArray(rawCalls) ||
    rawCalls.length > 12 ||
    (choice.finish_reason === "tool_calls") !== rawCalls.length > 0
  )
    throw protocolError();
  const ids = new Set<string>();
  const calls = rawCalls.map((raw) => {
    const tool = object(raw);
    const fn = object(tool.function);
    if (
      tool.type !== "function" ||
      typeof tool.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(tool.id) ||
      ids.has(tool.id) ||
      typeof fn.name !== "string" ||
      !fn.name ||
      fn.name.length > 100 ||
      typeof fn.arguments !== "string"
    )
      throw protocolError();
    ids.add(tool.id);
    let args: Record<string, unknown>;
    try {
      args = object(JSON.parse(fn.arguments));
    } catch {
      throw protocolError();
    }
    return {
      id: tool.id,
      type: "function" as const,
      function: { name: fn.name, arguments: fn.arguments },
      args,
    };
  });
  if (
    !calls.length &&
    (typeof message.content !== "string" || !message.content.trim())
  )
    throw protocolError();
  return {
    model: body.model,
    content: message.content as string | null,
    calls,
  };
}

export async function testCompatibleConnection(
  connection: CompatibleConnection,
  signal?: AbortSignal,
) {
  const started = Date.now();
  return withCompatibleHttp(connection, 20000, signal, async (http) => {
    const response = completion(
      await http.request({
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 8,
      }),
    );
    if (response.calls.length) throw protocolError();
    return {
      model: response.model,
      elapsedMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  });
}

export async function planWithCompatible(
  tools: ReturnType<typeof createAgentTools>,
  options: {
    connection: CompatibleConnection;
    prompt: string;
    at: string;
    signal?: AbortSignal;
    onProgress?: (progress: PlannerProgress) => void;
    onEvent?: (event: PlannerStreamEvent) => void;
  },
) {
  if (
    typeof options.prompt !== "string" ||
    !options.prompt.trim() ||
    options.prompt.length > 12000
  )
    throw new AgentToolError("INVALID_PROMPT", "需求文本须为1至12000字符");
  const started = Date.now();
  const session = new PlannerSession(tools, options.at);
  const specs = agentToolSpecs(tools.call("list_capabilities")).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
  const messages: Record<string, unknown>[] = [
    {
      role: "system",
      content:
        plannerInstructions(session.at, session.source) +
        "\n兼容接口的最终答案请调用submit_result提交上述三个字段，不要用普通聊天文本提交。完整保存日常的安排、预览或执行检查使用saved-daily；明确两个游戏用saved-both-games，两者planHash=null。先给清单、暂时不确认启动也必须使用保存日常意图，不能编译替代草稿。额外账号/游戏筛选、跳过任务或改参数不适用该意图。submit_result只提交结果，没有游戏执行权限。",
    },
    { role: "user", content: options.prompt },
  ];
  return withCompatibleHttp(
    options.connection,
    120000,
    options.signal,
    async (http) => {
      options.onProgress?.({ phase: "thinking" });
      for (let round = 0; round < 16; round++) {
        const response = completion(
          await http.request({
            stream: true,
            messages,
            tools: [...specs, resultTool],
            tool_choice: "auto",
            max_tokens: 4096,
            ...(new URL(options.connection.baseUrl).hostname ===
            "api.deepseek.com"
              ? { response_format: { type: "json_object" } }
              : {}),
          }),
        );
        http.check();
        for (const call of response.calls) {
          if (
            call.function.name !== "submit_result" &&
            !agentToolNames.includes(call.function.name as AgentToolName)
          )
            throw new AgentToolError("TOOL_FORBIDDEN", "拒绝未注册工具");
          options.onEvent?.({
            kind: "tool-requested",
            callId: call.id,
            tool: call.function.name as AgentToolName | "submit_result",
          });
        }
        const submitted = response.calls.find(
          (c) => c.function.name === "submit_result",
        );
        if (submitted) {
          if (response.calls.length !== 1) throw protocolError();
          return {
            ...session.finish(JSON.stringify(submitted.args)),
            model: response.model,
            formatRepairs: 0 as const,
            codexVersion: "",
            transport: "compatible" as const,
            elapsedMs: Date.now() - started,
          };
        }
        if (!response.calls.length) {
          let final = response;
          let result: ReturnType<PlannerSession["finish"]>;
          let formatRepairs: 0 | 1 = 0;
          try {
            result = session.finish(final.content!);
          } catch (error) {
            if (
              !(error instanceof AgentToolError) ||
              error.code !== "INVALID_OUTPUT"
            )
              throw error;
            // One formatting-only attempt shares the original deadline. No tool replay.
            http.check();
            messages.push(
              { role: "assistant", content: final.content },
              {
                role: "user",
                content:
                  "最终格式无效。禁止调用工具查询、编译或操作游戏；只调用submit_result提交最终结果，kind、text、planHash都必填。answer/question/blocked的planHash必须显式为JSON null；draft必须原样引用本会话最后成功编译结果。不得编造证据、完成状态或执行结果。",
              },
            );
            final = completion(
              await http.request({
                stream: true,
                messages,
                tools: [resultTool],
                tool_choice: {
                  type: "function",
                  function: { name: "submit_result" },
                },
                max_tokens: 4096,
                ...(new URL(options.connection.baseUrl).hostname ===
                "api.deepseek.com"
                  ? { response_format: { type: "json_object" } }
                  : {}),
              }),
            );
            http.check();
            if (
              final.calls.length &&
              (final.calls.length !== 1 ||
                final.calls[0].function.name !== "submit_result")
            )
              throw protocolError();
            result = session.finish(
              final.calls.length
                ? JSON.stringify(final.calls[0].args)
                : final.content!,
            );
            formatRepairs = 1;
          }
          return {
            ...result,
            model: final.model,
            formatRepairs,
            codexVersion: "",
            transport: "compatible" as const,
            elapsedMs: Date.now() - started,
          };
        }
        messages.push({
          role: "assistant",
          content: response.content,
          tool_calls: response.calls.map(({ args: _args, ...tool }) => tool),
        });
        for (const call of response.calls) {
          http.check();
          const result = session.call(
            call.id,
            call.function.name,
            call.args,
            options.onEvent,
          );
          options.onProgress?.({
            phase: "tool",
            tool: call.function.name as AgentToolName,
          });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result.contentItems.map((item) => item.text).join("\n"),
          });
        }
      }
      throw new AgentToolError(
        "ROUND_BUDGET",
        "模型规划轮次超过预算，未执行游戏任务",
      );
    },
    options.onEvent,
  );
}
