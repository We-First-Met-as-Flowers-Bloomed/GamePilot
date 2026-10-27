import {
  createHistoryIndex,
  frozenHistoryPlans,
  readableHistorySnapshot,
} from "../../../games/history-gate";
import { createHash } from "node:crypto";
import type { DeviceLane, DeviceLanes, Plan } from "../../../packages/protocol";
import type { PlannerViewState } from "../../../packages/protocol/agent-planner";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import {
  requestMayAffectChannel,
  taskMayAffectChannel,
} from "../../../packages/protocol/account-channel";
import type { ArknightsProfiles } from "../../../games/arknights/config";
import type { ConfiguredSnapshot } from "../../../packages/agent/configured";
import type { LaneExecutionSnapshot } from "./lane-snapshot";
import { freezeLaneDevice } from "./lane-device";
import { agentLaneAlias } from "../../../packages/protocol/lane-alias";
import { canonical } from "../../../packages/acceptance/files";
import {
  AgentToolError,
  agentDate,
  type CompiledDraft,
} from "../../../packages/protocol/agent";
import { createAgentTools } from "../../../packages/agent/tools";
import { mumuResource } from "./execution-coordinator";
import {
  agentExecutionGameDay,
  prepareAgentGame,
  hasAgentNonLoginSkills,
  agentHistoryOverlaps,
  agentHistoryTouchesDay,
} from "../../../games/agent-execution";
import { gamePlugins } from "../../../games/registry";
import { validateGameOrder } from "../../../games/agent";
import { completedContinuationRequestIds } from "../../../games/continuation-history";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";
import { matchesStartupReconciliation } from "../../../games/arknights/startup-reconciliation";
import {
  disjointTerminalHistory,
  resolvedUnstartedOnmyojiHistory,
} from "../../../games/agent-history-admission";

export interface AgentExecutionContext {
  configured: ConfiguredSnapshot;
  lanes: DeviceLanes;
  profiles: ArknightsProfiles;
  requests: ExecutionRecord[];
  tasks: TaskRecord[];
  /** Created only by the host after closing idle workers and probing native process exit. */
  startupInspection?: StartupInspectionPermit;
  /** Facts revalidated by the host against both immutable request/task records. */
  startupFacts?: StartupReconciliationFact[];
}

export interface StartupInspectionPermit {
  verified: true;
  observedAt: string;
  evidenceReference: string;
  resources: string[];
}

export function pureArknightsLogin(target: LaneExecutionSnapshot): boolean {
  return (
    !target.onmyojiPlan &&
    target.arknightsPlan?.gameId === "arknights" &&
    target.arknightsPlan.mode === "live" &&
    target.arknightsPlan.skillIds.length === 1 &&
    target.arknightsPlan.skillIds[0] === "login"
  );
}

/** Host-captured successful compile result; this is not an IPC/model input parser. */
export function prepareCompiledAgentExecution(
  draft: CompiledDraft,
  context: AgentExecutionContext,
  now: Date,
  startedAt = draft.at,
): LaneExecutionSnapshot[] {
  const source = context.configured.snapshot.source;
  if (source !== "configured" && source !== "recorded")
    throw new AgentToolError(
      "EXECUTION_DRAFT_REQUIRED",
      "执行只能使用当前本地配置或持久记录来源",
    );
  return prepareAgentExecution(
    {
      revision: 1,
      status: "completed",
      requestId: "host-compiled-goal",
      source,
      startedAt,
      result: {
        status: "draft",
        source,
        execution: "not-started",
        canExecute: false,
        draft,
        trace: [],
        modelText: "",
        model: "host",
        codexVersion: "host",
        elapsedMs: 0,
      },
    },
    context,
    now,
  );
}

