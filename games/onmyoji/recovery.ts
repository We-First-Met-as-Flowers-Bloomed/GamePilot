import type { TaskRecord } from "../../packages/protocol/task-record";
import { onmyojiStepEvidence, retainedOnmyojiEffects } from "./evidence";
import { classifyOnmyojiFrame } from "./inspection";

export function onmyojiReplayBlockers(task: TaskRecord): string[] {
  if (task.gameId !== "onmyoji") return ["游戏与阴阳师恢复契约不符"];
  return task.steps
    .filter((step) => {
      if (
        ["succeeded", "skipped"].includes(step.status) ||
        retainedOnmyojiEffects(step)
      )
        return false;
      if (step.status === "not-run")
        return Boolean(step.startedAt || step.result);
      return onmyojiStepEvidence(step)?.phase !== "not-submitted";
    })
    .map((step) => `${step.skillId}的提交或效果未确认，不能重新领取或提交`);
}
/** Existing login proves game state, not current role identity. Never register automatic replay. */
export const onmyojiRecovery = {
  classify: classifyOnmyojiFrame,
  replayBlockers: onmyojiReplayBlockers,
  retainedStep: retainedOnmyojiEffects,
  allowRetry: () => false,
  propose: () => undefined,
};
