import {
  defaultArknightsConfig,
  type ArknightsProfile,
  type ArknightsConfig,
} from "./arknights/config";
import { validateRoutine, type Routine } from "../packages/protocol/routine";
import { games, dailySkills } from "./registry";
import { arknightsDailySkills } from "./arknights/daily-plan";

export function plannerDefaultSkills(
  gameId: string,
  profile?: ArknightsConfig,
) {
  return gameId === "arknights" && profile
    ? arknightsDailySkills(profile)
    : dailySkills(gameId);
}

/** The AI contract only reviews the six daily defaults and zero supplies.
 * Saved typed options belong to the explicit settings/job review flow, not this contract. */
export function agentArknightsConfig<T extends ArknightsConfig>(profile: T): T {
  const safe = structuredClone(profile);
  for (const key of ["taskOptions", "extendedOptions", "copilotOptions"])
    Reflect.deleteProperty(safe, key);
  return safe;
}

/** Explicit game-data allowlist. Never carry account text or local job paths. */
export function plannerProfile(
  p: ArknightsProfile,
  id: string,
): ArknightsProfile {
  return {
    ...defaultArknightsConfig,
    id,
    name: id,
    ...plannerSettings(p),
  };
}
export function plannerSettings(p: ArknightsConfig) {
  return {
    clientType: p.clientType,
    stage: p.stage,
    mail: p.mail,
    taskAward: p.taskAward ?? true,
    recruit: p.recruit,
    creditShopping: p.creditShopping,
    freeRecruit: p.freeRecruit,
    eventOrundum: p.eventOrundum,
    eventMining: p.eventMining,
    specialAccess: p.specialAccess,
    signInEvent: p.signInEvent,
    maxRunMinutes: p.maxRunMinutes,
  };
}
export { plannerAwardLabels } from "./arknights/award-flags";
export function plannerRoutine(value: Routine | undefined, gameId: string) {
  return value === undefined
    ? undefined
    : validateRoutine(
        value,
        games.find((g) => g.id === gameId)!,
      );
}
