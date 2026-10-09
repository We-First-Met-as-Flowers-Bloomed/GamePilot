import type { DeviceLane } from "../../../packages/protocol";
import type { ArknightsProfiles } from "../../../games/arknights/config";
export function validateLaneProfiles(
  lanes: DeviceLane[],
  profiles: ArknightsProfiles,
) {
  for (const lane of lanes)
    if (
      lane.enabled &&
      lane.arknights.enabled &&
      !profiles.profiles.some((p) => p.id === lane.arknights.profileId)
    )
      throw new Error(
        `${lane.name} 绑定的明日方舟档案不存在，请先重新绑定设备账号`,
      );
}
export function maintenanceLanes(lanes: DeviceLane[]) {
  return lanes.filter(
    (lane) =>
      lane.enabled &&
      lane.onmyoji.enabled &&
      // Maintenance is independent of the daily list. Honor an old explicit opt-out.
      lane.onmyoji.routine?.steps.find((s) => s.skillId === "foster")
        ?.enabled !== false,
  );
}
export function dailyLaneScope(lane: DeviceLane) {
  return JSON.stringify([
    lane.managerPath.toLowerCase().replaceAll("\\", "/"),
    lane.instance,
    lane.arknights.enabled ? lane.arknights.profileId : "",
    lane.onmyoji.enabled,
  ]);
}
