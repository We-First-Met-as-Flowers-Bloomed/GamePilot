import { createHash } from "node:crypto";
import type { GoalRun } from "../../../packages/protocol/agent-goal";
import type { AgentRuntimePrincipal } from "../../../packages/protocol/agent-runtime";

/** Additional host facts only; the planner already bounds the chat history. */
export const DSH_GOAL_CONTEXT_MAX_BYTES = 8192;
const prefix = "\n宿主本会话目标事实：";

function goalFacts(goal: GoalRun) {
  return {
    id: goal.id,
    revision: goal.revision,
    status: goal.status,
    updatedAt: goal.updatedAt,
    prompt: goal.prompt,
    message: goal.message,
    waitingReason: goal.waitingReason,
    originalScopes:
      goal.originalReview?.scopes ??
      goal.attempts[0]?.review.scopes ??
      goal.review?.scopes ??
      goal.grant.scopes,
    submission: goal.submission,
    receipt: goal.receipt,
    flowComplete: goal.flowComplete,
    goalSatisfied: goal.goalSatisfied,
  };
}

function goalContext(
  principal: AgentRuntimePrincipal,
  goals: readonly GoalRun[],
) {
  const referenced = (goal: GoalRun) => {
    const escaped = goal.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`).test(
      principal.prompt,
    );
  };
  const closed = (goal: GoalRun) =>
    goal.status === "completed" || goal.status === "cancelled";
  const owned = goals
    .filter((goal) => goal.sessionId === principal.sessionId)
    .sort(
      (a, b) =>
        Number(referenced(b)) - Number(referenced(a)) ||
        Number(closed(a)) - Number(closed(b)) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
  if (!owned.length) return "";
  type Facts = ReturnType<typeof goalFacts>;
  type Stub = Pick<Facts, "id" | "revision" | "status"> & {
    details: "read_goal";
  };
  const selected: (Facts | Stub)[] = [];
  const serialize = () =>
    prefix +
    JSON.stringify({
      canAuthorizeExecution: false,
      receiptsDoNotProveCompletion: true,
      detailTool: "read_goal",
      requiresReadGoal:
        selected.length < owned.length ||
        selected.some((goal) => "details" in goal),
      omittedGoalCount: owned.length - selected.length,
      goals: selected,
    });
  for (const goal of owned) {
    selected.push(goalFacts(goal));
    if (Buffer.byteLength(serialize(), "utf8") <= DSH_GOAL_CONTEXT_MAX_BYTES)
      continue;
    // Never cut a constraint or receipt in half. Retrieve oversized details from
    // the durable Goal store; this context cannot grant or resume execution.
    selected[selected.length - 1] = {
      id: goal.id,
      revision: goal.revision,
      status: goal.status,
      details: "read_goal",
    };
    if (Buffer.byteLength(serialize(), "utf8") > DSH_GOAL_CONTEXT_MAX_BYTES) {
      selected.pop();
      break;
    }
  }
  return serialize();
}

export function createDshTurnContext(input: {
  prompt: string;
  requestId: string;
  principal?: AgentRuntimePrincipal;
  goals?: readonly GoalRun[];
}) {
  const { principal } = input;
  const sessionId = principal
    ? "chat-turn-" +
      createHash("sha256")
        .update(JSON.stringify([principal.sessionId, principal.turnId]))
        .digest("hex")
    : `planner-${input.requestId}`;
  return {
    // Authority reads this separate, unchanged current message, never the facts.
    currentMessage: principal?.prompt ?? input.prompt,
    prompt:
      input.prompt +
      (principal ? goalContext(principal, input.goals ?? []) : ""),
    sessionId,
    // Resuming is restricted to this App turn; a fresh turn has a fresh key.
    // Existing in-turn followup also retains the key and the shared tool budget.
    resume: Boolean(principal),
  };
}
