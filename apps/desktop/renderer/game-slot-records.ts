import type {
  DeviceLane,
  Plan,
  RunEvent,
  RunStatus,
} from "../../../packages/protocol";
import type { ArknightsProfile } from "../../../games/arknights/config";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import { arknightsGameDay } from "../../../games/arknights/result-policy";
import { gameDay as onmyojiGameDay } from "../../../games/onmyoji/policy";
import { games } from "../../../games/registry";
import { compileDailyPlan } from "../../../games/routines";
import { arknightsDailySkills } from "../../../games/arknights/daily-plan";
import { isActiveStatus } from "../../../packages/protocol/run-state";
import { channelHistoryLaneIds } from "../../../packages/protocol/account-channel";

type GameId = "arknights" | "onmyoji";
type Scope = "daily" | "single" | "maintenance" | "continuation" | "unknown";
type Profile = Pick<ArknightsProfile, "id" | "expectedUid" | "clientType"> &
  Partial<ArknightsProfile>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : (value ?? null);
const same = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const date = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
const physical = (lane: DeviceLane, gameId: GameId) =>
  lane.deviceInstances?.[gameId] ?? lane.instance;
function gamePlan(request: ExecutionRecord, gameId: GameId): Plan | undefined {
  const value =
    object(request.snapshot[`${gameId}Plan`]) ?? object(request.snapshot.plan);
  return value?.gameId === gameId &&
    Array.isArray(value.skillIds) &&
    value.skillIds.length > 0 &&
    value.skillIds.every((id) => typeof id === "string") &&
    ["live", "rehearsal"].includes(String(value.mode))
    ? (value as unknown as Plan)
    : undefined;
}
function slotTarget(request: ExecutionRecord) {
  return object(request.snapshot.gameSlot);
}
function declaredGame(
  request: ExecutionRecord,
  laneId: string,
  gameId: GameId,
) {
  const slot = slotTarget(request);
  if (slot && (slot.laneId !== laneId || slot.gameId !== gameId)) return false;
  return Boolean(
    gamePlan(request, gameId) ||
    (slot?.laneId === laneId && slot.gameId === gameId),
  );
}
function gameCount(request: ExecutionRecord) {
  return (["arknights", "onmyoji"] as const).filter((id) =>
    gamePlan(request, id),
  ).length;
}
function requestLane(request: ExecutionRecord, lane: DeviceLane) {
  const frozen = object(request.snapshot.lane);
  return (
    !!request.laneId &&
    channelHistoryLaneIds(lane).includes(request.laneId) &&
    (!frozen || frozen.id === request.laneId)
  );
}

