import type { DeviceLane, Plan } from "../../../packages/protocol";
import type {
  ArknightsProfile,
  ArknightsProfiles,
} from "../../../games/arknights/config";
import { gamePlugins } from "../../../games/registry";
import { validateLaneProfiles } from "./daily-policy";
import { freezeLaneDevice } from "./lane-device";

export interface LaneExecutionSnapshot {
  lane: DeviceLane;
  startedAt: string;
  profile?: ArknightsProfile;
  arknightsPlan?: Plan;
  onmyojiPlan?: Plan;
  copilot?: import("../../../packages/protocol/copilot").PreparedCopilotPlan;
  exclusions?: {
    gameId: string;
    skillIds: string[];
    skipReason: "not-open";
    evidenceTimestamp: string;
    evidenceReference: string;
  }[];
}
/**
 * 2026-10-15（账号级 Actor · P1a'）：这一个槽位在这个时段该跑哪些游戏。
 *
 * 顺序与执行顺序一致（注册表 order），供调度层按「槽位 × 游戏」逐个发起请求。
 */
export function scheduledGames(
  input: DeviceLane,
  maintenance: boolean,
  slot: "primary" | "secondary" = "primary",
): string[] {
  let lane = structuredClone(input);
  const plugins = gamePlugins
    .list()
    .filter((plugin) => plugin.lane !== undefined);
  for (const plugin of plugins) {
    const binding = plugin.lane!;
    if (
      (maintenance && !binding.maintenancePlan) ||
      (!maintenance && !binding.dailySlots.includes(slot))
    )
      lane = binding.setEnabled(lane, false);
  }
  return plugins
    .sort((a, b) => a.order - b.order)
    .filter((plugin) => plugin.lane!.enabled(lane))
    .map((plugin) => plugin.descriptor.id);
}

/**
 * 只为**一个游戏**冻结执行快照：把这个游戏之外的游戏在该槽位视图里关掉，
 * 于是冻结出的计划、据此做的准入判定、以及之后写下的执行记录，都只覆盖这一个游戏。
 *
 * 为什么需要它：现在一次 lane 请求同时冻结两个游戏的计划，导致"方舟失败"会连
 * 阴阳师的当日机会一起吃掉（同日判定按计划重叠 → 命中）。拆成每游戏一份之后，
 * 一个游戏的失败只影响它自己，另一个游戏可以在设备恢复后照常跑（P1b）。
 *
 * 设备层的顺序不变式不受影响：同一台设备仍然一次只跑一个游戏、且上一个引擎
 * 必须干净释放（见 lane-plan.ts 顶部注释与 tests/lane-plan.test.ts）。
 */
export function freezeLaneExecutionForGame(
  input: DeviceLane,
  profiles: ArknightsProfiles,
  gameId: string,
  maintenance: boolean,
  now = new Date(),
  slot: "primary" | "secondary" = "primary",
): LaneExecutionSnapshot | undefined {
  const plugins = gamePlugins
    .list()
    .filter((plugin) => plugin.lane !== undefined);
  const target = plugins.find((plugin) => plugin.descriptor.id === gameId);
  const binding = target?.lane;
  if (!binding) return undefined;
  // 只关掉**其它**游戏；绝不把用户关掉的游戏强行打开。
  let lane = structuredClone(input);
  for (const plugin of plugins) {
    const other = plugin.lane!;
    if (plugin.descriptor.id === gameId) continue;
    lane = other.setEnabled(lane, false);
  }
  const snapshot = freezeLaneExecution(lane, profiles, maintenance, now, slot);
  // 该游戏被用户关闭、或不在这个时段（或维护范围）内时，不产生快照。
  return binding.enabled(snapshot.lane) ? snapshot : undefined;
}

export function freezeLaneExecution(
  input: DeviceLane,
  profiles: ArknightsProfiles,
  maintenance: boolean,
  now = new Date(),
  slot: "primary" | "secondary" = "primary",
): LaneExecutionSnapshot {
  let lane = structuredClone(input);
  const plugins = gamePlugins
    .list()
    .filter((plugin) => plugin.lane !== undefined);
  for (const plugin of plugins) {
    const binding = plugin.lane!;
    if (
      (maintenance && !binding.maintenancePlan) ||
      (!maintenance && !binding.dailySlots.includes(slot))
    )
      lane = binding.setEnabled(lane, false);
  }
  validateLaneProfiles([lane], profiles);
  lane = freezeLaneDevice(
    lane,
    plugins
      .filter((plugin) => plugin.lane!.enabled(lane))
      .map((plugin) => plugin.descriptor.id),
  );
  const snapshot: LaneExecutionSnapshot = {
    lane,
    startedAt: now.toISOString(),
  };
  for (const plugin of plugins) {
    const binding = plugin.lane!;
    if (!binding.enabled(lane)) continue;
    const profile = profiles.profiles.find(
      (p) => p.id === lane.arknights.profileId,
    );
    const frozen =
      maintenance && binding.maintenancePlan
        ? { plan: structuredClone(binding.maintenancePlan) }
        : binding.compileDaily(lane, profile, now);
    (snapshot as LaneExecutionSnapshot & Record<string, unknown>)[
      binding.planKey
    ] = frozen.plan;
    if ("profile" in frozen && frozen.profile)
      snapshot.profile = structuredClone(frozen.profile);
  }
  return snapshot;
}
