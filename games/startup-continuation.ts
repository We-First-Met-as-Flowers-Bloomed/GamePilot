import { readableHistorySnapshot } from "./history-gate";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import {
  validateDeviceLanes,
  validatePlan,
  type Plan,
} from "../packages/protocol";
import { validateRequestId } from "../packages/protocol/execution";
import { validStartupFaultAssociation } from "../packages/protocol/startup-fault";
import type { StartupReconciliationFact } from "../packages/protocol/startup-reconciliation";
import { canonical } from "../packages/protocol/canonical";
import { normalizeAbsoluteWindowsPath } from "../packages/protocol/windows-path";
import { validateArknightsConfig } from "./arknights/config";
import { validArknightsEvidence } from "./arknights/evidence";
import { matchesStartupReconciliation } from "./arknights/startup-reconciliation";
import { onmyojiStepEvidence } from "./onmyoji/evidence";
import { historyGameDay } from "./agent-history";
import { projectExecutionDetail } from "./execution-detail";
import { games } from "./registry";
import { asRecord as object } from "../packages/protocol/struct";

export type StartupFailureProof = {
  parentId: string;
  fingerprint: string;
  observedAt: string;
};

function physicalBinding(request: ExecutionRecord) {
  if (!readableHistorySnapshot(request)) return;
  validateRequestId(request.id);
  if (
    request.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(request.fingerprint) ||
    !["single", "daily"].includes(request.source) ||
    !request.laneId ||
    !request.batchId
  )
    return;
  const lane = validateDeviceLanes({
    version: 1,
    lanes: [request.snapshot.lane],
  }).lanes[0];
  if (lane.id !== request.laneId) return;
  const resource = `mumu:${normalizeAbsoluteWindowsPath(lane.managerPath).toLowerCase()}#${lane.instance}`;
  if (request.resources.length !== 1 || request.resources[0] !== resource)
    return;
  return { lane, resource };
}

function binding(request: ExecutionRecord) {
  const physical = physicalBinding(request);
  if (!physical?.lane.enabled) return;
  const { lane, resource } = physical;
  const plans: Plan[] = [];
  for (const [key, gameId] of [
    ["plan", undefined],
    ["arknightsPlan", "arknights"],
    ["onmyojiPlan", "onmyoji"],
  ] as const) {
    if (request.snapshot[key] === undefined) continue;
    const plan = validatePlan(request.snapshot[key], games);
    if (
      plan.mode !== "live" ||
      plan.skillIds[0] !== "login" ||
      (gameId && plan.gameId !== gameId) ||
      plans.some((p) => p.gameId === plan.gameId) ||
      !["arknights", "onmyoji"].includes(plan.gameId)
    )
      return;
    if (plan.gameId === "arknights") {
      const raw = object(request.snapshot.profile);
      if (
        !raw ||
        !lane.arknights.enabled ||
        raw.id !== lane.arknights.profileId
      )
        return;
      const { id: _id, name: _name, ...settings } = raw;
      if (!validateArknightsConfig(settings).expectedUid) return;
    } else if (!lane.onmyoji.enabled) return;
    plans.push(plan);
  }
  if (!plans.length || plans.length > 2) return;
  return { lane, resource, plans };
}

