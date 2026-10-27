import type { DeviceLane } from "../../../packages/protocol";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";
import {
  agentHistoryOverlaps,
  agentHistoryTouchesDay,
} from "../../../games/agent-execution";
import { dailySkills } from "../../../games/registry";
import { completedContinuationRequestIds } from "../../../games/continuation-history";
import { historyPlan } from "../../../games/agent-history";
import { requestMayAffectChannel } from "../../../packages/protocol/account-channel";

function scheduleHistoryPlan(request: ExecutionRecord, tasks: TaskRecord[]) {
  const snapshot = request.snapshot;
  if (snapshot.arknightsPlan !== undefined) return snapshot.arknightsPlan;
  const frozen = snapshot.lane as DeviceLane | undefined;
  if (
    snapshot.plan !== undefined ||
    frozen?.arknights?.enabled !== false ||
    frozen?.onmyoji?.enabled !== true
  )
    return undefined;
  try {
    const plan = historyPlan(snapshot.onmyojiPlan);
    if (plan.gameId !== "onmyoji" || plan.mode !== "live") return undefined;
    for (const task of tasks.filter(
      (task) => task.executionId === request.id,
    )) {
      if (
        task.gameId !== "onmyoji" ||
        JSON.stringify(historyPlan(task.plan)) !== JSON.stringify(plan)
      )
        return undefined;
    }
    // This proves only a disjoint game, never success or settlement of unknown work.
    return plan;
  } catch {
    // Missing, malformed or contradictory frozen evidence keeps the conservative guard.
    return undefined;
  }
}

/** A custom subset cannot become a daily completion or trigger a full automatic replay. */
export function assertAgentScheduleClear(
  lane: DeviceLane,
  requests: ExecutionRecord[],
  now: Date,
  periodStart?: Date,
  evidence?: { tasks: TaskRecord[]; startupFacts: StartupReconciliationFact[] },
) {
  const covered = completedContinuationRequestIds(
    requests,
    evidence?.tasks ?? [],
    evidence?.startupFacts ?? [],
    now,
  );
  for (const request of requests) {
    if (!requestMayAffectChannel(request, lane)) continue;
    if (
      !request.resolution &&
      !covered.has(request.id) &&
      ["running", "unknown", "failed", "cancelled"].includes(request.status)
    )
      throw new Error(
        `${lane.name} 的${request.snapshot.agent ? "本次 AI 任务" : "原执行请求"}尚需核对，已阻止自动日常补跑；请在任务记录中处理。`,
      );
    if (!request.snapshot.agent) continue;
    // Completed descendants settle the parent uncertainty, not its business effects.
    // Keep every original plan in the overlap checks below.
    // Confirmed saved daily work wrote the ordinary per-slot completion receipt.
    // It is not a custom subset and must not acquire the Ark-only replay guard.
    if (
      request.source === "daily" &&
      (request.snapshot.agent as { kind?: string }).kind === "saved-daily" &&
      request.status === "succeeded"
    )
      continue;
    if (
      agentHistoryTouchesDay(request.startedAt, request.finishedAt, now) &&
      // Only a verified success wholly before the new period can release this guard.
      !(
        periodStart &&
        request.status === "succeeded" &&
        Date.parse(request.finishedAt ?? "") < periodStart.getTime()
      ) &&
      agentHistoryOverlaps(
        {
          gameId: "arknights",
          mode: "live",
          skillIds: dailySkills("arknights"),
        },
        scheduleHistoryPlan(request, evidence?.tasks ?? []),
      )
    )
      throw new Error(
        `${lane.name} 本时段已提交过本次 AI 任务，暂停自动日常补跑以避免重复；没有标记整套日常完成。`,
      );
  }
}
