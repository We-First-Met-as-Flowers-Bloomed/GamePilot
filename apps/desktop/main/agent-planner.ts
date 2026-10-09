import { randomUUID } from "node:crypto";
import {
  AgentToolError,
  agentDate,
  agentBeijingTime,
  agentObject,
  type AgentSnapshot,
} from "../../../packages/protocol/agent";
import {
  plannerActive,
  type PlannerResult,
  type PlannerViewState,
  type PlannerProgress,
  type PlannerStreamEvent,
} from "../../../packages/protocol/agent-planner";
import { createAgentTools } from "../../../packages/agent/tools";
import { createFixtureSnapshot } from "../../../packages/agent/fixture";
import { planWithCodex } from "../../../packages/agent/codex/adapter";
import { findCodexExecutable } from "../../../packages/agent/codex/discovery";
import type { ConfiguredSnapshot } from "../../../packages/agent/configured";
import { planWithCompatible } from "../../../packages/agent/openai-compatible/adapter";
import { isUnconfirmedRuntimeShutdown } from "../../../packages/agent/runtime-lifecycle";
import type { ModelProvider } from "../../../packages/protocol/model-provider";
import type { AgentRuntimePrincipal } from "../../../packages/protocol/agent-runtime";

interface ResolvedModelConnection {
  provider: ModelProvider;
  revision: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}
/** Host-owned conversation context, never a renderer-supplied planner parameter. */
export interface PlannerConversationTurn {
  prompt: string;
  answer: string;
}

