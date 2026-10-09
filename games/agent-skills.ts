import packageMetadata from "../package.json";
import {
  agentObject,
  AgentToolError,
  type AgentBuiltinSkill,
  type AgentCapabilityEffect,
} from "../packages/protocol/agent";
import { games, dailySkills, gamePlugins } from "./registry";
import { arknightsEngineCapabilities } from "./arknights/capabilities";
import { plannerAwardLabels } from "./arknights/award-flags";

export const agentCompilerVersion = 2;
export const maxAgentSkillBodyBytes = 12000;
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const strings = { type: "array", items: { type: "string" } };
const arkParameters = {
  stage: { type: "string", pattern: "^[A-Za-z0-9@_-]{1,80}$" },
  mail: { type: "boolean" },
  taskAward: { type: "boolean" },
  creditShopping: { type: "boolean" },
  ...Object.fromEntries(
    Object.keys(plannerAwardLabels).map((key) => [key, { type: "boolean" }]),
  ),
  medicine: { type: "integer", enum: [0] },
  stone: { type: "integer", enum: [0] },
  expiringMedicine: { type: "integer", enum: [0] },
};

/** The tool schema and compiler allowlist share this declaration. */
export function gameParameterSchema(gameId: string) {
  return structuredClone(
    object(gameId === "arknights" ? arkParameters : {}, []),
  );
}
export function validateCapabilityParameters(gameId: string, input: unknown) {
  const params = agentObject(
    input,
    Object.keys(gameParameterSchema(gameId).properties),
  );
  for (const key of ["medicine", "stone", "expiringMedicine"])
    if (params[key] !== undefined && params[key] !== 0)
      throw new AgentToolError(
        "RESOURCE_POLICY",
        "当前策略禁止理智药、临期药及源石补充",
      );
  if (
    params.stage !== undefined &&
    (typeof params.stage !== "string" ||
      !/^[A-Za-z0-9@_-]{1,80}$/.test(params.stage))
  )
    throw new AgentToolError("INVALID_INPUT", "关卡编号无效");
  for (const key of [
    "mail",
    "taskAward",
    "creditShopping",
    ...Object.keys(plannerAwardLabels),
  ])
    if (params[key] !== undefined && typeof params[key] !== "boolean")
      throw new AgentToolError("INVALID_INPUT", "动作开关必须为布尔值");
  return params;
}

