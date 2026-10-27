import type { Game } from "../../packages/protocol";
export const onmyoji: Game = {
  id: "onmyoji",
  name: "阴阳师",
  subtitle: "MuMu · Android",
  skills: [
    {
      id: "login",
      position: "first",
      title: "启动与上号",
      description: "启动游戏，复用已有登录态进入当前角色",
      ready: true,
    },
    {
      id: "check-in",
      title: "每日签到",
      description: "通过庭院事务完成每日一签及游戏内已启用日常",
      ready: true,
    },
    {
      id: "mail",
      title: "邮件附件",
      description: "检查邮箱并只使用一键领取，不已读或删除邮件",
      ready: true,
    },
    {
      id: "daily-gift",
      title: "每日礼包",
      description: "进入礼包屋日常页，只领取第一张免费每日礼包",
      ready: true,
    },
    {
      id: "guild-quest",
      title: "阴阳寮集体任务",
      description:
        "在寮境打开集体任务，领取当日已完成的奖励；需要提供 N 阶式神的「提交」卡会消耗式神，不自动提交，只在结果里说明",
      ready: true,
    },
    {
      id: "foster",
      maintenanceOnly: true,
      title: "结界寄养",
      description: "太鼓优先、斗鱼次选，选择同类最高星级好友结界",
      ready: true,
    },
    {
      id: "guild-kirin",
      weekdays: [1, 2, 3, 4],
      title: "阴阳寮麒麟",
      description: "周一至周四06:00–23:00进入神社，用当前阵容完成一次狩猎战",
      ready: true,
    },
    {
      id: "realm-raid",
      title: "地域鬼王",
      description: "按声望核对今日记录，用当前阵容完成普通 1 级挑战",
      ready: true,
    },
    {
      id: "oboroguruma",
      title: "胧车挂机",
      description: "从探索进入胧车，核对御魂配置与八岐大蛇加成，设最大次数后出发",
      ready: true,
    },
    {
      id: "hana-claim",
      position: "last",
      title: "花合战奖励",
      description: "在所有每日任务完成后进入花合战并全部领取",
      ready: true,
    },
  ],
};
