import { canonical } from "../protocol/canonical";
import { AgentToolError, agentObject } from "../protocol/agent";
import type { AgentRuntimeToolBinding } from "../protocol/agent-runtime";
import {
  validateCopilotReview,
  type CopilotReview,
} from "../protocol/copilot-review";

/** These host ports only search/cache/prepare. This binding has no execution port. */
export function withCopilotReadTools(
  binding: AgentRuntimeToolBinding,
  ports: {
    assertCurrent(): Promise<void>;
    search(input: unknown, signal: AbortSignal): Promise<unknown>;
    prepare(
      input: { laneId: string; stage: string; count: number },
      signal: AbortSignal,
    ): Promise<CopilotReview>;
  },
): AgentRuntimeToolBinding {
  const calls = new Map<string, { hash: string; value: Promise<unknown> }>();
  return {
    ...binding,
    specs: [
      ...binding.specs,
      {
        name: "search_copilot",
        description:
          "只读查找指定普通关卡的社区作业，最多5条；不操作设备、不授权游戏执行。",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["stage", "limit"],
          properties: {
            stage: { type: "string", maxLength: 64 },
            limit: { type: "integer", minimum: 1, maximum: 5 },
          },
        },
      },
      {
        name: "prepare_copilot",
        description:
          "按get_environment的laneId准备普通关卡临时作业1至3场，理智药/源石均0、跳过剧情。只冻结哈希和本地确认清单，不启动游戏；现场UID、干员专精/模组与逐场结果仍待核验。",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["laneId", "stage", "count"],
          properties: {
            laneId: { type: "string", maxLength: 64 },
            stage: { type: "string", maxLength: 64 },
            count: { type: "integer", minimum: 1, maximum: 3 },
          },
        },
      },
    ],
    call: async (name, args, context) => {
      if (!["search_copilot", "prepare_copilot"].includes(name))
        return binding.call(name, args, context);
      context.signal.throwIfAborted();
      await ports.assertCurrent();
      context.signal.throwIfAborted();
      const hash = canonical({ name, args }),
        previous = calls.get(context.callId);
      if (previous) {
        if (previous.hash !== hash)
          throw new AgentToolError(
            "CALL_SCOPE_CHANGED",
            "工具调用编号与原范围不同",
          );
        return previous.value;
      }
      if (calls.size >= 8)
        throw new AgentToolError("TOOL_BUDGET", "作业查询/准备预算已用尽");
      const value = Promise.resolve().then(async () => {
        const p = agentObject(
          args,
          name === "search_copilot"
            ? ["stage", "limit"]
            : ["laneId", "stage", "count"],
        );
        if (
          typeof p.stage !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p.stage)
        )
          throw new AgentToolError("INVALID_INPUT", "作业关卡编号无效");
        let result: unknown;
        if (name === "search_copilot") {
          if (
            !Number.isInteger(p.limit) ||
            Number(p.limit) < 1 ||
            Number(p.limit) > 5
          )
            throw new AgentToolError("INVALID_INPUT", "搜索最多5条作业");
          result = await ports.search(p, context.signal);
        } else {
          if (
            typeof p.laneId !== "string" ||
            !/^lane-[a-z]+$/.test(p.laneId) ||
            !Number.isInteger(p.count) ||
            Number(p.count) < 1 ||
            Number(p.count) > 3
          )
            throw new AgentToolError(
              "INVALID_INPUT",
              "作业需要唯一槽位与1至3场次数",
            );
          const raw = await ports.prepare(
            { laneId: p.laneId, stage: p.stage, count: Number(p.count) },
            context.signal,
          );
          try {
            result = validateCopilotReview(raw);
          } catch {
            throw new AgentToolError(
              "INVALID_TOOL_RESULT",
              "临时作业准备记录无效；游戏尚未启动，请重新准备",
            );
          }
        }
        context.signal.throwIfAborted();
        await ports.assertCurrent();
        return result;
      });
      calls.set(context.callId, { hash, value });
      return value;
    },
  };
}
