import {
  validateRequestId,
  type ExecutionRecord,
} from "../../packages/protocol/execution";
import type { TaskRecord } from "../../packages/protocol/task-record";
import { validateDeviceLanes } from "../../packages/protocol";
import { canonical } from "../../packages/protocol/canonical";
import { sha256 } from "../../packages/protocol/sha256";
import { normalizeAbsoluteWindowsPath } from "../../packages/protocol/windows-path";
import {
  validStartupExecutorExitEvidence,
  validStartupReconciliationCandidate,
  validStartupReconciliationFact,
  type StartupExecutorExitEvidence,
  type StartupReconciliationBinding,
  type StartupReconciliationCandidate,
  type StartupReconciliationFact,
} from "../../packages/protocol/startup-reconciliation";
import { projectExecutionDetail } from "../execution-detail";
import { historyGameDay, historyPlan } from "../agent-history";
import { validArknightsEvidence } from "./evidence";
import { validateArknightsConfig } from "./config";

const digest = (input: unknown) => sha256(canonical(input));

/** Binding hashes include private identity fields without returning UID/account names. */
export function startupReconciliationBinding(
  request: ExecutionRecord,
): StartupReconciliationBinding | undefined {
  try {
    validateRequestId(request.id);
    if (
      request.version !== 1 ||
      !/^[a-f0-9]{64}$/.test(request.fingerprint) ||
      !["single", "daily"].includes(request.source) ||
      !request.laneId ||
      !request.batchId ||
      !Number.isFinite(Date.parse(request.startedAt)) ||
      !request.finishedAt ||
      !Number.isFinite(Date.parse(request.finishedAt)) ||
      Date.parse(request.finishedAt) < Date.parse(request.startedAt)
    )
      return;
    const lane = validateDeviceLanes({
      version: 1,
      lanes: [request.snapshot.lane],
    }).lanes[0];
    const raw = request.snapshot.profile as
      { id?: string; name?: string } | undefined;
    if (!raw || typeof raw.id !== "string") return;
    const { id: profileId, name: _name, ...settings } = raw;
    const profile = validateArknightsConfig(settings);
    if (
      !profile.expectedUid ||
      lane.id !== request.laneId ||
      lane.arknights.profileId !== profileId ||
      !lane.enabled ||
      !lane.arknights.enabled
    )
      return;
    const resource = `mumu:${normalizeAbsoluteWindowsPath(lane.managerPath).toLowerCase()}#${lane.instance}`;
    if (request.resources.length !== 1 || request.resources[0] !== resource)
      return;
    return {
      resource,
      laneId: lane.id,
      instance: lane.instance,
      profileId,
      clientType: profile.clientType,
      identityHash: digest({
        purpose: "startup-identity-v1",
        clientType: profile.clientType,
        expectedUid: profile.expectedUid,
      }),
      profileHash: digest({
        purpose: "startup-profile-v1",
        profileId,
        clientType: profile.clientType,
        expectedUid: profile.expectedUid,
        accountName: profile.accountName,
      }),
    };
  } catch {
    return;
  }
}

