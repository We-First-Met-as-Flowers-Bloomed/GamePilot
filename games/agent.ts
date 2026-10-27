import type { DeviceLane } from "../packages/protocol";
import {
  AgentToolError,
  type GameDraftInput,
  type CompiledGameDraft,
} from "../packages/protocol/agent";
import type { ArknightsProfile } from "./arknights/config";
import { taskFor } from "./arknights/config";
import { ArknightsCapabilityError } from "./arknights/capabilities";
import {
  arknightsConfigForPlan,
  arknightsDailySkills,
} from "./arknights/daily-plan";
import { isGuildKirinWindow } from "./onmyoji/policy";
import { games, dailySkills, gamePlugins } from "./registry";
import { compileDailyPlan } from "./routines";
import type { TrustedGameRegistry } from "./plugin";
import { plannerAwardLabels } from "./arknights/award-flags";
import { agentArknightsConfig } from "./agent-configuration";
import {
  compiledCapabilityEffects,
  gameCapabilityDescriptors,
  validateCapabilityParameters,
} from "./agent-skills";

export function gameAgentCatalog() {
  return gameCapabilityDescriptors();
}

export function validateGameOrder(
  inputs: GameDraftInput[],
  registry: TrustedGameRegistry = gamePlugins,
) {
  if (
    inputs.some(
      (g) => !registry.descriptors().some((game) => game.id === g.gameId),
    )
  )
    throw new AgentToolError("UNSUPPORTED_GAME", "未知游戏");
  if (
    inputs.some(
      (input, index) =>
        index > 0 &&
        registry.get(inputs[index - 1].gameId).order >=
          registry.get(input.gameId).order,
    )
  )
    throw new AgentToolError(
      "INVALID_ORDER",
      "游戏计划必须遵循已注册插件顺序，不能重复游戏",
    );
}

/** Pure compilation. Never imports an engine or loads native resources. */
export function compileGameDraft(
  input: GameDraftInput,
  lane: DeviceLane,
  profile: ArknightsProfile | undefined,
  at: string,
): CompiledGameDraft {
  if (!games.some((game) => game.id === input.gameId))
    throw new AgentToolError("UNSUPPORTED_GAME", "未知游戏");
  return gamePlugins.get(input.gameId).compile(input, lane, profile, at);
}

