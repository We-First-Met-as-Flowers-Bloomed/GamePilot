import type { DeviceLane } from "../../../packages/protocol";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import {
  requestMayAffectChannel,
  taskMayAffectChannel,
} from "../../../packages/protocol/account-channel";
import {
  confirmedFosterAt,
  unresolvedFoster,
} from "../../../games/onmyoji/maintenance-policy";
import { mumuResource } from "./execution-coordinator";

export function assertMaintenanceClear(
  lane: DeviceLane,
  requests: ExecutionRecord[],
  records: TaskRecord[],
  now = new Date(),
) {
  const resource = mumuResource(lane.managerPath, lane.instance);
  const byId = new Map(requests.map((r) => [r.id, r]));
  const matches = (request: ExecutionRecord) =>
    resource === "*" ||
    request.resources.some((key) => key === "*" || key === resource) ||
    (lane.legacyBinding !== undefined &&
      requestMayAffectChannel(request, lane));
  const matching = records.filter((r) => {
    const request = r.executionId ? byId.get(r.executionId) : undefined;
    if (request?.resolution?.action === "abandoned") return false;
    if (request) return matches(request);
    // Legacy/orphan records cannot prove the device changed. Fail closed for this lane.
    return taskMayAffectChannel(r, lane);
  });
  const pending = unresolvedFoster(matching, now);
  if (pending)
    throw Error(
      `${lane.name} 的寄养结果未确认（${pending.runId}），已暂停自动维护；请先核对任务记录和游戏现场。`,
    );

  const confirmedAt = Math.max(
    -Infinity,
    ...matching.map((record) => {
      const request = record.executionId
        ? byId.get(record.executionId)
        : undefined;
      // Lane names and orphan tasks cannot establish the observed physical device.
      if (
        !request ||
        resource === "*" ||
        request.resources.includes("*") ||
        !request.resources.includes(resource)
      )
        return -Infinity;
      return confirmedFosterAt(record, now) ?? -Infinity;
    }),
  );
  for (const request of requests.filter(matches)) {
    const plans = [request.snapshot.plan, request.snapshot.onmyojiPlan];
    const containsLiveFoster = plans.some((value) => {
      if (!value || typeof value !== "object") return false;
      const plan = value as {
        gameId?: unknown;
        mode?: unknown;
        skillIds?: unknown;
      };
      return (
        plan.gameId === "onmyoji" &&
        plan.mode === "live" &&
        Array.isArray(plan.skillIds) &&
        plan.skillIds.includes("foster")
      );
    });
    const maintenance = request.source === "maintenance" || containsLiveFoster;
    if (
      request.status !== "running" &&
      (!maintenance ||
        request.resolution?.action === "abandoned" ||
        !["unknown", "failed", "cancelled"].includes(request.status))
    )
      continue;
    const endedAt = Date.parse(request.finishedAt ?? request.startedAt);
    if (
      request.status !== "running" &&
      !request.resources.includes("*") &&
      endedAt < confirmedAt
    )
      continue;
    throw Error(
      `${lane.name} 的寄养结果未确认（${request.id}），已暂停自动维护；请先核对任务记录和游戏现场。`,
    );
  }
}
