import { canonical } from "../acceptance/files";
import { MAX_DEVICE_LANES } from "../protocol";
import {
  AgentToolError,
  agentObject,
  agentString,
  type CompiledDraft,
} from "../protocol/agent";
import {
  gameGoalToolNames,
  type AgentRuntimePrincipal,
  type AgentRuntimeToolBinding,
} from "../protocol/agent-runtime";
import type { PlannerSource } from "../protocol/agent-planner";
import { gameMessageAuthority } from "./game-message-authority";
import { assertAgentPreferenceMessageAuthority } from "../../games/agent-message-scope";
import { plannerAwardLabels } from "../../games/arknights/award-flags";

export interface GameGoalToolHost {
  assertCurrent(): Promise<void>;
  runSaved(
    scope: "saved" | "both",
    signal: AbortSignal,
  ): Promise<{ id: string }>;
  runPlan(draft: CompiledDraft, signal: AbortSignal): Promise<{ id: string }>;
  read(goalId: string): Promise<unknown>;
  inspect?(goalId: string, signal: AbortSignal): Promise<unknown>;
  wait(goalId: string, timeoutMs: number): Promise<unknown>;
  cancel(goalId: string): Promise<{ id: string }>;
  resume(goalId: string): Promise<{ id: string }>;
  resumeDaily?(signal: AbortSignal): Promise<{ id: string }>;
  preferences(
    args: Record<string, unknown>,
    principal: AgentRuntimePrincipal,
  ): Promise<unknown>;
}
const schema = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const goalId = { type: "string", minLength: 1, maxLength: 240 };
export function createGameGoalTools(options: {
  principal: AgentRuntimePrincipal;
  source: PlannerSource;
  host: GameGoalToolHost;
}): AgentRuntimeToolBinding {
  const authority = gameMessageAuthority(options.principal.prompt);
  const calls = new Map<
    string,
    { fingerprint: string; result: Promise<unknown> }
  >();
  const goals = new Set<string>();
  let draft: CompiledDraft | undefined;
  let changedPreferences = false;
  const tool = (name: string, description: string, inputSchema: unknown) => ({
    name,
    description,
    inputSchema,
  });
  const specs = [
    tool(
      "run_saved_daily",
      "请求保存日常清单，执行必须另有宿主结构化本地确认。先查询能力/环境；scope=saved沿用当前早晚时段，both使用早间双游戏计划。额外筛选/跳过/改参数须compile_plan后run_plan。LOCAL_CONFIRMATION_REQUIRED转本地检查；受理目标不代表游戏完成。",
      schema({ scope: { type: "string", enum: ["saved", "both"] } }),
    ),
    tool(
      "run_plan",
      "请求本轮最后成功compile_plan的精确planHash；执行必须另有宿主结构化本地确认，宿主重验冻结计划、账号、历史与资源。模型不能传入自己的计划或授权。",
      schema({ planHash: { type: "string", pattern: "^[a-f0-9]{64}$" } }),
    ),
    tool(
      "read_goal",
      "查询本会话持久目标的实际状态、原回执和核验结果；模型回复/受理不等于目标完成。",
      schema({ goalId }),
    ),
    tool(
      "inspect_goal",
      "只读观察本会话原目标绑定的设备当前页面；运行中不抢设备，不发送点击、不上传完整图片。返回采集时间、实际页面与账号核验事实，unknown不能认为已登录。",
      schema({ goalId }),
    ),
    tool(
      "wait_goal",
      "有界等待目标状态变化，最多20秒；长游戏由后台监督，无需循环查询，终态自动回原聊天。",
      schema(
        { goalId, timeoutMs: { type: "integer", minimum: 0, maximum: 20000 } },
        ["goalId"],
      ),
    ),
    tool(
      "cancel_goal",
      "仅当前用户明确停止目标时调用，直接送到宿主停止游戏；以真实停止回执为准。",
      schema({ goalId }),
    ),
    tool(
      "resume_goal",
      "用户当前明确要求继续时，核对本会话原目标的宿主注册恢复；不重跑已完成步骤，不处理未知身份/未知提交。",
      schema({ goalId }),
    ),
    tool(
      "save_daily_preference",
      "仅当前用户明确要求以后/默认保存时修改原日常开关，不产生执行授权。使用get_environment别名与当前配置revision，只选用户指定的账号、游戏和任务。方舟只领邮件用award并保存parameters.mail=true、taskAward=false和全部活动开关false；不扩身份或资源。",
      schema(
        {
          environmentRevision: { type: "string" },
          laneIds: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: MAX_DEVICE_LANES,
          },
          gameId: { type: "string", enum: ["arknights", "onmyoji"] },
          skillIds: { type: "array", items: { type: "string" }, minItems: 1 },
          shopping: { type: "boolean" },
          parameters: schema(
            Object.fromEntries(
              ["mail", "taskAward", ...Object.keys(plannerAwardLabels)].map(
                (key) => [key, { type: "boolean" }],
              ),
            ),
            [],
          ),
        },
        ["environmentRevision", "laneIds", "gameId", "skillIds"],
      ),
    ),
  ];
  if (options.host.resumeDaily)
    specs.push(
      tool(
        "resume_daily",
        "用户明确继续先前日常且它没有持久目标时，宿主按当前账号/游戏范围选择原请求；只允许当日启动失败已独立登录对账、全部业务未开始的日常。无需编号，歧义时说明账号，不擅选、不重跑已完成项、不开始其他账号。已有目标用resume_goal。",
        schema({}),
      ),
    );
  const invoke = async (name: string, input: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    await options.host.assertCurrent();
    signal.throwIfAborted();
    if (options.source === "fixture")
      throw new AgentToolError(
        "PREVIEW_READONLY",
        "演练不能操作真实目标或日常设置",
      );
    if (name === "run_saved_daily" || name === "run_plan") {
      if (!authority.execute)
        throw new AgentToolError(
          "MESSAGE_NOT_AUTHORIZED",
          "当前消息只允许查询或预览，没有游戏执行授权",
        );
      if (name === "run_saved_daily") {
        const v = agentObject(input, ["scope"]);
        if (v.scope !== "saved" && v.scope !== "both")
          throw new AgentToolError("INVALID_INPUT", "日常范围无效");
        if (authority.constraints.shopping === false)
          throw new AgentToolError(
            "CUSTOM_PLAN_REQUIRED",
            "跳过购物需编译准确的自定义任务，不能执行完整保存日常",
          );
        const value = await options.host.runSaved(v.scope, signal);
        goals.add(value.id);
        return value;
      }
      const v = agentObject(input, ["planHash"]);
      if (
        !draft ||
        draft.status !== "valid" ||
        !draft.planHash ||
        draft.planHash !== v.planHash
      )
        throw new AgentToolError(
          "UNVERIFIED_DRAFT",
          "必须引用本轮最后一次成功的宿主编译结果",
        );
      const value = await options.host.runPlan(structuredClone(draft), signal);
      goals.add(value.id);
      return value;
    }
    if (name === "save_daily_preference") {
      assertAgentPreferenceMessageAuthority(options.principal.prompt);
      const v = agentObject(input, [
        "environmentRevision",
        "laneIds",
        "gameId",
        "skillIds",
        "shopping",
        "parameters",
      ]);
      if (v.parameters !== undefined) {
        const flags = agentObject(v.parameters, [
          "mail",
          "taskAward",
          ...Object.keys(plannerAwardLabels),
        ]);
        if (Object.values(flags).some((flag) => typeof flag !== "boolean"))
          throw new AgentToolError(
            "INVALID_INPUT",
            "奖励偏好只能包含受限布尔开关",
          );
      }
      const saved = await options.host.preferences(v, options.principal);
      changedPreferences = true;
      draft = undefined;
      return saved;
    }
    if (name === "resume_daily") {
      if (!authority.resume)
        throw new AgentToolError(
          "MESSAGE_NOT_AUTHORIZED",
          "当前用户未要求继续原日常",
        );
      agentObject(input, []);
      if (!options.host.resumeDaily)
        throw new AgentToolError("TOOL_FORBIDDEN", "当前宿主未提供日常接管");
      const value = await options.host.resumeDaily(signal);
      goals.add(value.id);
      return value;
    }
    const v = agentObject(
      input,
      name === "wait_goal" ? ["goalId", "timeoutMs"] : ["goalId"],
    );
    const id = agentString(v.goalId, "目标编号", 240);
    if (name === "read_goal") return options.host.read(id);
    if (name === "inspect_goal") {
      if (!options.host.inspect)
        throw new AgentToolError(
          "OBSERVATION_UNAVAILABLE",
          "当前宿主未提供现场观察",
        );
      return options.host.inspect(id, signal);
    }
    if (name === "wait_goal") {
      const ms = v.timeoutMs ?? 10000;
      if (!Number.isInteger(ms) || (ms as number) < 0 || (ms as number) > 20000)
        throw new AgentToolError("INVALID_INPUT", "等待时间须为0至20000毫秒");
      return options.host.wait(id, ms as number);
    }
    if (name === "cancel_goal") {
      if (!authority.stop)
        throw new AgentToolError(
          "MESSAGE_NOT_AUTHORIZED",
          "当前用户未要求停止目标",
        );
      const value = await options.host.cancel(id);
      goals.add(value.id);
      return value;
    }
    if (name === "resume_goal") {
      if (!authority.resume)
        throw new AgentToolError(
          "MESSAGE_NOT_AUTHORIZED",
          "当前用户未要求继续原目标",
        );
      const value = await options.host.resume(id);
      goals.add(value.id);
      return value;
    }
    throw new AgentToolError("TOOL_FORBIDDEN", "未注册的目标工具");
  };
  return {
    specs,
    compiled(value) {
      draft = value?.status === "valid" ? structuredClone(value) : undefined;
    },
    goalIds: () => [...goals],
    changedPreferences: () => changedPreferences,
    async call(name, args, context) {
      context.signal.throwIfAborted();
      if (
        !gameGoalToolNames.includes(name as (typeof gameGoalToolNames)[number])
      )
        throw new AgentToolError("TOOL_FORBIDDEN", "未注册的目标工具");
      const fingerprint = canonical({ name, args });
      const prior = calls.get(context.callId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new AgentToolError(
            "CALL_ID_CONFLICT",
            "重复工具编号参数不一致",
          );
        return structuredClone(await prior.result);
      }
      const result = invoke(name, args, context.signal);
      calls.set(context.callId, { fingerprint, result });
      return structuredClone(await result);
    },
  };
}
