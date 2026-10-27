import type { DesktopAPI } from "../../../../packages/protocol";
import {
  createGameAutomationController,
  useGameAutomation,
} from "./useGameAutomation";
export function createArknightsAutomationController(
  api: DesktopAPI | undefined,
) {
  return createGameAutomationController(api, "arknights");
}
export function useArknightsAutomation(api: DesktopAPI | undefined) {
  return useGameAutomation(api, "arknights");
}
export type ArknightsAutomationController = ReturnType<
  typeof useArknightsAutomation
>;