export function prepareAgentExecution(
  state: PlannerViewState,
  context: AgentExecutionContext,
  now: Date,
): LaneExecutionSnapshot[] {
  const result = state.result;
  const draft = result?.draft;
  const snapshot = context.configured.snapshot;
  if (
    state.status !== "completed" ||
    !state.requestId ||
    result?.status !== "draft" ||
    !["configured", "recorded"].includes(result.source) ||
    snapshot.source !== result.source ||
    (state.source !== undefined && state.source !== result.source) ||
    !draft ||
    draft.status !== "valid" ||
    draft.canExecute !== false ||
    !draft.planHash ||
    !/^[a-f0-9]{64}$/.test(draft.planHash)
  )
    throw new AgentToolError(
      "EXECUTION_DRAFT_REQUIRED",
      "请先完成当前配置或持久记录来源的有效草稿，再检查执行条件",
    );
  const fresh = (raw: unknown) => {
    let timestamp: number;
    try {
      timestamp = Date.parse(agentDate(raw));
    } catch {
      throw new AgentToolError("DRAFT_EXPIRED", "草稿缺少有效时间，请重新规划");
    }
    const age = now.getTime() - timestamp;
    if (
      !Number.isFinite(age) ||
      age < -60_000 ||
      age > 15 * 60_000 ||
      draft.lanes.some((entry) =>
        entry.games.some(
          (game) =>
            agentExecutionGameDay(new Date(timestamp), game.plan.gameId) !==
            agentExecutionGameDay(now, game.plan.gameId),
        ),
      )
    )
      throw new AgentToolError(
        "DRAFT_EXPIRED",
        "草稿已过期或跨越游戏日，请重新规划",
      );
  };
  fresh(state.startedAt);
  fresh(draft.at);
  const tools = createAgentTools(snapshot);
  const catalog = tools.call("list_capabilities");
  const environment = tools.call("get_environment");
  if (
    draft.compilerVersion !== 2 ||
    draft.skillRevision !== catalog.skills?.revision
  )
    throw new AgentToolError(
      "COMPILER_CHANGED",
      "草稿使用旧编译器或旧技能正文，只能查看历史；请重新生成并检查计划",
    );
  if (!catalog.complete || catalog.revision !== draft.catalogRevision)
    throw new AgentToolError(
      "CAPABILITIES_CHANGED",
      "能力目录已变化，请重新规划",
    );
  if (
    !environment.complete ||
    environment.revision !== draft.environmentRevision
  )
    throw new AgentToolError(
      "ENVIRONMENT_CHANGED",
      "环境配置已变化或不完整，请重新规划",
    );
  const { catalogRevision, environmentRevision, at, lanes } = draft;
  const hash = createHash("sha256")
    .update(canonical({ catalogRevision, environmentRevision, at, lanes }))
    .digest("hex");
  if (hash !== draft.planHash)
    throw new AgentToolError("DRAFT_CHANGED", "草稿校验值不符，请重新规划");
  if (
    !lanes.length ||
    new Set(lanes.map((l) => l.laneId)).size !== lanes.length ||
    snapshot.lanes!.lanes.length !== context.lanes.lanes.length ||
    snapshot.profiles!.profiles.length !== context.profiles.profiles.length
  )
    throw new AgentToolError(
      "ENVIRONMENT_CHANGED",
      "设备槽位或账号映射已变化，请重新规划",
    );
  const frozen = lanes.map((entry): LaneExecutionSnapshot => {
    const index = snapshot.lanes!.lanes.findIndex((l) => l.id === entry.laneId);
    const alias = snapshot.lanes!.lanes[index];
    const lane = context.lanes.lanes[index];
    const profileIndex = snapshot.profiles!.profiles.findIndex(
      (p) => p.id === alias?.arknights.profileId,
    );
    const profile = context.profiles.profiles[profileIndex];
    if (
      !alias ||
      alias.id !== agentLaneAlias(index) ||
      !lane ||
      alias.instance !== lane.instance ||
      entry.instance !== lane.instance ||
      !alias.enabled ||
      !lane.enabled ||
      !entry.games.length ||
      entry.games.length > 2 ||
      new Set(entry.games.map((game) => game.plan.gameId)).size !==
        entry.games.length
    )
      throw new AgentToolError(
        "ENVIRONMENT_CHANGED",
        "设备实例、启用状态或账号绑定已变化，请重新规划",
      );
    if (mumuResource(lane.managerPath, lane.instance) === "*")
      throw new AgentToolError(
        "DEVICE_PATH_REQUIRED",
        "请在设置中固定模拟器管理器的完整路径，再检查执行条件",
      );
    validateGameOrder(
      entry.games.map((game) => ({ gameId: game.plan.gameId })),
    );
    let frozenLane = structuredClone({
      ...lane,
      closeEmulatorAfterSuccess: false,
    });
    for (const plugin of gamePlugins.list())
      if (plugin.lane) frozenLane = plugin.lane.setEnabled(frozenLane, false);
    const frozen: LaneExecutionSnapshot = {
      lane: frozenLane,
      startedAt: now.toISOString(),
    };
    for (const game of entry.games) {
      const binding = gamePlugins.get(game.plan.gameId).lane;
      if (!binding)
        throw new AgentToolError(
          "UNSUPPORTED_EXECUTION_GAME",
          "游戏账号执行绑定未注册",
        );
      binding.assertBinding(alias, lane, profile, profileIndex);
      const prepared = prepareAgentGame(game, lane, profile, draft.at);
      frozen.lane = binding.freezeSelection(frozen.lane, prepared.plan);
      (frozen as LaneExecutionSnapshot & Record<string, unknown>)[
        binding.planKey
      ] = structuredClone(prepared.plan);
      if (prepared.profile) frozen.profile = structuredClone(prepared.profile);
      if (game.excluded.length) {
        frozen.exclusions ??= [];
        frozen.exclusions.push({
          gameId: game.plan.gameId,
          skillIds: [...game.excluded],
          skipReason: "not-open",
          evidenceTimestamp: draft.at,
          evidenceReference: `${game.plan.gameId}:compiled-calendar-exclusion`,
        });
      }
    }
    frozen.lane = freezeLaneDevice(
      frozen.lane,
      entry.games.map((game) => game.plan.gameId),
    );
    return frozen;
  });
  const resources = frozen.map((s) =>
    mumuResource(s.lane.managerPath, s.lane.instance),
  );
  if (new Set(resources).size !== resources.length)
    throw new AgentToolError(
      "RESOURCE_CONFLICT",
      "多个草稿槽位指向同一个模拟器，请调整后重新规划",
    );
  for (const target of frozen)
    for (const plan of [target.arknightsPlan, target.onmyojiPlan])
      if (plan) guardHistory(target, context, now, plan);
  return frozen;
}

