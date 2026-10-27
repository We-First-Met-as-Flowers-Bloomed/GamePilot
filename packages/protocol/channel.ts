import type { DeviceLanes } from "./index";
import type { ArknightsProfiles } from "../../games/arknights/config";

export interface ChannelCopyInput {
  sourceLaneId: string;
  gameId: "arknights" | "onmyoji";
  targets: { instance: number; name: string }[];
}
export interface ChannelCopyResult {
  lanes: DeviceLanes;
  profiles: ArknightsProfiles;
}
