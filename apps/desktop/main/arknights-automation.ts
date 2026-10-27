import {
  validateArknightsAutomation,
  type ArknightsAutomationConfig,
  type ArknightsAutomationSkill,
} from "../../../packages/protocol/arknights-automation";
import {
  AutomationService,
  AutomationStore,
  type AutomationOptions,
} from "./game-automation";
export type {
  AutomationOutcome as ArknightsAutomationOutcome,
  AutomationRun as ArknightsAutomationRun,
  AutomationAdmission as ArknightsAutomationAdmission,
} from "./game-automation";
export type ArknightsAutomationDocument =
  import("./game-automation").AutomationDocument<ArknightsAutomationSkill>;
export type ArknightsAutomationLedger =
  import("./game-automation").AutomationLedger<ArknightsAutomationSkill>;
export type ArknightsAutomationOptions =
  AutomationOptions<ArknightsAutomationSkill>;
const spec = {
  namespace: "ark" as const,
  validate: validateArknightsAutomation,
};
/** Compatibility preserves the original ledger path and durable request identifiers. */
export class ArknightsAutomationStore extends AutomationStore<ArknightsAutomationSkill> {
  constructor(
    file: string,
    defaults: ArknightsAutomationConfig = {
      version: 1,
      enabled: false,
      jobs: [],
    },
  ) {
    super(file, defaults, spec);
  }
}
export class ArknightsAutomationService extends AutomationService<ArknightsAutomationSkill> {
  constructor(options: ArknightsAutomationOptions) {
    super(options, spec);
  }
}
