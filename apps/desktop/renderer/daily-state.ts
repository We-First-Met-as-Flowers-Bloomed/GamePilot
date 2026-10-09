import type { DeviceLane, RunEvent } from "../../../packages/protocol";
import { deviceLanePlanKey } from "../../../packages/protocol";
import {
  isActiveStatus,
  latestRunStates,
  eventExecutionSource,
} from "../../../packages/protocol/run-state";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import { arknightsGameDay } from "../../../games/arknights/result-policy";
import { gameDay as onmyojiGameDay } from "../../../games/onmyoji/policy";

export function dailyLaneState(
  lane: DeviceLane,
  events: RunEvent[],
  now: Date,
  requests: readonly ExecutionRecord[] = [],
) {
  const batchEvents = events.filter(
    (event) =>
      event.laneId === lane.id &&
      event.batchId &&
      event.runId === event.batchId &&
      event.status,
  );
  const states = latestRunStates(batchEvents).reverse();
  const lastRun =
    states.find((event) => isActiveStatus(event.status)) ??
    states.find((event) => eventExecutionSource(event, requests) === "daily") ??
    states.find((event) => !event.maintenance);
  const start =
    lastRun &&
    batchEvents.find(
      (event) =>
        event.runId === lastRun.runId &&
        (event.status === "queued" || event.status === "running"),
    );
  const startedAt = Date.parse(lastRun?.startedAt ?? start?.at ?? "");
  // Match the scheduler's lane policy. Missing old start evidence is not today's success.
  const day = lane.onmyoji.enabled ? onmyojiGameDay : arknightsGameDay;
  const gameDay = Number.isFinite(startedAt)
    ? day(new Date(startedAt))
    : undefined;
  const samePlan = Boolean(
    lastRun?.planKey && lastRun.planKey === deviceLanePlanKey(lane),
  );
  const isDaily =
    lastRun &&
    eventExecutionSource(lastRun, requests) === "daily" &&
    !requests.some(
      (request) =>
        request.laneId === lane.id &&
        request.batchId === lastRun.batchId &&
        request.snapshot?.continuation,
    );
  return {
    status:
      isActiveStatus(lastRun?.status) ||
      (isDaily && samePlan && gameDay === day(now))
        ? (lastRun?.status ?? null)
        : null,
    lastRun,
    gameDay,
  };
}
