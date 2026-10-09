import type { Plan, RunEvent, RunStatus, SkillResult } from "./index";
import { validStructuredSkillOutcome } from "./index";
import { validArknightsEvidence } from "../../games/arknights/evidence";
import { validFailureEvidence, type FailureEvidence } from "./fault";

export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "skipped"
  | "failed"
  | "cancelled"
  | "unknown"
  | "not-run";
export interface TaskStepRecord {
  skillId: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  message: string;
  evidence?: RunEvent["stepEvidence"];
  result?: SkillResult;
  diagnostics: string[];
}
export interface TaskRecord {
  fault?: FailureEvidence;
  executionId?: string;
  version: 1;
  runId: string;
  laneId?: string;
  batchId?: string;
  laneName?: string;
  instance?: number;
  profileId?: string;
  maintenance?: boolean;
  gameId: string;
  plan: Plan;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: RunStatus | "unknown";
  message: string;
  steps: TaskStepRecord[];
}
export const taskRecordKey = (r: Pick<TaskRecord, "laneId" | "runId">) =>
  JSON.stringify([r.laneId ?? "", r.runId]);
export const taskActive = (status: TaskRecord["status"]) =>
  ["queued", "running", "stopping"].includes(status);
const text = (s: string) => s.slice(0, 2000);

/** Only structured lifecycle facts change status. Native logs are diagnostic evidence. */
export function reduceTaskRecords(
  records: TaskRecord[],
  event: RunEvent,
): TaskRecord[] {
  const index = records.findIndex(
    (r) => taskRecordKey(r) === taskRecordKey(event),
  );
  if (index < 0) {
    if (
      !event.plan ||
      event.type !== "status" ||
      event.status !== "queued" ||
      !event.runId ||
      event.plan.gameId !== event.gameId
    )
      return records;
    return [
      ...records,
      {
        version: 1,
        executionId: event.executionId,
        runId: event.runId,
        laneId: event.laneId,
        batchId: event.batchId,
        laneName: event.laneName,
        instance: event.instance,
        profileId: event.profileId,
        maintenance: event.maintenance,
        gameId: event.gameId,
        plan: structuredClone(event.plan),
        startedAt: event.at,
        updatedAt: event.at,
        status: "queued",
        message: text(event.message),
        steps: event.plan.skillIds.map((skillId) => ({
          skillId,
          status: "pending",
          message: "等待执行",
          diagnostics: [],
        })),
      },
    ];
  }
  const original = records[index];
  if (
    !taskActive(original.status) ||
    (event.gameId && event.gameId !== original.gameId)
  )
    return records;
  const record = structuredClone(original);
  if (event.fault && !record.fault) {
    if (
      !(
        (event.type === "step" &&
          event.stepStatus === "failed" &&
          event.fault.skillId === event.skillId) ||
        (event.type === "status" && event.status === "failed")
      ) ||
      Date.parse(event.fault.observedAt) < Date.parse(record.startedAt) ||
      Date.parse(event.fault.observedAt) > Date.parse(event.at)
    )
      throw Error("故障证据事件无效");
    if (
      !validFailureEvidence(event.fault) ||
      event.fault.runId !== record.runId ||
      (event.fault.skillId &&
        !record.plan.skillIds.includes(event.fault.skillId))
    )
      throw Error("故障证据关联无效");
    record.fault = structuredClone(event.fault);
  }
  const step = record.steps.find((s) => s.skillId === event.skillId);
  if (event.type === "step" && event.stepStatus && step) {
    if (!["pending", "running"].includes(step.status)) return records;
    step.status = event.stepStatus;
    step.message = text(event.message);
    step.evidence = event.stepEvidence;
    if (event.stepStatus === "running") step.startedAt ??= event.at;
    else step.finishedAt = event.at;
  } else if (event.type === "log" && step) {
    if (event.result) step.result = structuredClone(event.result);
    step.diagnostics = [...step.diagnostics, text(event.message)].slice(-8);
  } else if (event.type === "status" && event.status) {
    if (event.status === "queued") return records; // Duplicate start cannot reset progress.
    record.status = event.resultUncertain ? "unknown" : event.status;
    record.message = text(event.message);
    if (!taskActive(record.status)) {
      record.finishedAt = event.at;
      const unfinished = record.steps.some((s) =>
        ["pending", "running"].includes(s.status),
      );
      for (const s of record.steps) {
        if (s.status === "running") {
          s.status = "unknown";
          s.finishedAt = event.at;
          s.message = "执行中断，现场结果未确认";
        } else if (s.status === "pending") {
          s.status = "not-run";
          s.message = "本轮未执行";
        }
      }
      if (event.status === "succeeded" && unfinished) {
        record.status = "unknown";
        record.message = "执行器结束，但缺少部分步骤的完成证据";
      }
    }
  } else return records;
  record.updatedAt = event.at;
  return records.map((r, i) => (i === index ? record : r));
}

