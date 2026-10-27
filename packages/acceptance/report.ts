import type { Plan } from "../protocol";
import { createHash } from "node:crypto";
import type { ExecutionRecord, ExecutionStatus } from "../protocol/execution";
import type { ExecutionDetail } from "../protocol/execution-detail";
import type { ExecutionProgress } from "../protocol/execution-progress";
import { readTaskRecord, type TaskRecord } from "../protocol/task-record";
import { isLegacyCopilotEvidence } from "../../games/arknights/evidence";
import { projectExecutionDetail } from "../../games/execution-detail";
import { mergeExecutionProgress } from "../../games/execution-progress";
import { canonical } from "./files";

export interface DailyExpectation {
  date: string;
  laneId: string;
  instance: number;
  plans: Plan[];
  slot?: "primary" | "secondary";
  dueTime?: string;
  bindingHash?: string;
}
export interface DailyInspection {
  date: string;
  slot: "primary" | "secondary";
  laneId: string;
  state:
    | "pending"
    | "missing"
    | "running"
    | "failed"
    | "unknown"
    | "incomplete"
    | "recovered"
    | "partial"
    | "flow-ended";
  requestIds: string[];
  originalStatus?: ExecutionStatus;
  continuationIds: string[];
  interventionRecorded: boolean;
  progress?: ExecutionProgress;
  startedAt?: string;
  finishedAt?: string;
  appVersion?: string;
  notes: string[];
  reviewRequired: boolean;
}
const samePlan = (a: unknown, b: Plan) => {
  const p = a as Plan | undefined;
  return (
    p?.gameId === b.gameId &&
    p.mode === "live" &&
    JSON.stringify(p.skillIds) === JSON.stringify(b.skillIds)
  );
};

const continuationOf = (r: ExecutionRecord) =>
  r.snapshot.continuation && typeof r.snapshot.continuation === "object"
    ? (r.snapshot.continuation as { parentId?: string })
    : undefined;

/** Match the coordinator's immutable request hash. Status/timestamps are lifecycle fields,
 * not authenticated by this hash; reward and seven-day acceptance still need review. */
function validContinuationFingerprint(r: ExecutionRecord): boolean {
  if (
    !Array.isArray(r.resources) ||
    !r.resources.length ||
    r.resources.length > 16 ||
    r.resources.some((v) => typeof v !== "string" || !v || v.length > 1024)
  )
    return false;
  const { startedAt: _admissionTime, ...snapshot } = r.snapshot;
  return (
    createHash("sha256")
      .update(
        canonical({
          id: r.id,
          source: r.source,
          resources: [...new Set(r.resources)].sort(),
          snapshot,
          ...(r.laneId ? { laneId: r.laneId } : {}),
          ...(r.batchId ? { batchId: r.batchId } : {}),
        }),
      )
      .digest("hex") === r.fingerprint
  );
}