/**
 * 请求自身的任务证据是否**完整且自洽**——只有可信的证据才允许用来放行。
 *
 * `agent-history-admission.test.ts` 的"disjoint 但证据不可信"用例要求：任务缺失、
 * 任务与请求对不上、同请求重复任务、任务状态与步骤自相矛盾，都必须继续拦住所有游戏。
 */
function requestEvidenceIsCoherent(
  request: ExecutionRecord,
  linked: readonly TaskRecord[],
): boolean {
  if (!linked.length) return false;
  if (!linked.every((task) => taskMatchesRequest(task, request))) return false;
  if (new Set(linked.map((task) => task.gameId)).size !== linked.length)
    return false;
  return linked.every((task) =>
    task.status === "succeeded"
      ? task.steps.every(
          (step) => step.status === "succeeded" || step.status === "skipped",
        )
      : task.steps.every(
          (step) => step.status !== "running" && step.status !== "pending",
        ),
  );
}

/**
 * 2026-10-15（账号级 Actor · P1a）：这条请求能否**被证明与本游戏无关**。
 *
 * 两个条件同时成立才算证明：
 *  1. 请求自己快照里**冻结的计划**可读，且没有任何一个与本计划重叠
 *     （`agentHistoryOverlaps` 同样用在同日判定里）；
 *  2. 该请求的任务证据**完整且自洽**（见上）。
 *
 * 这是结构性证据，不靠任务反推游戏归属，所以用来放行是安全的；任何一条读不到、
 * 对不上或自相矛盾，都退回"继续拦截"。今天一个槽位的请求同时冻结两个游戏，
 * 因此本函数返回 false，行为与之前完全一致；等 P1a'（每个「槽位 × 游戏」一个请求）
 * 落地后，它才会真正放行。
 */
function requestProvablyOtherGames(
  request: ExecutionRecord,
  linked: readonly TaskRecord[],
  plan: Plan,
): boolean {
  const frozen = frozenHistoryPlans(request);
  if (!frozen?.length) return false;
  if (frozen.some((entry) => agentHistoryOverlaps(plan, entry))) return false;
  return requestEvidenceIsCoherent(request, linked);
}

/**
 * 2026-10-15（账号级 Actor · P1 调研结论）：**不要**用"任务里的 gameId"来放宽未处置闸门。
 *
 * 试过一版：请求是设备级的、任务才带 gameId，看起来"只关联别的游戏就可以放行"，
 * 但 `agent-history-admission.test.ts` 里有一组"disjoint 但证据不可信"的用例
 * （计划丢失 / 计划非法 / 任务状态自相矛盾 / 重复任务）正是要求这种情况下**继续拦**。
 * 结论：归属判断必须用结构性证据（冻结的计划 + 自洽的任务证据），不要从任务反推。
 */
