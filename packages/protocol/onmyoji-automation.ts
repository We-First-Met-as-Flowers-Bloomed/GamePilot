import type { DeviceLane } from "./index";
import {
  validateAutomation,
  type AutomationConfig,
  type AutomationJob,
  type RunAutomationJobInput,
} from "./automation";

export const ONMYOJI_DAILY_SKILLS = [
  "login",
  "check-in",
  "mail",
  "daily-gift",
  "guild-kirin",
  "realm-raid",
  "hana-claim",
] as const;
// Foster is a maintenance process with a separate lifecycle, not a scheduled daily step.
export const ONMYOJI_AUTOMATION_SKILLS = [
  ...ONMYOJI_DAILY_SKILLS,
  "guild-quest",
  "oboroguruma",
] as const;
export type OnmyojiAutomationSkill = (typeof ONMYOJI_AUTOMATION_SKILLS)[number];
export type OnmyojiJob = AutomationJob<OnmyojiAutomationSkill>;
export type OnmyojiAutomationConfig = AutomationConfig<OnmyojiAutomationSkill>;
export type RunOnmyojiJobInput = RunAutomationJobInput;
export function validateOnmyojiAutomation(
  input: unknown,
): OnmyojiAutomationConfig {
  return validateAutomation(input, ONMYOJI_AUTOMATION_SKILLS);
}
/** Proposal only; installing/upgrading the App does not authorize a new daily run. */
export function defaultOnmyojiAutomation(
  lanes: DeviceLane[],
): OnmyojiAutomationConfig {
  return validateOnmyojiAutomation({
    version: 1,
    enabled: false,
    jobs: lanes
      .filter((lane) => lane.enabled && lane.onmyoji.enabled)
      .flatMap((lane, index) =>
        ["09:00", "20:30"].map((time, slot) => ({
          id: `yys-${index + 1}-${slot === 0 ? "am" : "pm"}`,
          name: `${lane.name.slice(0, 40)} ${slot === 0 ? "早间" : "晚间"}`,
          laneId: lane.id,
          enabled: true,
          time,
          weekdays: slot === 0 ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4],
          skillIds:
            slot === 0
              ? [...ONMYOJI_DAILY_SKILLS]
              : ["login", "guild-kirin", "hana-claim"],
          catchUp: true,
        })),
      ),
  });
}
