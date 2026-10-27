import type { ArknightsAutomationSkill } from "../../../packages/protocol/arknights-automation";
import {
  createAutomationRun,
  type AutomationHost,
} from "./game-automation-host";
export type ArknightsAutomationHost = AutomationHost<ArknightsAutomationSkill>;
export function createArknightsAutomationRun(host: ArknightsAutomationHost) {
  return createAutomationRun(host, "arknights");
}
