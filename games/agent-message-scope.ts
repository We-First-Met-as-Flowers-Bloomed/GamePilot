import type { DeviceLane, Plan } from "../packages/protocol";
import { agentLaneAlias } from "../packages/protocol/lane-alias";
import type { GoalScope } from "../packages/protocol/agent-goal";
import { AgentToolError } from "../packages/protocol/agent";
import {
  gameMessageAuthority,
  gameMessageIsInquiry,
  gameMessageIsCompletionReport,
  normalizeGameExclusions,
} from "../packages/agent/game-message-authority";
import type { ArknightsProfile, ArknightsProfiles } from "./arknights/config";
import { plannerAwardLabels } from "./arknights/award-flags";
import { gamePlugins } from "./registry";

export interface MessageScopeSnapshot {
  lane: { id: string; name?: string };
  profile?: ArknightsProfile;
  arknightsPlan?: Plan;
  onmyojiPlan?: Plan;
  startedAt?: string;
  exclusions?: {
    gameId: string;
    skillIds: string[];
    skipReason: "not-open";
    evidenceTimestamp: string;
    evidenceReference: string;
  }[];
}

function reject(message: string): never {
  throw new AgentToolError("GOAL_SCOPE_EXCEEDED", message);
}
const allAccountsPattern =
  /(?:所有|全部|两个|2个|双|各)(?:已启用的?|启用的?)?(?:明日方舟|阴阳师)?(?:账号|账户|号)|(?:账号|账户)(?:都|全都|全部|一起)/;
function messageClients(text: string): ("Bilibili" | "Official")[] {
  return [
    ...(/B\s*服|哔哩/i.test(text) ? ["Bilibili" as const] : []),
    ...(/官服/.test(text) ? ["Official" as const] : []),
  ];
}
export function gamePreferencePrompt(prompt: string): string {
  return normalizeGameExclusions(
    prompt
      .normalize("NFKC")
      .replace(
        /```[\s\S]*?```|`[^`\n]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|^\s*>[^\n]*/gm,
        "",
      )
      .split(/[，,。；;\n]/)
      .filter((clause) => !gameMessageIsCompletionReport(clause))
      .join("；")
      .trim(),
  );
}

