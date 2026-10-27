import {
  AgentToolError,
  agentBeijingTime,
  agentToolNames,
  type AgentToolName,
  type CompiledDraft,
} from "../protocol/agent";
import type {
  AgentRuntimeToolBinding,
  AgentRuntimeToolName,
} from "../protocol/agent-runtime";
import type {
  PlannerResult,
  PlannerStreamEvent,
} from "../protocol/agent-planner";
import type { CompatibleConnection } from "./openai-compatible/http";
import type { createAgentTools } from "./tools";
import { PlannerSession } from "./planner";
import { agentToolSpecs } from "./tool-specs";
import { runWithDsh } from "./dsh/adapter";
import type { DshEvent } from "./dsh/adapter";
import { publicAgentDetailJson } from "../protocol/agent-events";
import { gameMessageAuthority } from "./game-message-authority";
import { goalResultReport } from "../../games/goal-report";
import type { GoalRun } from "../protocol/agent-goal";
import { gamePreferencePrompt } from "../../games/agent-message-scope";
import {
  recordedDailyQueryReport,
  recordedQueryReport,
} from "../../games/recorded-query-report";
import { recordedDailyQueryScopes } from "../../games/recorded-daily-query";
import { isUnconfirmedRuntimeShutdown } from "./runtime-lifecycle";
import {
  validateCopilotReview,
  isCopilotReview,
} from "../protocol/copilot-review";

