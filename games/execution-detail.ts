import type { Plan } from "../packages/protocol";
import { historyNativeMatches } from "./agent-history";
import { summarizeTaskResult } from "./task-result-summary";
import {
  validateRequestId,
  type ExecutionRecord,
} from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import {
  validateTaskRecord,
  type TaskRecord,
} from "../packages/protocol/task-record";
import type { ContinuationLink } from "../packages/protocol/continuation";

const uncertain = "缺少可靠记录，是否执行过尚不确定";
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function continuationLink(value: unknown): ContinuationLink | undefined {
  const link = object(value);
  if (
    !link ||
    typeof link.parentId !== "string" ||
    !/^[a-zA-Z0-9:._-]{1,160}$/.test(link.parentId) ||
    typeof link.parentFingerprint !== "string" ||
    link.parentFingerprint.length > 128 ||
    typeof link.acknowledgedPartial !== "boolean"
  )
    return;
  const selections = (value: unknown) => {
    if (!Array.isArray(value) || value.length > 2) return;
    const result: ContinuationLink["retained"] = [];
    for (const raw of value) {
      const entry = object(raw);
      if (
        !entry ||
        !["arknights", "onmyoji"].includes(String(entry.gameId)) ||
        !Array.isArray(entry.skillIds) ||
        entry.skillIds.length > 32 ||
        entry.skillIds.some(
          (id) => typeof id !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(id),
        )
      )
        return;
      result.push({
        gameId: entry.gameId as string,
        skillIds: [...entry.skillIds],
      });
    }
    return result;
  };
  const retained = selections(link.retained),
    excluded = selections(link.excluded);
  if (!retained || !excluded) return;
  return {
    parentId: link.parentId,
    parentFingerprint: link.parentFingerprint,
    retained,
    excluded,
    acknowledgedPartial: link.acknowledgedPartial,
  };
}
function frozenPlan(value: unknown): Plan | undefined {
  const p = object(value);
  if (
    !p ||
    typeof p.gameId !== "string" ||
    !p.gameId ||
    (p.mode !== "live" && p.mode !== "rehearsal") ||
    !Array.isArray(p.skillIds) ||
    !p.skillIds.length ||
    p.skillIds.length > 32 ||
    p.skillIds.some((id) => typeof id !== "string" || !id) ||
    new Set(p.skillIds).size !== p.skillIds.length
  )
    return undefined;
  return { gameId: p.gameId, mode: p.mode, skillIds: [...p.skillIds] };
}
function withinRequest(task: TaskRecord, request: ExecutionRecord): boolean {
  const start = Date.parse(task.startedAt),
    updated = Date.parse(task.updatedAt);
  const within = (value: string) => {
    const at = Date.parse(value);
    return at >= start && at <= updated;
  };
  return (
    start >= Date.parse(request.startedAt) &&
    updated >= start &&
    (!request.finishedAt || updated <= Date.parse(request.finishedAt)) &&
    (task.finishedAt === undefined || within(task.finishedAt)) &&
    task.steps.every(
      (step) =>
        (step.startedAt === undefined || within(step.startedAt)) &&
        (step.finishedAt === undefined || within(step.finishedAt)) &&
        (step.startedAt === undefined ||
          step.finishedAt === undefined ||
          Date.parse(step.startedAt) <= Date.parse(step.finishedAt)),
    )
  );
}

export function projectExecutionDetail(
  request: ExecutionRecord,
  rawTasks: TaskRecord[],
): ExecutionDetail {
  const tasks = rawTasks.map(validateTaskRecord);
  const lane = object(request.snapshot.lane);
  const profile = object(request.snapshot.profile);
  const agent = object(request.snapshot.agent);
  const laneMatches =
    !!request.laneId &&
    lane?.id === request.laneId &&
    Number.isInteger(lane.instance) &&
    Number(lane.instance) >= 0 &&
    Number(lane.instance) <= 999;
  const profileMatches =
    laneMatches &&
    typeof profile?.id === "string" &&
    !!profile.id &&
    profile.id === object(lane?.arknights)?.profileId;
  const frozenUid = request.laneId
    ? profileMatches
      ? profile?.expectedUid
      : undefined
    : object(request.snapshot.arknights)?.expectedUid;
  const expectedUid = typeof frozenUid === "string" ? frozenUid : undefined;
  const warnings: string[] = [];
  const plans: Plan[] = [];
  for (const [key, gameId] of [
    ["plan", undefined],
    ["arknightsPlan", "arknights"],
    ["onmyojiPlan", "onmyoji"],
  ] as const) {
    const value = request.snapshot[key];
    if (value === undefined) continue;
    const plan = frozenPlan(value);
    if (!plan || (gameId && plan.gameId !== gameId)) {
      warnings.push("原始执行计划格式不完整，无法可靠关联步骤记录");
    } else plans.push(plan);
  }
  if (!plans.length) warnings.push("原始执行计划缺失，是否执行过尚不确定");
  const games: ExecutionDetail["games"] = [];
  for (const plan of plans) {
    if (games.some((game) => game.plan.gameId === plan.gameId)) continue;
    const uniquePlan =
      plans.filter((p) => p.gameId === plan.gameId).length === 1;
    if (!uniquePlan) warnings.push(`${plan.gameId} 原始执行计划存在冲突`);
    // Count all matching game candidates first: an invalid duplicate is still ambiguous.
    const candidates = tasks.filter(
      (t) =>
        t.executionId === request.id &&
        t.laneId === request.laneId &&
        t.batchId === request.batchId &&
        t.gameId === plan.gameId,
    );
    const task = candidates.length === 1 ? candidates[0] : undefined;
    const reliable =
      uniquePlan &&
      task &&
      task.plan.mode === plan.mode &&
      JSON.stringify(task.plan.skillIds) === JSON.stringify(plan.skillIds) &&
      (request.laneId
        ? laneMatches &&
          task.instance === lane!.instance &&
          (task.gameId !== "arknights" ||
            (profileMatches && task.profileId === profile!.id))
        : task.instance === undefined && task.profileId === undefined) &&
      withinRequest(task, request) &&
      historyNativeMatches(task, expectedUid);
    games.push(
      reliable
        ? { plan, record: task, summary: summarizeTaskResult(task) }
        : { plan, issue: uncertain },
    );
  }
  const {
    id: originalId,
    source,
    status,
    startedAt,
    finishedAt,
    message,
    resolution,
    laneId,
    batchId,
  } = request;
  return structuredClone({
    request: {
      id: originalId,
      source,
      status,
      startedAt,
      finishedAt,
      message,
      resolution,
      laneId,
      batchId,
      ...(continuationLink(request.snapshot.continuation)
        ? { continuation: continuationLink(request.snapshot.continuation) }
        : {}),
      ...(laneMatches && typeof lane?.name === "string"
        ? { laneName: lane.name }
        : {}),
      ...(laneMatches ? { instance: lane!.instance as number } : {}),
      ...(profileMatches && typeof profile?.name === "string"
        ? { profileName: profile.name }
        : {}),
      ...(typeof agent?.requestId === "string" &&
      /^[a-zA-Z0-9:._-]{1,160}$/.test(agent.requestId)
        ? { agentRequestId: agent.requestId }
        : {}),
    },
    games,
    warnings: [...new Set(warnings)],
  });
}
