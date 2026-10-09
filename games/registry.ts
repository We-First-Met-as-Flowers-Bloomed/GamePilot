import { onmyoji } from "./onmyoji";
import { arknights } from "./arknights";
import {
  createTrustedGameRegistry,
  runPluginSkill,
  validatePluginPlan,
  type GamePlugin,
} from "./plugin";
import { compileBuiltinGameDraft } from "./agent";
import { builtinGameCapabilityDescriptors } from "./agent-skills";
import { arknightsGameDay } from "./arknights/result-policy";
import { gameDay as onmyojiGameDay } from "./onmyoji/policy";
import { evaluateGameSkillOutcome } from "./goal-outcome";
import {
  allowIncidentRetry,
  proposeIncidentRecovery,
  recognizeIncidentScreen,
  incidentReplayBlockers,
  retainedIncidentNativeStep,
} from "./agent-recovery";
import { onmyojiRecovery } from "./onmyoji/recovery";
import { arknightsLaneContract } from "./arknights/lane-plugin";
import { onmyojiLaneContract } from "./onmyoji/lane-plugin";

const builtin = (
  descriptor: GamePlugin["descriptor"],
  adapterId: string,
  order: number,
  skills: string[],
  gameDay: GamePlugin["gameDay"],
  lane: GamePlugin["lane"],
  recovery: GamePlugin["recovery"],
): GamePlugin => ({
  descriptor,
  adapterId,
  order,
  dailySkills: Object.freeze(skills),
  gameDay,
  lane,
  compile: compileBuiltinGameDraft,
  capabilities: () =>
    builtinGameCapabilityDescriptors().find(
      (game) => game.id === descriptor.id,
    )!,
  validate: validatePluginPlan,
  run: runPluginSkill,
  outcome: (step, snapshot) =>
    evaluateGameSkillOutcome(descriptor.id, step, snapshot),
  recovery,
});
export const gamePlugins = createTrustedGameRegistry([
  builtin(
    onmyoji,
    "maaframework",
    2,
    [
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "guild-quest",
      "guild-kirin",
      "realm-raid",
      "hana-claim",
    ],
    onmyojiGameDay,
    onmyojiLaneContract,
    onmyojiRecovery,
  ),
  builtin(
    arknights,
    "maacore",
    1,
    ["login", "recruit", "fight", "infrastructure", "friends", "award"],
    arknightsGameDay,
    arknightsLaneContract,
    {
      classify: (frame) => recognizeIncidentScreen(frame, "arknights"),
      replayBlockers: incidentReplayBlockers,
      retainedStep: retainedIncidentNativeStep,
      allowRetry: allowIncidentRetry,
      propose: proposeIncidentRecovery,
    },
  ),
]);
export const games = gamePlugins.descriptors();
export function dailySkills(gameId: string): string[] {
  return [...gamePlugins.get(gameId).dailySkills];
}
