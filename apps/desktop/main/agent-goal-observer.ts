import type { Plan } from "../../../packages/protocol";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import type { ContinuationLink } from "../../../packages/protocol/continuation";
import type {
  GoalObservation,
  GoalRequestResult,
  GoalRecoveryReference,
  GoalRun,
  GoalScope,
} from "../../../packages/protocol/agent-goal";
import { AgentToolError } from "../../../packages/protocol/agent";
import { canonical } from "../../../packages/acceptance/files";
import {
  evaluateGoalOutcome,
  type GoalOutcomeCriteria,
} from "../../../games/goal-outcome";
import { gamePlugins } from "../../../games/registry";
import type { ExecutionCoordinator } from "./execution-coordinator";
import type { RunLedger } from "./run-ledger";
import type { PreparedGoal } from "./agent-goals";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";

export interface GoalObserverContext {
  goal: GoalRun;
  /** Exact reserved requests only. Neither unrelated lanes nor external continuations are adopted. */
  requests: ExecutionRecord[];
  tasks: TaskRecord[];
  candidateRequestIds: string[];
}
export interface GoalObserverDependencies {
  executions: Pick<ExecutionCoordinator, "assertHealthy" | "snapshot">;
  ledger: Pick<RunLedger, "assertHealthy" | "forExecution"> &
    Partial<Pick<RunLedger, "flush" | "snapshot">>;
  startupFacts?(): StartupReconciliationFact[];
  criteria?(goal: GoalRun): GoalOutcomeCriteria;
  /** Read-only host policy/evidence registration. It may not operate the device or call a model. */
  findRecovery?(
    context: GoalObserverContext,
  ): Promise<GoalRecoveryReference | undefined>;
  /** Must revalidate fresh fingerprints/account/submission evidence; returns a frozen plan only. */
  prepareRecovery?(
    context: GoalObserverContext,
    reference: GoalRecoveryReference,
  ): Promise<PreparedGoal>;
}
interface Reservation {
  requestId: string;
  batchId: string;
  laneId: string;
  scopes: GoalScope[];
  parentRequestId?: string;
  externalParent?: { requestId: string; fingerprint: string; goalId: string };
}
function reservations(goal: GoalRun): Reservation[] {
  return goal.attempts.flatMap((attempt) =>
    attempt.submission.requestIds.map((requestId) => {
      const lanes = [
        ...new Set(attempt.review.scopes.map((scope) => scope.laneId)),
      ];
      const laneId = lanes.find(
        (id) => requestId === `${attempt.submission.batchId}:${id}`,
      );
      if (!laneId)
        throw new AgentToolError(
          "GOAL_RESERVATION_INVALID",
          "目标原始请求编号与冻结账号范围不一致。",
        );
      return {
        requestId,
        batchId: attempt.submission.batchId,
        laneId,
        scopes: attempt.review.scopes.filter(
          (scope) => scope.laneId === laneId,
        ),
        parentRequestId: attempt.submission.parentRequestId,
        ...(attempt.submission.attempt === 0 &&
        goal.selection.kind === "continuation" &&
        goal.selection.parentRequestId === attempt.submission.parentRequestId &&
        attempt.review.frozenPlan.kind === "continuation" &&
        goal.selection.parentRequestId ===
          attempt.review.frozenPlan.parentRequestId &&
        goal.selection.parentFingerprint === attempt.review.frozenPlan.hash &&
        goal.selection.parentFingerprint === attempt.review.fingerprint
          ? {
              externalParent: {
                requestId: goal.selection.parentRequestId!,
                fingerprint: goal.selection.parentFingerprint!,
                goalId: goal.id,
              },
            }
          : {}),
      };
    }),
  );
}
function plansFor(request: ExecutionRecord): Plan[] {
  return [
    request.snapshot.plan,
    request.snapshot.arknightsPlan,
    request.snapshot.onmyojiPlan,
  ].filter(
    (value): value is Plan =>
      !!value &&
      typeof value === "object" &&
      typeof (value as Plan).gameId === "string" &&
      Array.isArray((value as Plan).skillIds),
  );
}
function accountBinding(request: ExecutionRecord) {
  const lane = request.snapshot.lane as
    | {
        id?: string;
        managerPath?: string;
        instance?: number;
        arknights?: { profileId?: string };
      }
    | undefined;
  const profile = request.snapshot.profile as
    { id?: string; expectedUid?: string; clientType?: string } | undefined;
  return canonical({
    laneId: lane?.id,
    managerPath: lane?.managerPath,
    instance: lane?.instance,
    profileId: lane?.arknights?.profileId,
    profile: profile && {
      id: profile.id,
      expectedUid: profile.expectedUid,
      clientType: profile.clientType,
    },
  });
}
function reservedRecordMatches(
  reservation: Reservation,
  request: ExecutionRecord,
  prior: ExecutionRecord[],
  all: ExecutionRecord[],
) {
  if (
    request.id !== reservation.requestId ||
    request.batchId !== reservation.batchId ||
    request.laneId !== reservation.laneId ||
    (request.snapshot.lane as { id?: unknown } | undefined)?.id !==
      reservation.laneId
  )
    return false;
  const plans = plansFor(request);
  if (
    plans.length !== reservation.scopes.length ||
    new Set(plans.map((plan) => plan.gameId)).size !== plans.length ||
    reservation.scopes.some(
      (scope) =>
        !plans.some(
          (plan) =>
            plan.gameId === scope.gameId &&
            plan.mode === "live" &&
            canonical(plan.skillIds) === canonical(scope.skillIds),
        ),
    )
  )
    return false;
  const link = request.snapshot.continuation as ContinuationLink | undefined;
  if (!reservation.parentRequestId) return !link;
  const parent =
    prior.find((record) => record.id === reservation.parentRequestId) ??
    (reservation.externalParent
      ? all.find(
          (record) =>
            record.id === reservation.externalParent!.requestId &&
            record.fingerprint === reservation.externalParent!.fingerprint,
        )
      : undefined);
  if (
    reservation.externalParent &&
    (!parent ||
      parent.source !== "daily" ||
      !["failed", "unknown"].includes(parent.status) ||
      (parent.resolution &&
        (!Number.isFinite(Date.parse(parent.resolution.at)) ||
          Date.parse(parent.resolution.at) <= Date.parse(request.startedAt))) ||
      !parent.finishedAt ||
      !Number.isFinite(Date.parse(parent.finishedAt)) ||
      !Number.isFinite(Date.parse(request.startedAt)) ||
      Date.parse(parent.finishedAt) > Date.parse(request.startedAt) ||
      canonical(parent.resources) !== canonical(request.resources) ||
      accountBinding(parent) !== accountBinding(request) ||
      canonical(plansFor(parent)) !== canonical(plans) ||
      !link ||
      link.acknowledgedPartial !== false ||
      !Array.isArray(link.retained) ||
      link.retained.length !== 0 ||
      !Array.isArray(link.excluded) ||
      link.excluded.length !== 0 ||
      (request.snapshot.agent as { requestId?: string } | undefined)
        ?.requestId !== reservation.externalParent.goalId)
  )
    return false;
  return (
    !!parent &&
    parent.laneId === request.laneId &&
    !!link &&
    link.parentId === parent.id &&
    link.parentFingerprint === parent.fingerprint
  );
}
function unknownResult(reservation: Reservation): GoalRequestResult {
  return {
    requestId: reservation.requestId,
    laneId: reservation.laneId,
    ...(reservation.scopes.length === 1
      ? { gameId: reservation.scopes[0].gameId }
      : {}),
    status: "unknown",
    flowComplete: false,
    goalSatisfied: null,
    skills: [],
  };
}