/** Per-game projection only. A parent receipt is neither game completion nor a replay permission. */
export function gameSlotRecords(input: {
  lane: DeviceLane;
  gameId: GameId;
  requests?: readonly ExecutionRecord[];
  tasks?: readonly TaskRecord[];
  events?: readonly RunEvent[];
  now?: Date;
  profile?: Profile;
}) {
  const { lane, gameId, profile } = input;
  const day = gameId === "arknights" ? arknightsGameDay : onmyojiGameDay;
  const currentGameDay = day(input.now ?? new Date());
  const instance = physical(lane, gameId);
  const allRequests = input.requests ?? [];
  // A duplicate exact ID cannot safely identify ownership, even when one copy appears to match.
  const requests = allRequests.filter(
    (request) =>
      requestLane(request, lane) &&
      allRequests.filter((other) => other.id === request.id).length === 1,
  );
  const taskRequest = (record: TaskRecord) => {
    if (record.executionId)
      return requests.find(
        (r) => r.id === record.executionId && r.batchId === record.batchId,
      );
    const candidates = requests.filter(
      (r) => r.batchId && r.batchId === record.batchId,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  };
  const tasks = (input.tasks ?? []).filter((record) => {
    if (record.gameId !== gameId || record.plan.gameId !== gameId) return false;
    const receipt = taskRequest(record);
    if (!receipt || record.laneId !== receipt.laneId) return false;
    const slot = slotTarget(receipt);
    if (slot && (slot.laneId !== receipt.laneId || slot.gameId !== gameId))
      return false;
    const frozen = object(receipt.snapshot.lane);
    const frozenProfile = object(receipt.snapshot.profile);
    const frozenInstance = frozen
      ? physical(frozen as unknown as DeviceLane, gameId)
      : instance;
    if (record.instance !== undefined && record.instance !== frozenInstance)
      return false;
    if (
      gameId === "arknights" &&
      record.profileId !== undefined &&
      frozenProfile?.id !== undefined &&
      record.profileId !== frozenProfile.id
    )
      return false;
    const plan = gamePlan(receipt, gameId);
    if (!plan && gameCount(receipt) > 0) return false;
    return !plan || same(plan, record.plan);
  });
  const candidates = requests.filter(
    (request) =>
      declaredGame(request, request.laneId!, gameId) ||
      tasks.some((record) => taskRequest(record)?.id === request.id),
  );
  const latestRequest = candidates
    .slice()
    .sort(
      (left, right) =>
        Number(right.status === "running") -
          Number(left.status === "running") ||
        right.startedAt.localeCompare(left.startedAt),
    )[0];
  const records = latestRequest
    ? tasks
        .filter((record) => taskRequest(record)?.id === latestRequest.id)
        .slice()
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    : [];
  const snapshot = latestRequest?.snapshot;
  const frozen = object(snapshot?.lane);
  const frozenBinding = object(frozen?.[gameId]);
  const binding = lane[gameId];
  const frozenProfile = object(snapshot?.profile);
  const selectedPlan = latestRequest && gamePlan(latestRequest, gameId);
  const boundIdentity =
    gameId === "arknights"
      ? Boolean(
          profile?.expectedUid &&
          profile.id === lane.arknights.profileId &&
          frozenBinding?.profileId === profile.id &&
          frozenProfile?.id === profile.id &&
          frozenProfile.expectedUid === profile.expectedUid &&
          frozenProfile.clientType === profile.clientType,
        )
      : Boolean(
          lane.onmyoji.identity &&
          same(frozenBinding?.identity, lane.onmyoji.identity),
        );
  // Saved account settings which were supplied must match the effective frozen settings.
  // The task selector owns recruit in a frozen plan, so compare it using that same selector.
  const profileMatches =
    gameId !== "arknights" ||
    Boolean(
      profile &&
      frozenProfile &&
      Object.entries(profile).every(
        ([key, value]) =>
          key === "name" ||
          same(
            frozenProfile[key],
            key === "recruit" && selectedPlan
              ? selectedPlan.skillIds.includes("recruit")
              : value,
          ),
      ),
    );
  let selectedPlanMatches = false;
  try {
    if (
      gameId === "onmyoji" ||
      (profile &&
        typeof profile.stage === "string" &&
        typeof profile.recruit === "boolean")
    ) {
      const defaults =
        gameId === "arknights"
          ? arknightsDailySkills(profile as ArknightsProfile)
          : undefined;
      selectedPlanMatches = same(
        selectedPlan,
        compileDailyPlan(
          gameId,
          binding.routine,
          defaults,
          input.now ?? new Date(),
        ),
      );
    }
  } catch {
    // A malformed or no-longer-supported saved plan cannot certify a historical result.
  }
  const currentPlanMatches = Boolean(
    lane.enabled &&
    binding.enabled &&
    frozen &&
    selectedPlan?.mode === "live" &&
    typeof frozen.managerPath === "string" &&
    frozen.managerPath.toLowerCase().replaceAll("\\", "/") ===
      lane.managerPath.toLowerCase().replaceAll("\\", "/") &&
    physical(frozen as unknown as DeviceLane, gameId) === instance &&
    frozenBinding?.enabled === true &&
    same(frozenBinding.routine, binding.routine) &&
    boundIdentity &&
    profileMatches &&
    selectedPlanMatches,
  );
  const scope: Scope = snapshot?.continuation
    ? "continuation"
    : (latestRequest?.source ?? "unknown");
  let status: RunStatus | "unknown" | null = null;
  const terminalRequest = latestRequest && latestRequest.status !== "running";
  if (records.length) {
    const activeRecord = records.find(
      (record) => record.status !== "unknown" && isActiveStatus(record.status),
    );
    const unknown = records.some(
      (record) =>
        record.status === "unknown" ||
        record.steps.some((step) => step.status === "unknown") ||
        (record.status === "succeeded" &&
          (record.plan.mode !== "live" ||
            record.steps.length !== record.plan.skillIds.length ||
            record.steps.some(
              (step) => !["succeeded", "skipped"].includes(step.status),
            ))),
    );
    if (records.length > 1 || (activeRecord && terminalRequest) || unknown)
      status = "unknown";
    else if (activeRecord) status = activeRecord.status;
    else if (records.some((record) => record.status === "failed"))
      status = "failed";
    else if (records.some((record) => record.status === "cancelled"))
      status = "cancelled";
    else if (records.every((record) => record.status === "succeeded"))
      status = "succeeded";
  } else if (latestRequest?.status === "running") status = "running";
  else if (
    latestRequest &&
    (gameCount(latestRequest) === 1 || slotTarget(latestRequest))
  )
    status =
      latestRequest.status === "succeeded" ? "unknown" : latestRequest.status;
  const active = status !== "unknown" && isActiveStatus(status);
  const uncertain = status === "unknown";
  const startedAt =
    date(latestRequest?.startedAt) ?? date(records[0]?.startedAt);
  const gameDay = startedAt ? day(new Date(startedAt)) : undefined;
  const recordedAt =
    records
      .map((record) => record.updatedAt)
      .sort()
      .at(-1) ??
    latestRequest?.finishedAt ??
    latestRequest?.startedAt;
  const steps = records
    .slice()
    .reverse()
    .flatMap((record) => record.steps.map((step) => ({ record, step })));
  const selectedStep =
    steps.find(({ step }) => step.status === "running") ??
    steps.find(({ step }) => ["unknown", "failed"].includes(step.status));
  const game = games.find((g) => g.id === gameId);
  const currentStep = selectedStep
    ? {
        gameId,
        gameName: game?.name ?? gameId,
        skillId: selectedStep.step.skillId,
        title:
          game?.skills.find((skill) => skill.id === selectedStep.step.skillId)
            ?.title ?? selectedStep.step.skillId,
        status: selectedStep.step.status,
      }
    : undefined;
  const label = active
    ? status === "stopping"
      ? "正在停止本游戏"
      : "本游戏请求运行中"
    : uncertain
      ? "本游戏部分结果未知"
      : status === "failed"
        ? "最近游戏任务失败 · 展开核对"
        : status === "cancelled"
          ? "本游戏请求已停止 · 结果待核对"
          : status === "succeeded"
            ? "最近游戏任务已结束 · 展开核对"
            : "App 游戏计划未验证";
  return {
    gameId,
    laneId: lane.id,
    instance,
    currentGameDay,
    gameDay,
    requestId: latestRequest?.id,
    batchId: latestRequest?.batchId,
    recordedAt,
    scope,
    status,
    label,
    active,
    uncertain,
    currentPlanMatches,
    records,
    latestRequest,
    currentStep,
    revision: JSON.stringify([
      latestRequest?.id,
      latestRequest?.status,
      latestRequest?.finishedAt,
      records.map((record) => [record.runId, record.updatedAt]),
    ]),
  };
}