function startupOnlyExecution(
  request: ExecutionRecord,
  tasks: TaskRecord[],
  allowUnstartedSuffix: boolean,
) {
  const binding = startupReconciliationBinding(request);
  if (!binding || request.snapshot.plan !== undefined) return;
  const lane = request.snapshot.lane as { onmyoji: { enabled: boolean } };
  if (lane.onmyoji.enabled !== (request.snapshot.onmyojiPlan !== undefined))
    return;
  const linked = tasks.filter(
    (task) =>
      task.executionId === request.id ||
      (task.batchId === request.batchId && task.laneId === request.laneId),
  );
  // A contradictory/duplicate later-game run is not evidence of serial non-start.
  if (
    linked.length !== 1 ||
    linked[0].executionId !== request.id ||
    tasks.filter(
      (task) =>
        task.laneId === linked[0].laneId && task.runId === linked[0].runId,
    ).length !== 1
  )
    return;
  const detail = projectExecutionDetail(request, linked);
  detail.games.forEach((game) => historyPlan(game.plan));
  const ark = detail.games[0];
  if (
    detail.warnings.length ||
    !ark ||
    ark.plan.gameId !== "arknights" ||
    ark.plan.mode !== "live" ||
    ark.plan.skillIds[0] !== "login" ||
    !ark.record ||
    !ark.record.finishedAt
  )
    return;
  // Only the original plan may include business that demonstrably never began.
  // Fresh identity verification must still be a separate pure-login execution.
  if (ark.plan.skillIds.length !== 1) {
    const login = ark.record.steps[0];
    if (
      !allowUnstartedSuffix ||
      !["failed", "cancelled"].includes(ark.record.status) ||
      !login.startedAt ||
      !login.finishedAt ||
      (ark.record.fault?.skillId && ark.record.fault.skillId !== "login") ||
      ark.record.steps
        .slice(1)
        .some(
          (step) =>
            step.status !== "not-run" ||
            step.startedAt !== undefined ||
            step.finishedAt !== undefined ||
            step.result !== undefined ||
            step.evidence !== undefined ||
            step.diagnostics.length !== 0,
        )
    )
      return;
  }
  if (detail.games.length !== 1) {
    if (
      !allowUnstartedSuffix ||
      request.source !== "daily" ||
      detail.games.length !== 2 ||
      detail.games[1].plan.gameId !== "onmyoji" ||
      detail.games[1].plan.mode !== "live" ||
      detail.games[1].record ||
      !["failed", "cancelled"].includes(ark.record.status) ||
      !ark.record.finishedAt
    )
      return;
  }
  return { binding, task: ark.record, step: ark.record.steps[0] };
}

export function startupReconciliationCandidate(
  request: ExecutionRecord,
  tasks: TaskRecord[],
): StartupReconciliationCandidate | undefined {
  try {
    if (
      !["failed", "cancelled", "unknown"].includes(request.status) ||
      request.resolution
    )
      return;
    const original = startupOnlyExecution(request, tasks, true);
    const native = original?.step.result?.arknights;
    if (
      !original ||
      !["failed", "cancelled", "unknown"].includes(original.task.status) ||
      !["failed", "cancelled", "unknown"].includes(original.step.status) ||
      !validArknightsEvidence(native) ||
      native.taskType !== "StartUp" ||
      native.submission !== "submitted" ||
      native.completion !== "unknown"
    )
      return;
    const gameDay = historyGameDay("arknights", request.startedAt);
    if (!gameDay) return;
    const candidate: StartupReconciliationCandidate = {
      version: 1,
      originalRequestId: request.id,
      originalFingerprint: request.fingerprint,
      originalRunId: original.task.runId,
      skillId: "login",
      evidenceHash: digest(original.task),
      gameDay,
      binding: original.binding,
    };
    return validStartupReconciliationCandidate(candidate)
      ? candidate
      : undefined;
  } catch {
    return;
  }
}
export interface CreateStartupReconciliationInput {
  id: string;
  originalRequest: ExecutionRecord;
  originalTasks: TaskRecord[];
  executorExit: StartupExecutorExitEvidence;
  freshRequest: ExecutionRecord;
  freshTasks: TaskRecord[];
  evidenceReference: string;
  now: Date;
}
export function createStartupReconciliationFact(
  input: CreateStartupReconciliationInput,
): StartupReconciliationFact {
  const refuse = () => {
    throw Error("纯启动对账缺少匹配的原请求、退出证明或新鲜账号核验事实");
  };
  const candidate = startupReconciliationCandidate(
    input.originalRequest,
    input.originalTasks,
  );
  if (
    !candidate ||
    !validStartupExecutorExitEvidence(input.executorExit) ||
    input.executorExit.requestId !== candidate.originalRequestId ||
    input.executorExit.resource !== candidate.binding.resource ||
    input.freshRequest.id === input.originalRequest.id ||
    input.freshRequest.status !== "succeeded"
  )
    return refuse();
  const fresh = startupOnlyExecution(
    input.freshRequest,
    input.freshTasks,
    false,
  );
  const native = fresh?.step.result?.arknights;
  if (
    !fresh ||
    fresh.task.status !== "succeeded" ||
    fresh.step.status !== "succeeded" ||
    fresh.task.runId === candidate.originalRunId ||
    canonical(fresh.binding) !== canonical(candidate.binding) ||
    !validArknightsEvidence(native) ||
    native.taskType !== "StartUp" ||
    native.submission !== "submitted" ||
    native.completion !== "native-confirmed" ||
    native.login?.method !== "profile"
  )
    return refuse();
  const observedAt = native.login.homeObservedAt;
  const exit = Date.parse(input.executorExit.observedAt),
    at = input.now.getTime();
  if (
    !observedAt ||
    !Number.isFinite(at) ||
    exit < Date.parse(input.originalRequest.finishedAt!) ||
    Date.parse(input.freshRequest.startedAt) < exit ||
    Date.parse(fresh.task.startedAt) < exit ||
    at < Date.parse(input.freshRequest.finishedAt!) ||
    at < Date.parse(fresh.task.updatedAt) ||
    at < Date.parse(observedAt) ||
    at - Date.parse(observedAt) > 15_000
  )
    return refuse();
  const fact: StartupReconciliationFact = {
    version: 1,
    id: input.id,
    candidate,
    executorExit: structuredClone(input.executorExit),
    freshLogin: {
      requestId: input.freshRequest.id,
      requestFingerprint: input.freshRequest.fingerprint,
      runId: fresh.task.runId,
      evidenceHash: digest(fresh.task),
      observedAt,
      evidenceReference: input.evidenceReference,
    },
    reconciledAt: input.now.toISOString(),
  };
  if (!validStartupReconciliationFact(fact)) return refuse();
  return fact;
}

