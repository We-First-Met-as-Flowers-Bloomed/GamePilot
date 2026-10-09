import { AgentToolError } from "../../../packages/protocol/agent";
import type { GoalRun, GoalScope } from "../../../packages/protocol/agent-goal";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { DeviceInspection } from "../../../packages/protocol/recovery";
import { canonical } from "../../../packages/acceptance/files";
import type { ExecutionCoordinator } from "./execution-coordinator";

interface InspectionScope {
  requestId: string;
  laneId: string;
  scopeGameIds: string[];
}
export type GoalInspectionReason =
  | "executor-owns-device"
  | "missing-request"
  | "resolved-request"
  | "request-changed"
  | "binding-unverified"
  | "inspection-unavailable"
  | "inspection-invalid";
export type GoalInspectionResult = InspectionScope &
  (
    | {
        kind: "not-probed";
        reason: GoalInspectionReason;
        pageVerified: false;
        accountVerified: false;
        account: "unknown";
      }
    | {
        kind: "observed";
        observedAt: string;
        foregroundPackage?: string;
        page: string;
        pageVerified: boolean;
        accountVerified: boolean;
        account: "matched" | "mismatch" | "unknown" | "unbound";
      }
  );
export interface GoalInspectionDependencies {
  executions: Pick<ExecutionCoordinator, "assertHealthy" | "get" | "inspect">;
  /** Read-only capture; its native screenshot remains in the app and is never included in this DTO. */
  capture(id: string, signal: AbortSignal): Promise<DeviceInspection>;
  /** Host binding/quarantined-resource guard; no configuration alone proves a visible account. */
  blocked?(record: ExecutionRecord): boolean;
}
interface Reservation {
  scope: InspectionScope;
  batchId: string;
  scopes: GoalScope[];
}
function latestReservations(goal: GoalRun): Reservation[] {
  const latest = new Map<string, Reservation>();
  for (const attempt of goal.attempts) {
    const lanes = [...new Set(attempt.review.scopes.map((s) => s.laneId))];
    const expected = lanes.map((id) => `${attempt.submission.batchId}:${id}`);
    if (
      expected.length !== attempt.submission.requestIds.length ||
      !expected.every((id) => attempt.submission.requestIds.includes(id))
    )
      throw new AgentToolError(
        "GOAL_RESERVATION_INVALID",
        "原目标请求编号与冻结账号范围不一致，不能核对设备。",
      );
    for (const laneId of lanes) {
      const scopes = attempt.review.scopes.filter((s) => s.laneId === laneId);
      latest.set(laneId, {
        batchId: attempt.submission.batchId,
        scopes,
        scope: {
          requestId: `${attempt.submission.batchId}:${laneId}`,
          laneId,
          scopeGameIds: [...new Set(scopes.map((s) => s.gameId))],
        },
      });
    }
  }
  if (latest.size > 2)
    throw new AgentToolError(
      "GOAL_INSPECTION_BUDGET",
      "一次最多核对两个原目标设备。",
    );
  return [...latest.values()];
}
const notProbed = (
  scope: InspectionScope,
  reason: GoalInspectionReason,
): GoalInspectionResult => ({
  ...scope,
  kind: "not-probed",
  reason,
  pageVerified: false,
  accountVerified: false,
  account: "unknown",
});
function recordMatches(reservation: Reservation, record: ExecutionRecord) {
  const plans = [
    record.snapshot.plan,
    record.snapshot.arknightsPlan,
    record.snapshot.onmyojiPlan,
  ].filter(
    (p): p is { gameId: string; mode: string; skillIds: string[] } =>
      !!p &&
      typeof p === "object" &&
      typeof (p as { gameId?: unknown }).gameId === "string" &&
      Array.isArray((p as { skillIds?: unknown }).skillIds),
  );
  return (
    record.id === reservation.scope.requestId &&
    record.batchId === reservation.batchId &&
    record.laneId === reservation.scope.laneId &&
    (record.snapshot.lane as { id?: unknown } | undefined)?.id ===
      reservation.scope.laneId &&
    record.resources.length > 0 &&
    record.resources.length <= 16 &&
    record.resources.every(
      (r) => typeof r === "string" && !!r && r.length <= 1024,
    ) &&
    plans.length === reservation.scopes.length &&
    reservation.scopes.every((s) =>
      plans.some(
        (p) =>
          p.gameId === s.gameId &&
          p.mode === "live" &&
          canonical(p.skillIds) === canonical(s.skillIds),
      ),
    )
  );
}
function unchanged(original: ExecutionRecord, current: ExecutionRecord) {
  return (
    current.id === original.id &&
    current.fingerprint === original.fingerprint &&
    current.batchId === original.batchId &&
    current.laneId === original.laneId &&
    canonical(current.resources) === canonical(original.resources) &&
    canonical(current.snapshot) === canonical(original.snapshot)
  );
}
function project(
  scope: InspectionScope,
  capture: DeviceInspection,
): GoalInspectionResult {
  if (
    !capture ||
    typeof capture.observedAt !== "string" ||
    capture.observedAt.length > 50 ||
    !Number.isFinite(Date.parse(capture.observedAt))
  )
    return notProbed(scope, "inspection-invalid");
  const ark = capture.arknights;
  const supported =
    scope.scopeGameIds.length === 1 && scope.scopeGameIds[0] === "arknights";
  const pages = [
    "home",
    "profile",
    "friends-list",
    "credit-shop",
    "battle",
    "settlement",
    "login",
    "network-error",
    "unknown",
    "other-app",
  ];
  const page = ark && pages.includes(ark.page) ? ark.page : "unknown";
  const account =
    supported &&
    ark &&
    ["matched", "mismatch", "unknown", "unbound"].includes(ark.account) &&
    (ark.account !== "matched" ||
      (ark.accountVerified === true && capture.accountVerified === true))
      ? ark.account
      : "unknown";
  const foregroundPackage =
    typeof capture.foregroundPackage === "string" &&
    capture.foregroundPackage.length <= 200 &&
    /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(capture.foregroundPackage)
      ? capture.foregroundPackage
      : undefined;
  return {
    ...scope,
    kind: "observed",
    observedAt: capture.observedAt,
    ...(foregroundPackage ? { foregroundPackage } : {}),
    page,
    pageVerified:
      supported &&
      page !== "unknown" &&
      page !== "other-app" &&
      capture.pageVerified === true &&
      ark?.pageVerified === true,
    accountVerified: account === "matched",
    account,
  };
}

