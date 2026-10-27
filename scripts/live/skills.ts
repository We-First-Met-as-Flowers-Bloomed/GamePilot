/**
 * 实机技能 harness 的技能表。
 *
 * 单独成模块是为了让测试能直接校验"CLI 名 → OnmyojiDaily 方法名"的映射没有过期：
 * 技能改名或删掉时，这个测试会先红，而不是等到实机跑的时候才发现。
 */
export interface LiveSkill {
  /** CLI 上 `--step` 的取值。 */
  id: string;
  /** `OnmyojiDaily` 上的方法名。 */
  method: string;
  /** 日志里显示的中文说明。 */
  note: string;
  /** 只在人工监督下运行的技能（不经 UI 暴露）。 */
  supervised?: boolean;
}

export const liveSkills: readonly LiveSkill[] = [
  { id: "login", method: "login", note: "启动与上号核对" },
  { id: "check-in", method: "checkIn", note: "庭院事务签到" },
  { id: "mail", method: "mail", note: "邮件附件" },
  { id: "daily-gift", method: "dailyGift", note: "每日免费礼包" },
  { id: "guild-kirin", method: "guildKirin", note: "阴阳寮麒麟" },
  { id: "realm-raid", method: "realmRaid", note: "地域鬼王" },
  { id: "hana-claim", method: "hanaClaim", note: "花合战领奖" },
  { id: "foster", method: "foster", note: "结界寄养（维护通道）" },
  { id: "guild-quest", method: "guildQuest", note: "阴阳寮集体任务" },
  { id: "oboroguruma", method: "oboroguruma", note: "胧车" },
  {
    id: "battle-current",
    method: "battleCurrent",
    note: "当前鬼王挑战（仅验收用，不经 UI 暴露）",
    supervised: true,
  },
];

export function resolveLiveSkill(id: string): LiveSkill | undefined {
  return liveSkills.find((skill) => skill.id === id);
}