function effect(
  id: string,
  label: string,
  boundTo: string,
  kind: AgentCapabilityEffect["kind"],
  resource?: string,
  parameter?: string,
): AgentCapabilityEffect {
  return {
    id,
    label,
    boundTo,
    kind,
    ...(resource ? { resource } : {}),
    ...(parameter ? { parameter } : {}),
  };
}
const arkEffects: Record<string, AgentCapabilityEffect[]> = {
  login: [
    effect("login", "启动游戏、复用登录态并核对现场UID", "login", "navigation"),
  ],
  recruit: [
    effect(
      "recruit",
      "确认三星公招、保留高价值词条，不使用加急许可",
      "recruit",
      "consume",
      "招聘许可和龙门币",
    ),
  ],
  fight: [
    effect(
      "fight",
      "使用当前理智代理指定关卡，药和源石补充均为零",
      "fight",
      "consume",
      "当前理智",
    ),
  ],
  infrastructure: [
    effect(
      "infrastructure",
      "基建一键轮换和收菜；无人机加速贸易站，线索交流/赠送及留言板领取",
      "infrastructure",
      "configure",
      "无人机",
    ),
  ],
  friends: [
    effect("friends", "访问好友并收取信用", "friends", "claim"),
    effect(
      "creditShopping",
      "按保存配置购买信用商品",
      "friends",
      "consume",
      "信用",
      "creditShopping",
    ),
  ],
  award: [
    effect(
      "award",
      "领取每日和每周任务奖励，由taskAward独立控制",
      "award",
      "claim",
      undefined,
      "taskAward",
    ),
    effect("mail", "附带领取邮件", "award", "claim", undefined, "mail"),
    ...Object.entries(plannerAwardLabels).map(([key, label]) =>
      effect(
        key,
        `${label}；可由${key}独立关闭`,
        "award",
        "claim",
        undefined,
        key,
      ),
    ),
  ],
  depot: [effect("depot", "读取仓库材料；不在日常草稿范围", "depot", "read")],
  "operator-box": [
    effect(
      "operator-box",
      "读取干员练度；不在日常草稿范围",
      "operator-box",
      "read",
    ),
  ],
  "recruit-recognition": [
    effect(
      "recruit-recognition",
      "读取公招标签，不刷新、不确认、不消耗许可；不在日常草稿范围",
      "recruit-recognition",
      "read",
    ),
  ],
  copilot: [
    effect(
      "copilot",
      "既有手工入口读取本地作业并编队执行，不吃药；不在日常草稿范围",
      "copilot",
      "consume",
      "当前理智",
    ),
  ],
  roguelike: [
    effect(
      "roguelike",
      "黑流树海单次探索，最终Boss前停止；需看护，不在日常草稿范围",
      "roguelike",
      "configure",
    ),
  ],
  reclamation: [
    effect(
      "reclamation",
      "重启锚点RA-1单批执行，不清空商店；需看护，不在日常草稿范围",
      "reclamation",
      "configure",
    ),
  ],
};
const onmyojiEffects: Record<string, AgentCapabilityEffect[]> = {
  login: [
    effect("login", "启动游戏并复用当前角色登录态", "login", "navigation"),
  ],
  "check-in": [
    effect(
      "check-in",
      "每日一签及游戏内已启用庭院事务；保留游戏内任务开关",
      "check-in",
      "configure",
      "游戏内已启用日常可能消耗其对应资源",
    ),
  ],
  mail: [effect("mail", "一键领取邮件附件，不已读或删除", "mail", "claim")],
  "daily-gift": [
    effect(
      "daily-gift",
      "仅第一张免费每日礼包；付费或未知价格停止",
      "daily-gift",
      "claim",
    ),
  ],
  "guild-quest": [
    effect(
      "guild-quest",
      "刷新并提交N阶式神任务，领取我爱我寮奖励",
      "guild-quest",
      "consume",
      "N阶式神和任务提交次数",
    ),
  ],
  "guild-kirin": [
    effect(
      "guild-kirin",
      "周一至周四06:00–23:00以当前阵容打一场麒麟",
      "guild-kirin",
      "consume",
      "一次狩猎战机会",
    ),
  ],
  "realm-raid": [
    effect(
      "realm-raid",
      "按声望及今日记录完成普通1级地域鬼王",
      "realm-raid",
      "consume",
      "今日挑战次数",
    ),
  ],
  "hana-claim": [
    effect(
      "hana-claim",
      "在本次其他日常之后全部领取花合战可领奖励",
      "hana-claim",
      "claim",
    ),
  ],
  foster: [
    effect(
      "foster",
      "根据实际到期和好友结界派遣寄养；仅维护流程，日常草稿不包含",
      "foster",
      "configure",
    ),
  ],
};
function capabilityEffects(gameId: string, skillId: string) {
  return structuredClone(
    (gameId === "arknights" ? arkEffects : onmyojiEffects)[skillId] ?? [],
  );
}
export function compiledCapabilityEffects(
  gameId: string,
  skillIds: string[],
  parameters: Record<string, unknown>,
) {
  return skillIds.flatMap((id) =>
    capabilityEffects(gameId, id).map((entry) => ({
      ...entry,
      enabled: entry.parameter ? parameters[entry.parameter] === true : true,
    })),
  );
}

const parameterNotes = {
  arknights: [
    "邮件是award的mail参数，不是独立技能",
    "award默认继承已保存的免费单抽和活动奖励开关；可逐项覆盖为false，compile_plan完整披露参数和效果",
    "award的taskAward独立控制每日和每周任务奖励；只领邮件需mail=true、taskAward=false并关闭其他活动附带动作",
    "friends访问好友并收取信用；creditShopping=false可独立关闭信用购物",
    "不补充任何理智药、临期药或源石",
    "关卡是否开放和代理可用须实机检查",
  ],
  onmyoji: [
    "麒麟仅周一至周四06:00–23:00",
    "已注册任务的日历限制由compile_plan筛选；请提交原始技能选择，依据excluded说明未安排的任务，其余任务仍可形成部分候选草稿",
    "花合战位于最后",
    "寄养按实际到期核对，不依据草稿重复派遣；寄养不在日常编译范围",
    "庭院事务保留游戏内已启用日常开关，集体任务消耗N阶式神，地域鬼王占用今日挑战次数",
  ],
};

