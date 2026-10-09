import { AgentToolError, agentObject } from "../../../packages/protocol/agent";
import type { ChatView } from "../../../packages/protocol/agent-chat";
import type { PlannerViewState } from "../../../packages/protocol/agent-planner";
import type {
  ChatCommandView,
  ChatIntentReviewInput,
} from "../../../packages/protocol/chat-commands";
import type { ChatCommandService } from "./chat-commands";

interface Dependencies {
  planner(): Promise<PlannerViewState>;
  chat(): Promise<ChatView>;
  commands: Pick<ChatCommandService, "reviewFromPlanner">;
}
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_:.-]{1,240}$/.test(v);
const stale = () =>
  new AgentToolError(
    "CHAT_INTENT_STALE",
    "这条模型意图已失效；请在当前会话重新说明需求并检查清单",
  );

/** Resolves a fresh public model intent into the original host review, never a launch. */
export class ChatIntentReviewService {
  constructor(private deps: Dependencies) {}
  private async resolve(target: ChatIntentReviewInput) {
    const chat = await this.deps.chat();
    // Chat reconciliation may invalidate the planner while retaining historical turns.
    // Only the verified snapshot obtained after it can authorize a new review.
    const live = await this.deps.planner();
    const session = chat.sessions.find((s) => s.id === target.sessionId);
    const turn = session?.turns.at(-1);
    const kind = live.result?.status;
    if (
      chat.error ||
      chat.selectedSessionId !== target.sessionId ||
      !turn ||
      turn.id !== target.turnId ||
      turn.planner.requestId !== target.requestId ||
      live.requestId !== target.requestId ||
      live.status !== "completed" ||
      turn.planner.status !== "completed" ||
      turn.planner.revision !== live.revision ||
      turn.source === "fixture" ||
      live.source === "fixture" ||
      live.result?.source === "fixture" ||
      turn.source !== live.result?.source ||
      turn.planner.result?.status !== kind ||
      (kind !== "saved-daily" && kind !== "saved-both-games") ||
      live.result?.execution !== "not-started" ||
      live.result?.canExecute !== false ||
      live.result?.draft
    )
      throw stale();
    return kind === "saved-both-games" ? "运行双游戏日常" : "运行保存的日常";
  }
  async assertCurrent(view: ChatCommandView) {
    if (!view.origin) return;
    const text = await this.resolve({
      sessionId: view.sessionId,
      turnId: view.origin.turnId,
      requestId: view.origin.plannerRequestId,
    });
    if (text !== view.text) throw stale();
  }
  async review(raw: ChatIntentReviewInput): Promise<ChatCommandView> {
    const value = agentObject(raw, ["sessionId", "turnId", "requestId"]);
    if (
      !validId(value.sessionId) ||
      !validId(value.turnId) ||
      !validId(value.requestId)
    )
      throw new AgentToolError("INVALID_CHAT_INTENT", "模型意图目标无效");
    const target = value as unknown as ChatIntentReviewInput;
    const text = await this.resolve(target);
    return this.deps.commands.reviewFromPlanner(
      { sessionId: target.sessionId, text },
      { turnId: target.turnId, plannerRequestId: target.requestId },
      async () => {
        if ((await this.resolve(target)) !== text) throw stale();
      },
    );
  }
}