const requestMatches = requestMayAffectChannel;

export function taskMatchesRequest(
  task: TaskRecord,
  request: ExecutionRecord,
): boolean {
  const original = request.snapshot.lane as Partial<DeviceLane> | undefined;
  const profile = request.snapshot.profile as { id?: string } | undefined;
  const plans = [
    request.snapshot.plan,
    request.snapshot.arknightsPlan,
    request.snapshot.onmyojiPlan,
  ].filter(Boolean);
  return (
    task.executionId === request.id &&
    task.laneId === request.laneId &&
    task.batchId === request.batchId &&
    (!original || task.instance === original.instance) &&
    (task.gameId !== "arknights" ||
      !original ||
      task.profileId === profile?.id) &&
    plans.some((plan) => canonical(plan) === canonical(task.plan))
  );
}

function exactHistoryDevice(
  request: ExecutionRecord,
  target: DeviceLane,
): boolean {
  const original = request.snapshot.lane as Partial<DeviceLane> | undefined;
  const resource = mumuResource(target.managerPath, target.instance);
  return (
    resource !== "*" &&
    request.laneId === target.id &&
    original?.id === target.id &&
    original.instance === target.instance &&
    original.onmyoji?.enabled === true &&
    target.onmyoji.enabled === true &&
    typeof original.managerPath === "string" &&
    mumuResource(original.managerPath, original.instance) === resource &&
    request.resources.length === 1 &&
    request.resources[0] === resource
  );
}