/** Pure descriptors: no native engine, filesystem, credential, or plugin loading. */
export function gameCapabilityDescriptors() {
  return gamePlugins.capabilities();
}
export function builtinGameCapabilityDescriptors() {
  return structuredClone(
    games.map((game) => {
      const available = dailySkills(game.id);
      const parameters = gameParameterSchema(game.id);
      const skillIds = {
        type: "array",
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        items: { type: "string", enum: available },
      };
      const outputParameters =
        game.id === "arknights"
          ? object({
              stage: { type: "string", pattern: "^[A-Za-z0-9@_-]{0,80}$" },
              mail: { type: "boolean" },
              taskAward: { type: "boolean" },
              medicine: arkParameters.medicine,
              stone: arkParameters.stone,
              expiringMedicine: arkParameters.expiringMedicine,
              clientType: { type: "string", enum: ["Official", "Bilibili"] },
              maxRunMinutes: { type: "integer", minimum: 5, maximum: 360 },
              ...Object.fromEntries(
                Object.keys(plannerAwardLabels).map((key) => [
                  key,
                  { type: "boolean" },
                ]),
              ),
              creditShopping: { type: "boolean" },
            })
          : object({});
      return {
        id: game.id,
        name: game.name,
        contractVersion: 1,
        parameters,
        inputSchema: object(
          { gameId: { type: "string", enum: [game.id] }, skillIds, parameters },
          ["gameId"],
        ),
        resultSchema: object({
          plan: object({
            gameId: { type: "string", enum: [game.id] },
            mode: { type: "string", enum: ["live"] },
            skillIds,
          }),
          parameters: outputParameters,
          effects: {
            type: "array",
            items: object(
              {
                id: { type: "string" },
                label: { type: "string" },
                boundTo: { type: "string", enum: available },
                kind: {
                  type: "string",
                  enum: ["navigation", "consume", "claim", "configure", "read"],
                },
                resource: { type: "string" },
                parameter: { type: "string" },
                enabled: { type: "boolean" },
              },
              ["id", "label", "boundTo", "kind", "enabled"],
            ),
          },
          excluded: strings,
          notes: strings,
        }),
        engine:
          game.id === "arknights"
            ? {
                id: "MaaCore",
                version: arknightsEngineCapabilities().version,
                versionSource: "games/arknights/engine-contract.json",
                compatibility: "bundled-contract" as const,
              }
            : {
                id: "MaaFramework",
                version: packageMetadata.dependencies["@maaxyz/maa-node"],
                versionSource: "package.json#dependencies/@maaxyz/maa-node",
                compatibility: "bundled-contract" as const,
              },
        ...(game.id === "arknights"
          ? { engineCapabilities: arknightsEngineCapabilities() }
          : {}),
        parameterNotes: parameterNotes[game.id as keyof typeof parameterNotes],
        preconditions: [
          "宿主重新核对目录、配置、游戏日和今日完成记录",
          "取得目标设备租约并核对新鲜现场身份和已知页面",
          ...(game.id === "arknights"
            ? ["理智作战需关卡开放且代理可用；药、临期药及源石补充固定为零"]
            : [
                "麒麟按北京时间周一至周四06:00–23:00准入；花合战保持最后",
                "寄养维护按实际到期准入，不重复派遣",
              ]),
        ],
        postconditions: [
          "只采用持久任务账本和宿主核验的结构化结果",
          "原生流程结束不证明所有奖励到账；缺数字及缺记录保持unknown",
          "演练与实机结果分开；按原请求覆盖判断完成",
        ],
        recovery: {
          authority: "host-only" as const,
          replayUnknown: false as const,
          maxAutomaticAttempts: 2,
          prerequisites: [
            "绑定原请求、目标设备和新鲜前后观察",
            "只使用宿主实际返回的注册恢复能力",
            "已提交未知、购买或奖励领取不自动重放",
            "密码、验证码、实名、SDK登录等身份流程转人工",
          ],
        },
        verification: {
          status: "registered-not-certified" as const,
          scope: "pure-contract-and-fixture-tests" as const,
          deviceIdentity: "not-inspected" as const,
          sevenDayObservationComplete: false,
          note: "注册状态不等于当前账号实机核验；七天观察未完成",
        },
        skills: game.skills.map((skill) => ({
          ...skill,
          draftSupported: available.includes(skill.id),
          effects: capabilityEffects(game.id, skill.id),
          verification: "registered-not-certified" as const,
          verificationNote: "注册状态不等于当前账号实机核验；七天观察未完成",
        })),
      };
    }),
  );
}