function inspectContinuation(
  result: DailyInspection,
  expected: DailyExpectation,
  root: ExecutionRecord,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  now: Date,
  start: number,
  end: number,
  due: number,
): DailyInspection {
  const reject = (message: string) => ({
    ...result,
    state:
      root.status === "unknown"
        ? ("unknown" as const)
        : ("incomplete" as const),
    notes: [...result.notes, message],
  });
  const lane = root.snapshot.lane as { instance?: number } | undefined;
  const schedule = root.snapshot.schedule as
    { slot?: string; dueAt?: string } | undefined;
  if (lane?.instance !== expected.instance)
    return reject("模拟器绑定与冻结基线不一致");
  if (
    expected.plans[0]?.gameId !== "arknights" ||
    root.snapshot.plan !== undefined ||
    (result.slot === "secondary"
      ? expected.plans.length !== 1 || !!root.snapshot.onmyojiPlan
      : expected.plans.length !== 2 ||
        expected.plans[1]?.gameId !== "onmyoji") ||
    expected.plans.some((p) => !samePlan(root.snapshot[p.gameId + "Plan"], p))
  )
    return reject("原请求与验收计划或本轮游戏范围不符");
  if (
    Date.parse(root.startedAt) < due ||
    (schedule?.dueAt !== undefined && Date.parse(schedule.dueAt) !== due)
  )
    return reject("原请求启动或计划时间与冻结轮次不一致");
  // Include descendants before validation so branches, future children and wrong bindings
  // cannot disappear merely because they fall outside this expectation's row filter.
  const chain = [root],
    seen = new Set([root.id]);
  for (let index = 0; index < chain.length; index++) {
    if (chain.length > 64) return reject("续跑关联超出链长限制");
    for (const child of requests.filter(
      (r) => continuationOf(r)?.parentId === chain[index].id,
    )) {
      if (seen.has(child.id)) return reject("续跑关联存在循环或重复编号");
      seen.add(child.id);
      chain.push(child);
    }
  }
  const details = new Map<string, ExecutionDetail>();
  for (const r of chain) {
    if (
      requests.filter((v) => v.id === r.id).length !== 1 ||
      !validContinuationFingerprint(r)
    )
      return reject("续跑链请求指纹或唯一标识不能核实");
    const begin = Date.parse(r.startedAt),
      final = r.finishedAt === undefined ? undefined : Date.parse(r.finishedAt);
    const childSchedule = r.snapshot.schedule as
      { slot?: string; dueAt?: string } | undefined;
    if (
      !Number.isFinite(begin) ||
      begin < start ||
      begin >= end ||
      begin > now.getTime() ||
      (final !== undefined &&
        (!Number.isFinite(final) || final < begin || final > now.getTime())) ||
      (r.status !== "running" && final === undefined) ||
      (childSchedule?.slot !== undefined &&
        childSchedule.slot !== result.slot) ||
      (childSchedule?.dueAt !== undefined &&
        Date.parse(childSchedule.dueAt) !== due)
    )
      return reject("续跑链游戏日、轮次或终态时间不能核实");
    const raw = tasks.filter((t) => t.executionId === r.id);
    let detail: ExecutionDetail;
    try {
      detail = projectExecutionDetail(r, raw);
    } catch {
      return reject("续跑链步骤记录格式无效");
    }
    let previousEnd = begin;
    for (const game of detail.games) {
      const task = game.record;
      if (!task && raw.some((t) => t.gameId === game.plan.gameId))
        detail.warnings.push("存在无法唯一关联的游戏步骤记录，不能认定未执行");
      if (!task) continue;
      const finish = Date.parse(task.finishedAt ?? task.updatedAt);
      if (
        task.maintenance ||
        (r.status === "succeeded" &&
          (task.status !== "succeeded" || !task.finishedAt)) ||
        Date.parse(task.startedAt) < previousEnd ||
        finish > now.getTime() ||
        task.steps.some(
          (s) =>
            s.status === "succeeded" &&
            s.result?.arknights &&
            s.result.arknights.completion !== "native-confirmed",
        )
      )
        detail.warnings.push("步骤顺序、维护范围或原生完成证据不能核实");
      previousEnd = finish;
    }
    details.set(r.id, detail);
  }
  let progress: ExecutionProgress;
  try {
    progress = mergeExecutionProgress(root.id, chain, details);
  } catch {
    return reject("续跑链合并校验未完成");
  }
  result.progress = progress;
  result.continuationIds = progress.requests.slice(1).map((r) => r.id);
  result.finishedAt = progress.requests.at(-1)?.finishedAt;
  result.notes.push(...progress.warnings);
  result.notes.push(
    "启动来源、退出方舟与账号身份仍需核对；续跑补齐不等于奖励逐项验收或七天验收通过",
  );
  result.state =
    progress.outcome === "recovered" || progress.outcome === "partial"
      ? progress.outcome
      : progress.outcome === "running" && now.getTime() < end
        ? "running"
        : root.status === "unknown"
          ? "unknown"
          : "incomplete";
  return result;
}