interface DshPlannerRunOptions {
  connection: CompatibleConnection;
  prompt: string;
  at: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  tools: { name: string; description: string; inputSchema: unknown }[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    context: { callId: string; signal: AbortSignal },
  ): Promise<unknown>;
  onEvent?: (event: DshEvent) => void;
  sessionId?: string;
  resume?: boolean;
  runtime?: { directory: string; nodePath?: string; home?: string };
}
type Runner = (options: DshPlannerRunOptions) => Promise<{
  finalText: string;
  model: string;
  sessionId: string;
  events: unknown[];
}>;
export async function planWithDsh(
  tools: ReturnType<typeof createAgentTools>,
  options: {
    connection: CompatibleConnection;
    prompt: string;
    /** Actual current user turn, excluding historical/model context. */
    currentMessage?: string;
    at: string;
    signal?: AbortSignal;
    binding?: AgentRuntimeToolBinding;
    onEvent?: (event: PlannerStreamEvent) => void;
    sessionId?: string;
    resume?: boolean;
    runtime?: DshPlannerRunOptions["runtime"];
    run?: Runner;
  },
): Promise<PlannerResult> {
  const started = Date.now();
  const session = new PlannerSession(tools, options.at);
  const specs = agentToolSpecs(tools.call("list_capabilities"));
  const binding = options.binding;
  const authority = gameMessageAuthority(
    options.currentMessage ?? options.prompt,
  );
  const operationRequested =
    authority.execute || authority.resume || authority.stop;
  const currentMessage = gamePreferencePrompt(
    options.currentMessage ?? options.prompt,
  );
  const claimStatusQuestion =
    /(?:领取|领|收取|收|拿到|收到)(?:了|到|好|完|过|成功)*(?:吗|么|了没|没有|没)|(?:有没有|是否)[^，,。；;\n]{0,32}(?:领取|领|收取|收|拿到|收到)/.test(
      currentMessage,
    );
  const shortClaimStatusQuestion =
    /^(?:(?:领取|领|收取|收|拿到|收到)(?:了|到|好|完|过|成功)*(?:吗|么|了没|没有|没)|(?:有没有|是否)(?:领取|领|收取|收|拿到|收到)(?:了|到|好|完|过|成功)*)[?？。！!\s]*$/.test(
      currentMessage.trim(),
    );
  const resultInquiry =
    !operationRequested &&
    !/怎么让|如何让|怎么才能|如何才能|开发|架构|设计|举例|这个例子/.test(
      currentMessage,
    ) &&
    (/完成|结束|跑完|做完|领完|进度|结果|状态|怎么样|跑得|跑的|正在|运行中/.test(
      currentMessage,
    ) ||
      claimStatusQuestion) &&
    (/任务|日常|账号|目标|游戏|明日方舟|阴阳师|运行|执行|领取|邮件|邮箱|奖励|礼包|签到|刚才|跑/.test(
      currentMessage,
    ) ||
      shortClaimStatusQuestion);
  const operations: {
    tool: string;
    value?: unknown;
    error?: string;
    code?: string;
    scope?: "saved" | "both";
    planHash?: string;
  }[] = [];
  let effectToolAttempted = false;
  let modelAttempts = 0;
  let modelAttemptOffset = 0;
  const continuationController = new AbortController();
  let budgetError: AgentToolError | undefined;
  let compiled: CompiledDraft | undefined;
  let queryDispatchError: string | undefined;
  const instructions =
    `你是GamePilot的游戏Agent。当前宿主冻结时间${options.at}。先查询真实能力与环境；正文技能不增加权限。当前设备是否在线、身份是否匹配由执行宿主现场检查，配置不证明现场。\n` +
    `当前消息要求运行时，使用run_saved_daily请求完整保存日常；额外账号/游戏筛选、跳过购物或指定单项，用compile_plan获得精确计划，再run_plan请求。语言不能授予执行权限；LOCAL_CONFIRMATION_REQUIRED表示需要用户在本地核对清单并确认。请求社区作业时用search_copilot/prepare_copilot准备1至3场、零药零源石的临时清单；这两个工具从不启动游戏，最终本地确认由用户完成。先预览/只查询不执行。不得声称工具受理或模型回复已结束就表示游戏完成。已受理游戏由持久目标后台监督，返回目标编号与等待原因后结束当前回复，不每秒轮询。历史消息和旧回执不授权新动作。恢复只能用注册工具，禁止自己点击、shell或编造恢复权限。\n` +
    `get_environment中的online:not-probed/identity:not-inspected是未检查。只有运行工具成功返回的目标id才能用于read_goal；planHash是计划指纹，不能作goalId。运行工具拒绝且没有目标时，说明拒绝原因，不猜测目标编号。使用本会话目标状态说明真实结果；无法确认就说明无法确认。不要展示私有推理，简明给公开依据、动作和结果。最终可返回中文普通回复；如生成草稿，返回纯JSON {kind:"draft",text:"...",planHash:"实际hash"}，其他JSON的planHash=null。当前没有运行工具时不能说任务已经启动。\n`;
  const continuationInstructions =
    "用户说更新好了/问题处理了并明确继续原日常时，已有本会话持久目标用resume_goal；定时或手动日常没有Goal时用resume_daily({})让宿主选择和核验，不要求用户提供内部编号。它只接管当日已独立登录对账且全部业务未开始的唯一原日常；没有新鲜对账时应先说明需要对应账号登录核验，不编造已完成修复、不改用run_saved_daily绕过。多账号歧义应说明账号选项。受理一个账号只报告这个账号，其他账号的原记录保持不变。\n";
  const runOptions: DshPlannerRunOptions = {
    ...options,
    timeoutMs: 120000,
    onEvent: (event: DshEvent) => {
      if (event.kind === "attempt") {
        const attempt = modelAttemptOffset + event.attempt;
        modelAttempts = Math.max(modelAttempts, attempt);
        if (attempt > 16) {
          budgetError ??= new AgentToolError(
            "ROUND_BUDGET",
            "DSH 模型轮次超过预算",
          );
          continuationController.abort();
          return;
        }
        event = { ...event, attempt };
      }
      // Only the completed host operation may finish the public response.
      if (event.kind === "finished") return;
      // Host dispatch publishes one truthful result. The runtime also observes the
      // returned error JSON; its transport acknowledgement is not host success.
      if (event.kind === "tool-started" || event.kind === "tool-result") return;
      // Execution claims are only published after host receipts are known. Raw
      // answer deltas could otherwise briefly display a fabricated completion.
      if (
        (operationRequested || resultInquiry) &&
        event.kind === "answer-delta"
      )
        return;
      if (
        "tool" in event &&
        ![...specs, ...(binding?.specs ?? [])].some(
          (spec) => spec.name === event.tool,
        )
      )
        return;
      options.onEvent?.(event as PlannerStreamEvent);
    },
    prompt:
      instructions +
      continuationInstructions +
      "\n本轮查询/编译工具总预算12次。核对已完成任务时，优先读取本次账号与游戏最近且包含所需业务步骤的记录，每个账号/游戏最多1条；纯登录记录不能替代业务记录。不要遍历全部旧记录，至少保留2次调用用于技能及计划编译。记录无法证明的结果明确保留未知，不据此自动补跑。\n用户需求与宿主历史上下文：\n" +
      options.prompt,
    tools: [...specs, ...(binding?.specs ?? [])],
    callTool: async (name, args, context) => {
      options.signal?.throwIfAborted();
      if (budgetError) throw budgetError;
      context.signal.throwIfAborted();
      if (agentToolNames.includes(name as AgentToolName)) {
        if (name === "compile_plan") {
          compiled = undefined;
          binding?.compiled(undefined);
        }
        const response = (() => {
          try {
            return session.call(context.callId, name, args, options.onEvent);
          } catch (error) {
            queryDispatchError =
              error instanceof AgentToolError ? error.code : "TOOL_FAILED";
            throw error;
          }
        })();
        const value = JSON.parse(response.contentItems[0].text) as unknown;
        if (name === "compile_plan" && response.success) {
          compiled = value as CompiledDraft;
          binding?.compiled(compiled);
        }
        return value;
      }
      if (!binding || !binding.specs.some((spec) => spec.name === name))
        throw new AgentToolError("TOOL_FORBIDDEN", "未注册的游戏工具");
      // An effect attempt cannot be replayed, even without a successful receipt.
      if (
        [
          "run_plan",
          "run_saved_daily",
          "resume_goal",
          "resume_daily",
          "cancel_goal",
          "save_daily_preference",
        ].includes(name)
      )
        effectToolAttempted = true;
      const tool = name as AgentRuntimeToolName;
      options.onEvent?.({
        kind: "tool-started",
        callId: context.callId,
        tool,
        details: { arguments: publicAgentDetailJson(args) },
      });
      const before = performance.now();
      try {
        let value = await binding.call(name, args, context);
        if (name === "prepare_copilot") {
          try {
            value = validateCopilotReview(value);
          } catch {
            throw new AgentToolError(
              "INVALID_TOOL_RESULT",
              "临时作业准备记录无效；游戏尚未启动，请重新准备",
            );
          }
        }
        operations.push({ tool, value });
        options.onEvent?.({
          kind: "tool-result",
          callId: context.callId,
          tool,
          success: true,
          details: {
            durationMs: performance.now() - before,
            result: publicAgentDetailJson(value),
          },
        });
        return value;
      } catch (error) {
        const code =
          error instanceof AgentToolError ? error.code : "HOST_TOOL_FAILED";
        operations.push({
          tool,
          code,
          ...(tool === "run_saved_daily"
            ? { scope: (args as { scope?: "saved" | "both" }).scope }
            : {}),
          ...(tool === "run_plan"
            ? { planHash: (args as { planHash?: string }).planHash }
            : {}),
          error:
            error instanceof AgentToolError
              ? error.message
              : "宿主工具未完成，请核对目标记录",
        });
        options.onEvent?.({
          kind: "tool-result",
          callId: context.callId,
          tool,
          success: false,
          code,
          details: {
            durationMs: performance.now() - before,
            result: publicAgentDetailJson({ error: { code } }),
          },
        });
        return {
          error: {
            code,
            message:
              error instanceof AgentToolError
                ? error.message
                : "宿主工具未完成，请核对目标记录",
          },
        };
      }
    },
  };
  const finish = (text: string) => {
    try {
      return session.finish(text);
    } catch (error) {
      if (!(error instanceof AgentToolError) || error.code !== "INVALID_OUTPUT")
        throw error;
      return session.finish(
        JSON.stringify({
          kind: "answer",
          text:
            text.trim().slice(0, 8000) ||
            "模型未返回说明，请查看宿主目标与任务记录。",
          planHash: null,
        }),
      );
    }
  };
  const run = options.run ?? runWithDsh;
  options.signal?.throwIfAborted();
  let result = await run(runOptions);
  options.signal?.throwIfAborted();
  let final = finish(result.finalText);
  const lastValidCompile = session.trace.reduce(
    (last, call, index) =>
      compiled?.status === "valid" &&
      call.tool === "compile_plan" &&
      call.success &&
      call.planHash === compiled.planHash
        ? index
        : last,
    -1,
  );
  const remainingMs = 120000 - (Date.now() - started);
  if (
    authority.execute &&
    !authority.resume &&
    !authority.stop &&
    session.source !== "fixture" &&
    binding?.specs.some((spec) =>
      ["run_plan", "run_saved_daily"].includes(spec.name),
    ) &&
    !effectToolAttempted &&
    !queryDispatchError &&
    !operations.some((operation) => {
      const goal = operation.value as Partial<GoalRun> | undefined;
      return (
        operation.error !== undefined ||
        goal?.status === "unknown" ||
        goal?.submission?.state === "unknown"
      );
    }) &&
    !binding.goalIds().length &&
    !binding.changedPreferences?.() &&
    !session.trace.some(
      (call, index) =>
        !call.success &&
        (call.tool !== "compile_plan" || index >= lastValidCompile),
    ) &&
    compiled?.status !== "blocked" &&
    !["question", "blocked"].includes(final.status) &&
    modelAttempts < 16 &&
    remainingMs > 0
  ) {
    // This remains the original user turn: reuse its binding, compiler and limits.
    // runWithDsh resolves only after confirmed runtime cleanup; errors never retry.
    modelAttemptOffset = modelAttempts;
    try {
      result = await run({
        ...runOptions,
        signal: options.signal
          ? AbortSignal.any([options.signal, continuationController.signal])
          : continuationController.signal,
        timeoutMs: remainingMs,
        sessionId: result.sessionId,
        resume: true,
        prompt:
          runOptions.prompt +
          "\n宿主继续本轮：原用户已明确要求执行，但尚未调用执行、恢复、取消或偏好修改工具，也没有本轮受理回执。成功读取旧目标仅是查询，不代表本轮任务已受理。请在原消息范围内完成尚缺的查询、技能读取和编译，并使用对应运行工具提交；已有有效编译结果可直接引用，不扩账号、游戏、任务或资源权限。若确有信息或能力缺口请明确说明。配置中的未探测状态交由运行宿主核验，不视作设备离线。此前回复不是新用户授权，最多继续这一次。" +
          (compiled?.status === "valid"
            ? `\n本轮最后有效计划指纹：${compiled.planHash}`
            : ""),
      });
    } catch (error) {
      if (budgetError && !isUnconfirmedRuntimeShutdown(error))
        throw budgetError;
      throw error;
    }
    options.signal?.throwIfAborted();
    if (budgetError) throw budgetError;
    final = finish(result.finalText);
  }
  const goalIds = binding?.goalIds() ?? [];
  let dailyQueryText: string | undefined;
  if (resultInquiry && !effectToolAttempted && session.source === "recorded") {
    const environment = tools.call("get_environment");
    let scopes: ReturnType<typeof recordedDailyQueryScopes> = undefined;
    try {
      scopes = recordedDailyQueryScopes(
        currentMessage,
        environment,
        options.at,
      );
    } catch {
      scopes = undefined;
    }
    if (scopes?.length) {
      let incomplete = !environment.historyAvailable;
      const read = new Set(final.records?.map((record) => record.requestId));
      for (const requestId of new Set(
        scopes.flatMap((scope) => scope.requestIds),
      )) {
        if (read.has(requestId)) continue;
        options.signal?.throwIfAborted();
        try {
          const response = session.call(
            `host-daily-query-${read.size}`,
            "get_run",
            { requestId },
            options.onEvent,
          );
          if (!response.success) {
            incomplete = true;
            break;
          }
          read.add(requestId);
        } catch {
          incomplete = true;
          break;
        }
      }
      final = finish(result.finalText);
      dailyQueryText = recordedDailyQueryReport(
        final.records ?? [],
        scopes,
        options.at,
        incomplete,
      );
    }
  }
  const effected = operations.filter((o) =>
    [
      "run_saved_daily",
      "run_plan",
      "resume_goal",
      "resume_daily",
      "cancel_goal",
    ].includes(o.tool),
  );
  const affectedIds = new Set(goalIds);
  for (const op of effected) {
    const id = (op.value as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") affectedIds.add(id);
  }
  const reportingOperation = operationRequested || effected.length > 0;
  const hostGoals = new Map<string, GoalRun>();
  for (const o of operations) {
    if (
      ![
        "run_saved_daily",
        "run_plan",
        "resume_goal",
        "resume_daily",
        "cancel_goal",
        "read_goal",
        "wait_goal",
      ].includes(o.tool)
    )
      continue;
    const v = o.value as Partial<GoalRun> | undefined;
    if (
      v?.id &&
      (!reportingOperation || affectedIds.has(v.id)) &&
      v.version === 1 &&
      Array.isArray(v.attempts) &&
      Array.isArray(v.requests) &&
      !!v.grant &&
      !!v.createdAt &&
      !!v.updatedAt
    )
      hostGoals.set(v.id, v as GoalRun);
  }
  const changed = binding?.changedPreferences?.();
  const preparedReview =
    !hostGoals.size &&
    !goalIds.length &&
    !changed &&
    !operations.some((o) => o.error)
      ? [...operations].reverse().find((o) => o.tool === "prepare_copilot")
          ?.value
      : undefined;
  const copilot = isCopilotReview(preparedReview)
    ? validateCopilotReview(preparedReview)
    : undefined;
  const preparationError =
    !hostGoals.size && !goalIds.length && !changed
      ? operations.find((o) => o.tool === "prepare_copilot" && o.error)?.error
      : undefined;
  const refusal = effected.find((o) => o.error)?.error;
  const confirmationRequest =
    !hostGoals.size &&
    !goalIds.length &&
    !changed &&
    !queryDispatchError &&
    operations
      .filter((o) => o.error)
      .every((o) => o.code === "LOCAL_CONFIRMATION_REQUIRED")
      ? operations.find(
          (o) =>
            o.code === "LOCAL_CONFIRMATION_REQUIRED" &&
            ["run_plan", "run_saved_daily"].includes(o.tool),
        )
      : undefined;
  const confirmationStatus =
    confirmationRequest?.tool === "run_saved_daily"
      ? confirmationRequest.scope === "both"
        ? "saved-both-games"
        : "saved-daily"
      : confirmationRequest?.tool === "run_plan" &&
          compiled?.status === "valid" &&
          compiled.planHash === confirmationRequest.planHash
        ? "draft"
        : undefined;
  const confirmationChanged =
    confirmationRequest?.tool === "run_plan" && !confirmationStatus;
  const unsupportedSaveClaim =
    ["saved-daily", "saved-both-games"].includes(final.status) && !changed;
  const publicText =
    (preparationError
      ? `临时作业未准备成功，游戏尚未启动。\n${preparationError}`
      : confirmationChanged
        ? "请求执行的计划与本轮最新草稿不同，游戏尚未启动。请重新检查准确的任务范围。"
        : copilot
          ? "临时作业已准备，游戏尚未启动。请核对下方账号、关卡、场数与零补充预算，再确认本次执行；现场身份和干员条件仍待检查。"
          : confirmationStatus
            ? "任务清单已准备，尚未启动游戏。请在本地检查账号、任务和资源范围，再确认本次执行。"
            : undefined) ??
    dailyQueryText ??
    (hostGoals.size
      ? [...hostGoals.values()]
          .slice(0, 8)
          .map(
            (goal) =>
              (resultInquiry
                ? `这份交办记录创建于 ${agentBeijingTime(goal.createdAt) ?? "未记录时间"}（北京时间）；结果只覆盖该记录的原范围。\n`
                : "") + goalResultReport(goal).text,
          )
          .join("\n\n")
          .slice(0, 8000)
      : goalIds.length
        ? "任务已交给执行器，等待实际结果核验。你可以继续聊天，进度和结果会显示在这条任务中。"
        : changed
          ? "日常偏好已由软件保存。本轮没有启动游戏任务。"
          : final.status === "draft"
            ? "已生成可查看的任务计划，尚未受理游戏动作；这份计划不代表任务已启动或完成。"
            : unsupportedSaveClaim
              ? "本轮没有保存日常设置；模型文字不能代替软件的保存回执。请重新交办需要保存的具体偏好。"
              : operationRequested || !!refusal
                ? "尚未受理游戏操作。" +
                  (refusal
                    ? `\n${refusal}`
                    : compiled?.status === "blocked" && compiled.reasons.length
                      ? `\n${compiled.reasons.slice(0, 8).join("\n")}`
                      : queryDispatchError === "TOOL_BUDGET"
                        ? "本轮查询工具预算已用尽，尚未提交游戏任务。已有任务要求仍保留；这不是账号信息缺失，也不能视作日常完成。"
                        : queryDispatchError
                          ? `查询工具未完成（${queryDispatchError}），本轮未提交游戏任务。`
                          : "模型本轮尚未提交运行工具，游戏任务没有启动。已有账号与任务要求仍保留，请查看本轮工具记录。")
                : resultInquiry
                  ? final.records?.length
                    ? recordedQueryReport(final.records)
                    : "尚未核对到对应任务的宿主结果，不能确认任务已完成。" +
                      (operations.find((o) => o.error)?.error
                        ? `\n${operations.find((o) => o.error)!.error}`
                        : "请指定原任务或账号，再查询结果。")
                  : final.modelText);
  options.onEvent?.({ kind: "finished" });
  return {
    ...final,
    modelText: publicText,
    ...(unsupportedSaveClaim
      ? { status: "answer" as const, draft: undefined }
      : {}),
    ...(binding?.changedPreferences?.()
      ? {
          configurationChangedByHost: true as const,
          status: "answer" as const,
          draft: undefined,
        }
      : {}),
    ...(goalIds.length
      ? {
          execution: "managed-by-goal",
          goalIds,
          status: "answer",
          draft: undefined,
        }
      : {}),
    ...(confirmationStatus
      ? {
          status: confirmationStatus as
            "draft" | "saved-daily" | "saved-both-games",
          ...(confirmationStatus === "draft"
            ? { draft: compiled }
            : { draft: undefined }),
          execution: "not-started" as const,
        }
      : {}),
    ...(confirmationChanged
      ? { status: "blocked" as const, draft: undefined }
      : {}),
    ...(copilot
      ? {
          copilot,
          status: "answer" as const,
          draft: undefined,
          execution: "not-started" as const,
        }
      : {}),
    transport: "dsh",
    model: result.model,
    codexVersion: "",
    elapsedMs: Date.now() - started,
  };
}