/** Host-only proof from the complete ledgers. A missing projected task is never proof. */
export function startupFailureProof(
  parent: ExecutionRecord,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  now: Date,
  successorId?: string,
  verifiedStartupFacts: StartupReconciliationFact[] = [],
): StartupFailureProof | undefined {
  try {
    const frozen = binding(parent),
      start = Date.parse(parent.startedAt),
      end = Date.parse(parent.finishedAt ?? ""),
      cutoff = now.getTime();
    if (
      !frozen ||
      parent.status !== "failed" ||
      parent.resolution ||
      !parent.startupFault ||
      !validStartupFaultAssociation(parent) ||
      ![
        "mumu-state-unavailable",
        "mumu-launch-failed",
        "mumu-boot-timeout",
      ].includes(parent.startupFault.code) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      !Number.isFinite(cutoff) ||
      start > end ||
      end > cutoff ||
      frozen.plans.some(
        (plan) =>
          historyGameDay(plan.gameId, parent.startedAt) !==
            historyGameDay(plan.gameId, now.toISOString()) ||
          historyGameDay(plan.gameId, parent.finishedAt!) !==
            historyGameDay(plan.gameId, now.toISOString()),
      )
    )
      return;
    const parents = requests.filter((r) => r.id === parent.id);
    if (parents.length !== 1 || canonical(parents[0]) !== canonical(parent))
      return;

    const safePhysicalBinding = (request: ExecutionRecord) => {
      try {
        return physicalBinding(request);
      } catch {
        return undefined;
      }
    };
    const relatedRequest = (request: ExecutionRecord) => {
      const other = safePhysicalBinding(request);
      if (other)
        return (
          other.resource === frozen.resource || other.lane.id === frozen.lane.id
        );
      return (
        !request.laneId ||
        request.laneId === parent.laneId ||
        request.resources.some((r) => r === "*" || r === frozen.resource) ||
        object(request.snapshot.lane)?.instance === frozen.lane.instance
      );
    };
    let successor: ExecutionRecord | undefined;
    if (successorId !== undefined) {
      const matches = requests.filter((r) => r.id === successorId);
      if (matches.length !== 1) return;
      successor = matches[0];
      const next = binding(successor),
        link = object(successor.snapshot.continuation);
      if (
        !next ||
        next.resource !== frozen.resource ||
        successor.laneId !== parent.laneId ||
        link?.parentId !== parent.id ||
        link.parentFingerprint !== parent.fingerprint ||
        Date.parse(successor.startedAt) !== cutoff
      )
        return;
    }
    for (const request of requests) {
      if (request.id === parent.id || request === successor) continue;
      if (object(request.snapshot.continuation)?.parentId === parent.id) return;
      if (!relatedRequest(request)) continue;
      const began = Date.parse(request.startedAt);
      if (!Number.isFinite(began)) return;
      // Reconstruct at admission: a later unrelated request cannot erase that proof.
      if (began > cutoff) continue;
      if (
        began >= start ||
        !request.finishedAt ||
        !Number.isFinite(Date.parse(request.finishedAt)) ||
        Date.parse(request.finishedAt) > start ||
        request.status === "running"
      )
        return;
    }
    // 分组索引：避免 tasks × requests 的嵌套全量过滤（账本增长后 O(n²) 变慢）。
    const requestsByExecution = new Map<string, ExecutionRecord[]>();
    for (const request of requests) {
      const group = requestsByExecution.get(request.id);
      if (group) group.push(request);
      else requestsByExecution.set(request.id, [request]);
    }
    const tasksByExecution = new Map<string, TaskRecord[]>();
    for (const task of tasks) {
      const group = tasksByExecution.get(task.executionId ?? "");
      if (group) group.push(task);
      else tasksByExecution.set(task.executionId ?? "", [task]);
    }
    const associated = (task: TaskRecord) => {
      const matches = requestsByExecution.get(task.executionId ?? "") ?? [];
      if (matches.length !== 1) return;
      const request = matches[0],
        bound = safePhysicalBinding(request);
      if (!bound) return;
      const detail = projectExecutionDetail(
        request,
        tasksByExecution.get(task.executionId ?? "") ?? [],
      );
      if (
        detail.warnings.length ||
        !detail.games.some(
          (g) => g.record && canonical(g.record) === canonical(task),
        )
      )
        return;
      return { request, bound };
    };
    for (const task of tasks) {
      // Direct or ambiguous batch association remains contradictory even if logged late.
      if (task.executionId === parent.id) return;
      const owner = associated(task);
      if (successor && task.executionId === successor.id && !owner) return;
      if (
        task.batchId === parent.batchId &&
        (!owner ||
          owner.request.batchId !== parent.batchId ||
          owner.request.laneId === parent.laneId ||
          owner.bound.resource === frozen.resource)
      )
        return;
      const relevant = owner
        ? owner.bound.resource === frozen.resource ||
          owner.request.laneId === parent.laneId
        : !task.laneId ||
          task.laneId === parent.laneId ||
          task.instance === undefined ||
          task.instance === frozen.lane.instance ||
          requests.some(
            (request) =>
              request.id === task.executionId && relatedRequest(request),
          );
      if (!relevant) continue;
      const began = Date.parse(task.startedAt);
      if (!Number.isFinite(began)) return;
      if (owner?.request === successor && successor && began >= cutoff)
        continue;
      if (began > cutoff) continue;
      if (
        began >= start ||
        !task.finishedAt ||
        !Number.isFinite(Date.parse(task.finishedAt)) ||
        Date.parse(task.finishedAt) > start ||
        ["running", "queued", "stopping"].includes(task.status)
      )
        return;
      // The detail projection validates native Arknights bounds. YYS effects
      // also need their own skill/observation bounds before any day exemption.
      if (
        task.steps.some(
          (step) =>
            step.result?.onmyoji !== undefined &&
            (task.gameId !== "onmyoji" || !onmyojiStepEvidence(step)),
        )
      )
        return;
      // Match continuation history's game-day scope without treating age or
      // abandonment as proof for an orphan, active run, or contradictory record.
      const currentDay = historyGameDay(task.gameId, now.toISOString());
      const closedPriorDay =
        owner &&
        ["succeeded", "failed", "cancelled", "unknown"].includes(
          owner.request.status,
        ) &&
        [
          owner.request.startedAt,
          owner.request.finishedAt,
          task.startedAt,
          task.finishedAt,
        ].every((value) => {
          const day = historyGameDay(task.gameId, value ?? "");
          return !!currentDay && !!day && day < currentDay;
        });
      // Current-day uncertainty still requires the exact verified reconciliation.
      const uncertain = task.steps.some((step) => {
        const native = step.result?.arknights,
          yys = step.result?.onmyoji;
        const observed = yys && onmyojiStepEvidence(step);
        return (
          (native &&
            (!validArknightsEvidence(native) ||
              (native.submission === "submitted" &&
                native.completion !== "native-confirmed"))) ||
          (yys && (!observed || observed.phase === "submitted"))
        );
      });
      if (
        uncertain &&
        !closedPriorDay &&
        !(
          owner &&
          verifiedStartupFacts.some(
            (fact) =>
              Date.parse(fact.reconciledAt) <= cutoff &&
              matchesStartupReconciliation(
                fact,
                owner.request,
                tasks.filter((t) => t.executionId === owner.request.id),
              ),
          )
        )
      )
        return;
    }
    return {
      parentId: parent.id,
      fingerprint: parent.fingerprint,
      observedAt: now.toISOString(),
    };
  } catch {
    return;
  }
}
