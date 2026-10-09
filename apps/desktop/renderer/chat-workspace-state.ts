import type { GoalRun } from "../../../packages/protocol/agent-goal";
import type { ChatSession } from "../../../packages/protocol/agent-chat";
import type { PlannerSource } from "../../../packages/protocol/agent-planner";

const running = new Set([
  "preparing",
  "running",
  "waiting",
  "recovering",
  "cancelling",
]);
/** Exact host ownership only; timestamps, model prose and a shared device never join sessions. */
export function sessionTaskState(
  sessionId: string | undefined,
  goals: readonly GoalRun[],
) {
  const entries = goals
    .filter((goal) => !!sessionId && goal.sessionId === sessionId)
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const active = entries.filter((goal) => running.has(goal.status));
  const attention = entries.filter(
    (goal) =>
      ["needs-user", "failed", "unknown"].includes(goal.status) ||
      (goal.status === "completed" && goal.goalSatisfied !== true),
  );
  const completed = entries.filter(
    (goal) => goal.status === "completed" && goal.goalSatisfied === true,
  );
  return {
    entries,
    active,
    attention,
    completed,
    label: attention.length
      ? `${attention.length} 项需要你处理`
      : active.length
        ? `${active.length} 项正在执行`
        : completed.length && completed.length === entries.length
          ? "本会话目标已核验完成"
          : entries.length
            ? "本会话任务已停止"
            : "还没有交办任务",
    tone: attention.length
      ? "attention"
      : active.length
        ? "running"
        : completed.length && completed.length === entries.length
          ? "success"
          : "idle",
  };
}
export function processingSession(
  sessions: readonly ChatSession[],
  requestId?: string,
) {
  if (!requestId) return;
  const matches = sessions.filter((session) =>
    session.turns.some(
      (turn) =>
        turn.planner.requestId === requestId &&
        ["running", "cancelling"].includes(turn.planner.status),
    ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}
export interface SessionDraft {
  text: string;
  source: PlannerSource;
}
export type SessionDrafts = Record<string, SessionDraft>;
export function updateSessionDraft(
  drafts: SessionDrafts,
  sessionId: string,
  text: string,
) {
  if (!sessionId) return drafts;
  return {
    ...drafts,
    [sessionId]: { source: drafts[sessionId]?.source ?? "recorded", text },
  };
}
export function clearSubmittedDraft(
  drafts: SessionDrafts,
  sessionId: string,
  submitted: string,
) {
  return drafts[sessionId]?.text.trim() === submitted
    ? updateSessionDraft(drafts, sessionId, "")
    : drafts;
}
