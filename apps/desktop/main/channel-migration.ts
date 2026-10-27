import {
  validateDeviceLanes,
  type DeviceLane,
  type DeviceLanes,
} from "../../../packages/protocol";
import {
  channelGame,
  legacyLaneScope,
  type ChannelGame,
} from "../../../packages/protocol/account-channel";

/** Pure migration: provenance points at original records, which remain untouched. */
export function migrateAccountChannels(input: DeviceLanes): DeviceLanes {
  const source = validateDeviceLanes(input);
  if (source.version === 2) return source;
  const reserved = new Set(source.lanes.map((lane) => lane.id));
  const uniqueId = (id: string) => {
    let candidate = id.slice(0, 64);
    for (let suffix = 2; reserved.has(candidate); suffix++)
      candidate = `${id.slice(0, 63 - String(suffix).length)}-${suffix}`;
    reserved.add(candidate);
    return candidate;
  };
  const lanes: DeviceLane[] = [];
  for (const original of source.lanes) {
    const one = channelGame(original);
    const selected: ChannelGame[] = one ? [one] : ["arknights", "onmyoji"];
    for (const game of selected) {
      const lane = structuredClone(original);
      lane.id =
        game === "onmyoji" && !one
          ? uniqueId(`${original.id}-onmyoji`)
          : original.id;
      lane.name = one
        ? original.name
        : `${original.name.replace(/\s*·\s*双游戏\s*$/, "").slice(0, 31)} · ${game === "arknights" ? "明日方舟" : "阴阳师"}`;
      lane.instance = original.deviceInstances?.[game] ?? original.instance;
      lane.enabled = original.enabled && original[game].enabled;
      lane.arknights.enabled = game === "arknights";
      lane.onmyoji.enabled = game === "onmyoji";
      lane.legacyBinding = {
        laneId: original.id,
        instance: lane.instance,
        scope: legacyLaneScope(original),
      };
      delete lane.deviceInstances;
      lanes.push(lane);
    }
  }
  return validateDeviceLanes({ version: 2, lanes });
}
