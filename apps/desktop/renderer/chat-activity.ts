import type { DeviceLane, RunStatus } from "../../../packages/protocol";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import {
  eventExecutionSource,
  isActiveStatus,
} from "../../../packages/protocol/run-state";
import { games } from "../../../games/registry";
import type { dailyLaneState } from "./daily-state";
import { executionForEvent } from "./execution-selection";

export type ChatLaneScope =
  "daily" | "single" | "maintenance" | "continuation" | "unknown";
export type ChatLaneActivity = ReturnType<typeof chatLaneActivity>;
const scopeNames: Record<ChatLaneScope, string> = {
  daily: "本轮日常",
  single: "单项任务",
  maintenance: "寄养维护",
  continuation: "所选续跑",
  unknown: "当前请求",
};
const stateNames: Record<RunStatus, string> = {
  queued: "准备中",
  running: "运行中",
  stopping: "正在停止",
  succeeded: "已完成",
  failed: "失败，待处理",
  cancelled: "已停止",
};

/** Compact chat status is derived from the same account-bound facts as the daily workspace. */
export function chatLaneActivity(
  lane: DeviceLane,
  daily: ReturnType<typeof dailyLaneState>,
  tasks: readonly TaskRecord[] = [],
  requests: readonly ExecutionRecord[] = [],
) {
  const requestId = executionForEvent(daily.lastRun, requests);
  const receipt = requestId
    ? requests.find((r) => r.id === requestId)
    : undefined;
  const declared = daily.lastRun
    ? eventExecutionSource(daily.lastRun, requests)
    : undefined;
  const scope: ChatLaneScope = receipt?.snapshot.continuation
    ? "continuation"
    : (declared ?? "unknown");
  const rejectedBinding = Boolean(
    !requestId &&
    (daily.lastRun?.executionId ||
      requests.filter(
        (r) => r.laneId === lane.id && r.batchId === daily.lastRun?.batchId,
      ).length > 1),
  );
  const records =
    daily.lastRun?.batchId && !rejectedBinding
      ? tasks.filter(
          (r) =>
            r.laneId === lane.id &&
            r.batchId === daily.lastRun!.batchId &&
            (!requestId || !r.executionId || r.executionId === requestId),
        )
      : [];
  const active = isActiveStatus(daily.status);
  const uncertain =
    !active &&
    Boolean(
      daily.lastRun?.resultUncertain ||
      receipt?.status === "unknown" ||
      (daily.status === "succeeded" && receipt?.status === "failed") ||
      records.some(
        (r) =>
          r.status === "unknown" || r.steps.some((s) => s.status === "unknown"),
      ),
    );
  const status = uncertain ? "unknown" : daily.status;
  const label = uncertain
    ? "部分结果未知"
    : daily.status
      ? `${scopeNames[scope]}${stateNames[daily.status]}`
      : scope === "continuation" && daily.lastRun?.status === "succeeded"
        ? "续跑已结束 · 原计划待核对"
        : "今日日常待核对";
  const candidates = records
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .flatMap((record) => record.steps.map((step) => ({ record, step })));
  const current =
    candidates.find(({ step }) => step.status === "running") ??
    candidates.find(({ step }) =>
      ["failed", "unknown"].includes(step.status),
    ) ??
    (active
      ? candidates.find(({ step }) => step.status === "pending")
      : undefined);
  const currentStep = current && {
    gameId: current.record.gameId,
    gameName:
      games.find((g) => g.id === current.record.gameId)?.name ??
      current.record.gameId,
    skillId: current.step.skillId,
    title:
      games
        .find((g) => g.id === current.record.gameId)
        ?.skills.find((s) => s.id === current.step.skillId)?.title ??
      current.step.skillId,
    status: current.step.status,
  };
  return {
    laneId: lane.id,
    label,
    status,
    active,
    uncertain,
    scope,
    requestId,
    dailyRequestId: scope === "daily" ? requestId : undefined,
    currentStep,
    canDiagnose: Boolean(
      receipt &&
      !receipt.resolution &&
      ["failed", "unknown"].includes(receipt.status),
    ),
    revision: JSON.stringify([
      daily.lastRun?.at,
      requests
        .filter((r) => r.laneId === lane.id)
        .map((r) => [r.id, r.status, r.finishedAt]),
      records.map((r) => [r.runId, r.updatedAt]),
    ]),
  };
}