export function interruptTaskRecords(records: TaskRecord[], at: string) {
  return records.reduce(
    (all, record) =>
      taskActive(record.status)
        ? reduceTaskRecords(all, {
            ...record,
            type: "status",
            status: "failed",
            resultUncertain: true,
            message: "应用中断，结果未知；核对游戏状态后再运行",
            at,
          })
        : all,
    records,
  );
}

/** Read only our versioned data; a corrupt record must never become an empty success. */
export function validateTaskRecord(value: unknown): TaskRecord {
  const r = value as TaskRecord;
  const date = (s: unknown) =>
    typeof s === "string" && Number.isFinite(Date.parse(s));
  const optionalString = (s: unknown) =>
    s === undefined || typeof s === "string";
  if (
    !r ||
    r.version !== 1 ||
    typeof r.runId !== "string" ||
    !r.runId ||
    typeof r.gameId !== "string" ||
    !optionalString(r.laneId) ||
    !optionalString(r.executionId) ||
    !optionalString(r.batchId) ||
    !optionalString(r.laneName) ||
    !optionalString(r.profileId) ||
    !r.plan ||
    r.plan.gameId !== r.gameId ||
    !["live", "rehearsal"].includes(r.plan.mode) ||
    !Array.isArray(r.plan.skillIds) ||
    r.plan.skillIds.length < 1 ||
    r.plan.skillIds.length > 32 ||
    r.plan.skillIds.some((id) => typeof id !== "string") ||
    new Set(r.plan.skillIds).size !== r.plan.skillIds.length ||
    !date(r.startedAt) ||
    !date(r.updatedAt) ||
    (r.finishedAt !== undefined && !date(r.finishedAt)) ||
    ![
      "queued",
      "running",
      "stopping",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
    ].includes(r.status) ||
    typeof r.message !== "string" ||
    (r.fault !== undefined &&
      (!validFailureEvidence(r.fault) ||
        r.fault.runId !== r.runId ||
        (r.fault.skillId !== undefined &&
          !r.plan.skillIds.includes(r.fault.skillId)) ||
        Date.parse(r.fault.observedAt) < Date.parse(r.startedAt) ||
        Date.parse(r.fault.observedAt) > Date.parse(r.updatedAt) ||
        (r.fault.capture.status === "stored" &&
          Date.parse(r.fault.capture.capturedAt) > Date.parse(r.updatedAt)))) ||
    !Array.isArray(r.steps) ||
    r.steps.length !== r.plan.skillIds.length ||
    r.steps.some(
      (s, i) =>
        !s ||
        s.skillId !== r.plan.skillIds[i] ||
        ![
          "pending",
          "running",
          "succeeded",
          "skipped",
          "failed",
          "cancelled",
          "unknown",
          "not-run",
        ].includes(s.status) ||
        typeof s.message !== "string" ||
        !validStructuredSkillOutcome(s.result) ||
        (s.result?.arknights !== undefined &&
          !validArknightsEvidence(s.result.arknights)) ||
        !Array.isArray(s.diagnostics) ||
        s.diagnostics.some((m) => typeof m !== "string"),
    )
  )
    throw Error("任务记录格式或版本无效");
  if (r.fault) {
    if (r.status === "succeeded") throw Error("完成记录不能附带失败证据");
    if (r.fault.source === "runner") {
      const step = r.steps.find((s) => s.skillId === r.fault!.skillId);
      if (
        !step ||
        !["failed", "unknown"].includes(step.status) ||
        !date(step.startedAt) ||
        !date(step.finishedAt) ||
        Date.parse(r.fault.observedAt) < Date.parse(step.startedAt!) ||
        Date.parse(r.fault.observedAt) > Date.parse(step.finishedAt!) ||
        (r.fault.capture.status === "stored" &&
          Date.parse(r.fault.capture.capturedAt) > Date.parse(step.finishedAt!))
      )
        throw Error("故障证据与失败步骤不符");
    }
  }
  return structuredClone(r);
}