export function guardHistory(
  target: LaneExecutionSnapshot,
  context: Pick<
    AgentExecutionContext,
    "requests" | "tasks" | "startupFacts" | "startupInspection"
  >,
  now: Date,
  selectedPlan?: Plan,
) {
  const history = createHistoryIndex(context.requests, context.tasks);
  const plan = selectedPlan ?? target.arknightsPlan!;
  const covered = completedContinuationRequestIds(
    context.requests,
    context.tasks,
    context.startupFacts,
  );
  const reconciled = new Set(
    context.requests
      .filter((request) =>
        context.startupFacts?.some(
          (fact) =>
            Date.parse(fact.reconciledAt) <= now.getTime() &&
            matchesStartupReconciliation(fact, request, context.tasks),
        ),
      )
      .map((request) => request.id),
  );
  const nonLogin = hasAgentNonLoginSkills(plan);
  const unstarted = new Set(
    context.requests
      .filter(
        (request) =>
          exactHistoryDevice(request, target.lane) &&
          resolvedUnstartedOnmyojiHistory(request, context.tasks, plan, now),
      )
      .map((request) => request.id),
  );
  const disjoint = new Set(
    context.requests
      .filter((request) =>
        disjointTerminalHistory(request, context.tasks, plan, now),
      )
      .map((request) => request.id),
  );
  const permit = context.startupInspection;
  const age = now.getTime() - Date.parse(permit?.observedAt ?? "");
  const inspecting =
    pureArknightsLogin(target) &&
    plan === target.arknightsPlan &&
    permit?.verified === true &&
    age >= 0 &&
    age <= 15_000 &&
    /^native-executor-exit:sha256:[a-f0-9]{64}$/.test(
      permit.evidenceReference,
    ) &&
    permit.resources.includes(
      mumuResource(target.lane.managerPath, target.lane.instance),
    );
  const unresolved = () => {
    throw new AgentToolError(
      "UNRESOLVED_EXECUTION",
      "目标设备存在运行中或未处置的失败、取消、未知记录，请先核对并处置原请求",
    );
  };
  const repeated = () => {
    throw new AgentToolError(
      "SAME_DAY_EXECUTION",
      "目标设备本游戏日已有重叠任务或不完整记录，不能自动补跑，请先核对游戏内结果",
    );
  };
  const active = (status: string) =>
    ["queued", "running", "stopping"].includes(status);
  const uncertain = (status: string) =>
    ["unknown", "failed", "cancelled"].includes(status);
  for (const request of context.requests) {
    if (!requestMatches(request, target.lane)) continue;
    if (!readableHistorySnapshot(request))
      throw new AgentToolError(
        "UNRESOLVED_EXECUTION",
        "目标设备执行快照版本不受支持，原记录须先核对",
      );
    const linked = history.tasks(request.id);
    if (
      active(request.status) ||
      (uncertain(request.status) &&
        !requestProvablyOtherGames(request, linked, plan) &&
        !inspecting &&
        !reconciled.has(request.id) &&
        !request.resolution &&
        !covered.has(request.id) &&
        !disjoint.has(request.id))
    )
      unresolved();
    if (!nonLogin) continue;
    if (
      agentHistoryTouchesDay(
        request.startedAt,
        request.finishedAt,
        now,
        plan.gameId,
      )
    ) {
      const plans = frozenHistoryPlans(request) ?? [];
      if (
        !unstarted.has(request.id) &&
        (!plans.length || plans.some((p) => agentHistoryOverlaps(plan, p)))
      )
        repeated();
    }
    for (const task of linked) {
      const associationMatches = taskMatchesRequest(task, request);
      if (
        active(task.status) ||
        (uncertain(task.status) &&
          !inspecting &&
          !(reconciled.has(request.id) && taskMatchesRequest(task, request)) &&
          !request.resolution &&
          !(covered.has(request.id) && associationMatches) &&
          !disjoint.has(request.id))
      )
        unresolved();
      if (
        !unstarted.has(request.id) &&
        agentHistoryTouchesDay(
          task.startedAt,
          task.finishedAt ?? task.updatedAt,
          now,
          plan.gameId,
        ) &&
        (!associationMatches || agentHistoryOverlaps(plan, task.plan))
      )
        repeated();
    }
  }
  // Orphan tasks cannot be excluded based on a renamed lane or missing manager path.
  for (const task of context.tasks) {
    const owners = task.executionId ? history.requests(task.executionId) : [];
    const associated = owners.length === 1 ? owners[0] : undefined;
    const physicalMatch = taskMayAffectChannel(task, target.lane, associated);
    if (
      !physicalMatch &&
      !(associated && requestMatches(associated, target.lane))
    )
      continue;
    if (
      active(task.status) ||
      (uncertain(task.status) &&
        !inspecting &&
        !(
          associated &&
          reconciled.has(associated.id) &&
          taskMatchesRequest(task, associated)
        ) &&
        !associated?.resolution &&
        !(associated && disjoint.has(associated.id)) &&
        !(
          associated &&
          covered.has(associated.id) &&
          taskMatchesRequest(task, associated)
        ))
    )
      unresolved();
    if (
      nonLogin &&
      !(
        associated &&
        unstarted.has(associated.id) &&
        taskMatchesRequest(task, associated)
      ) &&
      agentHistoryTouchesDay(
        task.startedAt,
        task.finishedAt ?? task.updatedAt,
        now,
        plan.gameId,
      ) &&
      agentHistoryOverlaps(plan, task.plan)
    )
      repeated();
  }
}

/** Saved and compiled goals share the same history gate, including scope exemptions. */
export function guardSavedDailyHistory(
  target: LaneExecutionSnapshot,
  context: AgentExecutionContext,
  now: Date,
  slot: "primary" | "secondary",
): void {
  const covered = completedContinuationRequestIds(
    context.requests,
    context.tasks,
    context.startupFacts,
  );
  for (const plan of [target.arknightsPlan, target.onmyojiPlan].filter(
    (p): p is Plan => !!p,
  )) {
    // The second daily period may reuse only settled successes from before 20:00.
    const history =
      slot === "secondary" && plan.gameId === "arknights"
        ? {
            ...context,
            requests: context.requests.filter(
              (r) =>
                !readableHistorySnapshot(r) ||
                (r.status !== "succeeded" && !covered.has(r.id)) ||
                new Date(r.finishedAt ?? r.startedAt).getHours() >= 20 ||
                agentExecutionGameDay(new Date(r.startedAt)) !==
                  agentExecutionGameDay(now),
            ),
            tasks: context.tasks.filter(
              (t) =>
                context.requests.some(
                  (r) => r.id === t.executionId && !readableHistorySnapshot(r),
                ) ||
                (t.status !== "succeeded" &&
                  !covered.has(t.executionId ?? "")) ||
                new Date(t.finishedAt ?? t.updatedAt).getHours() >= 20 ||
                agentExecutionGameDay(new Date(t.startedAt)) !==
                  agentExecutionGameDay(now),
            ),
          }
        : context;
    guardHistory(target, history, now, plan);
  }
}
