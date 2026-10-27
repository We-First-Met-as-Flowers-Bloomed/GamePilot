import type { DeviceLane } from "./index";
import {
  validateAutomation,
  type AutomationConfig,
  type AutomationJob,
  type RunAutomationJobInput,
} from "./automation";

export const ARKNIGHTS_DAILY_SKILLS = [
  "login",
  "recruit",
  "fight",
  "infrastructure",
  "friends",
  "award",
] as const;
export const ARKNIGHTS_AUTOMATION_SKILLS = [
  ...ARKNIGHTS_DAILY_SKILLS,
  "depot",
  "operator-box",
  "recruit-recognition",
  "copilot",
  "roguelike",
  "reclamation",
  "sss-copilot",
  "paradox-copilot",
  "switch-theme",
  "video-recognition",
  "activity-game",
  "operator-progress",
] as const;
export type ArknightsAutomationSkill =
  (typeof ARKNIGHTS_AUTOMATION_SKILLS)[number];
export type ArknightsJob = AutomationJob<ArknightsAutomationSkill>;
export type ArknightsAutomationConfig =
  AutomationConfig<ArknightsAutomationSkill>;
export type RunArknightsJobInput = RunAutomationJobInput;
export function validateArknightsAutomation(
  input: unknown,
): ArknightsAutomationConfig {
  return validateAutomation(input, ARKNIGHTS_AUTOMATION_SKILLS);
}

/** Produces an inert proposal. Migration or the user must explicitly enable it. */
export function defaultArknightsAutomation(
  lanes: DeviceLane[],
): ArknightsAutomationConfig {
  return validateArknightsAutomation({
    version: 1,
    enabled: false,
    jobs: lanes
      .filter((lane) => lane.enabled && lane.arknights.enabled)
      .flatMap((lane, index) =>
        (["08:00", "20:00"] as const).map((time, slot) => ({
          id: `ark-${index + 1}-${slot === 0 ? "am" : "pm"}`,
          name: `${lane.name.slice(0, 40)} ${slot === 0 ? "早间" : "晚间"}`,
          laneId: lane.id,
          enabled: true,
          time,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          skillIds: ARKNIGHTS_DAILY_SKILLS.filter(
            (id) => slot === 0 || id !== "friends",
          ),
          catchUp: true,
        })),
      ),
  });
}
