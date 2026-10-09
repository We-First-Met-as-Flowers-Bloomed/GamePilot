import type { Plan } from "../packages/protocol";

const onmyojiMinutes: Record<string, number> = {
  login: 5,
  "check-in": 5,
  mail: 3,
  "daily-gift": 4,
  "guild-quest": 8,
  foster: 30,
  "guild-kirin": 15,
  "realm-raid": 20,
  "hana-claim": 5,
};

/** Finite deadlines, not an activity heartbeat. Native logs cannot extend them. */
export function executionBudget(plan?: Plan) {
  if (
    plan?.gameId !== "onmyoji" ||
    plan.mode !== "live" ||
    !Array.isArray(plan.skillIds) ||
    !plan.skillIds.length ||
    new Set(plan.skillIds).size !== plan.skillIds.length ||
    plan.skillIds.some((id) => !Object.hasOwn(onmyojiMinutes, id))
  )
    return undefined;
  const steps = Object.fromEntries(
    plan.skillIds.map((id) => [id, onmyojiMinutes[id] * 60_000]),
  );
  return {
    steps,
    totalMs: Object.values(steps).reduce((sum, n) => sum + n, 60_000),
  };
}
