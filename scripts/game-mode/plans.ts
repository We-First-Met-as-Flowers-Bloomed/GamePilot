/**
 * 游戏模式：每个游戏的"全流程日常"计划（真实玩家视角）。
 *
 * 这里描述的是**玩家每天应该完成什么**，而不是"App 目前能跑什么"：
 *  - `required` 区分"不做就亏"和"看情况做"；
 *  - `when` 描述开放条件（工作日/周末/常驻），由技能自己再确认一次；
 *  - `expect` 是验收点，供日报与人工核对；
 *  - `guide` 指向 docs/game-guides 里对应的操作/救援说明。
 *
 * 计划是数据，不是逻辑：改计划不会碰到已经冻结的方舟实现，也不会绕过任何安全闸门
 * （所有步骤仍然通过各游戏自己的技能实现执行）。
 */
export type GameId = "onmyoji" | "arknights";

export interface GameModeStep {
  /** 步骤 id，等于技能 id（方舟/阴阳师的技能表）。 */
  skill: string;
  label: string;
  /** 必做：没完成就算当天欠账。 */
  required: boolean;
  /** 开放条件；技能内部还会再确认一次。 */
  when: "always" | "workday" | "weekend";
  /** 验收点：人可读的"怎么算完成"。 */
  expect: string;
  /** 攻略/救援说明的锚点（docs/game-guides/<game>.md#<guide>）。 */
  guide: string;
  /** 维护类步骤（不受日常同日门禁约束，按自己的周期跑）。 */
  maintenance?: boolean;
  /**
   * 2026-10-25：每天只需做一次的动作（签到/邮件/免费礼包/花合战/上号）。
   * 同日重复运行时，若当天已有 succeeded 记录则直接跳过、不重放；避免"已领过"被技能判成 unknown。
   */
  oncePerDay?: boolean;
}

export interface GameModePlan {
  game: GameId;
  title: string;
  /** 该游戏技能表里可作为步骤的技能全集，用于校验计划没写错名字。 */
  knownSkills: readonly string[];
  steps: readonly GameModeStep[];
}

export const onmyojiMode: GameModePlan = {
  game: "onmyoji",
  title: "阴阳师 · 每日全流程",
  knownSkills: [
    "login",
    "check-in",
    "mail",
    "daily-gift",
    "guild-kirin",
    "realm-raid",
    "hana-claim",
    "foster",
    "guild-quest",
    "oboroguruma",
    "battle-current",
  ],
  steps: [
    {
      skill: "login",
      label: "上号",
      required: true,
      when: "always",
      oncePerDay: true,
      expect: "两帧核对已进入游戏（庭院）",
      guide: "login",
    },
    {
      skill: "check-in",
      label: "庭院事务签到",
      required: true,
      when: "always",
      oncePerDay: true,
      expect: "一键事务已执行且每日一签显示已完成",
      guide: "check-in",
    },
    {
      skill: "mail",
      label: "邮件附件",
      required: true,
      when: "always",
      oncePerDay: true,
      expect: "附件已领取且邮箱无待领取项（只点一键领取）",
      guide: "mail",
    },
    {
      skill: "daily-gift",
      label: "每日免费礼包",
      required: true,
      when: "always",
      oncePerDay: true,
      expect: "礼包屋日常页的免费礼包已领取，入口消失；付费卡一张都不点",
      guide: "daily-gift",
    },
    {
      skill: "guild-kirin",
      label: "阴阳寮麒麟",
      required: false,
      when: "always",
      expect: "当日可挑战时打完并确认伤害结算；不可挑战时算跳过",
      guide: "guild-kirin",
    },
    {
      skill: "realm-raid",
      label: "地域鬼王",
      required: true,
      when: "always",
      // 2026-10-25：当日次数用完后再次进入会让技能报 unknown（"进入地域鬼王失败"），
      // 因此按"每天只跑一遍"处理；同日重跑直接跳过，避免把已完成的日常判成失败。
      oncePerDay: true,
      expect: "按双帧声望配额核对当天不同鬼王通关成绩（1/1、2/2 或 3/3），不改玩家等级设置",
      guide: "realm-raid",
    },
    {
      skill: "hana-claim",
      label: "花合战领奖",
      required: true,
      when: "always",
      oncePerDay: true,
      expect: "花合战任务页无待领取奖励，并返回庭院",
      guide: "hana-claim",
    },
  ],
};

export const arknightsMode: GameModePlan = {
  game: "arknights",
  title: "明日方舟 · 每日全流程（已冻结）",
  knownSkills: [
    "login",
    "recruit",
    "fight",
    "infrastructure",
    "friends",
    "award",
    "depot",
    "operator-box",
    "recruit-recognition",
    "copilot",
    "roguelike",
    "reclamation",
  ],
  steps: [
    {
      skill: "login",
      label: "上号与账号核验",
      required: true,
      when: "always",
      expect: "个人名片双帧 UID 与预设账号一致，并返回主页",
      guide: "login",
    },
    {
      skill: "recruit",
      label: "保守自动公招",
      required: true,
      when: "always",
      expect: "按设置只确认三星、保留高价值词条，不用加急",
      guide: "recruit",
    },
    {
      skill: "fight",
      label: "理智作战",
      required: true,
      when: "always",
      expect: "按现有理智代理指定关卡（不吃药、不碎石）并给出本批结算",
      guide: "fight",
    },
    {
      skill: "infrastructure",
      label: "基建轮换与收菜",
      required: true,
      when: "always",
      expect: "一键轮换、收菜、无人机加速贸易站完成",
      guide: "infrastructure",
    },
    {
      skill: "friends",
      label: "好友与信用商店",
      required: true,
      when: "always",
      expect: "收取信用并按设置购物，余额已核对",
      guide: "friends",
    },
    {
      skill: "award",
      label: "领取任务奖励",
      required: true,
      when: "always",
      expect: "每日/周奖励已领取",
      guide: "award",
    },
  ],
};

export const gameModePlans: readonly GameModePlan[] = [
  onmyojiMode,
  arknightsMode,
];

export function planFor(game: GameId): GameModePlan {
  const plan = gameModePlans.find((item) => item.game === game);
  if (!plan) throw new Error(`未知游戏模式：${game}`);
  return plan;
}

/** 当天该做的步骤（周末/工作日过滤；维护类永远列出，由技能自己判断是否需要做）。 */
export function stepsForDay(plan: GameModePlan, day: Date): GameModeStep[] {
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  return plan.steps.filter(
    (step) =>
      step.when === "always" ||
      (step.when === "weekend" ? weekend : !weekend),
  );
}
