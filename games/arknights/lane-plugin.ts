import type { GameLaneContract } from "../plugin";
import { compileDailyPlan } from "../routines";
import { arknightsDailySkills, arknightsConfigForPlan } from "./daily-plan";
import { AgentToolError } from "../../packages/protocol/agent";

export const arknightsLaneContract: GameLaneContract = {
  planKey: "arknightsPlan",
  actionKey: "arknights",
  afterRunAction: "closeArknights",
  dailySlots: ["primary", "secondary"],
  enabled: (lane) => lane.arknights.enabled,
  setEnabled: (lane, enabled) => ({
    ...lane,
    arknights: { ...lane.arknights, enabled },
  }),
  savedRoutine: (lane) => lane.arknights.routine,
  withRoutine: (lane, routine) => ({
    ...lane,
    arknights: { ...lane.arknights, routine },
  }),
  compileDaily(lane, profile, now) {
    if (!profile) throw Error(`${lane.name} 的明日方舟账号档案不存在`);
    const plan = compileDailyPlan(
      "arknights",
      lane.arknights.routine,
      arknightsDailySkills(profile),
      now,
    );
    return {
      plan,
      profile: structuredClone({
        ...profile,
        ...arknightsConfigForPlan(profile, plan),
      }),
    };
  },
  freezeSelection: (lane, plan) => ({
    ...lane,
    arknights: {
      ...lane.arknights,
      enabled: true,
      routine: {
        version: 1,
        steps: plan.skillIds.map((skillId) => ({ skillId, enabled: true })),
      },
    },
  }),
  assertBinding(alias, lane, profile, index) {
    if (
      !alias.arknights.enabled ||
      !lane.arknights.enabled ||
      !profile ||
      alias.arknights.profileId !== `profile-${index + 1}` ||
      lane.arknights.profileId !== profile.id
    )
      throw new AgentToolError(
        "ENVIRONMENT_CHANGED",
        "明日方舟启用状态或账号绑定已变化，请重新规划",
      );
  },
};
