import type { DeviceLane, Plan } from "../../../packages/protocol";
import type {
  ArknightsProfile,
  ArknightsProfiles,
} from "../../../games/arknights/config";
import { gamePlugins } from "../../../games/registry";

export interface LaneExecutionSnapshot {
  lane: DeviceLane;
  startedAt: string;
  profile?: ArknightsProfile;
  arknightsPlan?: Plan;
  onmyojiPlan?: Plan;
  exclusions?: {
    gameId: string;
    skillIds: string[];
    skipReason: "not-open";
    evidenceTimestamp: string;
    evidenceReference: string;
  }[];
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