export function compileBuiltinGameDraft(
  input: GameDraftInput,
  lane: DeviceLane,
  profile: ArknightsProfile | undefined,
  at: string,
): CompiledGameDraft {
  const game = games.find((g) => g.id === input.gameId);
  if (!game) throw new AgentToolError("UNSUPPORTED_GAME", "未知游戏");
  const available = dailySkills(game.id);
  const params = validateCapabilityParameters(game.id, input.parameters ?? {});
  const saved =
    game.id === "arknights" ? lane.arknights.routine : lane.onmyoji.routine;
  const routine = input.skillIds
    ? {
        version: 1 as const,
        steps: input.skillIds.map((skillId) => ({ skillId, enabled: true })),
      }
    : saved;
  for (const id of input.skillIds ??
    routine?.steps.filter((s) => s.enabled).map((s) => s.skillId) ??
    [])
    if (!available.includes(id))
      throw new AgentToolError(
        "UNSUPPORTED_SKILL",
        "该技能不在首版日常草稿范围",
      );
  const now = new Date(at);
  const effective = profile
    ? {
        ...agentArknightsConfig(profile),
        ...(params.stage === undefined
          ? {}
          : { stage: params.stage as string }),
        ...(params.mail === undefined ? {} : { mail: params.mail as boolean }),
        ...Object.fromEntries(
          ["taskAward", "creditShopping", ...Object.keys(plannerAwardLabels)]
            .filter((key) => params[key] !== undefined)
            .map((key) => [key, params[key]]),
        ),
      }
    : undefined;
  const defaults =
    game.id === "arknights" && effective
      ? arknightsDailySkills(effective)
      : available;
  const requested =
    routine?.steps.filter((s) => s.enabled).map((s) => s.skillId) ?? defaults;
  const plan = compileDailyPlan(game.id, routine, defaults, now);
  if (game.id === "onmyoji" && !isGuildKirinWindow(now))
    plan.skillIds = plan.skillIds.filter((id) => id !== "guild-kirin");
  const excluded = requested.filter((id) => !plan.skillIds.includes(id));
  const notes = excluded.length
    ? [
        `以下任务不在指定日期/时间的开放范围，已从草稿排除：${excluded.map((id) => game.skills.find((skill) => skill.id === id)?.title ?? id).join("、")}`,
      ]
    : [];
  if (game.id === "arknights") {
    if (!effective)
      throw new AgentToolError("MISSING_PROFILE", "明日方舟账号档案不存在");
    if (plan.skillIds.includes("fight") && !effective.stage)
      throw new AgentToolError(
        "MISSING_CONFIGURATION",
        "理智作战缺少关卡，请填写关卡或关闭该任务",
      );
    let config;
    try {
      config = arknightsConfigForPlan(effective, plan);
    } catch (error) {
      if (error instanceof ArknightsCapabilityError)
        throw new AgentToolError("UNSUPPORTED_CAPABILITY", error.message);
      throw error;
    }
    if (params.stage !== undefined && !plan.skillIds.includes("fight"))
      throw new AgentToolError(
        "UNUSED_PARAMETER",
        "指定了关卡但未启用理智作战",
      );
    if (params.mail !== undefined && !plan.skillIds.includes("award"))
      throw new AgentToolError(
        "UNUSED_PARAMETER",
        "领取邮件需要启用任务奖励技能",
      );
    if (
      ["taskAward", ...Object.keys(plannerAwardLabels)].some(
        (key) => params[key] !== undefined,
      ) &&
      !plan.skillIds.includes("award")
    )
      throw new AgentToolError(
        "UNUSED_PARAMETER",
        "奖励动作开关需要启用任务奖励技能",
      );
    if (
      params.creditShopping !== undefined &&
      !plan.skillIds.includes("friends")
    )
      throw new AgentToolError(
        "UNUSED_PARAMETER",
        "信用购物开关需要启用好友信用技能",
      );
    // Read limits from the same native mapper as the real executor.
    const fight = taskFor("fight", { ...config, stage: config.stage || "LS-6" })
      .params as Record<string, unknown>;
    const parameters = {
      stage: plan.skillIds.includes("fight") ? config.stage : "",
      mail: plan.skillIds.includes("award") && config.mail,
      taskAward: plan.skillIds.includes("award") && (config.taskAward ?? true),
      medicine: fight.medicine,
      stone: fight.stone,
      expiringMedicine: fight.expiring_medicine,
      clientType: config.clientType,
      maxRunMinutes: config.maxRunMinutes,
      ...Object.fromEntries(
        Object.keys(plannerAwardLabels).map((key) => [
          key,
          plan.skillIds.includes("award") &&
            config[key as keyof typeof plannerAwardLabels],
        ]),
      ),
      creditShopping:
        plan.skillIds.includes("friends") && config.creditShopping,
    };
    return {
      plan,
      parameters,
      effects: compiledCapabilityEffects(game.id, plan.skillIds, parameters),
      excluded,
      notes: [
        ...notes,
        ...(plan.skillIds.includes("award") &&
        Object.keys(plannerAwardLabels).some(
          (key) => config[key as keyof typeof plannerAwardLabels],
        )
          ? [
              `按保存配置附带：${Object.entries(plannerAwardLabels)
                .filter(
                  ([key]) => config[key as keyof typeof plannerAwardLabels],
                )
                .map(([, label]) => label)
                .join("、")}；各附带动作可用对应参数独立关闭`,
            ]
          : []),
        ...(plan.skillIds.includes("award")
          ? [
              config.taskAward !== false
                ? config.mail
                  ? "本次同时领取邮件与每日和每周任务奖励；只领邮件可关闭taskAward和所有其他附带动作"
                  : "本次领取每日和每周任务奖励；本次不领取邮件"
                : config.mail
                  ? "本次只领取邮件及清单中明确启用的附带动作；任务奖励已关闭"
                  : "本次任务奖励和邮件均已关闭",
            ]
          : []),
        "需要检查账号UID、关卡开放和代理状态；未启动游戏",
      ],
    };
  }
  return {
    plan,
    parameters: {},
    effects: compiledCapabilityEffects(game.id, plan.skillIds, {}),
    excluded,
    notes: [
      ...notes,
      "执行前需核对当前角色、今日完成记录和寄养到期；未启动游戏",
    ],
  };
}
