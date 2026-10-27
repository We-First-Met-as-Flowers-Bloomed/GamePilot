import type { Plan } from "../packages/protocol";
import { historyNativeMatches } from "./agent-history";
import { summarizeTaskResult } from "./task-result-summary";
import {
  validateRequestId,
  type ExecutionRecord,
} from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import {
  readTaskRecord,
  type TaskRecord,
} from "../packages/protocol/task-record";
import type { ContinuationLink } from "../packages/protocol/continuation";
import { asRecord as object } from "../packages/protocol/struct";
import {
  parseContinuationLink as continuationLink,
  parseFrozenPlan as frozenPlan,
} from "../packages/protocol/execution-snapshot";
import { readableHistorySnapshot } from "./history-gate";

const uncertain = "缺少可靠记录，是否执行过尚不确定";

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
  const tasks = rawTasks.map(readTaskRecord);
  const view = readableHistorySnapshot(request);
  const snapshot = view?.raw ?? {};
  const lane = object(snapshot.lane);
  const profile = object(snapshot.profile);
  const agent = object(snapshot.agent);
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
    : object(snapshot.arknights)?.expectedUid;
  const expectedUid = typeof frozenUid === "string" ? frozenUid : undefined;
  const warnings: string[] = [];
  if (!view)
    warnings.push("执行快照版本或格式不受支持，原记录保留且不能用于续跑");
  const plans: Plan[] = [];
  for (const [key, gameId] of [
    ["plan", undefined],
    ["arknightsPlan", "arknights"],
    ["onmyojiPlan", "onmyoji"],
  ] as const) {
    const value = snapshot[key];
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
      ...(continuationLink(snapshot.continuation)
        ? { continuation: continuationLink(snapshot.continuation) }
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
