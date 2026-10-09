import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { LaneExecutionSnapshot } from "./lane-snapshot";
import type { DailyOccurrence } from "./scheduler";
import { mumuResource } from "./execution-coordinator";
import { canonical } from "../../../packages/acceptance/files";
import {
  startupFaultFrom,
  validStartupFaultAssociation,
} from "../../../packages/protocol/startup-fault";

export function unsubmittedStartupFailure(
  error: unknown,
  executionId: string,
  tasks: TaskRecord[],
): boolean {
  return (
    !!startupFaultFrom(error) &&
    !tasks.some(
      (task) =>
        task.executionId === executionId ||
        (!!task.batchId &&
          executionId.startsWith(task.batchId + ":") &&
          (!task.laneId || executionId === `${task.batchId}:${task.laneId}`)),
    )
  );
}

export function scheduledStartupRetry(
  frozen: LaneExecutionSnapshot,
  occurrence: DailyOccurrence,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  now: Date,
  expectedAttempts = 1,
): {
  allowed: boolean;
  status?: string;
  lastAttemptAt?: string;
  reason?: string;
} {
  const resource = mumuResource(frozen.lane.managerPath, frozen.lane.instance);
  const denied = (reason: string, status?: string) => ({
    allowed: false,
    reason,
    status,
  });
  if (
    resource === "*" ||
    !Number.isFinite(now.getTime()) ||
    now < occurrence.dueAt
  )
    return denied("设备或本时段时间无法确认");
  const related = requests.filter(
    (request) =>
      request.resources.includes(resource) || request.resources.includes("*"),
  );
  if (related.some((request) => request.status === "running"))
    return denied("设备仍有运行中的原请求", "running");
  const recent = related.filter(
    (request) => Date.parse(request.startedAt) >= occurrence.dueAt.getTime(),
  );
  if (
    related.some((request) => !Number.isFinite(Date.parse(request.startedAt)))
  )
    return denied("原请求时间无效");
  recent.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const samePeriod = recent.filter((request) => {
    const schedule = request.snapshot.schedule as
      { slot?: string; dueAt?: string } | undefined;
    return (
      request.source === "daily" &&
      schedule?.slot === occurrence.slot &&
      schedule.dueAt === occurrence.dueAt.toISOString()
    );
  });
  const original = samePeriod[0];
  if (!original) return denied("本时段没有可核对的原请求");
  if (
    !Number.isInteger(expectedAttempts) ||
    expectedAttempts < 1 ||
    expectedAttempts > 3 ||
    samePeriod.length !== expectedAttempts
  )
    return denied(
      "调度尝试次数与持久原请求不一致，不能复用旧失败证明",
      original.status,
    );
  if (
    samePeriod.some(
      (request) =>
        !request.resolution &&
        ["running", "unknown", "cancelled"].includes(request.status),
    )
  )
    return denied("本时段仍有未确认的原请求", original.status);
  if (recent[0] !== original)
    return denied("原失败后已有其他请求，不能自动重放", original.status);
  if (recent[1]?.startedAt === original.startedAt)
    return denied("原请求时间存在冲突");
  const schedule = original.snapshot.schedule as
    { slot?: string; dueAt?: string } | undefined;
  const exact =
    original.source === "daily" &&
    !original.snapshot.continuation &&
    !original.snapshot.agent &&
    original.laneId === frozen.lane.id &&
    original.resources.length === 1 &&
    original.resources[0] === resource &&
    schedule?.slot === occurrence.slot &&
    schedule.dueAt === occurrence.dueAt.toISOString() &&
    ["lane", "profile", "arknightsPlan", "onmyojiPlan"].every(
      (key) =>
        canonical(original.snapshot[key]) ===
        canonical((frozen as unknown as Record<string, unknown>)[key]),
    );
  if (!exact)
    return denied(
      "最近请求与当前设备、账号、轮次或计划不一致",
      original.status,
    );
  if (original.status !== "failed")
    return denied("原请求不是可确认的未提交失败", original.status);
  if (
    !original.startupFault ||
    !validStartupFaultAssociation(original) ||
    !Number.isFinite(Date.parse(original.finishedAt ?? "")) ||
    Date.parse(original.finishedAt!) > now.getTime()
  )
    return denied("缺少有效的已知启动故障及结束时间", original.status);
  if (
    ![
      "mumu-state-unavailable",
      "mumu-launch-failed",
      "mumu-boot-timeout",
    ].includes(original.startupFault.code)
  )
    return denied("原实例停止尚未确认，不能自动重试启动", original.status);
  if (
    tasks.some(
      (task) =>
        task.executionId === original.id ||
        (!!original.batchId && task.batchId === original.batchId) ||
        (task.laneId === frozen.lane.id &&
          Date.parse(task.startedAt) >= occurrence.dueAt.getTime()),
    )
  )
    return denied("本时段已有游戏任务记录，不能整套重放", original.status);
  return {
    allowed: true,
    status: original.status,
    lastAttemptAt: original.finishedAt,
    reason: "本时段已确认在游戏任务提交前启动失败",
  };
}
