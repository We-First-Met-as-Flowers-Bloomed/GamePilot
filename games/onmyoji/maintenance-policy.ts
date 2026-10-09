import type { TaskRecord } from "../../packages/protocol/task-record";

/**
 * 真实执行器返回的证据类型。
 *
 * `packages/runtime/runner.ts` 只在结果自带 `status` 时才写 `adapter-result`，
 * 否则写 `adapter-return`；而阴阳师的 `fosterScheduleResult()` 只返回
 * `outcome/observedAt/nextRunAt`，不带 `status` —— 所以寄养步骤实际写入的
 * **永远是 `adapter-return`**。此处若只认 `adapter-result`，下面的确认分支就
 * 永远不可达，`assertMaintenanceClear` 的第二道闸门会永久关闭。
 * 两者都是真实执行器的返回值，都要接受；演练证据不在此列。
 */
const ADAPTER_EVIDENCE = ["adapter-result", "adapter-return"];

/** Actual live observations only; successful status alone is not a foster result. */
export function confirmedFosterAt(
  record: TaskRecord,
  now = new Date(),
): number | undefined {
  if (record.gameId !== "onmyoji" || record.plan.mode !== "live") return;
  const step = record.steps.find((s) => s.skillId === "foster");
  const result = step?.result;
  const observed = Date.parse(result?.observedAt ?? "");
  const next = Date.parse(result?.nextRunAt ?? "");
  if (
    step &&
    ["succeeded", "skipped"].includes(step.status) &&
    ADAPTER_EVIDENCE.includes(step.evidence ?? "") &&
    ["active", "started"].includes(result?.outcome ?? "") &&
    observed >= Date.parse(step.startedAt ?? "") &&
    observed <= Date.parse(step.finishedAt ?? "") &&
    observed <= now.getTime() &&
    next > observed &&
    next - observed <= 6 * 60 * 60_000
  )
    return observed;
}

/** These records already belong to one physical device. Old outcomes remain intact. */
export function unresolvedFoster(
  records: TaskRecord[],
  now = new Date(),
): TaskRecord | undefined {
  const live = records.filter(
    (r) => r.gameId === "onmyoji" && r.plan.mode === "live",
  );
  let confirmedAt = -Infinity;
  for (const r of live) {
    confirmedAt = Math.max(confirmedAt, confirmedFosterAt(r, now) ?? -Infinity);
  }
  return live.find((r) => {
    const step = r.steps.find((s) => s.skillId === "foster");
    return (
      step &&
      ["running", "unknown", "failed", "cancelled"].includes(step.status) &&
      !(Date.parse(step.finishedAt ?? r.updatedAt) < confirmedAt)
    );
  });
}