type MessageAccountLane = Pick<DeviceLane, "id" | "name">;
function accountOrdinal(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const normalized = value.replace(/两/g, "二").replace(/〇/g, "零");
  const digits = "零一二三四五六七八九";
  if (normalized.length === 1 && normalized !== "十")
    return digits.indexOf(normalized);
  if (/^[一二三四五六七八九]?十[一二三四五六七八九]?$/.test(normalized)) {
    const [tens, units] = normalized.split("十");
    return (
      (tens ? digits.indexOf(tens) : 1) * 10 +
      (units ? digits.indexOf(units) : 0)
    );
  }
  return NaN;
}
function accountReferences(text: string, lanes: MessageAccountLane[]) {
  const mentions: { index: number; start: number; end: number }[] = [];
  for (const match of text.matchAll(
    /(?:账号|账户|槽位)\s*([零〇一二两三四五六七八九十\d]+)(?![A-Za-z0-9_.-]|[零〇一二两三四五六七八九十])|([零〇一二两三四五六七八九十\d]+)号|第([零〇一二两三四五六七八九十\d]+)(?:个)?(?:账号|账户|槽位)/g,
  )) {
    const value = match[1] ?? match[2] ?? match[3];
    const ordinal = accountOrdinal(value);
    mentions.push({
      index: ordinal - 1,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  for (const [index, lane] of lanes.entries()) {
    for (const alias of new Set([
      lane.id,
      lane.name,
      agentLaneAlias(index),
    ])) {
      if (alias.length < 2) continue;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = /^[\x00-\x7f]+$/.test(alias)
        ? `(?<![a-zA-Z0-9_-])${escaped}(?![a-zA-Z0-9_-])`
        : escaped;
      for (const match of text.matchAll(new RegExp(pattern, "g")))
        mentions.push({
          index,
          start: match.index,
          end: match.index + match[0].length,
        });
    }
  }
  return mentions.sort((a, b) => a.start - b.start);
}

/** Only fresh host bindings may translate public account words to actual lane IDs. */
export function agentMessageAccountSelection(
  prompt: string,
  lanes: MessageAccountLane[],
) {
  const text = gamePreferencePrompt(prompt);
  const mentions = accountReferences(text, lanes);
  for (const marker of text.matchAll(/账号|账户|槽位/g)) {
    const end = marker.index + marker[0].length;
    if (
      mentions.some(
        (mention) =>
          (mention.start <= marker.index && mention.end >= end) ||
          (mention.start >= end &&
            /^\s*$/.test(text.slice(end, mention.start))),
      )
    )
      continue;
    const prefix = text.slice(0, marker.index);
    const tail = text.slice(end);
    if (
      /(?:所有|全部|两个|2个|双|各)(?:已启用的?|启用的?)?(?:明日方舟|阴阳师)?$/.test(
        prefix,
      ) ||
      /(?:官服|B服|哔哩(?:哔哩)?服?)$/i.test(prefix) ||
      (/(?:检查|核对|确认)\s*$/.test(prefix) &&
        /^\s*是否在线\s*(?:[，,。；;!?？！\n]|$)/.test(tail)) ||
      /^\s*(?:都|全都|全部|一起|共同|日常|每日|任务|计划|运行|执行|领取|收取|继续|重试|停止|取消|做|跑|的?(?:日常|任务|计划|配置|设置|范围|绑定|UID|身份))/.test(
        tail,
      ) ||
      /^\s*(?:[，,。；;!?？！\n]|$)/.test(tail)
    )
      continue;
    reject(
      "当前消息中的账号编号或昵称无法核对，请使用已配置账号的完整名称或有效序号；不会改为全部账号",
    );
  }
  const denied = new Set<number>();
  const explicit = new Set<number>();
  for (const mention of mentions) {
    const prefix =
      text
        .slice(0, mention.start)
        .split(/[，,。；;\n]/)
        .at(-1) ?? "";
    const suffix = text.slice(mention.end);
    if (
      /(?:不要|禁止|排除|跳过|不含|除了|(?<!分)别).{0,12}$/.test(prefix) ||
      /^(?:先|暂时)?(?:不要|不用|不|别)(?:运行|执行|跑|做日常)/.test(suffix)
    )
      denied.add(mention.index);
    else explicit.add(mention.index);
  }
  const clients = messageClients(text);
  return {
    explicit: [...explicit].filter((index) => !denied.has(index)),
    denied,
    hasAccountWords: mentions.length > 0,
    all: allAccountsPattern.test(text),
    client: clients.length === 1 ? clients[0] : undefined,
  };
}

function accountSelection(
  prompt: string,
  lanes: DeviceLane[],
  profiles: ArknightsProfiles,
) {
  return {
    ...agentMessageAccountSelection(prompt, lanes),
    configured: lanes
      .map((lane, index) => ({ lane, index }))
      .filter(({ lane }) => lane.enabled),
    clientMatches: (index: number, client: string) =>
      profiles.profiles.find(
        (profile) => profile.id === lanes[index]?.arknights.profileId,
      )?.clientType === client,
  };
}

interface ScopedMessageClause {
  text: string;
  laneIds?: string[];
  gameIds?: string[];
}

function scopedMessageClauses(
  prompt: string,
  lanes: MessageAccountLane[],
): ScopedMessageClause[] {
  const clauses: string[] = [];
  for (const raw of prompt.split(/[，,。；;\n]/).filter(Boolean)) {
    const references = accountReferences(raw, lanes);
    let start = 0;
    for (let i = 1; i < references.length; i++) {
      const previous = references[i - 1],
        current = references[i];
      // "账号一和账号二领邮件" shares a task; "账号一邮件然后账号二基建" does not.
      if (
        current.start >= previous.end &&
        /邮件|邮箱|基建|公招|信用|好友|商店|礼包|登录|奖励|花合战|签到|麒麟|鬼王|理智|作战|刷图|日常|每日任务|每日计划/.test(
          raw.slice(previous.end, current.start),
        )
      ) {
        clauses.push(raw.slice(start, current.start));
        start = current.start;
      }
    }
    clauses.push(raw.slice(start));
  }
  let laneIds: string[] | undefined, gameIds: string[] | undefined;
  return clauses.map((text) => {
    const accounts = agentMessageAccountSelection(text, lanes);
    if (accounts.explicit.length || accounts.all) {
      const indexes = accounts.all
        ? lanes.map((_, index) => index)
        : accounts.explicit;
      if (indexes.some((index) => !lanes[index]))
        reject("当前消息选择的账号不存在，请明确可用账号");
      laneIds = indexes
        .filter((index) => !accounts.denied.has(index))
        .map((index) => lanes[index].id);
    } else if (accounts.hasAccountWords) {
      // A denied account is a constraint, not an affirmative task target.
      laneIds = [];
    }
    const selectedGames: string[] = [];
    for (const match of text.matchAll(/明日方舟|阴阳师/g)) {
      if (
        !/(?:不要|禁止|跳过|取消|先不|暂不|不运行|不执行|不启动|不切换|不跑).{0,6}$/.test(
          text.slice(0, match.index),
        )
      )
        selectedGames.push(match[0] === "明日方舟" ? "arknights" : "onmyoji");
    }
    if (/双游戏|两个游戏/.test(text)) gameIds = ["arknights", "onmyoji"];
    else if (selectedGames.length) gameIds = [...new Set(selectedGames)];
    if (
      !accounts.hasAccountWords &&
      !selectedGames.length &&
      gameMessageAuthority(text).constraints.shopping === false &&
      !taskIntentSelection(text).requested.length
    )
      return { text };
    return {
      text,
      laneIds: laneIds && [...laneIds],
      gameIds: gameIds && [...gameIds],
    };
  });
}

/** Bind execution to actual current lanes; an unspecified account uses saved enabled lanes. */
export function assertAgentExecutionAccounts(
  prompt: string,
  selectedLaneIds: string[],
  lanes: DeviceLane[],
  profiles: ArknightsProfiles,
): void {
  const selection = accountSelection(prompt, lanes, profiles);
  const selected = selectedLaneIds.map((id) =>
    lanes.findIndex((lane) => lane.id === id),
  );
  const targets = (
    selection.explicit.length
      ? selection.explicit
      : selection.hasAccountWords && !selection.denied.size
        ? []
        : selection.configured
            .map(({ index }) => index)
            .filter((index) => !selection.denied.has(index))
  ).filter(
    (index) =>
      !selection.client || selection.clientMatches(index, selection.client),
  );
  const exact =
    selection.hasAccountWords || selection.all || !!selection.client;
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    targets.some((index) => !lanes[index]) ||
    (exact && selected.length !== targets.length) ||
    selected.some((index) => !lanes[index]?.enabled || !targets.includes(index))
  )
    reject("计划包含当前消息未选择或未启用的实际账号");
  if (
    selection.client &&
    selected.some((index) => !selection.clientMatches(index, selection.client!))
  )
    reject("计划与当前消息选择的客户端账号不符");
  const text = gamePreferencePrompt(prompt);
  const clients = messageClients(text);
  if (
    clients.some(
      (client) =>
        !selected.some((index) => selection.clientMatches(index, client)),
    )
  )
    reject("计划省略了当前消息明确选择的客户端账号");
  const mentions = accountReferences(text, lanes)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter(
      (mention, index, list) =>
        index === 0 || mention.start !== list[index - 1].start,
    );
  for (let index = 0; index < mentions.length; index++) {
    const mention = mentions[index];
    if (!selected.includes(mention.index)) continue;
    const description = text.slice(
      mention.end,
      mentions[index + 1]?.start ?? text.length,
    );
    const namedClients = messageClients(description);
    if (
      namedClients.length === 1 &&
      !selection.clientMatches(mention.index, namedClients[0])
    )
      reject("当前消息为该账号指定的客户端与实际绑定不符");
  }
}
export function assertAgentPreferenceMessageAuthority(prompt: string): void {
  const text = gamePreferencePrompt(prompt);
  if (
    !/(?:以后|今后|默认|每天|记住|保存.{0,12}(?:设置|偏好|日常|计划))/.test(
      text,
    ) ||
    gameMessageIsInquiry(text) ||
    /(?:不要|禁止|暂不|先不|无需).{0,12}(?:修改|更改|保存|设置|记住)|不(?:要求|需要|用|必).{0,12}(?:改|保存|设置|记住)/.test(
      text,
    )
  )
    throw new AgentToolError(
      "MESSAGE_NOT_AUTHORIZED",
      "当前消息未明确授权保存长期设置，查询或否定修改不能授权保存",
    );
}

/** Resolve user account words against the fresh private bindings, not model-selected aliases. */
export function assertAgentPreferenceAccounts(
  prompt: string,
  selected: number[],
  lanes: DeviceLane[],
  profiles: ArknightsProfiles,
  gameId: string,
): void {
  prompt = gamePreferencePrompt(prompt);
  const selection = accountSelection(prompt, lanes, profiles);
  const { explicit, client, configured } = selection;
  const targets = explicit.length
    ? [...new Set(explicit)]
    : selection.all || selection.denied.size
      ? configured.map(({ index }) => index)
      : client
        ? configured
            .filter(
              ({ lane }) =>
                profiles.profiles.find(
                  (profile) => profile.id === lane.arknights.profileId,
                )?.clientType === client,
            )
            .map(({ index }) => index)
        : configured.length === 1
          ? [configured[0].index]
          : [];
  const allowedTargets = targets.filter(
    (index) => !selection.denied.has(index),
  );
  if (
    !allowedTargets.length ||
    allowedTargets.length !== selected.length ||
    allowedTargets.some((index) => !lanes[index]) ||
    selected.some(
      (index) => !lanes[index]?.enabled || !allowedTargets.includes(index),
    )
  )
    reject(
      "长期偏好必须对应当前消息明确选择的实际账号，不能由模型选择其他账号",
    );
  if (
    client &&
    (gameId !== "arknights" ||
      selected.some(
        (index) =>
          profiles.profiles.find(
            (profile) => profile.id === lanes[index].arknights.profileId,
          )?.clientType !== client,
      ))
  )
    reject("偏好与当前消息选择的客户端账号不符");
  if (!/明日方舟|阴阳师/.test(prompt)) {
    const inferred = /基建|公招|信用|购物|购买|理智/.test(prompt)
      ? "arknights"
      : /花合战|麒麟|鬼王|每日礼包/.test(prompt)
        ? "onmyoji"
        : undefined;
    const configuredGames = [
      ...new Set(
        selected.flatMap((index) =>
          gamePlugins
            .list()
            .filter((plugin) => plugin.lane?.enabled(lanes[index]))
            .map((plugin) => plugin.descriptor.id),
        ),
      ),
    ];
    if (
      (inferred ??
        (configuredGames.length === 1 ? configuredGames[0] : undefined)) !==
      gameId
    )
      reject("当前消息没有明确区分游戏，不能由模型修改另一款游戏的偏好");
  }
}
const intents = [
  {
    pattern: /邮件|邮箱/,
    skills: { arknights: "award", onmyoji: "mail" },
    awardFlag: "mail",
  },
  { pattern: /基建/, skills: { arknights: "infrastructure" } },
  { pattern: /公招|公开招募/, skills: { arknights: "recruit" } },
  { pattern: /信用|好友|商店/, skills: { arknights: "friends" } },
  { pattern: /每日礼包|免费礼包/, skills: { onmyoji: "daily-gift" } },
  {
    pattern: /登录|核验.*UID|UID.*核验/i,
    skills: { arknights: "login", onmyoji: "login" },
  },
  {
    pattern: /任务奖励/,
    skills: { arknights: "award" },
    awardFlag: "taskAward",
  },
  { pattern: /花合战/, skills: { onmyoji: "hana-claim" } },
  { pattern: /签到/, skills: { onmyoji: "check-in" } },
  { pattern: /麒麟/, skills: { onmyoji: "guild-kirin" } },
  { pattern: /地域鬼王/, skills: { onmyoji: "realm-raid" } },
  { pattern: /理智|作战|刷图/, skills: { arknights: "fight" } },
] as const;

function taskIntentSelection(prompt: string) {
  // Shopping is a flag of friends, so denying it must still permit free credit.
  const text = prompt.replace(
    /(?:不|不要|禁止|跳过|取消|关闭)(?:信用商店(?:购物|购买)?|信用购物|购物|购买)/g,
    "",
  );
  const positive = new Set<(typeof intents)[number]>();
  const denied = new Set<(typeof intents)[number]>();
  for (const intent of intents) {
    for (const match of text.matchAll(
      new RegExp(intent.pattern.source, `${intent.pattern.flags}g`),
    )) {
      const prefix =
        text
          .slice(0, match.index)
          .split(/[，,。；;、\n]/)
          .at(-1) ?? "";
      const suffix = text
        .slice(match.index + match[0].length)
        .split(/[，,。；;、\n]/)[0];
      if (
        /(?:不|勿|(?<!分)别)\s*$/.test(prefix) ||
        /(?:不要|禁止|跳过|取消|关闭|先不|暂不|无需|不用|不必|不做|不领|(?<!分)别|不收|不领取|不收取|不运行|不执行|不启动)(?:(?!但|而是|只|仅|单独|请|帮我).){0,12}$/.test(
          prefix,
        ) ||
        /^(?:奖励|任务)?(?:先|暂时)?(?:不要|不用|无需|不必|不|别)(?:做|领|收|运行|执行|启动|完成)/.test(
          suffix,
        )
      )
        denied.add(intent);
      else positive.add(intent);
    }
  }
  // An explicit denial wins over another mention of the same action.
  return {
    requested: [...positive].filter((intent) => !denied.has(intent)),
    denied: [...denied],
  };
}

export function agentMessageSkillSelection(prompt: string, gameId: string) {
  const selection = taskIntentSelection(gamePreferencePrompt(prompt));
  const ids = (entries: (typeof intents)[number][]) =>
    entries.flatMap((intent) => {
      const skillId = (intent.skills as Record<string, string>)[gameId];
      return skillId ? [skillId] : [];
    });
  return {
    requested: [...new Set(ids(selection.requested))],
    denied: [...new Set(ids(selection.denied))],
  };
}
export function isShoppingOnlyPreference(prompt: string): boolean {
  const text = gamePreferencePrompt(prompt);
  const taskText = text.replace(
    /(?:不|不要|禁止|跳过|取消|关闭|开启|启用|打开)?(?:信用商店|信用购物|购物|购买)/g,
    "",
  );
  return (
    /购物|购买/.test(text) &&
    !/日常|每日任务|每日计划/.test(taskText) &&
    !intents.some((intent) => intent.pattern.test(taskText))
  );
}

function explicitFightStage(prompt: string): string | undefined {
  const parts = prompt.split(/[，,。；;\n]/);
  const namesStage = (clause: string) =>
    /理智刷|刷\s*[A-Za-z0-9]|关卡/.test(clause);
  if (!parts.some(namesStage)) return undefined;
  const clauses = parts.filter(
    (clause) =>
      namesStage(clause) ||
      /^(?:或者|或|还是)?\s*[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/.test(clause.trim()),
  );
  const stages = new Set<string>();
  for (const clause of clauses) {
    const codes = [
      ...clause.matchAll(
        /(?<![A-Za-z0-9_@-])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+(?![A-Za-z0-9_@-])/g,
      ),
    ];
    if (
      codes.length !== 1 ||
      /还是|或|任选|随便|不|(?<!分)别|勿|没|未/.test(clause)
    )
      reject("当前消息中的作战关卡无法唯一核对，请明确关卡后再执行");
    stages.add(codes[0][0].toUpperCase());
  }
  if (stages.size !== 1) reject("同一账号的作战关卡不唯一，不能由模型选择");
  return [...stages][0];
}

/** Check the registered skill IDs and actual executor flags, never native task nicknames. */
export function assertAgentGameMessageScope(
  prompt: string,
  scopes: GoalScope[],
  snapshots: MessageScopeSnapshot[] | undefined,
  options: {
    savedDaily?: boolean;
    mode?: "execution" | "preference";
    accountLanes?: MessageAccountLane[];
  } = {},
): void {
  prompt = gamePreferencePrompt(prompt);
  const authority = gameMessageAuthority(prompt);
  if (options.mode === "preference")
    assertAgentPreferenceMessageAuthority(prompt);
  else if (!authority.execute)
    throw new AgentToolError(
      "CURRENT_MESSAGE_REQUIRED",
      "本轮没有明确执行授权",
    );
  if (
    scopes.some((scope) =>
      Object.values(scope.resources).some(
        (value) => !Number.isFinite(value) || value !== 0,
      ),
    )
  )
    throw new AgentToolError(
      "RESOURCE_LIMIT",
      "本次聊天未授权使用理智药、源石或即将过期理智药",
    );
  const games = [...new Set(scopes.map((scope) => scope.gameId))];
  const clauses = options.accountLanes
    ? scopedMessageClauses(prompt, options.accountLanes)
    : undefined;
  const requiredGames = new Set<string>(
    /双游戏|两个游戏/.test(prompt) ? ["arknights", "onmyoji"] : [],
  );
  const deniedGames = new Set<string>();
  for (const match of prompt.matchAll(/明日方舟|阴阳师/g)) {
    const id = match[0] === "明日方舟" ? "arknights" : "onmyoji";
    const prefix =
      prompt
        .slice(0, match.index)
        .split(/[，,。；;\n]/)
        .at(-1) ?? "";
    if (
      /(?:不要|禁止|跳过|取消|先不|暂不|不运行|不执行|不启动|不切换|不跑).{0,6}$/.test(
        prefix,
      )
    )
      deniedGames.add(id);
    else requiredGames.add(id);
  }
  deniedGames.forEach((id) => requiredGames.delete(id));
  if (
    games.some((id) => deniedGames.has(id)) ||
    (requiredGames.size &&
      (games.some((id) => !requiredGames.has(id)) ||
        (options.mode !== "preference" &&
          [...requiredGames].some((id) => !games.includes(id)))))
  )
    reject("冻结计划必须完整对应本轮明确选择的游戏，不能增加或省略游戏");
  if (
    options.mode !== "preference" &&
    !clauses &&
    allAccountsPattern.test(prompt) &&
    [...new Set(scopes.map((scope) => scope.laneId))].some((laneId) =>
      [...requiredGames].some(
        (gameId) =>
          !scopes.some(
            (scope) => scope.laneId === laneId && scope.gameId === gameId,
          ),
      ),
    )
  )
    reject("本轮明确要求各账号的所选游戏，冻结范围不能省略其中一个账号游戏");
  if (
    /明日方舟/.test(prompt) &&
    !/阴阳师|双游戏|两个游戏/.test(prompt) &&
    games.some((id) => id !== "arknights")
  )
    reject("本轮只指定明日方舟，请编译单游戏计划");
  if (
    /阴阳师/.test(prompt) &&
    !/明日方舟|双游戏|两个游戏/.test(prompt) &&
    games.some((id) => id !== "onmyoji")
  )
    reject("本轮只指定阴阳师，请编译单游戏计划");
  if (
    !clauses &&
    /只|仅|单独/.test(prompt) &&
    /(?:账号|槽位|号)\s*[一二12]|(?:一|二|1|2)号/.test(prompt) &&
    new Set(scopes.map((scope) => scope.laneId)).size > 1
  )
    reject("本轮只授权一个账号，请编译精确账号计划");

  if (!snapshots?.length || !scopes.length)
    reject("缺少可核对的冻结游戏范围与账号配置");
  for (const clause of clauses ?? []) {
    if (!clause.laneIds?.length || !clause.gameIds?.length) continue;
    if (
      !taskIntentSelection(clause.text).requested.length &&
      !/日常|每日任务|每日计划/.test(clause.text)
    )
      continue;
    for (const laneId of clause.laneIds)
      for (const gameId of clause.gameIds)
        if (
          !scopes.some(
            (scope) => scope.laneId === laneId && scope.gameId === gameId,
          )
        )
          reject(
            "冻结计划缺少当前消息为该账号指定的游戏，不能交换或省略账号任务",
          );
  }
  for (const scope of scopes) {
    const scopePrompt = clauses
      ? clauses
          .filter(
            (clause) =>
              (!clause.laneIds || clause.laneIds.includes(scope.laneId)) &&
              (!clause.gameIds || clause.gameIds.includes(scope.gameId)),
          )
          .map((clause) => clause.text)
          .join("；")
      : prompt;
    if (!scopePrompt) reject("冻结计划包含当前消息未安排的账号或游戏");
    // A named subtask applies only to its account/game, including its denied actions.
    const daily = /日常|每日任务|每日计划|保存.*计划/.test(
      scopePrompt.replace(
        /(?:不|不要|不准|不许|不得|禁止|切勿|勿|暂不|先不|无需|不用|不必|不需要|(?<!分)别)(?:开始|执行|运行|开跑|跑|做|完成)?(?:其他|其它|别的|额外|剩余)?(?:日常|每日任务|每日计划)|(?:其他|其它|别的|额外|剩余)?(?:日常|每日任务|每日计划)(?:先|暂时)?(?:不|不要|不准|不许|不得|禁止|切勿|勿|无需|不用|不必|不需要|(?<!分)别)(?:做|跑|执行|运行|开始|完成)/g,
        "",
      ),
    );
    const taskOnly =
      /(?:只|仅|单独)[^，。；;\n]{0,28}?(?:领取|收取|运行|执行|做|领|收)(?:(?!日常|每日任务|每日计划)[^，。；;\n]){0,12}(?:登录|核验|邮件|邮箱|基建|公招|信用|花合战|礼包|签到|麒麟|鬼王|作战|任务奖励)/.test(
        scopePrompt,
      );
    const limited =
      (!daily || taskOnly) &&
      !(options.mode === "preference" && isShoppingOnlyPreference(scopePrompt));
    const { requested, denied } = taskIntentSelection(scopePrompt);
    const scopeAuthority = gameMessageAuthority(scopePrompt);
    const plugin = gamePlugins
      .list()
      .find((plugin) => plugin.descriptor.id === scope.gameId);
    if (
      !plugin?.lane ||
      scope.skillIds.some(
        (id) =>
          !plugin.dailySkills.includes(id) ||
          !plugin.descriptor.skills.some(
            (skill) => skill.id === id && skill.ready && !skill.maintenanceOnly,
          ),
      )
    )
      reject("冻结计划包含未注册或维护专用动作，不能由日常授权启动");
    if (
      !options.savedDaily &&
      scope.gameId === "onmyoji" &&
      scope.skillIds.includes("guild-quest")
    )
      reject(
        "自定义日常不能新开会消耗式神的集体任务；只保留已配置的保存日常能力",
      );
    const candidates = snapshots.filter(
      (snapshot) => snapshot.lane.id === scope.laneId,
    );
    const snapshot = candidates[0];
    const plan =
      snapshot &&
      ((snapshot as unknown as Record<string, unknown>)[plugin.lane.planKey] as
        Plan | undefined);
    if (
      candidates.length !== 1 ||
      !plan ||
      plan.gameId !== scope.gameId ||
      plan.mode !== "live" ||
      JSON.stringify(plan.skillIds) !== JSON.stringify(scope.skillIds)
    )
      reject("冻结账号计划与目标授权范围不一致");
    if (
      denied.some((intent) => {
        const id = (intent.skills as Record<string, string>)[scope.gameId];
        return (
          id &&
          !(scope.gameId === "arknights" && id === "award") &&
          scope.skillIds.includes(id)
        );
      })
    )
      reject("冻结计划包含本轮明确要求跳过的任务");
    if (limited) {
      const allowed = [
        "login",
        ...requested.flatMap((intent) => {
          const id = (intent.skills as Record<string, string>)[scope.gameId];
          return id ? [id] : [];
        }),
      ];
      if (scope.skillIds.some((id) => !allowed.includes(id)))
        reject("本轮指定了单项任务，请编译准确任务范围");
      if (
        allowed.some(
          (id) =>
            !scope.skillIds.includes(id) &&
            !snapshot.exclusions?.some(
              (excluded) =>
                excluded.gameId === scope.gameId &&
                excluded.skillIds.includes(id) &&
                id === "guild-kirin" &&
                excluded.skipReason === "not-open" &&
                excluded.evidenceReference ===
                  "onmyoji:compiled-calendar-exclusion" &&
                excluded.evidenceTimestamp === snapshot.startedAt &&
                Number.isFinite(Date.parse(excluded.evidenceTimestamp)),
            ),
        )
      )
        reject("冻结计划缺少本轮请求的单项任务，不能只执行登录后宣称目标完成");
    }
    if (scope.gameId !== "arknights") continue;
    const profile = snapshot.profile;
    if (!profile) reject("明日方舟冻结账号配置缺失，不能核对实际动作");
    if (plan.skillIds.includes("fight")) {
      const stage = explicitFightStage(scopePrompt);
      if (stage && profile.stage.toUpperCase() !== stage)
        reject("冻结作战关卡与当前消息指定的关卡不一致");
    }
    if (
      plan.skillIds.includes("award") &&
      denied.some(
        (intent) =>
          "awardFlag" in intent && profile[intent.awardFlag] !== false,
      )
    )
      reject("冻结领奖计划仍启用本轮明确禁止的邮件或任务奖励动作");
    if (
      scopeAuthority.constraints.shopping === false &&
      plan.skillIds.includes("friends") &&
      profile.creditShopping !== false
    )
      reject("本轮要求跳过购物，冻结计划仍启用或未明确关闭信用购买");
    if (
      limited &&
      plan.skillIds.includes("award") &&
      requested.some(
        (intent) => "awardFlag" in intent && intent.awardFlag === "mail",
      )
    ) {
      if (
        profile.mail !== true ||
        (!requested.some(
          (intent) => "awardFlag" in intent && intent.awardFlag === "taskAward",
        ) &&
          profile.taskAward !== false) ||
        Object.keys(plannerAwardLabels).some(
          (key) => profile[key as keyof typeof plannerAwardLabels] !== false,
        )
      )
        reject("只领邮件必须启用邮件、关闭未授权的任务奖励和全部活动附带动作");
    }
    if (
      limited &&
      plan.skillIds.includes("award") &&
      requested.some(
        (intent) => "awardFlag" in intent && intent.awardFlag === "taskAward",
      ) &&
      profile.taskAward !== true
    )
      reject("当前消息要求领取任务奖励，实际任务奖励开关不能关闭");
    if (
      limited &&
      plan.skillIds.includes("award") &&
      requested.some(
        (intent) => "awardFlag" in intent && intent.awardFlag === "taskAward",
      ) &&
      !requested.some(
        (intent) => "awardFlag" in intent && intent.awardFlag === "mail",
      ) &&
      (profile.mail !== false ||
        Object.keys(plannerAwardLabels).some(
          (key) => profile[key as keyof typeof plannerAwardLabels] !== false,
        ))
    )
      reject("只领任务奖励不能附带未授权的邮件或活动动作");
  }
  for (const snapshot of snapshots)
    for (const plugin of gamePlugins.list()) {
      if (!plugin.lane) continue;
      const plan = (snapshot as unknown as Record<string, unknown>)[
        plugin.lane.planKey
      ] as Plan | undefined;
      if (
        plan &&
        !scopes.some(
          (scope) =>
            scope.laneId === snapshot.lane.id && scope.gameId === plan.gameId,
        )
      )
        reject("冻结执行包含目标授权之外的账号或游戏");
    }
}
