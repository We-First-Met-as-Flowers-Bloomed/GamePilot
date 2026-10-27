import {
  validStructuredSkillOutcome,
  type SkillResult,
} from "../../packages/protocol";
import type { StepOutcome } from "./report";
import { validArknightsEvidence } from "../../games/arknights/evidence";

export type CompletionState =
  "succeeded" | "skipped" | "failed" | "blocked" | "unknown";

/** Evidence belongs to this attempt; a future or earlier observation cannot prove it. */
function evidenceWithinAttempt(item: StepOutcome): boolean {
  const times = [
    item.evidenceTimestamp,
    item.observedAt,
    item.onmyoji?.observedAt,
    ...(item.onmyoji?.effects.map((effect) => effect.observedAt) ?? []),
    item.arknights?.observedAt,
    item.arknights?.login?.observedAt,
    item.arknights?.login?.homeObservedAt,
    item.onmyojiIdentity?.startedAt,
    item.onmyojiIdentity?.observedAt,
    ...(item.onmyojiIdentity?.frames.map((frame) => frame.observedAt) ?? []),
  ].filter((value) => value !== undefined);
  if (!times.length) return true;
  const start =
    item.startedAt === undefined ? -Infinity : Date.parse(item.startedAt);
  const finish =
    item.finishedAt === undefined ? Infinity : Date.parse(item.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(finish) || start > finish)
    return false;
  const end = Math.min(finish, Date.now());
  return times.every((time) => {
    const observed = typeof time === "string" ? Date.parse(time) : NaN;
    return Number.isFinite(observed) && observed >= start && observed <= end;
  });
}

/** Read legacy and current receipts without changing the adapter's original facts. */
export function completionState(item: StepOutcome): CompletionState {
  if (
    item.status === "failed" ||
    item.status === "blocked" ||
    item.status === "unknown"
  )
    return item.status;
  if (item.status !== "succeeded" && item.status !== "skipped")
    return "unknown";
  if (item.summary !== undefined && typeof item.summary !== "string")
    return "unknown";
  if (
    item.arknights !== undefined &&
    (!validArknightsEvidence(item.arknights) ||
      (item.status === "succeeded" &&
        item.arknights.completion !== "native-confirmed"))
  )
    return "unknown";
  if (
    !validStructuredSkillOutcome(item as SkillResult) ||
    !evidenceWithinAttempt(item)
  )
    return "unknown";
  if (item.onmyoji && item.onmyoji.skillId !== item.skill) return "unknown";
  if (item.skipReason === "unknown") return "unknown";

  const lawfulSkip =
    item.status === "skipped" &&
    (item.skipReason === "not-open" ||
      item.skipReason === "user-excluded" ||
      (!item.required &&
        item.skipReason === "unavailable" &&
        item.goalSatisfied === false));
  if (lawfulSkip) return "skipped";
  if (item.goalSatisfied === null || item.goalSatisfied === false)
    return "unknown";
  if (item.skipReason === "unavailable") return "unknown";
  if (
    item.skill === "daily-gift" &&
    /领取状态(?:未|无法)确认/.test((item.summary ?? "").replace(/\s/g, "")) &&
    item.goalSatisfied !== true
  )
    return "unknown";
  return item.status;
}

export function isSettledOutcome(item: StepOutcome): boolean {
  const state = completionState(item);
  return state === "succeeded" || state === "skipped";
}

export function stepOutcomeFromResult(
  step: Pick<StepOutcome, "skill" | "label" | "required">,
  result: SkillResult | undefined,
  attempts: number,
  startedAt: string,
  finishedAt: string,
): StepOutcome {
  return {
    ...result,
    skill: step.skill,
    label: step.label,
    required: step.required,
    status: result?.status ?? "succeeded",
    summary: result?.summary ?? "完成",
    attempts,
    startedAt,
    finishedAt,
  };
}
