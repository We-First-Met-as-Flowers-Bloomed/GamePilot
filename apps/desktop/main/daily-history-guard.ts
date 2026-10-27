import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";
import type { LaneExecutionSnapshot } from "./lane-snapshot";
import type { DailyOccurrence } from "./scheduler";
import { guardHistory, taskMatchesRequest } from "./agent-execution-policy";
import { assertAgentScheduleClear } from "./agent-schedule-guard";
import { scheduledStartupRetry } from "./scheduled-startup-retry";
import { mumuResource } from "./execution-coordinator";

/** The manual button and scheduler use the same complete ledgers before admission. */
export function assertDailyHistoryClear(
  target: LaneExecutionSnapshot,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  now: Date,
  startupFacts: StartupReconciliationFact[] = [],
  occurrence?: DailyOccurrence,
) {
  const resource = mumuResource(target.lane.managerPath, target.lane.instance);
  const inPeriod = (r: ExecutionRecord) => {
    const schedule = r.snapshot.schedule as
      { slot?: string; dueAt?: string } | undefined;
    return (
      r.source === "daily" &&
      r.resources.includes(resource) &&
      schedule?.slot === occurrence?.slot &&
      schedule?.dueAt === occurrence?.dueAt.toISOString()
    );
  };
  // Retry permissions still come from exact persisted pre-submit evidence, never
  // from a missing success, a button click, or an abandoned unknown request.
  const retry =
    occurrence &&
    scheduledStartupRetry(
      target,
      occurrence,
      requests,
      tasks,
      now,
      requests.filter(inPeriod).length,
    );
  const eligible = retry?.allowed
    ? requests.filter(
        (r) =>
          !(
            inPeriod(r) &&
            scheduledStartupRetry(target, occurrence!, [r], tasks, now, 1)
              .allowed
          ),
      )
    : requests;
  const periodStart =
    occurrence?.slot === "secondary" ? occurrence.dueAt : undefined;
  assertAgentScheduleClear(target.lane, eligible, now, periodStart, {
    tasks,
    startupFacts,
  });
  // A later scheduled period may follow finished success; it cannot discard
  // unresolved history or tasks which arrive after that request's finish time.
  const earlier = new Set(
    eligible
      .filter(
        (r) =>
          periodStart &&
          r.status === "succeeded" &&
          Number.isFinite(Date.parse(r.startedAt)) &&
          Date.parse(r.startedAt) <= Date.parse(r.finishedAt ?? "") &&
          Date.parse(r.finishedAt ?? "") < periodStart.getTime() &&
          tasks
            .filter((t) => t.executionId === r.id)
            .every(
              (t) =>
                taskMatchesRequest(t, r) &&
                t.status === "succeeded" &&
                Number.isFinite(Date.parse(t.startedAt)) &&
                Date.parse(t.startedAt) >= Date.parse(r.startedAt) &&
                Number.isFinite(Date.parse(t.finishedAt ?? "")) &&
                Date.parse(t.finishedAt!) <= Date.parse(r.finishedAt!) &&
                Number.isFinite(Date.parse(t.updatedAt)) &&
                Date.parse(t.updatedAt) <= Date.parse(r.finishedAt!),
            ),
      )
      .map((r) => r.id),
  );
  const context = {
    requests: eligible.filter((r) => !earlier.has(r.id)),
    tasks: tasks.filter(
      (t) =>
        !earlier.has(t.executionId ?? "") ||
        !t.finishedAt ||
        Date.parse(t.finishedAt) >= periodStart!.getTime() ||
        Date.parse(t.updatedAt) >= periodStart!.getTime(),
    ),
    startupFacts,
  };
  for (const plan of [target.arknightsPlan, target.onmyojiPlan])
    if (plan) guardHistory(target, context, now, plan);
}