/** Read-only structural audit. No successful execution is automatically accepted as reward proof. */
export function inspectDaily(
  expected: DailyExpectation,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  now: Date,
): DailyInspection {
  const start = Date.parse(expected.date + "T04:00:00+08:00");
  const end = start + 86400000;
  const slot = expected.slot ?? "primary";
  const due = Date.parse(
    expected.date +
      "T" +
      (expected.dueTime ?? (slot === "secondary" ? "20:00" : "08:00")) +
      ":00+08:00",
  );
  const rows = requests.filter(
    (r) =>
      r.source === "daily" &&
      !Object.prototype.hasOwnProperty.call(r.snapshot, "continuation") &&
      r.laneId === expected.laneId &&
      ((r.snapshot.schedule as { slot?: string } | undefined)?.slot ??
        "primary") === slot &&
      Date.parse(r.startedAt) >= start &&
      Date.parse(r.startedAt) < end &&
      Date.parse(r.startedAt) <= now.getTime(),
  );
  const result: DailyInspection = {
    date: expected.date,
    slot,
    laneId: expected.laneId,
    state: now.getTime() < due ? "pending" : "missing",
    requestIds: rows.map((r) => r.id),
    continuationIds: [],
    interventionRecorded: false,
    notes: [],
    reviewRequired: true,
  };
  if (!rows.length) return result;
  if (rows.length !== 1)
    return {
      ...result,
      state: "incomplete",
      notes: ["同游戏日同轮有多次请求，需核对人工介入或重复执行"],
    };
  const request = rows[0];
  result.startedAt = request.startedAt;
  result.finishedAt = request.finishedAt;
  result.appVersion = String(request.snapshot.appVersion ?? "unknown");
  result.originalStatus = request.status;
  result.interventionRecorded = requests.some(
    (r) => continuationOf(r)?.parentId === request.id,
  );
  if (result.interventionRecorded) {
    result.notes.push(`原始请求状态：${request.status}；续跑不覆盖原始结果`);
    return inspectContinuation(
      result,
      expected,
      request,
      requests,
      tasks,
      now,
      start,
      end,
      due,
    );
  }
  if (request.status === "running")
    return {
      ...result,
      state: now.getTime() < end ? "running" : "unknown",
      notes: ["尚无终态，不能确认完成"],
    };
  if (request.status !== "succeeded")
    return {
      ...result,
      state: request.status === "unknown" ? "unknown" : "failed",
      notes: ["原始请求未成功，后续记录不覆盖此结果"],
    };
  result.state = "incomplete";
  const reject = (message: string) => ({ ...result, notes: [message] });
  if (
    (request.snapshot.lane as { instance?: number } | undefined)?.instance !==
    expected.instance
  )
    return reject("模拟器绑定与冻结基线不一致");
  if (
    expected.plans[0]?.gameId !== "arknights" ||
    (slot === "secondary"
      ? expected.plans.length !== 1 || !!request.snapshot.onmyojiPlan
      : expected.plans.length !== 2 || expected.plans[1]?.gameId !== "onmyoji")
  )
    return reject("请求或基线不符合本轮游戏范围");
  if (slot === "secondary" && Date.parse(request.startedAt) < due)
    return reject("第二轮在计划时间前启动，需核对");
  let previousEnd = Date.parse(request.startedAt);
  const finalAt = Date.parse(request.finishedAt ?? "");
  if (
    !Number.isFinite(finalAt) ||
    finalAt < previousEnd ||
    finalAt > now.getTime()
  )
    return reject("请求终态时间无效");
  for (const plan of expected.plans) {
    if (!samePlan(request.snapshot[plan.gameId + "Plan"], plan))
      return reject("原请求与验收计划不符，或包含演练");
    const candidates = tasks.filter(
      (t) =>
        t.executionId === request.id &&
        t.laneId === request.laneId &&
        t.batchId === request.batchId &&
        t.gameId === plan.gameId,
    );
    if (candidates.length !== 1) return reject("缺少唯一关联的游戏步骤账本");
    let task: TaskRecord;
    try {
      task = readTaskRecord(candidates[0]);
    } catch {
      return reject("步骤记录格式无效");
    }
    if (
      task.instance !== expected.instance ||
      task.maintenance ||
      !samePlan(task.plan, plan) ||
      task.status !== "succeeded" ||
      task.steps.some((s) => !["succeeded", "skipped"].includes(s.status))
    )
      return reject("游戏计划或步骤未完整结束，不能沿用总完成标记");
    const begin = Date.parse(task.startedAt),
      finish = Date.parse(task.finishedAt ?? "");
    if (
      !Number.isFinite(finish) ||
      begin < previousEnd ||
      finish < begin ||
      finish > finalAt
    )
      return reject("双游戏时间顺序或结束时间不一致");
    previousEnd = finish;
    if (
      task.steps.some((step) => isLegacyCopilotEvidence(step.result?.arknights))
    )
      return reject(
        "旧版作业仅记录原生任务链结束，缺少冻结关卡、逐场三星及前后账号/主页证明，不能作为新版作业验收通过依据",
      );
    if (plan.gameId === "arknights") {
      if (
        task.steps.some(
          (s) =>
            s.status === "succeeded" &&
            s.result?.arknights?.completion !== "native-confirmed",
        )
      )
        result.notes.push("明日方舟部分步骤缺少原生完成证据");
      if (
        !task.steps.find((s) => s.skillId === "login")?.result?.arknights?.login
      )
        result.notes.push("明日方舟账号身份未核验");
    }
  }
  result.state = "flow-ended";
  result.notes.push(
    "启动来源、退出方舟的独立证据和人工介入仍需核对；流程结束不等于奖励逐项验收通过",
  );
  return result;
}

export const inspectionLabels: Record<DailyInspection["state"], string> = {
  pending: "未到计划时间",
  missing: "未发现日常请求",
  running: "运行中",
  failed: "失败或取消",
  unknown: "结果未知",
  incomplete: "记录不完整或需核对",
  recovered: "续跑补齐原计划（待验收）",
  partial: "续跑部分完成（包含取消项，待核对）",
  "flow-ended": "双游戏流程已结束（待验收）",
};

export function summarizeDaily(rows: DailyInspection[]) {
  const count = (state: DailyInspection["state"]) =>
    rows.filter((r) => r.state === state).length;
  return {
    total: rows.length,
    flowEnded: count("flow-ended"),
    recovered: count("recovered"),
    partial: count("partial"),
    running: count("running"),
    pending: count("pending"),
    missing: count("missing"),
    failed: count("failed"),
    unknown: count("unknown"),
    incomplete: count("incomplete"),
    firstPassFlowEnded: rows.filter(
      (r) => r.state === "flow-ended" && !r.interventionRecorded,
    ).length,
    withRecordedIntervention: rows.filter((r) => r.interventionRecorded).length,
  };
}
