import { validatePlan, type DeviceLane, type Plan } from "../packages/protocol";
import {
  AgentToolError,
  type CompiledGameDraft,
} from "../packages/protocol/agent";
import { canonical } from "../packages/acceptance/files";
import type { ArknightsProfile } from "./arknights/config";
import { arknightsConfigForPlan } from "./arknights/daily-plan";
import { compileGameDraft } from "./agent";
import { games, gamePlugins } from "./registry";
import { historyPlan } from "./agent-history";
import { plannerAwardLabels } from "./arknights/award-flags";
import { agentArknightsConfig } from "./agent-configuration";

export function agentExecutionGameDay(
  at: string | Date,
  gameId = "arknights",
): string {
  return gamePlugins.get(gameId).gameDay(new Date(at));
}

/** Rebuild the actual executor configuration from the reviewed game semantics. */
export function prepareAgentGame(
  draft: CompiledGameDraft,
  lane: DeviceLane,
  profile: ArknightsProfile | undefined,
  at: string,
): { plan: Plan; profile?: ArknightsProfile } {
  let plan: Plan;
  try {
    plan = validatePlan(draft.plan, games);
  } catch {
    throw new AgentToolError(
      "INVALID_EXECUTION_PLAN",
      "草稿包含无效或尚未适配的技能",
    );
  }
  if (plan.mode !== "live" || plan.skillIds[0] !== "login")
    throw new AgentToolError(
      "LOGIN_REQUIRED",
      "确认执行必须使用实机计划，且账号登录核验必须位于首步",
    );
  if (plan.gameId === "arknights" && !profile?.expectedUid.trim())
    throw new AgentToolError(
      "UID_REQUIRED",
      "请先为本地账号绑定 UID，再检查执行条件",
    );
  const overrides =
    plan.gameId === "arknights"
      ? {
          ...(plan.skillIds.includes("fight")
            ? { stage: draft.parameters.stage }
            : {}),
          ...(plan.skillIds.includes("award")
            ? Object.fromEntries(
                ["mail", "taskAward", ...Object.keys(plannerAwardLabels)].map(
                  (key) => [key, draft.parameters[key]],
                ),
              )
            : {}),
          ...(plan.skillIds.includes("friends")
            ? { creditShopping: draft.parameters.creditShopping }
            : {}),
          medicine: 0,
          stone: 0,
          expiringMedicine: 0,
        }
      : {};
  const rebuilt = compileGameDraft(
    {
      gameId: plan.gameId,
      skillIds: [...plan.skillIds, ...draft.excluded],
      parameters: overrides,
    },
    lane,
    profile,
    at,
  );
  if (
    canonical(rebuilt.plan) !== canonical(draft.plan) ||
    canonical(rebuilt.parameters) !== canonical(draft.parameters) ||
    canonical(rebuilt.effects) !== canonical(draft.effects) ||
    canonical(rebuilt.excluded) !== canonical(draft.excluded)
  )
    throw new AgentToolError(
      "DRAFT_CHANGED",
      "草稿技能或完整参数与当前账号配置不符，请重新规划",
    );
  if (plan.gameId !== "arknights") return { plan };
  const effective = {
    ...agentArknightsConfig(profile!),
    ...(plan.skillIds.includes("fight")
      ? { stage: draft.parameters.stage as string }
      : {}),
    ...(plan.skillIds.includes("award")
      ? Object.fromEntries(
          ["mail", "taskAward", ...Object.keys(plannerAwardLabels)].map(
            (key) => [key, draft.parameters[key]],
          ),
        )
      : {}),
    ...(plan.skillIds.includes("friends")
      ? { creditShopping: draft.parameters.creditShopping as boolean }
      : {}),
  } as ArknightsProfile;
  return {
    plan,
    profile: { ...effective, ...arknightsConfigForPlan(effective, plan) },
  };
}

export function hasAgentNonLoginSkills(plan: Plan): boolean {
  return plan.skillIds.some((id) => id !== "login");
}

/** Unknown plans are not evidence that an action is safe to repeat. */
export function agentHistoryOverlaps(target: Plan, raw: unknown): boolean {
  try {
    const previous = historyPlan(raw);
    return (
      previous.mode === "live" &&
      previous.gameId === target.gameId &&
      previous.skillIds.some(
        (id) => id !== "login" && target.skillIds.includes(id),
      )
    );
  } catch {
    return true;
  }
}

export function agentHistoryTouchesDay(
  start: string,
  end: string | undefined,
  now: Date,
  gameId = "arknights",
): boolean {
  if (
    !Number.isFinite(Date.parse(start)) ||
    end === undefined ||
    !Number.isFinite(Date.parse(end))
  )
    return true;
  const key = (at: string | Date) => agentExecutionGameDay(at, gameId);
  const day = key(now);
  const first = key(start);
  const last = key(end);
  return first > last || (first <= day && day <= last);
}
