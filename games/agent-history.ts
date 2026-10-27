import type { Plan } from "../packages/protocol";
import { games, gamePlugins } from "./registry";
import type {
  TaskStepRecord,
  TaskRecord,
} from "../packages/protocol/task-record";
import { taskFor, defaultArknightsConfig } from "./arknights/config";
import { agentDate } from "../packages/protocol/agent";
import { validArknightsEvidence } from "./arknights/evidence";

export function historyPlan(raw: unknown): Plan {
  const plan = raw as Plan;
  const game = games.find((g) => g.id === plan?.gameId);
  if (
    !game ||
    !["live", "rehearsal"].includes(plan.mode) ||
    !Array.isArray(plan.skillIds) ||
    !plan.skillIds.length ||
    plan.skillIds.length > 32 ||
    new Set(plan.skillIds).size !== plan.skillIds.length ||
    plan.skillIds.some((id) => !game.skills.some((s) => s.id === id))
  )
    throw Error("invalid plan");
  return { gameId: game.id, skillIds: [...plan.skillIds], mode: plan.mode };
}
export function historyGameDay(gameId: string, at: string) {
  try {
    return gamePlugins.get(gameId).gameDay(new Date(at));
  } catch {
    return undefined;
  }
}
export function historyStepStatus(
  step: TaskStepRecord,
): TaskStepRecord["status"] {
  if (
    ["succeeded", "skipped"].includes(step.status) &&
    step.result?.arknights &&
    (!validArknightsEvidence(step.result.arknights) ||
      step.result.arknights.completion !== "native-confirmed")
  )
    return "unknown";
  return step.status;
}
/** Check private native context before stripping it from the model-facing record. */
export function historyNativeMatches(task: TaskRecord, expectedUid?: string) {
  try {
    return task.steps.every((step) => {
      const e = step.result?.arknights;
      if (!e) return true;
      if (
        task.gameId !== "arknights" ||
        taskFor(step.skillId, {
          ...defaultArknightsConfig,
          stage: "LS-6",
          copilotFile: "redacted.json",
        }).type !== e.taskType
      )
        return false;
      const observed = Date.parse(agentDate(e.observedAt));
      const start = Date.parse(step.startedAt ?? task.startedAt);
      const end = Date.parse(
        step.finishedAt ?? task.finishedAt ?? task.updatedAt,
      );
      if (observed < start || observed > end) return false;
      return (
        !e.login ||
        (Boolean(expectedUid) &&
          e.login.expectedUid === expectedUid &&
          e.login.observedUid === expectedUid &&
          Date.parse(agentDate(e.login.observedAt)) >= observed &&
          Date.parse(agentDate(e.login.observedAt)) <= end &&
          ((e.login.method === undefined &&
            e.login.homeObservedAt === undefined) ||
            (e.login.method === "profile" &&
              e.login.homeObservedAt !== undefined &&
              Date.parse(agentDate(e.login.homeObservedAt)) >=
                Date.parse(agentDate(e.login.observedAt)) &&
              Date.parse(agentDate(e.login.homeObservedAt)) <= end)))
      );
    });
  } catch {
    return false;
  }
}
