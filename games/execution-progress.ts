import { readableHistorySnapshot } from "./history-gate";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type { ExecutionProgress } from "../packages/protocol/execution-progress";
import type {
  ContinuationLink,
  ContinuationSelection,
} from "../packages/protocol/continuation";
import type { Plan } from "../packages/protocol";
import type { TaskRecord } from "../packages/protocol/task-record";
import { startupFailureProof } from "./startup-continuation";
import type { StartupReconciliationFact } from "../packages/protocol/startup-reconciliation";
import { matchesStartupReconciliation } from "./arknights/startup-reconciliation";
import { previewDailyContinuation, continuationPlans } from "./continuation";
import { historyStepStatus } from "./agent-history";
import { arknightsConfigForPlan } from "./arknights/daily-plan";
import {
  validateArknightsConfig,
  type ArknightsConfig,
} from "./arknights/config";
import { asRecord } from "../packages/protocol/struct";

/** 宽松快照访问需要 any 字段；结构判断复用 protocol 的 asRecord。 */
const object = (v: unknown): Record<string, any> | undefined =>
  asRecord<Record<string, any>>(v);

const linkOf = (r: ExecutionRecord) => object(r.snapshot.continuation);
const plansOf = (r: ExecutionRecord) =>
  [r.snapshot.plan, r.snapshot.arknightsPlan, r.snapshot.onmyojiPlan].filter(
    Boolean,
  ) as Plan[];
const normalize = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(normalize)
    : object(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => [key, normalize(v)]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
const finished = (s: string) => ["succeeded", "skipped"].includes(s);

/** Validate a continuation against the same frozen selection policy used to admit it. */
function validateChild(
  parent: ExecutionRecord,
  child: ExecutionRecord,
  details: Map<string, ExecutionDetail>,
  verifiedStartupFacts: StartupReconciliationFact[],
  rawTasks: TaskRecord[] | undefined,
  rawRequests: ExecutionRecord[],
): ContinuationLink {
  if (!readableHistorySnapshot(parent) || !readableHistorySnapshot(child))
    throw Error("续跑快照版本不受支持");
  const link = linkOf(child),
    lane = object(parent.snapshot.lane),
    nextLane = object(child.snapshot.lane),
    profile = object(parent.snapshot.profile),
    nextProfile = object(child.snapshot.profile);
  if (
    !link ||
    link.parentId !== parent.id ||
    link.parentFingerprint !== parent.fingerprint ||
    child.source !== "daily" ||
    !parent.laneId ||
    child.laneId !== parent.laneId ||
    !same(child.resources, parent.resources) ||
    !lane ||
    !nextLane ||
    lane.id !== nextLane.id ||
    lane.instance !== nextLane.instance ||
    lane.managerPath !== nextLane.managerPath ||
    lane.arknights?.profileId !== nextLane.arknights?.profileId ||
    profile?.id !== nextProfile?.id ||
    profile?.expectedUid !== nextProfile?.expectedUid ||
    profile?.clientType !== nextProfile?.clientType
  )
    throw Error("续跑指纹、资源或账号绑定不匹配");
  const start = Date.parse(child.startedAt),
    end = Date.parse(parent.finishedAt ?? "");
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < end ||
    (child.finishedAt !== undefined &&
      (!Number.isFinite(Date.parse(child.finishedAt)) ||
        Date.parse(child.finishedAt) < start))
  )
    throw Error("续跑时间顺序不可靠");
  const parentDetail = details.get(parent.id);
  if (!parentDetail) throw Error("续跑缺少可靠原请求详情");
  // Reconstruct admission at the child's start, without changing the stored record.
  // Closing an issue later cannot erase an already admitted recovery's evidence.
  if (parent.resolution) {
    const resolvedAt = Date.parse(parent.resolution.at);
    if (!Number.isFinite(resolvedAt) || resolvedAt <= start)
      throw Error("原请求在续跑前已经结束处理");
  }
  const admissionParent = parent.resolution
    ? { ...parent, resolution: undefined }
    : parent;
  const proof =
    rawTasks &&
    startupFailureProof(
      admissionParent,
      rawRequests.map((request) =>
        request.id === parent.id && parent.resolution
          ? { ...request, resolution: undefined }
          : request,
      ),
      rawTasks,
      new Date(start),
      child.id,
      verifiedStartupFacts,
    );
  const preview = previewDailyContinuation(
    parentDetail,
    admissionParent,
    new Date(start),
    verifiedStartupFacts,
    proof,
  );
  const selections = plansOf(child).map((plan) => ({
    gameId: plan.gameId,
    skillIds: plan.skillIds.filter(
      (id) =>
        id !== "login" ||
        (plan.skillIds.length === 1 &&
          preview.defaults.some(
            (selection) =>
              selection.gameId === plan.gameId &&
              selection.skillIds.includes("login"),
          )),
    ),
  }));
  const expected = continuationPlans(
    preview,
    {
      parentId: parent.id,
      fingerprint: parent.fingerprint,
      selections,
      acknowledgePartial: link.acknowledgedPartial,
    },
    verifiedStartupFacts,
    proof,
  );
  if (!same(plansOf(child), expected))
    throw Error("续跑不是原计划的剩余所选步骤");
  if (profile || nextProfile) {
    const settings = (p: Record<string, any> | undefined) => {
      if (!p) throw Error("续跑缺少原账号配置");
      const { id: _id, name: _name, ...config } = p;
      return validateArknightsConfig(config);
    };
    const originalConfig = settings(profile),
      nextConfig = settings(nextProfile);
    const arkPlan = expected.find((p) => p.gameId === "arknights");
    const frozenConfig = arkPlan
      ? arknightsConfigForPlan(originalConfig as ArknightsConfig, arkPlan)
      : originalConfig;
    if (!same(nextConfig, frozenConfig))
      throw Error("续跑任务参数与原冻结配置不一致");
  }
  const group = (retained: boolean): ContinuationSelection[] => {
    const entries: ContinuationSelection[] = [];
    for (const step of preview.steps) {
      if (step.skillId === "login") continue;
      if (
        retained
          ? step.status !== "retained"
          : !["retry", "pending", "excluded"].includes(step.status) ||
            expected.some(
              (p) =>
                p.gameId === step.gameId && p.skillIds.includes(step.skillId),
            )
      )
        continue;
      let g = entries.find((g) => g.gameId === step.gameId);
      if (!g) {
        g = { gameId: step.gameId, skillIds: [] };
        entries.push(g);
      }
      g.skillIds.push(step.skillId);
    }
    return entries;
  };
  if (!same(link.retained, group(true)) || !same(link.excluded, group(false)))
    throw Error("保留或取消项与原进度不一致");
  return link as unknown as ContinuationLink;
}

