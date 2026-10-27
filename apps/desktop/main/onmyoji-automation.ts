import type { DeviceLane } from "../../../packages/protocol";
import type { ArknightsProfiles } from "../../../games/arknights/config";
import {
  validateOnmyojiAutomation,
  type OnmyojiAutomationConfig,
  type OnmyojiAutomationSkill,
  type OnmyojiJob,
} from "../../../packages/protocol/onmyoji-automation";
import {
  AutomationService,
  AutomationStore,
  type AutomationOptions,
} from "./game-automation";
import { freezeLaneExecutionForGame } from "./lane-snapshot";

const spec = {
  namespace: "yys" as const,
  skipPastOnFirstEnable: true,
  validate: validateOnmyojiAutomation,
};
export class OnmyojiAutomationStore extends AutomationStore<OnmyojiAutomationSkill> {
  constructor(
    file: string,
    defaults: OnmyojiAutomationConfig = {
      version: 1,
      enabled: false,
      jobs: [],
    },
  ) {
    super(file, defaults, spec);
  }
}
export class OnmyojiAutomationService extends AutomationService<OnmyojiAutomationSkill> {
  constructor(options: AutomationOptions<OnmyojiAutomationSkill>) {
    super(options, spec);
  }
}
export function freezeOnmyojiJob(
  lane: DeviceLane,
  profiles: ArknightsProfiles,
  input: OnmyojiJob,
  now = new Date(),
) {
  const job = validateOnmyojiAutomation({
    version: 1,
    enabled: true,
    jobs: [input],
  }).jobs[0];
  if (job.laneId !== lane.id || !lane.enabled || !lane.onmyoji.enabled)
    throw Error("计划绑定的阴阳师账号渠道未启用或不存在");
  const selected = structuredClone(lane);
  selected.onmyoji.routine = {
    version: 1,
    steps: job.skillIds.map((skillId) => ({ skillId, enabled: true })),
  };
  // Primary selects the daily planner; the job's explicit steps carry evening semantics.
  const snapshot = freezeLaneExecutionForGame(
    selected,
    profiles,
    "onmyoji",
    false,
    now,
    "primary",
  );
  if (!snapshot?.onmyojiPlan) throw Error("阴阳师计划没有可执行步骤");
  return snapshot;
}
