import type { TaskRecord } from "../packages/protocol/task-record";
import { summarizeTaskResult } from "./task-result-summary";
import type { ExecutionProgress } from "../packages/protocol/execution-progress";

/** Host calls this only after association/native validation, before private receipts are stripped. */
export function agentTaskResult(record: TaskRecord, expectedStage?: string) {
  const clean = structuredClone(record);
  clean.message = "原记录状态需核对";
  for (const step of clean.steps) {
    step.message = "该步骤记录未确认完成";
    step.diagnostics = [];
    // Free-form result summaries may contain account names, paths or arbitrary instructions.
    const native = step.result?.arknights;
    step.result = native ? { arknights: native } : undefined;
    if (native?.lastSettlement && native.lastSettlement.stage !== expectedStage)
      delete native.lastSettlement;
  }
  return summarizeTaskResult(clean);
}

/** Export only references within the deidentified, currently associated history scope. */
export function agentExecutionProgress(
  p: ExecutionProgress,
  aliases: ReadonlyMap<string, string>,
  laneId: string,
): ExecutionProgress | undefined {
  const refs = [
    p.requestId,
    p.rootId,
    p.latestId,
    ...p.requests.map((r) => r.id),
    ...p.steps.map((s) => s.sourceId),
  ];
  if (refs.some((id) => !aliases.has(id))) return;
  return {
    version: 1,
    requestId: aliases.get(p.requestId)!,
    rootId: aliases.get(p.rootId)!,
    latestId: aliases.get(p.latestId)!,
    laneId,
    source: p.source,
    originalStatus: p.originalStatus,
    outcome: p.outcome,
    wholePlanComplete: p.wholePlanComplete,
    startedAt: p.startedAt,
    counts: { ...p.counts },
    requests: p.requests.map((r) => ({
      id: aliases.get(r.id)!,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      ...(r.appVersion && /^\d+\.\d+\.\d+$/.test(r.appVersion)
        ? { appVersion: r.appVersion }
        : {}),
    })),
    steps: p.steps.map((s) => ({ ...s, sourceId: aliases.get(s.sourceId)! })),
    warnings: p.warnings.length
      ? ["原计划关联或完成证据不完整，不能确认补齐"]
      : [],
  };
}