/** Original records stay immutable; only uniquely verified descendants can supply missing facts. */
export function mergeExecutionProgress(
  id: string,
  records: ExecutionRecord[],
  details: Map<string, ExecutionDetail>,
  verifiedStartupFacts: StartupReconciliationFact[] = [],
  rawTasks?: TaskRecord[],
  rawRequests: ExecutionRecord[] = records,
): ExecutionProgress {
  const warnings: string[] = [],
    matches = (id: string) => records.filter((r) => r.id === id);
  const requested = matches(id);
  if (requested.length !== 1) throw Error("未找到唯一的执行请求");
  let root = requested[0];
  if (root.snapshot.continuation !== undefined && !linkOf(root))
    warnings.push("续跑关联格式不可靠");
  const visited = new Set<string>();
  while (linkOf(root)) {
    if (visited.has(root.id) || visited.size >= 64) {
      warnings.push("续跑关联存在循环或超出链长限制");
      break;
    }
    visited.add(root.id);
    const link = linkOf(root)!,
      parents = matches(String(link.parentId));
    if (parents.length !== 1) {
      warnings.push("缺少唯一原请求，不能核实续跑进度");
      break;
    }
    root = parents[0];
  }
  const chain = [root],
    links = new Map<string, ContinuationLink>();
  const followed = new Set([root.id]);
  let tip = root;
  while (!warnings.length) {
    const children = records.filter((r) => linkOf(r)?.parentId === tip.id);
    if (!children.length) break;
    if (children.length !== 1) {
      warnings.push("原请求存在多个续跑分支，需核对");
      break;
    }
    const child = children[0];
    if (followed.has(child.id) || followed.size >= 64) {
      warnings.push("续跑关联存在循环或超出链长限制");
      break;
    }
    try {
      links.set(
        child.id,
        validateChild(
          tip,
          child,
          details,
          verifiedStartupFacts,
          rawTasks,
          rawRequests,
        ),
      );
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : "续跑关联校验未完成",
      );
      break;
    }
    followed.add(child.id);
    chain.push(child);
    tip = child;
  }
  if (!chain.some((r) => r.id === id))
    warnings.push("所查请求不能可靠关联到原计划");
  const tipUnsubmitted = !!(
    rawTasks &&
    tip.finishedAt &&
    startupFailureProof(
      tip,
      rawRequests,
      rawTasks,
      new Date(tip.finishedAt),
      undefined,
      verifiedStartupFacts,
    )
  );
  const original = details.get(root.id);
  if (!original || !original.games.length)
    warnings.push("原计划缺少可靠游戏详情");
  if (
    root.source === "maintenance" ||
    original?.games.some((g) => g.plan.mode !== "live")
  )
    warnings.push("维护或演练不作为真实原计划完成证据");
  const steps: ExecutionProgress["steps"] = (original?.games ?? []).flatMap(
    (game) =>
      game.plan.skillIds.map((skillId) => ({
        gameId: game.plan.gameId,
        skillId,
        status: (() => {
          const step = game.record?.steps.find((s) => s.skillId === skillId);
          return step
            ? historyStepStatus(step)
            : root.id === tip.id && tipUnsubmitted
              ? "not-run"
              : "unknown";
        })(),
        sourceId: root.id,
        continued: false,
      })),
  );
  for (const request of chain) {
    const began = Date.parse(request.startedAt),
      ended = Date.parse(request.finishedAt ?? "");
    if (
      !Number.isFinite(began) ||
      (request.status !== "running" &&
        (!Number.isFinite(ended) || ended < began))
    )
      warnings.push("请求终态时间不完整，不能确认原计划完成");
    const detail = details.get(request.id);
    if (!detail) {
      warnings.push("缺少请求详情，不能确认原计划补齐");
      continue;
    }
    warnings.push(...detail.warnings);
    const link = links.get(request.id);
    if (link) {
      for (const entry of link.excluded)
        for (const skillId of entry.skillIds) {
          const s = steps.find(
            (s) => s.gameId === entry.gameId && s.skillId === skillId,
          );
          if (s) {
            s.status = "excluded";
            s.sourceId = request.id;
            s.continued = true;
          }
        }
      for (const game of detail.games)
        for (const skillId of game.plan.skillIds) {
          const s = steps.find(
            (s) => s.gameId === game.plan.gameId && s.skillId === skillId,
          );
          if (!s) {
            warnings.push("续跑包含原计划之外的步骤");
            continue;
          }
          const step = game.record?.steps.find((s) => s.skillId === skillId);
          s.status = step
            ? historyStepStatus(step)
            : request.id === tip.id && tipUnsubmitted
              ? "not-run"
              : "unknown";
          s.sourceId = request.id;
          const reconciledStartup =
            s.gameId === "arknights" &&
            skillId === "login" &&
            verifiedStartupFacts.some((fact) =>
              matchesStartupReconciliation(
                fact,
                root,
                (original?.games ?? []).flatMap((game) =>
                  game.record ? [game.record] : [],
                ),
              ),
            );
          s.continued =
            !reconciledStartup ||
            (request.status === "succeeded" &&
              game.record?.status === "succeeded" &&
              !!game.record.finishedAt &&
              finished(s.status));
        }
    }
    for (const game of detail.games) {
      if (game.record?.maintenance)
        warnings.push("维护步骤不能作为原日常计划完成证据");
      if (
        game.record &&
        request.status === "succeeded" &&
        (game.record.status !== "succeeded" || !game.record.finishedAt)
      )
        warnings.push("请求成功与游戏步骤终态不一致，不能确认原计划完成");
      // Missing later games may be proven unstarted, but never completed.
      if (
        !game.record &&
        steps.some(
          (s) =>
            s.gameId === game.plan.gameId &&
            !finished(s.status) &&
            s.status !== "excluded",
        )
      ) {
        if (request.id === tip.id && !tipUnsubmitted)
          warnings.push("部分游戏缺少可靠步骤证据");
      }
    }
  }
  const business = steps.filter((s) => s.skillId !== "login"),
    counts = {
      total: business.length,
      completed: business.filter((s) => s.status === "succeeded").length,
      skipped: business.filter((s) => s.status === "skipped").length,
      excluded: business.filter((s) => s.status === "excluded").length,
      remaining: business.filter(
        (s) => !finished(s.status) && s.status !== "excluded",
      ).length,
    };
  const wholePlanComplete =
    !warnings.length &&
    !!steps.length &&
    steps.every((s) => finished(s.status)) &&
    tip.status === "succeeded";
  const active = tip.status === "running";
  const outcome: ExecutionProgress["outcome"] = warnings.length
    ? "unconfirmed"
    : active
      ? "running"
      : wholePlanComplete
        ? chain.length > 1
          ? "recovered"
          : "complete"
        : tip.status === "succeeded" &&
            counts.excluded > 0 &&
            counts.remaining === 0
          ? "partial"
          : tip.status === "unknown"
            ? "unconfirmed"
            : "incomplete";
  return {
    version: 1,
    requestId: id,
    rootId: root.id,
    latestId: tip.id,
    laneId: root.laneId,
    source: root.source,
    originalStatus: root.status,
    outcome,
    wholePlanComplete,
    startedAt: root.startedAt,
    requests: chain.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      ...(typeof r.snapshot.appVersion === "string"
        ? { appVersion: r.snapshot.appVersion }
        : {}),
    })),
    steps,
    counts,
    warnings: [...new Set(warnings)],
  };
}
