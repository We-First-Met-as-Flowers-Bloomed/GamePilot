import {
  createHistoryIndex,
  frozenHistoryPlans as frozenPlans,
  historySameDevice as sameDevice,
  historyTouchesDay as touchesDay,
} from "./history-gate";
import type { Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type {
  TaskRecord,
  TaskStepRecord,
} from "../packages/protocol/task-record";
import { historyGameDay, historyStepStatus } from "./agent-history";
import { projectExecutionDetail } from "./execution-detail";
import { mergeExecutionProgress } from "./execution-progress";
import { previewDailyContinuation } from "./continuation";
import { validArknightsEvidence } from "./arknights/evidence";
import type { StartupReconciliationFact } from "../packages/protocol/startup-reconciliation";
import { matchesStartupReconciliation } from "./arknights/startup-reconciliation";
import { onmyojiStepEvidence } from "./onmyoji/evidence";
import { asRecord as object } from "../packages/protocol/struct";

/** Native uncertainty belongs to the device admission, not a cancellable item. */
export class ContinuationHistoryError extends Error {
  readonly code = "UNCONFIRMED_NATIVE";
  constructor(message: string) {
    super(message);
    this.name = "ContinuationHistoryError";
  }
}

export function assertNativeEffectsKnown(
  task: TaskRecord,
  now: Date,
  request: ExecutionRecord | undefined,
  tasks: TaskRecord[],
  verifiedStartupFacts: StartupReconciliationFact[],
): void {
  if (
    !touchesDay(
      task.gameId,
      task.startedAt,
      task.finishedAt ?? task.updatedAt,
      now,
    )
  )
    return;
  for (const step of task.steps) {
    const onmyoji = step.result?.onmyoji;
    if (
      onmyoji !== undefined &&
      (!onmyojiStepEvidence(step) || onmyoji.phase === "submitted")
    )
      throw new ContinuationHistoryError(
        "目标设备同游戏日存在未确认阴阳师提交或矛盾效果证据，不能继续业务，请先核对",
      );
    const native = step.result?.arknights;
    const reconciled =
      native?.taskType === "StartUp" &&
      step.skillId === "login" &&
      request &&
      verifiedStartupFacts.some(
        (fact) =>
          Date.parse(fact.reconciledAt) <= now.getTime() &&
          fact.candidate.originalRunId === task.runId &&
          matchesStartupReconciliation(fact, request, tasks),
      );
    if (
      !reconciled &&
      native !== undefined &&
      (!validArknightsEvidence(native) ||
        (native.submission === "submitted" &&
          native.completion !== "native-confirmed"))
    )
      throw new ContinuationHistoryError(
        "目标设备同游戏日存在未确认原生提交或矛盾元数据，不能继续任何业务，请先核对",
      );
  }
}

function checkSteps(steps: TaskStepRecord[], skills: string[]): void {
  for (const skillId of skills) {
    const candidates = steps.filter((step) => step.skillId === skillId);
    const step = candidates.length === 1 ? candidates[0] : undefined;
    if (!step) throw Error("目标设备同游戏日的重叠业务缺少可靠记录，请先核对");
    const status = historyStepStatus(step),
      native = step.result?.arknights;
    if (
      native?.submission === "submitted" &&
      native.completion !== "native-confirmed"
    )
      throw new ContinuationHistoryError(
        "目标设备的独立请求存在未知或未确认的原生提交，请先核对",
      );
    if (
      status === "succeeded" ||
      (native?.submission === "submitted" &&
        native.completion === "native-confirmed")
    )
      throw Error(
        "目标设备同游戏日已有独立请求完成重叠业务，不能沿旧进度重复执行",
      );
    if (
      status === "not-run" ||
      status === "skipped" ||
      (native?.submission === "not-submitted" &&
        native.completion === "not-started")
    )
      continue;
    throw Error("目标设备的独立请求存在未知或未确认的重叠业务效果，请先核对");
  }
}

/** Reuse the frozen serial-lane stop proof; absence alone never means unstarted. */
function serialGameNotStarted(
  request: ExecutionRecord,
  detail: ExecutionDetail | undefined,
  tasks: TaskRecord[],
  gameId: string,
  now: Date,
  verifiedStartupFacts: StartupReconciliationFact[],
): boolean {
  if (
    request.source !== "daily" ||
    request.snapshot.plan !== undefined ||
    !["failed", "cancelled", "unknown"].includes(request.status) ||
    !request.finishedAt ||
    !Number.isFinite(Date.parse(request.finishedAt)) ||
    !detail ||
    detail.warnings.length ||
    detail.games.length !== 2 ||
    detail.games[0].plan.gameId !== "arknights" ||
    detail.games[1].plan.gameId !== gameId ||
    gameId !== "onmyoji" ||
    detail.games[1].record ||
    tasks.some(
      (task) => task.executionId === request.id && task.gameId === gameId,
    )
  )
    return false;
  const previous = detail.games[0].record;
  if (
    !previous ||
    !["failed", "cancelled"].includes(previous.status) ||
    !previous.finishedAt
  )
    return false;
  // Only the exact verified startup fact may remove this serial-lane hazard.
  const preview = previewDailyContinuation(
    detail,
    request,
    now,
    verifiedStartupFacts,
  );
  return (
    preview.canContinue &&
    preview.steps
      .filter((step) => step.gameId === gameId)
      .every((step) => step.status === "pending")
  );
}

/** Completed, uniquely verified coverage closes uncertainty without changing raw request facts. */
export function completedContinuationRequestIds(
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  verifiedStartupFacts: StartupReconciliationFact[] = [],
  now?: Date,
): Set<string> {
  const covered = new Set<string>();
  const index = createHistoryIndex(requests, tasks);
  const details = new Map<string, ExecutionDetail>();
  for (const request of requests) {
    try {
      details.set(
        request.id,
        projectExecutionDetail(request, index.tasks(request.id)),
      );
    } catch {
      /* Incomplete or corrupt evidence never exempts an unresolved request. */
    }
  }
  for (const request of requests) {
    if (
      !requests.some(
        (child) => object(child.snapshot.continuation)?.parentId === request.id,
      )
    )
      continue;
    try {
      const progress = mergeExecutionProgress(
        request.id,
        requests,
        details,
        verifiedStartupFacts,
        tasks,
      );
      if (
        progress.requests.length > 1 &&
        !progress.warnings.length &&
        (!now ||
          progress.requests.every(
            (record) => Date.parse(record.finishedAt ?? "") <= now.getTime(),
          )) &&
        progress.wholePlanComplete
      )
        progress.requests.forEach((record) => covered.add(record.id));
    } catch {
      /* Missing, partial, ambiguous or unknown native coverage stays gated. */
    }
  }
  return covered;
}

/** A continuation cannot replay another independent run's confirmed or unknown effects. */
export function assertContinuationHistory(
  parent: ExecutionRecord,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  plans: Plan[],
  now: Date,
  verifiedStartupFacts: StartupReconciliationFact[] = [],
): void {
  const business = plans
    .filter((plan) => plan.mode === "live")
    .map((plan) => ({
      ...plan,
      skillIds: plan.skillIds.filter((id) => id !== "login"),
    }))
    .filter((plan) => plan.skillIds.length);
  if (!business.length) return;
  const index = createHistoryIndex(requests, tasks);
  const details = new Map<string, ExecutionDetail>();
  for (const request of requests) {
    try {
      details.set(
        request.id,
        projectExecutionDetail(request, index.tasks(request.id)),
      );
    } catch {
      /* Unreliable records cannot supply an exemption. */
    }
  }
  const excluded = new Set([parent.id]);
  try {
    const progress = mergeExecutionProgress(
      parent.id,
      requests,
      details,
      verifiedStartupFacts,
      tasks,
    );
    if (!progress.warnings.length)
      progress.requests.forEach((request) => excluded.add(request.id));
  } catch {
    /* Only independently verified links are exempt. */
  }
  const checkedTasks = new Set<TaskRecord>();
  for (const request of requests) {
    if (excluded.has(request.id)) {
      for (const game of details.get(request.id)?.games ?? [])
        if (game.record)
          tasks
            .filter(
              (task) =>
                task.executionId === request.id &&
                task.runId === game.record!.runId,
            )
            .forEach((task) => checkedTasks.add(task));
      continue;
    }
    if (!sameDevice(parent, request)) continue;
    // Abandonment and a smaller selection never turn unconfirmed submitted
    // work into proof of an idle, safe device. Only other devices/days differ.
    for (const task of index.tasks(request.id))
      assertNativeEffectsKnown(task, now, request, tasks, verifiedStartupFacts);
    const frozen = frozenPlans(request),
      detail = details.get(request.id);
    for (const proposed of business) {
      if (
        !touchesDay(proposed.gameId, request.startedAt, request.finishedAt, now)
      )
        continue;
      if (!frozen)
        throw Error("目标设备同游戏日的独立请求计划不完整，重叠效果待核对");
      const originals = frozen.filter(
        (plan) => plan.gameId === proposed.gameId && plan.mode === "live",
      );
      for (const original of originals) {
        const overlap = proposed.skillIds.filter((id) =>
          original.skillIds.includes(id),
        );
        if (!overlap.length) continue;
        const games = detail?.games.filter(
          (game) => game.plan.gameId === proposed.gameId,
        );
        if (
          games?.length === 1 &&
          !games[0].record &&
          serialGameNotStarted(
            request,
            detail,
            tasks,
            proposed.gameId,
            now,
            verifiedStartupFacts,
          )
        )
          continue;
        if (games?.length !== 1 || !games[0].record || detail?.warnings.length)
          throw Error("目标设备同游戏日的独立请求重叠业务未确认，请先核对");
        checkSteps(games[0].record.steps, overlap);
      }
    }
    for (const game of detail?.games ?? [])
      if (game.record)
        tasks
          .filter(
            (task) =>
              task.executionId === request.id &&
              task.runId === game.record!.runId,
          )
          .forEach((task) => checkedTasks.add(task));
  }
  const lane = object(parent.snapshot.lane);
  for (const task of tasks) {
    if (checkedTasks.has(task) || task.plan.mode !== "live") continue;
    const associated = requests.find(
      (request) => request.id === task.executionId,
    );
    const physical = associated
      ? sameDevice(parent, associated)
      : task.laneId === parent.laneId ||
        task.instance === lane?.instance ||
        (task.laneId === undefined && task.instance === undefined);
    if (!physical) continue;
    assertNativeEffectsKnown(
      task,
      now,
      associated,
      tasks,
      verifiedStartupFacts,
    );
    for (const proposed of business) {
      if (
        task.gameId !== proposed.gameId ||
        !touchesDay(
          proposed.gameId,
          task.startedAt,
          task.finishedAt ?? task.updatedAt,
          now,
        )
      )
        continue;
      const overlap = proposed.skillIds.filter((id) =>
        task.plan.skillIds.includes(id),
      );
      if (overlap.length) checkSteps(task.steps, overlap);
    }
  }
}