/** Read-only ledger projection and in-memory trusted recovery registration for GoalService. */
export function createGoalObserver(deps: GoalObserverDependencies) {
  const registered = new Map<string, GoalRecoveryReference>();
  const read = async (goal: GoalRun) => {
    deps.executions.assertHealthy();
    deps.ledger.assertHealthy();
    await deps.ledger.flush?.();
    deps.executions.assertHealthy();
    deps.ledger.assertHealthy();
    const expected = reservations(goal);
    const all = deps.executions.snapshot(Number.MAX_SAFE_INTEGER);
    const requests: ExecutionRecord[] = [],
      tasks: TaskRecord[] = [];
    const invalidLanes = new Set<string>();
    const latest = new Map<string, Reservation>();
    const parents = new Set<string>();
    for (const reservation of expected) {
      latest.set(reservation.laneId, reservation);
      const record = all.find(
        (request) => request.id === reservation.requestId,
      );
      if (
        !record ||
        !reservedRecordMatches(reservation, record, requests, all) ||
        (reservation.parentRequestId &&
          parents.has(reservation.parentRequestId))
      ) {
        invalidLanes.add(reservation.laneId);
        continue;
      }
      if (reservation.parentRequestId) parents.add(reservation.parentRequestId);
      requests.push(record);
      tasks.push(...deps.ledger.forExecution(record.id));
    }
    const context: GoalObserverContext = {
      goal: structuredClone(goal),
      requests,
      tasks,
      candidateRequestIds: [...latest.values()]
        .filter(
          (reservation) =>
            !invalidLanes.has(reservation.laneId) &&
            requests.some(
              (request) =>
                request.id === reservation.requestId &&
                ["failed", "unknown"].includes(request.status),
            ) &&
            !tasks
              .filter((task) => task.executionId === reservation.requestId)
              .some(
                (task) =>
                  gamePlugins.get(task.gameId).recovery.replayBlockers(task)
                    .length > 0,
              ),
        )
        .map((reservation) => reservation.requestId),
    };
    return { expected, latest, invalidLanes, context, all };
  };
  const observe = async (goal: GoalRun): Promise<GoalObservation> => {
    const { expected, latest, invalidLanes, context, all } = await read(goal);
    const valid = context.requests.filter(
      (request) => !invalidLanes.has(request.laneId!),
    );
    // A newly adopted daily starts this Goal at its reserved child. Its exact
    // external parent was checked above, but that old failure is not a Goal
    // attempt or a completion obligation. Keep the real ledger/link untouched.
    const adoptedRoots = new Set(
      expected.filter((r) => r.externalParent).map((r) => r.requestId),
    );
    const projected = valid.map((request) =>
      adoptedRoots.has(request.id)
        ? {
            ...request,
            snapshot: { ...request.snapshot, continuation: undefined },
          }
        : request,
    );
    const evaluation = evaluateGoalOutcome(
      projected,
      deps.ledger.snapshot?.(Number.MAX_SAFE_INTEGER) ?? context.tasks,
      deps.criteria?.(goal),
      all,
      deps.startupFacts?.() ?? [],
    );
    const resultRows: GoalRequestResult[] = [...evaluation.requests];
    for (const reservation of expected) {
      if (resultRows.some((row) => row.requestId === reservation.requestId))
        continue;
      const request = context.requests.find(
        (record) => record.id === reservation.requestId,
      );
      if (!request || invalidLanes.has(reservation.laneId))
        resultRows.push(unknownResult(reservation));
      else
        resultRows.push(
          ...evaluateGoalOutcome(
            [request],
            context.tasks.filter((task) => task.executionId === request.id),
            deps.criteria?.(goal),
          ).requests,
        );
    }
    const missing = invalidLanes.size > 0;
    const observation: GoalObservation = {
      requests: resultRows,
      flowComplete: !missing && latest.size > 0 && evaluation.flowComplete,
      goalSatisfied: missing ? null : evaluation.goalSatisfied,
      summary: missing
        ? "部分预留请求缺失、冻结范围不符或续跑关联无法核对；保留未知结果，不重发动作。"
        : evaluation.summary,
    };
    registered.delete(goal.id);
    if (deps.findRecovery && context.candidateRequestIds.length) {
      const reference = await deps.findRecovery(structuredClone(context));
      if (
        reference &&
        context.candidateRequestIds.includes(reference.requestId) &&
        reference.laneId ===
          context.requests.find((request) => request.id === reference.requestId)
            ?.laneId
      ) {
        registered.set(goal.id, structuredClone(reference));
        observation.recovery = structuredClone(reference);
      }
    }
    return observation;
  };
  const recover = async (
    goal: GoalRun,
    reference: GoalRecoveryReference,
  ): Promise<PreparedGoal> => {
    const proof = registered.get(goal.id);
    if (
      !proof ||
      canonical(proof) !== canonical(reference) ||
      !deps.prepareRecovery
    )
      throw new AgentToolError(
        "GOAL_RECOVERY_NOT_REGISTERED",
        "恢复引用未由当前宿主证据登记；请重新对账原请求。",
      );
    const { context } = await read(goal);
    if (!context.candidateRequestIds.includes(reference.requestId))
      throw new AgentToolError(
        "GOAL_RECOVERY_CHANGED",
        "原请求状态或续跑关联已变化，不能使用旧恢复引用。",
      );
    // The host callback must freshly revalidate identity/package and the captured failure fingerprint.
    return deps.prepareRecovery(
      structuredClone(context),
      structuredClone(reference),
    );
  };
  return { observe, recover };
}