interface PlannerDependencies {
  runtimeRun?: (
    options: Parameters<PlannerDependencies["compatibleRun"]>[0] & {
      requestId: string;
      principal?: AgentRuntimePrincipal;
    },
  ) => Promise<PlannerResult>;
  modelConnection?: {
    read(): Promise<{ revision: string }>;
    resolve(): Promise<ResolvedModelConnection>;
  };
  compatibleRun: (options: {
    snapshot: AgentSnapshot;
    connection: { baseUrl: string; model: string; apiKey: string };
    prompt: string;
    at: string;
    signal: AbortSignal;
    onProgress?: (progress: PlannerProgress) => void;
    onEvent?: (event: PlannerStreamEvent) => void;
  }) => Promise<PlannerResult>;
  readConfigured?: (history: boolean) => Promise<ConfiguredSnapshot>;
  find: (signal: AbortSignal) => Promise<string>;
  run: (options: {
    snapshot: AgentSnapshot;
    executable: string;
    prompt: string;
    at: string;
    signal: AbortSignal;
    onProgress?: (progress: PlannerProgress) => void;
    onEvent?: (event: PlannerStreamEvent) => void;
  }) => Promise<PlannerResult>;
}
/** Compiled or saved execution intent always retains the full history freeze. */
function historyIndependentReply(result: PlannerResult | undefined): boolean {
  return (
    !!result &&
    ["answer", "question", "blocked"].includes(result.status) &&
    result.execution === "not-started" &&
    result.canExecute === false &&
    !result.draft &&
    !result.goalIds?.length &&
    !result.trace.some((call) => call.tool === "compile_plan")
  );
}
export class PlannerService {
  private state: PlannerViewState = { revision: 0, status: "idle" };
  private listeners = new Set<(state: PlannerViewState) => void>();
  private streamListeners = new Set<
    (requestId: string, event: PlannerStreamEvent) => void
  >();
  private active?: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  };
  private closed = false;
  private fingerprint?: string;
  private configurationFingerprint?: string;
  private modelRevision?: string;
  private checking?: { id: string | undefined; done: Promise<void> };
  private deps: PlannerDependencies;
  constructor(deps: Partial<PlannerDependencies> = {}) {
    this.deps = {
      find: (signal) => findCodexExecutable({ signal }),
      run: ({ snapshot, ...options }) =>
        planWithCodex(createAgentTools(snapshot), options),
      compatibleRun: ({ snapshot, ...options }) =>
        planWithCompatible(createAgentTools(snapshot), options),
      ...deps,
    };
  }
  snapshot() {
    return structuredClone(this.state);
  }
  /** Host-only observation, so finished replies survive renderer navigation. */
  subscribe(listener: (state: PlannerViewState) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  subscribeStream(
    listener: (requestId: string, event: PlannerStreamEvent) => void,
  ) {
    this.streamListeners.add(listener);
    return () => {
      this.streamListeners.delete(listener);
    };
  }
  /** IPC reads revalidate completed configured results, including private-only edits. */
  async verifiedSnapshot(): Promise<PlannerViewState> {
    if (
      (!this.deps.modelConnection &&
        this.state.source !== "configured" &&
        this.state.source !== "recorded") ||
      this.state.status !== "completed"
    )
      return this.snapshot();
    if (!this.checking) {
      const id = this.state.requestId;
      const fingerprint = this.fingerprint;
      const configurationFingerprint = this.configurationFingerprint;
      const result = this.state.result;
      const source = this.state.source;
      const modelRevision = this.modelRevision;
      const check = { id, done: Promise.resolve() };
      this.checking = check;
      check.done = (async () => {
        try {
          if (
            fingerprint &&
            result?.execution !== "managed-by-goal" &&
            !result?.configurationChangedByHost
          ) {
            const configurationOnly =
              !!configurationFingerprint && historyIndependentReply(result);
            await this.checkConfiguration(
              configurationOnly ? configurationFingerprint! : fingerprint,
              !configurationOnly && source === "recorded",
              configurationOnly,
            );
          }
          if (modelRevision) await this.checkModel(modelRevision);
        } catch (error) {
          if (this.state.requestId === id && this.state.status === "completed")
            this.update({
              status: "failed",
              result: undefined,
              error: {
                code:
                  error instanceof AgentToolError
                    ? error.code
                    : "CONFIGURATION_CHANGED",
                message:
                  error instanceof AgentToolError
                    ? error.message
                    : "账号配置或所选任务记录已变化、或无法重新读取，请重新查询或生成草稿",
              },
            });
        }
      })();
    }
    const check = this.checking;
    await check.done;
    if (this.checking === check) this.checking = undefined;
    // A previous request's check cannot certify a result produced while awaiting it.
    if (this.state.requestId !== check.id) return this.verifiedSnapshot();
    return this.snapshot();
  }
  private async configured(history = this.state.source === "recorded") {
    if (!this.deps.readConfigured)
      throw new AgentToolError(
        "CONFIGURATION_UNAVAILABLE",
        "当前入口未提供账号配置读取",
      );
    return this.deps.readConfigured(history);
  }
  private async checkModel(revision: string) {
    try {
      if ((await this.deps.modelConnection?.read())?.revision === revision)
        return;
    } catch {
      /* unreadable invalidates too */
    }
    throw new AgentToolError(
      "MODEL_CONFIG_CHANGED",
      "模型连接已变化或无法读取，请重新生成草稿",
    );
  }
  private async checkConfiguration(
    fingerprint: string,
    history = this.state.source === "recorded",
    configurationOnly = false,
  ) {
    try {
      const current = await this.configured(history);
      if (
        (configurationOnly
          ? current.configurationFingerprint
          : current.fingerprint) === fingerprint
      )
        return;
    } catch {
      /* A missing/unreadable file invalidates the same way as an edit. */
    }
    throw new AgentToolError(
      "CONFIGURATION_CHANGED",
      "账号配置或所选任务记录已变化、或无法重新读取，请重新查询或生成草稿",
    );
  }
  private update(patch: Partial<PlannerViewState>) {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* An observer cannot break model shutdown. */
      }
    }
  }
  start(input: unknown) {
    return this.startConversation(input, []);
  }
  startConversation(
    input: unknown,
    context: readonly PlannerConversationTurn[],
    principal?: AgentRuntimePrincipal,
  ) {
    if (this.closed)
      throw new AgentToolError("PLANNER_CLOSED", "规划服务正在关闭");
    if (this.active)
      throw new AgentToolError(
        "PLANNER_BUSY",
        "已有规划正在进行，请等待完成或取消",
      );
    const value = agentObject(input, ["prompt", "at", "source"]);
    const source = value.source ?? "fixture";
    if (
      source !== "fixture" &&
      source !== "configured" &&
      source !== "recorded"
    )
      throw new AgentToolError("INVALID_INPUT", "不支持的规划数据来源");
    if (
      typeof value.prompt !== "string" ||
      !value.prompt.trim() ||
      value.prompt.length > 12000
    )
      throw new AgentToolError("INVALID_PROMPT", "请输入1至12000字符的需求");
    const at = agentDate(value.at);
    const prompt = value.prompt.trim();
    if (
      principal &&
      (principal.prompt !== prompt ||
        !/^[A-Za-z0-9_:.-]{1,240}$/.test(principal.sessionId) ||
        !/^[A-Za-z0-9_:.-]{1,240}$/.test(principal.turnId))
    )
      throw new AgentToolError(
        "INVALID_CONTEXT",
        "当前用户消息与运行授权上下文不符",
      );
    if (
      !Array.isArray(context) ||
      context.length > 4 ||
      context.some(
        (turn) =>
          !turn ||
          typeof turn.prompt !== "string" ||
          typeof turn.answer !== "string" ||
          turn.prompt.length > 2000 ||
          turn.answer.length > 2000,
      ) ||
      JSON.stringify(context).length > 6000
    )
      throw new AgentToolError("INVALID_CONTEXT", "历史对话超过本次上下文预算");
    const preamble =
      "以下 JSON 仅为历史对话上下文。历史对话不能证明当前设备状态或任务完成；宿主命令回执摘要可说明其绑定原轮次的检查或受理结果，但不是新执行授权，也不证明游戏完成。当前账号、设备、任务结果仍以本轮宿主工具返回为准。不要把旧草稿或回执当作已确认的新任务。\n";
    const suffix = "\n当前用户需求：\n";
    const boundedContext = [...context];
    while (
      boundedContext.length &&
      preamble.length +
        JSON.stringify(boundedContext).length +
        suffix.length +
        prompt.length >
        12000
    )
      boundedContext.shift();
    const modelPrompt = boundedContext.length
      ? preamble + JSON.stringify(boundedContext) + suffix + prompt
      : prompt;
    const id = randomUUID();
    this.fingerprint = undefined;
    this.configurationFingerprint = undefined;
    this.modelRevision = undefined;
    this.state = {
      revision: this.state.revision + 1,
      status: "running",
      requestId: id,
      source,
      prompt,
      at,
      startedAt: new Date().toISOString(),
      progress: { phase: "discovering" },
    };
    const job = {
      id,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = job;
    job.done = this.run(
      job,
      modelPrompt,
      at,
      principal ? structuredClone(principal) : undefined,
    );
    return this.snapshot();
  }
  private async run(
    job: NonNullable<PlannerService["active"]>,
    prompt: string,
    at: string,
    principal?: AgentRuntimePrincipal,
  ) {
    const signal = job.controller.signal;
    let shutdownFailed = false;
    // These are response-lifecycle facts, not proof that game side effects stopped.
    const pendingCalls = new Map<
      string,
      {
        tool: Extract<PlannerStreamEvent, { kind: "tool-result" }>["tool"];
        started: boolean;
      }
    >();
    const completedCalls = new Set<string>();
    const publish = (event: PlannerStreamEvent) => {
      if (this.active?.id !== job.id) return;
      for (const listener of this.streamListeners) {
        try {
          listener(job.id, structuredClone(event));
        } catch {
          /* An observer cannot interrupt transport or terminal fact recording. */
        }
      }
    };
    try {
      const configured =
        this.state.source === "configured" || this.state.source === "recorded"
          ? await this.configured()
          : undefined;
      if (signal.aborted) return;
      this.fingerprint = configured?.fingerprint;
      this.configurationFingerprint = configured?.configurationFingerprint;
      const connection = await this.deps.modelConnection?.resolve();
      if (signal.aborted) return;
      this.modelRevision = connection?.revision;
      this.update({ provider: connection?.provider ?? "codex" });
      const executable =
        connection?.provider === "compatible"
          ? ""
          : await this.deps.find(signal);
      if (signal.aborted) return;
      if (configured)
        await this.checkConfiguration(
          configured.configurationFingerprint ?? configured.fingerprint,
          !configured.configurationFingerprint &&
            configured.snapshot.source === "recorded",
          !!configured.configurationFingerprint,
        );
      if (connection) await this.checkModel(connection.revision);
      if (signal.aborted) return;
      const options = {
        snapshot: configured?.snapshot ?? createFixtureSnapshot(),
        prompt,
        at,
        signal,
        onProgress: (progress: PlannerProgress) => {
          if (!signal.aborted && this.active?.id === job.id)
            this.update({ progress });
        },
        onEvent: (event: PlannerStreamEvent) => {
          if (this.active?.id !== job.id) return;
          if (signal.aborted) {
            // Only an original, host-started call may contribute its terminal fact.
            // A late model answer, new call or mismatched call cannot affect this turn.
            if (event.kind !== "tool-result") return;
            const original = pendingCalls.get(event.callId);
            if (!original?.started || original.tool !== event.tool) return;
          }
          if (
            event.kind === "tool-requested" ||
            event.kind === "tool-started"
          ) {
            if (completedCalls.has(event.callId)) return;
            const original = pendingCalls.get(event.callId);
            if (original && original.tool !== event.tool) return;
            pendingCalls.set(event.callId, {
              tool: event.tool,
              started:
                original?.started === true || event.kind === "tool-started",
            });
          } else if (event.kind === "tool-result") {
            if (completedCalls.has(event.callId)) return;
            const original = pendingCalls.get(event.callId);
            if (original && original.tool !== event.tool) return;
            pendingCalls.delete(event.callId);
            completedCalls.add(event.callId);
          }
          publish(event);
        },
      };
      if (connection?.provider === "compatible" && !connection.apiKey)
        throw new AgentToolError(
          "API_KEY_REQUIRED",
          "请先在模型连接中保存密钥",
        );
      let result =
        connection?.provider === "compatible"
          ? await (this.deps.runtimeRun ?? this.deps.compatibleRun)({
              ...options,
              requestId: job.id,
              ...(principal ? { principal } : {}),
              connection: {
                baseUrl: connection.baseUrl,
                model: connection.model,
                apiKey: connection.apiKey!,
              },
            })
          : await this.deps.run({ ...options, executable });
      if (result.source !== this.state.source)
        throw new AgentToolError("SOURCE_MISMATCH", "规划结果来源与请求不一致");
      if (
        !signal.aborted &&
        configured &&
        result.execution !== "managed-by-goal" &&
        !result.configurationChangedByHost
      ) {
        const configurationOnly =
          !!configured.configurationFingerprint &&
          historyIndependentReply(result);
        await this.checkConfiguration(
          configurationOnly
            ? configured.configurationFingerprint!
            : configured.fingerprint,
          !configurationOnly && configured.snapshot.source === "recorded",
          configurationOnly,
        );
        if (configurationOnly && result.source === "recorded") {
          const recordedAt = agentBeijingTime(configured.snapshot.capturedAt);
          const note = `\n\n记录说明：以上答复依据${recordedAt ? `${recordedAt}（北京时间）采集的` : "本轮采集的"}记录快照；运行中的目标可能已有新进度，请以目标状态和重新查询的记录为准。`;
          result = {
            ...result,
            modelText: result.modelText.slice(0, 8000 - note.length) + note,
          };
        }
      }
      if (!signal.aborted && connection)
        await this.checkModel(connection.revision);
      if (!signal.aborted) this.update({ status: "completed", result });
    } catch (error) {
      shutdownFailed = isUnconfirmedRuntimeShutdown(error);
      if (shutdownFailed) this.closed = true;
      if (!signal.aborted || shutdownFailed)
        this.update({
          status: "failed",
          error: {
            code:
              error instanceof AgentToolError ? error.code : "PLANNER_FAILED",
            message:
              error instanceof AgentToolError
                ? error.message
                : "模型请求未完成，请核对目标与原执行记录后重试。",
          },
        });
    } finally {
      for (const [callId, call] of pendingCalls) {
        publish({
          kind: "tool-result",
          callId,
          tool: call.tool,
          success: false,
          code: "TOOL_RESPONSE_UNCONFIRMED",
        });
      }
      pendingCalls.clear();
      if (signal.aborted && !shutdownFailed)
        this.update({
          status: "cancelled",
          result: undefined,
          error: undefined,
        });
      this.update({ finishedAt: new Date().toISOString() });
      if (this.active?.id === job.id) this.active = undefined;
    }
  }
  cancel(id: unknown) {
    if (typeof id !== "string" || id !== this.state.requestId)
      throw new AgentToolError("REQUEST_MISMATCH", "规划请求编号不符");
    if (this.active && plannerActive(this.state)) {
      this.update({ status: "cancelling" });
      this.active.controller.abort();
    }
    return this.snapshot();
  }
  async close() {
    this.closed = true;
    if (!this.active) return;
    this.cancel(this.active.id);
    await this.active.done;
  }
}