/** Inspects accepted requests without submitting, recovering or marking any game outcome complete. */
export function createGoalInspection(deps: GoalInspectionDependencies) {
  return {
    inspect: async (
      goal: GoalRun,
      signal: AbortSignal,
    ): Promise<GoalInspectionResult[]> => {
      signal.throwIfAborted();
      const reservations = latestReservations(goal);
      try {
        deps.executions.assertHealthy();
      } catch {
        return reservations.map(({ scope }) =>
          notProbed(scope, "inspection-unavailable"),
        );
      }
      const results: GoalInspectionResult[] = [];
      for (const reservation of reservations) {
        signal.throwIfAborted();
        const scope = reservation.scope;
        let record: ExecutionRecord;
        try {
          record = deps.executions.get(scope.requestId);
        } catch {
          results.push(notProbed(scope, "missing-request"));
          continue;
        }
        const refusal = (
          current: ExecutionRecord,
        ): GoalInspectionReason | undefined => {
          if (
            !recordMatches(reservation, current) ||
            !unchanged(record, current)
          )
            return "request-changed";
          if (current.status === "running") return "executor-owns-device";
          if (current.resolution) return "resolved-request";
          if (deps.blocked?.(structuredClone(current)))
            return "binding-unverified";
          return undefined;
        };
        try {
          const reason = refusal(record);
          if (reason) {
            results.push(notProbed(scope, reason));
            continue;
          }
          results.push(
            await deps.executions.inspect(record.resources, async () => {
              signal.throwIfAborted();
              deps.executions.assertHealthy();
              const before = refusal(deps.executions.get(scope.requestId));
              if (before) return notProbed(scope, before);
              const capture = await deps.capture(scope.requestId, signal);
              signal.throwIfAborted();
              deps.executions.assertHealthy();
              const after = refusal(deps.executions.get(scope.requestId));
              return after ? notProbed(scope, after) : project(scope, capture);
            }),
          );
        } catch {
          signal.throwIfAborted();
          results.push(notProbed(scope, "inspection-unavailable"));
        }
      }
      return results;
    },
  };
}
