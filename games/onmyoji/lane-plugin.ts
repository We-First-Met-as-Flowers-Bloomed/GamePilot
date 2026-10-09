import type { GameLaneContract } from "../plugin";
import { compileDailyPlan } from "../routines";
import { AgentToolError } from "../../packages/protocol/agent";

export const onmyojiLaneContract: GameLaneContract = {
  planKey: "onmyojiPlan",
  actionKey: "onmyoji",
  dailySlots: ["primary"],
  maintenancePlan: {
    gameId: "onmyoji",
    skillIds: ["login", "foster"],
    mode: "live",
  },
  enabled: (lane) => lane.onmyoji.enabled,
  setEnabled: (lane, enabled) => ({
    ...lane,
    onmyoji: { ...lane.onmyoji, enabled },
  }),
  savedRoutine: (lane) => lane.onmyoji.routine,
  withRoutine: (lane, routine) => ({
    ...lane,
    onmyoji: { ...lane.onmyoji, routine },
  }),
  compileDaily: (lane, _profile, now) => ({
    plan: compileDailyPlan("onmyoji", lane.onmyoji.routine, undefined, now),
  }),
  freezeSelection: (lane, plan) => ({
    ...lane,
    onmyoji: {
      ...lane.onmyoji,
      enabled: true,
      routine: {
        version: 1,
        steps: plan.skillIds.map((skillId) => ({ skillId, enabled: true })),
      },
    },
  }),
  assertBinding(alias, lane) {
    if (!alias.onmyoji.enabled || !lane.onmyoji.enabled)
      throw new AgentToolError(
        "ENVIRONMENT_CHANGED",
        "阴阳师启用状态已变化，请重新规划",
      );
  },
};
