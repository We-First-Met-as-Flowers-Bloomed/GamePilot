import type { DeviceLane } from "../../../packages/protocol";
import type { ArknightsProfiles } from "../../../games/arknights/config";
import { validateArknightsAutomation, type ArknightsJob } from "../../../packages/protocol/arknights-automation";
import { freezeLaneExecutionForGame } from "./lane-snapshot";

/** Freeze the job, account and parameters together; a later edit affects the next run. */
export function freezeArknightsJob(lane: DeviceLane, profiles: ArknightsProfiles, input: ArknightsJob, now = new Date()) {
  const job = validateArknightsAutomation({version:1,enabled:true,jobs:[input]}).jobs[0];
  if (job.laneId !== lane.id || !lane.enabled || !lane.arknights.enabled)
    throw Error("计划绑定的方舟账号渠道未启用或不存在");
  const selected = structuredClone(lane);
  selected.arknights.routine = {version:1,steps:job.skillIds.map(skillId=>({skillId,enabled:true}))};
  const snapshot = freezeLaneExecutionForGame(selected,profiles,"arknights",false,now);
  if (!snapshot?.arknightsPlan) throw Error("方舟计划没有可执行步骤");
  return snapshot;
}
