import { randomUUID } from "node:crypto";
import { AgentToolError, agentObject } from "../../../packages/protocol/agent";
import type {
  ChatCommandConfirmation,
  ChatCommandReviewInput,
  ChatCommandStore,
  ChatCommandSummary,
  ChatCommandView,
} from "../../../packages/protocol/chat-commands";

export interface PreparedChatCommand {
  fingerprint: string;
  summary: ChatCommandSummary[];
  payload: unknown; // Host-owned frozen plans, never received back from renderer or model.
  needsAcknowledgement?: boolean;
}
interface Dependencies {
  validateSession(id: string): Promise<string | void>;
  validateOrigin?(view: ChatCommandView): Promise<void>;
  prepare(
    command: Pick<ChatCommandView, "kind" | "parentId" | "text" | "sessionId">,
  ): Promise<PreparedChatCommand>;
  launch(
    prepared: PreparedChatCommand,
    view: ChatCommandView,
  ): Promise<{ batchId: string; requestIds: string[] }>;
  load?(): Promise<ChatCommandStore | undefined>;
  save(store: ChatCommandStore): Promise<void>;
  record?(view: ChatCommandView): Promise<void>;
}
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_:.-]{1,240}$/.test(v);
function valid(v: ChatCommandView) {
  return (
    !!v &&
    id(v.reviewId) &&
    id(v.sessionId) &&
    Number.isSafeInteger(v.revision) &&
    v.revision > 0 &&
    ["saved-daily", "continue"].includes(v.kind) &&
    ["review", "submitted", "blocked", "unknown"].includes(v.status) &&
    typeof v.text === "string" &&
    v.text.length <= 12000 &&
    typeof v.fingerprint === "string" &&
    v.fingerprint.length > 0 &&
    v.fingerprint.length <= 200 &&
    Number.isFinite(Date.parse(v.createdAt)) &&
    Number.isFinite(Date.parse(v.expiresAt)) &&
    (v.parentId === undefined || id(v.parentId)) &&
    (v.origin === undefined ||
      (id(v.origin.turnId) &&
        id(v.origin.plannerRequestId) &&
        v.kind === "saved-daily")) &&
    (v.sessionContext === undefined ||
      (typeof v.sessionContext === "string" &&
        v.sessionContext.length <= 500)) &&
    (v.needsAcknowledgement === undefined ||
      typeof v.needsAcknowledgement === "boolean") &&
    Array.isArray(v.summary) &&
    v.summary.length <= 8 &&
    v.summary.every(
      (l) =>
        typeof l.laneName === "string" &&
        l.laneName.length <= 200 &&
        Array.isArray(l.games) &&
        l.games.length <= 2 &&
        l.games.every(
          (g) =>
            id(g.gameId) &&
            typeof g.title === "string" &&
            g.title.length <= 200 &&
            Array.isArray(g.steps) &&
            g.steps.length <= 64 &&
            g.steps.every((s) => typeof s === "string" && s.length <= 200),
        ),
    ) &&
    (v.confirmedRevision === undefined ||
      (Number.isSafeInteger(v.confirmedRevision) &&
        v.confirmedRevision > 0 &&
        v.confirmedRevision < v.revision)) &&
    (v.message === undefined ||
      (typeof v.message === "string" && v.message.length <= 1000)) &&
    (v.receipt === undefined ||
      (id(v.receipt.batchId) &&
        Array.isArray(v.receipt.requestIds) &&
        v.receipt.requestIds.length <= 8 &&
        v.receipt.requestIds.every(id)))
  );
}
/** Exact review/receipt bridge to the existing scheduler. Model prose never becomes an admission. */
export class ChatCommandService {
  private entries: ChatCommandView[] = [];
  private error = false;
  private operation = false;
  private cancellation = 0;
  private initialized: Promise<void>;
  constructor(private deps: Dependencies) {
    this.initialized = this.restore();
  }
  get busy() {
    return this.operation;
  }
  cancelPending() {
    this.cancellation++;
  }
  private async restore() {
    try {
      const store = await this.deps.load?.();
      if (!store) return;
      if (
        store.version !== 1 ||
        !Array.isArray(store.entries) ||
        store.entries.length > 256 ||
        store.entries.some((v) => !valid(v)) ||
        new Set(store.entries.map((v) => v.reviewId)).size !==
          store.entries.length
      )
        throw Error("store");
      this.entries = structuredClone(store.entries);
    } catch {
      this.error = true;
    }
  }
  private async persist() {
    try {
      await this.deps.save({
        version: 1,
        entries: structuredClone(this.entries),
      });
    } catch {
      this.error = true;
      throw new AgentToolError(
        "COMMAND_STORE_UNAVAILABLE",
        "聊天指令记录无法可靠保存；请检查原执行记录，不要重复启动",
      );
    }
  }
  private async enter() {
    await this.initialized;
    if (this.error)
      throw new AgentToolError(
        "COMMAND_STORE_UNAVAILABLE",
        "聊天指令记录不可用，请核对原执行记录",
      );
    if (this.operation)
      throw new AgentToolError(
        "COMMAND_BUSY",
        "上一条宿主指令正在受理，请稍后核对回执",
      );
    this.operation = true;
  }
  async snapshot(sessionId?: string) {
    await this.initialized;
    if (sessionId !== undefined && !id(sessionId))
      throw new AgentToolError("INVALID_SESSION", "会话编号无效");
    return structuredClone(
      this.entries.filter((v) => !sessionId || v.sessionId === sessionId),
    );
  }
  async review(raw: ChatCommandReviewInput): Promise<ChatCommandView> {
    return this.reviewInternal(raw);
  }
  /** Trusted main-process entry: the public IPC receives only a turn target. */
  async reviewFromPlanner(
    raw: ChatCommandReviewInput,
    origin: NonNullable<ChatCommandView["origin"]>,
    assertCurrent: () => Promise<void>,
  ) {
    if (!id(origin.turnId) || !id(origin.plannerRequestId) || raw.requestId)
      throw new AgentToolError("INVALID_CHAT_INTENT", "模型意图来源无效");
    return this.reviewInternal(raw, origin, assertCurrent);
  }
  private async reviewInternal(
    raw: ChatCommandReviewInput,
    origin?: NonNullable<ChatCommandView["origin"]>,
    assertCurrent?: () => Promise<void>,
  ): Promise<ChatCommandView> {
    const input = agentObject(raw, ["sessionId", "text", "requestId"]);
    if (
      !id(input.sessionId) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 12000 ||
      (input.requestId !== undefined && !id(input.requestId))
    )
      throw new AgentToolError("INVALID_COMMAND", "聊天指令参数无效");
    await this.enter();
    const cancellation = this.cancellation;
    try {
      await assertCurrent?.();
      const sessionContext = await this.deps.validateSession(input.sessionId);
      if (origin) {
        const existing = this.entries.find(
          (v) =>
            v.sessionId === input.sessionId &&
            v.origin?.turnId === origin.turnId &&
            v.origin?.plannerRequestId === origin.plannerRequestId,
        );
        if (existing) return structuredClone(existing);
      }
      const text = input.text.trim();
      const kind = input.requestId !== undefined ? "continue" : "saved-daily";
      if (
        kind === "saved-daily" &&
        ![
          "运行保存的日常",
          "运行每日任务",
          "运行双游戏日常",
          "/run-daily",
        ].includes(text)
      )
        throw new AgentToolError(
          "COMMAND_NOT_RECOGNIZED",
          "请使用“运行保存的日常”，或通过模型生成并检查自定义计划",
        );
      const command = {
        kind,
        text,
        sessionId: input.sessionId,
        ...(input.requestId ? { parentId: input.requestId } : {}),
      } as Pick<ChatCommandView, "kind" | "text" | "parentId" | "sessionId">;
      let prepared: PreparedChatCommand;
      let rejection: string | undefined;
      try {
        prepared = await this.deps.prepare(command);
      } catch (error) {
        if (!origin || !(error instanceof AgentToolError)) throw error;
        const code = /^[A-Z0-9_]{1,80}$/.test(error.code)
          ? error.code
          : "REVIEW_REJECTED";
        // A model preview never launches; preserve definite host refusals in its
        // original turn instead of losing them when the user changes views.
        prepared = {
          fingerprint: `rejected:${code}`,
          summary: [],
          payload: undefined,
        };
        rejection =
          code === "SAME_DAY" || code === "SAME_DAY_EXECUTION"
            ? `该游戏日已有执行记录（${code}），没有重复启动；请查看原任务记录。`
            : `宿主检查未通过（${code}），没有启动游戏；请核对原任务记录或修改需求后重新检查。`;
      }
      await assertCurrent?.();
      if (cancellation !== this.cancellation)
        throw new AgentToolError(
          "COMMAND_CANCELLED",
          "指令检查已取消，没有启动游戏",
        );
      if (sessionContext !== (await this.deps.validateSession(input.sessionId)))
        throw new AgentToolError(
          "COMMAND_CONTEXT_CHANGED",
          "会话轮次已变化，请重新检查",
        );
      const now = new Date();
      const view: ChatCommandView = {
        ...command,
        ...(origin ? { origin: structuredClone(origin) } : {}),
        reviewId: randomUUID(),
        sessionId: input.sessionId,
        revision: 1,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 15 * 60000).toISOString(),
        status: rejection ? "blocked" : "review",
        ...(rejection ? { message: rejection } : {}),
        fingerprint: prepared.fingerprint,
        summary: structuredClone(prepared.summary),
        ...(sessionContext ? { sessionContext } : {}),
        ...(prepared.needsAcknowledgement
          ? { needsAcknowledgement: true }
          : {}),
      };
      if (!valid(view))
        throw new AgentToolError(
          "INVALID_COMMAND_REVIEW",
          "宿主计划检查结果无效",
        );
      this.entries = [...this.entries.slice(-255), view];
      await this.persist();
      await this.deps.record?.(view);
      return structuredClone(view);
    } finally {
      this.operation = false;
    }
  }
  async confirm(raw: ChatCommandConfirmation): Promise<ChatCommandView> {
    const input = agentObject(raw, [
      "sessionId",
      "reviewId",
      "revision",
      "acknowledgePartial",
    ]);
    if (
      !id(input.sessionId) ||
      !id(input.reviewId) ||
      !Number.isSafeInteger(input.revision) ||
      (input.revision as number) < 1
    )
      throw new AgentToolError("INVALID_CONFIRMATION", "聊天确认参数无效");
    await this.enter();
    const cancellation = this.cancellation;
    try {
      const view = this.entries.find((v) => v.reviewId === input.reviewId);
      if (!view || view.sessionId !== input.sessionId)
        throw new AgentToolError(
          "COMMAND_MISMATCH",
          "原会话指令不存在，请重新检查",
        );
      // A committed admission, including an unknown receipt, is never sent again.
      if (view.confirmedRevision === input.revision && view.status !== "review")
        return structuredClone(view);
      if (view.status !== "review" || view.revision !== input.revision)
        throw new AgentToolError(
          "COMMAND_CHANGED",
          "指令版本已变化，请重新检查",
        );
      const sessionContext = await this.deps.validateSession(view.sessionId);
      if (view.origin) {
        if (!this.deps.validateOrigin)
          throw new AgentToolError("CHAT_INTENT_STALE", "模型意图需重新检查");
        await this.deps.validateOrigin(view);
      }
      if (view.sessionContext !== sessionContext)
        throw new AgentToolError(
          "COMMAND_CONTEXT_CHANGED",
          "会话轮次已变化，请在当前需求重新检查",
        );
      if (
        input.acknowledgePartial !== undefined &&
        typeof input.acknowledgePartial !== "boolean"
      )
        throw new AgentToolError("INVALID_CONFIRMATION", "部分执行确认值无效");
      if (view.needsAcknowledgement && input.acknowledgePartial !== true)
        throw new AgentToolError(
          "PARTIAL_ACK_REQUIRED",
          "请先核对失败步骤的部分执行情况并明确确认",
        );
      if (Date.now() > Date.parse(view.expiresAt))
        throw new AgentToolError(
          "COMMAND_EXPIRED",
          "指令检查已过期，请重新检查",
        );
      const prepared = await this.deps.prepare(view);
      if (cancellation !== this.cancellation)
        throw new AgentToolError(
          "COMMAND_CANCELLED",
          "指令受理已取消，没有启动游戏",
        );
      if (
        prepared.fingerprint !== view.fingerprint ||
        JSON.stringify(prepared.summary) !== JSON.stringify(view.summary)
      )
        throw new AgentToolError(
          "COMMAND_CHANGED",
          "账号、原计划或剩余步骤已变化，请重新检查",
        );
      view.confirmedRevision = view.revision;
      view.revision++;
      view.status = "unknown";
      view.message = "受理意图已保存，正在核对原调度器回执；不能重复提交";
      await this.persist();
      await this.deps.record?.(view);
      try {
        const current = await this.deps.prepare(view);
        const currentSessionContext = await this.deps.validateSession(
          view.sessionId,
        );
        if (view.origin) {
          try {
            await this.deps.validateOrigin!(view);
          } catch {
            view.status = "blocked";
            view.message = "本轮模型意图已失效，没有交给游戏执行器";
            await this.persist();
            await this.deps.record?.(view);
            return structuredClone(view);
          }
        }
        if (
          cancellation !== this.cancellation ||
          currentSessionContext !== view.sessionContext ||
          current.fingerprint !== prepared.fingerprint ||
          JSON.stringify(current.summary) !== JSON.stringify(prepared.summary)
        ) {
          view.status = "blocked";
          view.message = "受理前配置或原任务已变化，没有交给游戏执行器";
          await this.persist();
          await this.deps.record?.(view);
          return structuredClone(view);
        }
        if (view.kind === "continue")
          current.payload = {
            ...(current.payload as Record<string, unknown>),
            acknowledgePartial: input.acknowledgePartial === true,
          };
        view.receipt = await this.deps.launch(current, structuredClone(view));
        if (!valid(view)) throw Error("receipt");
        view.status = "submitted";
        view.message = "原调度器已受理；任务完成情况以执行账本为准";
      } catch {
        view.status = "unknown";
        view.message = "受理结果未确认；请查询精确执行回执，不要重发";
      }
      await this.persist();
      await this.deps.record?.(view);
      return structuredClone(view);
    } finally {
      this.operation = false;
    }
  }
}
