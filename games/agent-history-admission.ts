import type { Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { historyPlan } from "./agent-history";
import { projectExecutionDetail } from "./execution-detail";
import { onmyojiStepEvidence } from "./onmyoji/evidence";

/** Remove only duplicate-plan rejection for a new authorized YYS plan whose
 * old business is recorded as unstarted after a resolved login timeout.
 * This does not retry or settle the old unknown login/Goal. */
export function resolvedUnstartedOnmyojiHistory(
  request: ExecutionRecord,
  tasks: TaskRecord[],
  selected: Plan,
  now: Date,
): boolean {
  try {
    const selection = historyPlan(selected);
    const resolution = request.resolution;
    const start = Date.parse(request.startedAt);
    const end = Date.parse(request.finishedAt ?? "");
    const resolved = Date.parse(resolution?.at ?? "");
    if (
      selection.gameId !== "onmyoji" ||
      selection.mode !== "live" ||
      selection.skillIds[0] !== "login" ||
      selection.skillIds.length < 2 ||
      !["unknown", "failed", "cancelled"].includes(request.status) ||
      resolution?.action !== "abandoned" ||
      !resolution.note?.trim() ||
      resolution.note.length > 1000 ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(resolved) ||
      !Number.isFinite(now.getTime()) ||
      end < start ||
      resolved < end ||
      resolved > now.getTime()
    )
      return false;
    const plans = [
      request.snapshot.plan,
      request.snapshot.arknightsPlan,
      request.snapshot.onmyojiPlan,
    ]
      .filter((plan) => plan !== undefined)
      .map(historyPlan);
    // Mixed-game requests retain their existing reconciliation contract.
    if (
      plans.length !== 1 ||
      plans[0].gameId !== "onmyoji" ||
      plans[0].mode !== "live" ||
      plans[0].skillIds[0] !== "login" ||
      plans[0].skillIds.length < 2
    )
      return false;
    const linked = tasks.filter((task) => task.executionId === request.id);
    const detail = projectExecutionDetail(request, linked);
    if (
      linked.length !== 1 ||
      detail.warnings.length ||
      detail.games.length !== 1
    )
      return false;
    const task = detail.games[0].record;
    if (
      !task ||
      !["unknown", "failed", "cancelled"].includes(task.status) ||
      !Number.isFinite(Date.parse(task.finishedAt ?? "")) ||
      Date.parse(task.finishedAt!) !== Date.parse(task.updatedAt)
    )
      return false;
    const login = task.steps[0],
      fault = task.fault;
    // A restart projection alone is not evidence that the worker stopped at login.
    if (
      login.skillId !== "login" ||
      login.result !== undefined ||
      login.evidence !== undefined ||
      !["unknown", "failed", "cancelled"].includes(login.status) ||
      !Number.isFinite(Date.parse(login.startedAt ?? "")) ||
      !Number.isFinite(Date.parse(login.finishedAt ?? "")) ||
      !fault ||
      fault.source !== "watchdog" ||
      fault.skillId !== "login" ||
      !["worker-run-timeout", "worker-native-timeout"].includes(fault.code) ||
      Date.parse(fault.observedAt) < Date.parse(login.startedAt!) ||
      Date.parse(fault.observedAt) > Date.parse(login.finishedAt!)
    )
      return false;
    return task.steps
      .slice(1)
      .every(
        (step) =>
          step.status === "not-run" &&
          step.startedAt === undefined &&
          step.finishedAt === undefined &&
          step.result === undefined &&
          step.evidence === undefined &&
          step.diagnostics.length === 0,
      );
  } catch {
    return false;
  }
}

/** Only unrelated terminal work is exempt; this never settles its original effects. */
export function disjointTerminalHistory(
  request: ExecutionRecord,
  tasks: TaskRecord[],
  selected: Plan,
  now: Date,
): boolean {
  try {
    // Login inspection retains its separate host executor-exit/identity contract.
    if (
      selected.mode !== "live" ||
      !selected.skillIds.some((id) => id !== "login") ||
      !["unknown", "failed", "cancelled"].includes(request.status)
    )
      return false;
    const start = Date.parse(request.startedAt);
    const end = Date.parse(request.finishedAt ?? "");
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end < start ||
      end > now.getTime()
    )
      return false;
    const raw = [
      request.snapshot.plan,
      request.snapshot.arknightsPlan,
      request.snapshot.onmyojiPlan,
    ].filter((plan) => plan !== undefined);
    const plans = raw.map(historyPlan);
    if (
      !plans.length ||
      plans.some(
        (plan) =>
          plan.mode !== "live" ||
          (plan.gameId === selected.gameId &&
            plan.skillIds.some(
              (id) => id !== "login" && selected.skillIds.includes(id),
            )),
      )
    )
      return false;
    const linked = tasks.filter((task) => task.executionId === request.id);
    const detail = projectExecutionDetail(request, linked);
    if (
      detail.warnings.length ||
      detail.games.length !== linked.length ||
      detail.games.some((game) => !game.record)
    )
      return false;
    for (const game of detail.games) {
      const task = game.record!;
      if (
        !["succeeded", "unknown", "failed", "cancelled"].includes(
          task.status,
        ) ||
        !Number.isFinite(Date.parse(task.finishedAt ?? "")) ||
        Date.parse(task.finishedAt!) !== Date.parse(task.updatedAt)
      )
        return false;
      for (const step of task.steps) {
        if (
          ["pending", "running"].includes(step.status) ||
          (task.status === "succeeded" &&
            !["succeeded", "skipped"].includes(step.status)) ||
          (step.status === "not-run" &&
            (step.startedAt !== undefined || step.result !== undefined)) ||
          (step.startedAt !== undefined &&
            !Number.isFinite(Date.parse(step.finishedAt ?? ""))) ||
          (task.gameId === selected.gameId &&
            step.skillId === "login" &&
            step.status !== "succeeded")
        )
          return false;
        const native = step.result?.arknights;
        if (
          native &&
          (native.completion === "unknown" ||
            (native.submission === "not-submitted" &&
              step.status === "succeeded") ||
            (native.submission === "submitted" &&
              ["not-run", "skipped"].includes(step.status)))
        )
          return false;
        const onmyoji = step.result?.onmyoji;
        if (
          onmyoji &&
          (!onmyojiStepEvidence(step) ||
            onmyoji.phase === "submitted" ||
            (onmyoji.phase === "not-submitted" &&
              step.status === "succeeded") ||
            (onmyoji.phase === "confirmed" &&
              ["not-run", "skipped"].includes(step.status)))
        )
          return false;
      }
    }
    return true;
  } catch {
    // Missing, malformed and ambiguously associated records are never a scope exemption.
    return false;
  }
}
