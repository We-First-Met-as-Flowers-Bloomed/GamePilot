import {
  taskFor,
  validateArknightsConfig,
  type ArknightsConfig,
  type ArknightsProfile,
} from "./config";
import type { Plan } from "../../packages/protocol";

/** Routine selection owns task switches; resource limits still come from the profile. */
export function arknightsConfigForPlan(
  config: ArknightsConfig,
  plan: Plan,
): ArknightsConfig {
  if (plan.gameId !== "arknights") throw Error("方舟配置不能用于其他游戏");
  // Stored profiles also carry UI identity. Strict task validation must receive
  // only task settings while still rejecting other unexpected fields.
  const {
    id: _id,
    name: _name,
    ...settings
  } = config as ArknightsConfig &
    Partial<Pick<ArknightsProfile, "id" | "name">>;
  const effective = validateArknightsConfig({
    ...settings,
    recruit: plan.skillIds.includes("recruit"),
  });
  for (const id of plan.skillIds) taskFor(id, effective);
  return effective;
}
export function arknightsDailySkills(config: ArknightsConfig): string[] {
  return [
    "login",
    ...(config.recruit ? ["recruit"] : []),
    ...(config.stage ? ["fight"] : []),
    "infrastructure",
    "friends",
    "award",
  ];
}
