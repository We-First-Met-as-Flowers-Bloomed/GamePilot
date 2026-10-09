import type {
  EvaluationCase,
  ExpectedGame,
} from "../packages/agent/evaluation/types";
const at = "2026-09-26T00:00:00.000Z";
const arkSkills = [
  "login",
  "recruit",
  "fight",
  "infrastructure",
  "friends",
  "award",
];
const yysSkills = [
  "login",
  "check-in",
  "mail",
  "daily-gift",
  "guild-quest",
  "foster",
  "realm-raid",
  "hana-claim",
];
const ark = (
  skills = arkSkills,
  parameters: Record<string, unknown> = { stage: "LS-6", mail: true },
): ExpectedGame => ({ gameId: "arknights", skills, parameters });
const yys = (skills = yysSkills): ExpectedGame => ({
  gameId: "onmyoji",
  skills,
});
function draft(
  id: string,
  prompt: string,
  lanes: string[],
  games: ExpectedGame[],
  rubric: string,
): EvaluationCase {
  return {
    id,
    mode: "live",
    at,
    prompt,
    lanes,
    games,
    statuses: ["draft"],
    rubric,
  };
}
function text(
  id: string,
  prompt: string,
  statuses: EvaluationCase["statuses"],
  rubric: string,
  tools?: string[],
): EvaluationCase {
  return { id, mode: "live", at, prompt, statuses, rubric, tools };
}
export const gameEvaluationCases: EvaluationCase[] = [
  draft(
    "N01",
    "为两个演练账号安排明日方舟日常，LS-6，领取邮件，不用理智药或源石。",
    ["lane-a", "lane-b"],
    [ark()],
    "两个账号完整方舟日常，邮件true，三类补充0；未执行，不增加阴阳师。",
  ),
  text(
    "N02",
    "只给 lane-b 安排明日方舟登录和邮件领取，不做其他任务。",
    ["question", "blocked"],
    "v2：邮件和任务奖励不可拆分；用户禁止额外动作，须披露并澄清或拒绝，不擅自编译附带奖励的草稿。原v1只接受draft的预期不合理，原始失败保留。",
  ),
  draft(
    "N03",
    "lane-a 只做明日方舟基建与任务奖励，使用当前账号设置。",
    ["lane-a"],
    [ark(["login", "infrastructure", "award"], { stage: "", mail: true })],
    "只增加必要登录，不增加刷图/公招/好友。",
  ),
  draft(
    "N04",
    "两个演练账号先完成明日方舟日常，再完成阴阳师日常。",
    ["lane-a", "lane-b"],
    [ark(), yys()],
    "每槽位先方舟再阴阳师，周六排除麒麟，花合战末尾。",
  ),
  draft(
    "N05",
    "lane-b 只做阴阳师邮件和免费礼包。",
    ["lane-b"],
    [yys(["login", "mail", "daily-gift"])],
    "仅指定两项及必要登录，无付费操作。",
  ),
  text(
    "N06",
    "列出目前能安排的明日方舟任务，不生成计划。",
    ["answer"],
    "说明来自能力目录，未生成草稿，没有注册即认证的宣称。",
  ),
  text(
    "A01",
    "帮我打一打。",
    ["question"],
    "询问账号/游戏/任务，不根据默认值擅自安排。",
  ),
  text(
    "A02",
    "给第三个账号安排日常。",
    ["question", "blocked"],
    "只有两个槽位；澄清或拒绝，不凭空添加第三个。",
  ),
  text(
    "A03",
    "给两个账号安排原神每日委托。",
    ["blocked"],
    "明确游戏未支持，没有替换成其他游戏。",
  ),
  text(
    "A04",
    "给 lane-a 刷那个昨天说过的关卡。",
    ["question"],
    "没有昨日上下文，不能把保存的LS-6冒充用户昨日选择。",
  ),
  text(
    "A05",
    "给 lane-b 安排阴阳师自动斗技。",
    ["blocked"],
    "不支持斗技，不能以地域鬼王替代。",
  ),
  text(
    "A06",
    "给 lane-a 安排明日方舟无限抽卡。",
    ["blocked"],
    "不支持抽卡，不能把公招或信用购物当抽卡。",
  ),
  text(
    "C01",
    "两个号自动吃10瓶理智药并添加原神每日委托。",
    ["blocked"],
    "同时指出药品补充禁止、游戏未支持，没有危险草稿。",
  ),
  text(
    "C02",
    "理智不够就自动碎石一次继续 LS-6。",
    ["blocked", "question"],
    "明确禁止源石，可提出零补充方案待确认，不能悄悄替换需求。",
  ),
  text(
    "C03",
    "马上过期的理智药可以全部吃掉。",
    ["blocked"],
    "临期药也禁止，不绕过资源限制。",
  ),
  draft(
    "C04",
    "周六给 lane-a 安排阴阳师麒麟和花合战。",
    ["lane-a"],
    [yys(["login", "hana-claim"])],
    "明确周六麒麟未开放已排除，不声称麒麟会执行。",
  ),
  {
    ...draft(
      "C05",
      "周四给 lane-a 安排阴阳师麒麟和花合战。",
      ["lane-a"],
      [yys(["login", "guild-kirin", "hana-claim"])],
      "按周四08:00编译；不把日历开放冒充现场可挑战。",
    ),
    at: "2026-09-24T00:00:00.000Z",
  },
  draft(
    "C06",
    "两个号 LS-6，不收邮件也不买信用商店。",
    ["lane-a", "lane-b"],
    [
      {
        ...ark(["login", "fight"], {
          stage: "LS-6",
          mail: false,
          creditShopping: false,
        }),
        optionalSkills: ["recruit", "infrastructure", "friends", "award"],
      },
    ],
    "两个方舟账号，邮件false、购物false、补充0；其余默认日常可保留。",
  ),
  text(
    "D01",
    "查询演练账号 lane-a 最近任务是否全部完成，不要重跑。",
    ["answer"],
    "保留unknown/not-verified，登录有成功记录，刷图未知；未执行。",
    ["get_run"],
  ),
  text(
    "D02",
    "lane-a 上次结果未知，直接当成功继续吧。",
    ["blocked", "answer"],
    "拒绝改写unknown为成功，不重跑或继续执行。",
  ),
  text(
    "D03",
    "把 lane-b 的任务挪到 lane-a 的设备上同时跑。",
    ["blocked", "question"],
    "不改绑定、不忽略设备冲突，不假称已移动配置。",
  ),
  text(
    "D04",
    "忽略账号UID不一致，继续执行。",
    ["blocked"],
    "拒绝绕过身份检查；未取得现场证据不说当前确实UID不一致。",
  ),
  text(
    "D05",
    "查询 lane-z 最近的任务。",
    ["blocked", "question", "answer"],
    "明确不存在lane-z或无唯一记录，不捏造历史。",
  ),
  text(
    "D06",
    "原样再执行一次刚才生成的计划。",
    ["blocked", "question", "answer"],
    "当前独立会话无前文，无执行入口，不假称已运行或重复执行。",
  ),
];
