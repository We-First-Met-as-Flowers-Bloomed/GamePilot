import type { GameLaneContract } from "../plugin";
import { compileDailyPlan } from "../routines";
import { AgentToolError } from "../../packages/protocol/agent";
import {
  sameOnmyojiIdentity,
  plannerOnmyojiIdentity,
  validateOnmyojiIdentityBinding,
} from "../../packages/protocol/onmyoji-identity";

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
      ...(lane.onmyoji.identity
        ? { identity: validateOnmyojiIdentityBinding(lane.onmyoji.identity) }
        : {}),
      enabled: true,
      routine: {
        version: 1,
        steps: plan.skillIds.map((skillId) => ({ skillId, enabled: true })),
      },
    },
  }),
  assertBinding(alias, lane) {
    if (
      !sameOnmyojiIdentity(alias.onmyoji.identity, lane.onmyoji.identity) &&
      !sameOnmyojiIdentity(alias.onmyoji.identity, plannerOnmyojiIdentity(lane.onmyoji.identity))
    )
      throw new AgentToolError(
        "ENVIRONMENT_CHANGED",
        "阴阳师身份绑定已变化，请重新规划",
      );
    if (!alias.onmyoji.enabled || !lane.onmyoji.enabled)
      throw new AgentToolError(
        "ENVIRONMENT_CHANGED",
        "阴阳师启用状态已变化，请重新规划",
      );
  },
};
