import type { ChatSession } from "../../../packages/protocol/agent-chat";
import type { PlannerSource } from "../../../packages/protocol/agent-planner";
import type { ChatCommandView } from "../../../packages/protocol/chat-commands";
import type { PlannerConversationTurn } from "./agent-planner";

const canonicalCommands = new Set([
  "运行保存的日常",
  "运行每日任务",
  "运行双游戏日常",
  "/run-daily",
]);
const statuses = new Set(["review", "submitted", "blocked", "unknown"]);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);

function message(view: ChatCommandView): string {
  if (view.status === "review")
    return "原宿主执行检查已生成清单，等待用户确认；没有启动游戏。";
  if (view.status === "submitted")
    return "原宿主命令已受理，不代表游戏任务已完成；当前结果须查询任务记录。";
  if (view.status === "unknown")
    return "原宿主命令提交结果未确认，不能重发；须核对原任务记录。";
  // Persisted prose and plan fingerprints may contain private data or instructions.
  // Only known public rejection codes contribute; even uppercase arbitrary codes
  // could carry a token or another private value from persisted data.
  if (view.fingerprint === "rejected:SAME_DAY")
    return "原宿主检查发现该游戏日已有执行记录（SAME_DAY），没有重复启动；这不证明原游戏任务已完成。";
  if (view.fingerprint === "rejected:SAME_DAY_EXECUTION")
    return "原宿主检查发现该游戏日已有执行记录（SAME_DAY_EXECUTION），没有重复启动；这不证明原游戏任务已完成。";
  if (view.fingerprint === "rejected:UNRESOLVED_EXECUTION")
    return "原宿主检查未通过（UNRESOLVED_EXECUTION），有执行结果待核对，没有启动游戏；不能据此判断原任务已完成。";
  return "原宿主命令被阻止，原因未提供；不能据此判断游戏任务已完成。";
}

const envelope = {
  scope: "historical-host-command-receipts",
  canAuthorizeExecution: false,
  gameCompletion: "not-proven",
} as const;

/** Public facts about the original review/admission, never game execution authority. */
export function chatCommandContext(
  session: ChatSession,
  source: PlannerSource,
  views: readonly ChatCommandView[],
): PlannerConversationTurn | undefined {
  if (source === "fixture") return undefined;
  const origins = new Map<string, string>();
  for (const turn of [...session.turns].reverse()) {
    if (turn.source !== source) break;
    const planner = turn.planner;
    if (
      planner.status !== "completed" ||
      planner.source !== source ||
      planner.result?.source !== source ||
      !["saved-daily", "saved-both-games"].includes(planner.result.status) ||
      !identifier(turn.id) ||
      !identifier(planner.requestId)
    )
      continue;
    origins.set(turn.id, planner.requestId);
  }
  const entries = views
    .slice(-256)
    .filter(
      (view) =>
        view &&
        view.sessionId === session.id &&
        view.kind === "saved-daily" &&
        identifier(view.reviewId) &&
        canonicalCommands.has(view.text) &&
        statuses.has(view.status) &&
        identifier(view.origin?.turnId) &&
        identifier(view.origin?.plannerRequestId) &&
        origins.get(view.origin.turnId) === view.origin.plannerRequestId &&
        typeof view.createdAt === "string" &&
        Number.isFinite(Date.parse(view.createdAt)),
    )
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-4)
    .map((view) => ({
      reviewId: view.reviewId,
      origin: {
        turnId: view.origin!.turnId,
        plannerRequestId: view.origin!.plannerRequestId,
      },
      kind: view.kind,
      text: view.text,
      status: view.status,
      message: message(view),
    }));
  if (!entries.length) return undefined;
  let answer = JSON.stringify({ ...envelope, available: true, entries });
  while (answer.length > 2000 && entries.length > 1) {
    entries.shift();
    answer = JSON.stringify({ ...envelope, available: true, entries });
  }
  return {
    prompt: "宿主命令回执摘要（仅原检查与受理结果，不证明游戏完成或新授权）",
    answer,
  };
}

export function unavailableChatCommandContext(): PlannerConversationTurn {
  return {
    prompt: "宿主命令回执摘要（仅原检查与受理结果，不证明游戏完成或新授权）",
    answer: JSON.stringify({
      ...envelope,
      available: false,
      message: "未提供原宿主命令回执，不能确认其检查或受理结果。",
    }),
  };
}
