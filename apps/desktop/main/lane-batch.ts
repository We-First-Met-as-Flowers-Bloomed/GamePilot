import type { DeviceLane } from "../../../packages/protocol";
import { ArknightsCapabilityError } from "../../../games/arknights/capabilities";

export async function launchIndependentLanes(
  lanes: DeviceLane[],
  batchId: string,
  launch: (lane: DeviceLane, batchId: string) => Promise<unknown>,
): Promise<{
  batchId: string;
  issues?: { laneId: string; message: string }[];
}> {
  const issues: { laneId: string; message: string }[] = [];
  let accepted = 0;
  for (const lane of lanes) {
    try {
      await launch(lane, batchId);
      accepted += 1;
    } catch (error) {
      if (!(error instanceof ArknightsCapabilityError)) throw error;
      issues.push({
        laneId: lane.id,
        message: `${lane.name}：${error.message}`,
      });
    }
  }
  if (!accepted)
    throw new ArknightsCapabilityError(
      `未启动任何账号：${issues.map((issue) => issue.message).join("；")}`,
    );
  return { batchId, ...(issues.length ? { issues } : {}) };
}