function requestAtReconciliation(
  request: ExecutionRecord,
  fact: StartupReconciliationFact,
): ExecutionRecord {
  // Resolution closes future handling. It cannot erase a factual reconciliation
  // already established before it, or invalidate a child admitted in between.
  const resolvedAt = Date.parse(request.resolution?.at ?? "");
  return Number.isFinite(resolvedAt) &&
    resolvedAt > Date.parse(fact.reconciledAt)
    ? { ...request, resolution: undefined }
    : request;
}
/** Exact old-hazard comparison only. Caller must load facts through full ledger verification. */
export function matchesStartupReconciliation(
  fact: unknown,
  request: ExecutionRecord,
  tasks: TaskRecord[],
): boolean {
  if (!validStartupReconciliationFact(fact)) return false;
  const candidate = startupReconciliationCandidate(
    requestAtReconciliation(request, fact),
    tasks,
  );
  return !!candidate && canonical(candidate) === canonical(fact.candidate);
}

/** Revalidate persisted proof against both immutable ledger associations, never against model DTOs. */
export function verifyStartupReconciliationFact(
  fact: unknown,
  originalRequest: ExecutionRecord,
  originalTasks: TaskRecord[],
  freshRequest: ExecutionRecord,
  freshTasks: TaskRecord[],
): boolean {
  if (!validStartupReconciliationFact(fact)) return false;
  try {
    const rebuilt = createStartupReconciliationFact({
      id: fact.id,
      originalRequest: requestAtReconciliation(originalRequest, fact),
      originalTasks,
      executorExit: fact.executorExit,
      freshRequest,
      freshTasks,
      evidenceReference: fact.freshLogin.evidenceReference,
      now: new Date(fact.reconciledAt),
    });
    return canonical(rebuilt) === canonical(fact);
  } catch {
    return false;
  }
}
