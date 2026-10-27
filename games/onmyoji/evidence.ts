import type { TaskStepRecord } from "../../packages/protocol/task-record";
import {
  validOnmyojiEvidence,
  type OnmyojiExecutionEvidence,
  type OnmyojiEffect,
} from "../../packages/protocol/onmyoji-evidence";

/** Frozen step association and observation bounds are mandatory for retained effects. */
export function onmyojiStepEvidence(
  step: TaskStepRecord,
): OnmyojiExecutionEvidence | undefined {
  const value = step.result?.onmyoji;
  const start = Date.parse(step.startedAt ?? ""),
    end = Date.parse(step.finishedAt ?? "");
  if (
    !validOnmyojiEvidence(value) ||
    value.skillId !== step.skillId ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start ||
    Date.parse(value.observedAt) < start ||
    Date.parse(value.observedAt) > end ||
    value.effects.some(
      (effect) =>
        Date.parse(effect.observedAt) < start ||
        Date.parse(effect.observedAt) > end,
    )
  )
    return;
  return value;
}

/** A failed flow with confirmed effects stays failed and is excluded from effect replay. */
export function retainedOnmyojiEffects(step: TaskStepRecord): boolean {
  return (
    ["failed", "cancelled"].includes(step.status) &&
    onmyojiStepEvidence(step)?.phase === "confirmed"
  );
}

export const onmyojiEffectLabels: Readonly<
  Record<OnmyojiEffect["kind"], string>
> = Object.freeze({
  "one-key-chores": "每日一签及一键庭院事务结果已核对",
  "mail-claim": "邮箱待领取附件状态已核对",
  "free-daily-gift": "每日免费礼包领取效果已核对",
  "guild-submit": "一批集体任务提交进度已核对",
  "guild-reward": "集体任务已领取的奖励状态已核对",
  "oboroguruma-equip": "胧车挂机御魂配置确认状态已核对",
  "oboroguruma-start": "胧车挂机出发状态已核对",
  "hana-claim": "花合战待领取奖励状态已核对",
});
/** Public facts use fixed labels; localized logs and stored free text cannot claim completion. */
export function onmyojiObservedEffects(step: TaskStepRecord): OnmyojiEffect[] {
  return (
    onmyojiStepEvidence(step)?.effects.map((effect) => ({
      ...effect,
      summary: onmyojiEffectLabels[effect.kind],
    })) ?? []
  );
}