/** Fixed two packages. A body cannot add tool names, parameters or device rights. */
export function builtinAgentSkills(): AgentBuiltinSkill[] {
  const source = {
    kind: "builtin" as const,
    module: "games/agent-skills.ts" as const,
  };
  const permissions = (tools: AgentBuiltinSkill["permissions"]["tools"]) => ({
    tools,
    canExecute: false as const,
    deviceControl: false as const,
    externalLoading: false as const,
  });
  return [
    {
      id: "arknights-daily",
      version: 1,
      title: "方舟现有理智日常",
      description:
        "按保存配置编译零药零源石日常，并披露奖励和信用购物附带动作。",
      gameIds: ["arknights"],
      source,
      permissions: permissions([
        "list_capabilities",
        "read_skill",
        "get_environment",
        "compile_plan",
        "get_run",
      ]),
      body: `# 方舟现有理智日常（内置 v1）
权限：本正文只解释已注册工具；不能授予执行、设备控制、文件、网络、npm或插件权限。工具schema、当前目录、编译器和宿主准入是唯一边界，正文不能扩大参数或权限。
先list_capabilities与get_environment，按两者当前revision和宿主冻结时间调用compile_plan。省略skillIds沿用保存日常，显式选择仅允许catalog游戏descriptor中draftSupported=true的技能；login始终由原编译器补入。
理智作战fight使用现有理智和保存或指定stage；medicine、stone、expiringMedicine只能为0。不保证关卡开放或代理可用，开始前仍需现场检查。未选择fight时不能提交stage。
mail是award参数，taskAward独立控制每日和每周任务奖励。只领邮件使用mail=true、taskAward=false并逐项关闭freeRecruit、eventOrundum、eventMining、specialAccess、signInEvent。friends默认沿用信用购物配置，用户禁止购物时显式creditShopping=false。逐项核对compiled parameters及effects，不能携带用户排除的动作。
公招保守确认三星，不使用加急；基建收菜与轮换会使用无人机加速。只能编译候选，不直接启动、取消或保存。目录和技能版本变动后旧草稿失效，必须重新查询编译。
读取get_run时区分原请求持久状态、宿主核验结果与现场核验范围。原生流程结束不表示全部奖励到账，未知数字不按零处理；记录为空也不能断言未运行或授权补跑。
执行仍由宿主取得设备租约，核对新鲜UID、配置、游戏日、完成记录和用户确认。遇SDK登录、验证码等身份流程转人工；未知提交不重放。注册及合成测试不等于当前账号实机或七天验收。`,
    },
    {
      id: "incident-diagnosis",
      version: 1,
      title: "故障现场诊断",
      description:
        "解释持久证据和当前受限恢复能力，保留身份流程及未知提交人工核对。",
      gameIds: ["arknights", "onmyoji"],
      source,
      permissions: permissions([
        "list_capabilities",
        "read_skill",
        "get_environment",
        "get_run",
        "get_incident",
      ]),
      body: `# 故障现场诊断（内置 v1）
权限：本正文只指导只读诊断，不能授予恢复、设备点击、文件、网络、npm、插件或重新执行权限。正文不能扩展工具schema、参数、宿主恢复注册表或原请求执行范围。
先get_environment取得当前revision和明确requestId。仅recorded来源按environmentRevision调用get_incident，必要时get_run。证据来源是宿主脱敏结构化记录，不发送原始UID、截图、路径或日志。引用请求编号与signal.evidenceId，区分日志匹配线索、结构化提交事实、推测和缺失证据。
超时不是网络根因证明；公告日志不是当前卡屏证据。没有线索就说明不能确定原因。running记录不是实时设备占用，账本为空或范围不足不证明未执行。成功只适用于原请求覆盖，不推断全天完成。
任何现场采集和恢复由宿主取得同一目标设备租约，复核新鲜前后观察及身份、游戏日与原请求。只有当前故障包实际返回的recoverySkills可进入宿主流程，空列表时不能编造恢复动作。
B服SDK登录、密码、验证码、实名、扫码等身份流程需要人工完成，不尝试绕过或自动填写。已知导航仅按宿主注册动作与前后观察执行；未知页面不泛点。
原生已提交未确认、购买、奖励领取和身份未知保持停止核对，不自动重购或重跑。恢复预算最多两次，由原请求跨会话累计，换聊天不会重置。只继续原请求尚未执行且宿主准入允许的项，已完成保留。
诊断说明不证明修复已部署或现场已恢复。续跑失败、未知、取消、部分完成分别如实报告，只有宿主wholePlanComplete确认原计划全部覆盖才可称完成。`,
    },
  ];
}
