import { validatePlan, type Plan } from "../packages/protocol";
import {
  validateRoutine,
  beijingWeekday,
  type Routine,
} from "../packages/protocol/routine";
import { games, dailySkills } from "./registry";

export function defaultRoutine(
  gameId: string,
  defaults = dailySkills(gameId),
): Routine {
  const game = games.find((g) => g.id === gameId);
  if (!game) throw Error("未知游戏");
  return validateRoutine(
    {
      version: 1,
      steps: defaults.map((skillId) => ({ skillId, enabled: true })),
    },
    game,
  );
}

/** Compiles saved/user/AI-authored data to the same whitelisted worker Plan. */
export function compileDailyPlan(
  gameId: string,
  input?: Routine,
  defaults?: string[],
  now = new Date(),
): Plan {
  const game = games.find((g) => g.id === gameId);
  if (!game) throw Error("未知游戏");
  const routine = validateRoutine(
    input ?? defaultRoutine(gameId, defaults),
    game,
  );
  const day = beijingWeekday(now);
  const ids = routine.steps
    .filter(
      (s) =>
        s.enabled &&
        !game.skills.find((skill) => skill.id === s.skillId)?.maintenanceOnly &&
        (!s.weekdays || s.weekdays.includes(day)) &&
        (!game.skills.find((skill) => skill.id === s.skillId)?.weekdays ||
          game.skills
            .find((skill) => skill.id === s.skillId)!
            .weekdays!.includes(day)),
    )
    .map((s) => s.skillId);
  const first = game.skills
    .filter((s) => s.position === "first")
    .map((s) => s.id);
  const last = game.skills
    .filter((s) => s.position === "last" && ids.includes(s.id))
    .map((s) => s.id);
  const skillIds = [
    ...first,
    ...ids.filter((id) => !first.includes(id) && !last.includes(id)),
    ...last,
  ];
  return validatePlan({ gameId, skillIds, mode: "live" }, games);
}

export function routineIncludes(
  gameId: string,
  input: Routine | undefined,
  skillId: string,
  now = new Date(),
) {
  return compileDailyPlan(gameId, input, undefined, now).skillIds.includes(
    skillId,
  );
}
