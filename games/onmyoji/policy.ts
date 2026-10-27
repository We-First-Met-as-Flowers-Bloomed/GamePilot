import type { Frame, Rect, TextHit } from "../../packages/runtime/device";
export function findText(frame: Frame, pattern: RegExp, roi?: Rect) {
  return frame.texts.find(
    (h) =>
      h.score >= 0.7 &&
      pattern.test(h.text.replace(/\s/g, "")) &&
      (!roi ||
        (h.box[0] >= roi[0] &&
          h.box[1] >= roi[1] &&
          h.box[0] + h.box[2] / 2 < roi[0] + roi[2] &&
          h.box[1] + h.box[3] / 2 < roi[1] + roi[3])),
  );
}
export function quotaFor(reputation: number) {
  if (
    !Number.isSafeInteger(reputation) ||
    reputation < 0 ||
    reputation > 1000000
  )
    throw new Error("声望识别无效");
  return reputation >= 10000 ? 3 : reputation >= 2000 ? 2 : 1;
}
export const isMap = (f: Frame) =>
  !!findText(f, /今[日目]挑战/, [0, 450, 230, 300]) &&
  !!(
    findText(f, /地域最强/, [0, 750, 230, 150]) ||
    findText(f, /筛选/, [1600, 0, 170, 180])
  );
export const isDetail = (f: Frame) =>
  !!findText(f, /难度选择/, [150, 140, 350, 130]) &&
  !!findText(f, /挑战/, [1600, 730, 260, 220]);
export const isExploration = (f: Frame) =>
  !!findText(f, /地域鬼王/, [550, 900, 1100, 180]);
export const isCourtyard = (f: Frame) =>
  !!findText(f, /^加成$/, [450, 0, 230, 180]) ||
  (!!findText(f, /^(探索|探)$/, [300, 100, 1200, 650]) &&
    !!findText(f, /式神录|阴阳术|好友|召唤/));
export const isCourtyardReward = (f: Frame) =>
  isCourtyard(f) && !!findText(f, /^获得奖励$/, [500, 200, 900, 300]);
export const isCourtyardTasks = (f: Frame) =>
  !!findText(f, /^庭院事务$/, [320, 0, 450, 180]) &&
  !findText(f, /^设置$/, [120, 0, 320, 150]);
export const hasOneKeyChores = (f: Frame) =>
  isCourtyardTasks(f) &&
  !!findText(f, /^一键$/, [1620, 830, 260, 170]) &&
  !!findText(f, /^完成$/, [1620, 900, 260, 170]);
/** The chores page remembers the last-open tab; an event tab hides the one-key
 * button. The 日常 tab anchor sits on the right edge whenever it is tappable. */
export function courtyardTasksDailyTabPoint(f: Frame): [number, number] | null {
  if (!isCourtyardTasks(f)) return null;
  const hit = findText(f, /^日常$/, [1580, 100, 340, 260]);
  if (!hit) return null;
  return [
    Math.round(hit.box[0] + hit.box[2] / 2),
    Math.round(hit.box[1] + hit.box[3] / 2),
  ];
}
export const isChoreClaimResult = (f: Frame) =>
  !!findText(f, /领取成功/, [320, 0, 600, 180]) &&
  !!findText(f, /完成啦|点击空白处关闭/, [0, 400, 1200, 680]);
/** The complete compact scroll is in front of the reward list on 2026-10-08.
 * A sign number alone can remain visible behind a different layer, so require
 * all four observed scroll anchors before changing the foreground priority.
 */
function foregroundDailySignClosePoint(f: Frame): [number, number] | null {
  if (f.width !== 1920 || f.height !== 1080 || centralConfirmation(f))
    return null;
  const visible = { ...f, texts: f.texts.filter((hit) => hit.score >= 0.9) };
  if (
    findText(visible, /^第\d+签$/, [650, 120, 320, 150]) &&
    findText(visible, /^奖励$/, [650, 470, 260, 130]) &&
    findText(visible, /^累计奖励$/, [650, 700, 320, 140]) &&
    findText(visible, /^解签$/, [1250, 600, 260, 200])
  )
    return [1310, 160];
  return null;
}
/** Observed 1920x1080 reward list: its panel covers the old bottom-centre tap. */
export function choreClaimClosePoint(f: Frame): [number, number] | null {
  if (
    f.width !== 1920 ||
    f.height !== 1080 ||
    !isChoreClaimResult(f) ||
    centralConfirmation(f) ||
    foregroundDailySignClosePoint(f)
  )
    return null;
  const title = findText(f, /^领取成功$/, [320, 0, 600, 180]);
  const hint = findText(f, /^点击空白处关闭(?:此界面)?$/, [500, 970, 900, 110]);
  if (!title || !hint || title.score < 0.9 || hint.score < 0.9) return null;
  // To the right of the captured panel, below navigation and above shop tabs.
  return [1860, 900];
}
/** Two observed sign-scroll layouts; never derive a click from an unknown overlay. */
export function dailySignClosePoint(f: Frame): [number, number] | null {
  if (centralConfirmation(f)) return null;
  const foreground = foregroundDailySignClosePoint(f);
  if (foreground) return foreground;
  // The scroll text can OCR through the foreground one-key reward list.
  if (isChoreClaimResult(f)) return null;
  const title = findText(f, /^第\d+签$/, [600, 60, 800, 250]);
  if (!title) return null;
  if (title.box[0] < 900 && findText(f, /^解签$/, [1300, 400, 300, 400]))
    return [1310, 160];
  if (
    title.box[0] >= 900 &&
    findText(f, /解签|签到\d+天领取/, [1450, 50, 450, 850])
  )
    return [1605, 105];
  return null;
}
export const isDailySignReward = (f: Frame) => dailySignClosePoint(f) !== null;

export function restoreBuffCancel(f: Frame) {
  const question = f.texts
    .filter(
      (h) =>
        h.score >= 0.7 &&
        h.box[0] >= 600 &&
        h.box[0] < 1300 &&
        h.box[1] >= 350 &&
        h.box[1] < 550,
    )
    .sort((a, b) => a.box[1] - b.box[1])
    .map((h) => h.text.replace(/\s/g, ""))
    .join("");
  if (
    !/是否打开.*之前.*自动关闭的加成/.test(question) ||
    !findText(f, /^确认$/, [950, 550, 350, 160])
  )
    return undefined;
  return findText(f, /^取消$/, [650, 550, 300, 160]);
}

/** Standard central dialog controls are a blocker, never permission to confirm. */
export function centralConfirmation(f: Frame) {
  const cancel = findText(f, /^取消$/, [650, 500, 300, 250]);
  const confirm = findText(f, /^(确认|确定)$/, [950, 500, 350, 250]);
  if (
    !cancel ||
    !confirm ||
    Math.abs(
      cancel.box[1] + cancel.box[3] / 2 - confirm.box[1] - confirm.box[3] / 2,
    ) > 60
  )
    return undefined;
  return { cancel, confirm };
}

/** The observed chores interruption: leave trained units in place, never extract. */
export function fullTrainingExtractionCancel(f: Frame) {
  const controls = centralConfirmation(f);
  if (!controls) return undefined;
  const body = f.texts
    .filter(
      (h) =>
        h.score >= 0.85 &&
        h.box[0] >= 650 &&
        h.box[0] + h.box[2] <= 1300 &&
        h.box[1] >= 400 &&
        h.box[1] + h.box[3] <= 560,
    )
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
    .map((h) => h.text.replace(/\s/g, ""))
    .join("");
  return /^您在结界中放置的式神已满级[，,]?请确认是否提取[？?]?$/.test(body)
    ? controls.cancel
    : undefined;
}

export const isMailbox = (f: Frame) =>
  !!findText(f, /^邮箱$/, [760, 0, 400, 180]) &&
  !!findText(f, /^(一键已读|删除已读)$/, [200, 820, 600, 220]);

export const hasMailOneKeyClaim = (f: Frame) =>
  isMailbox(f) &&
  !!findText(f, /^键$/, [120, 820, 140, 120]) &&
  !!findText(f, /^领取$/, [60, 860, 180, 130]);

export const isMailClaimConfirm = (f: Frame) =>
  !!findText(f, /^全部领取$/, [700, 0, 520, 180]) &&
  !!findText(f, /^确定$/, [1000, 730, 360, 250]);

export const isMailReward = (f: Frame) =>
  !!findText(f, /^获得奖励$/, [500, 100, 900, 400]) &&
  !!findText(f, /^邮箱$/, [760, 0, 400, 180]);

// Illustration animation obscures the mailbox, so use its own two anchors.
export const isIllustrationReward = (f: Frame) =>
  !!findText(f, /^获得插画$/, [650, 30, 650, 200]) &&
  !!findText(f, /^插画收集[:：]?第\d+张$/, [650, 900, 650, 160]);

export const isShop = (f: Frame) =>
  !!findText(f, /^热门推荐$/, [120, 0, 500, 160]) &&
  !!findText(f, /^礼包屋$/, [1550, 930, 280, 150]);

/** Locate the rendered daily tab between its actual surrounding tabs. */
export function dailyGiftTabPoint(f: Frame): [number, number] | null {
  if (!findText(f, /^礼包屋$/, [1550, 930, 280, 150]) || centralConfirmation(f))
    return null;
  const limited = findText(f, /^限时$/, [1700, 80, 200, 240]);
  const privilege = findText(f, /^特权$/, [1700, 500, 200, 380]);
  if (!limited || !privilege || limited.score < 0.9 || privilege.score < 0.9)
    return null;
  const roi: Rect = [1700, 300, 200, 410];
  const joined = findText(f, /^日常$/, roi);
  let point: [number, number] | null = null;
  if (joined && joined.score >= 0.9)
    point = [
      joined.box[0] + joined.box[2] / 2,
      joined.box[1] + joined.box[3] / 2,
    ];
  else {
    // The original vertical 日 character was captured as 印 at score 0.791.
    const top = findText(f, /^(日|印)$/, roi);
    const bottom = findText(f, /^常$/, roi);
    if (
      top &&
      bottom &&
      top.score >= 0.78 &&
      bottom.score >= 0.9 &&
      bottom.box[1] > top.box[1] &&
      bottom.box[1] - top.box[1] <= 100 &&
      Math.abs(
        top.box[0] + top.box[2] / 2 - bottom.box[0] - bottom.box[2] / 2,
      ) <= 35
    ) {
      const left = Math.min(top.box[0], bottom.box[0]);
      const right = Math.max(
        top.box[0] + top.box[2],
        bottom.box[0] + bottom.box[2],
      );
      point = [
        (left + right) / 2,
        (top.box[1] + bottom.box[1] + bottom.box[3]) / 2,
      ];
    }
  }
  return point &&
    point[1] > limited.box[1] + limited.box[3] &&
    point[1] < privilege.box[1]
    ? point
    : null;
}
// This verifies navigation only. The first 每日礼包 card must independently
// establish the daily list before the only permitted free claim can execute.
export const isGiftHouse = (f: Frame) => dailyGiftTabPoint(f) !== null;

/** 2026-10-14 更新后的商店街：底部为周边屋/寄售屋/插画屋/秘卷屋/秘魂屋/皮肤屋/杂货铺/
 *  魂玉屋/礼包屋。三个导航锚点仍然必须同时命中（缺一即停止后续商店输入），
 *  只放过实测到的 OCR 掉尾字：失败帧把「周边屋」读成「周边」（0.999，箱字丢失）。 */
export const isShopDistrict = (f: Frame) =>
  !!findText(f, /^周边屋?$/, [0, 930, 280, 150]) &&
  !!findText(f, /^魂玉屋?$/, [1350, 930, 300, 150]) &&
  !!findText(f, /^礼包屋?$/, [1550, 930, 300, 150]);

export const isDailyGiftList = (f: Frame) =>
  !!findText(f, /^每日礼包$/, [180, 150, 320, 180]) &&
  !!findText(f, /^礼包屋$/, [1550, 930, 280, 150]) &&
  !!findText(f, /^推荐$/, [150, 70, 250, 150]);

function dailyGiftCardHits(f: Frame) {
  if (!isDailyGiftList(f)) return [];
  const title = findText(f, /^每日礼包$/, [180, 150, 320, 180]);
  if (!title) return [];
  const left = Math.max(180, title.box[0] - 100);
  const right = Math.min(540, title.box[0] + title.box[2] + 120);
  return f.texts.filter(
    (hit) =>
      hit.score >= 0.7 &&
      hit.box[0] >= left &&
      hit.box[0] + hit.box[2] <= right &&
      hit.box[1] >= 390 &&
      hit.box[1] <= 520,
  );
}
function dailyGiftPriceText(value: string) {
  const text = value.replace(/\s/g, "");
  return (
    /^(?:[¥￥]|魂玉|勾玉|金币|售价|价格)?\d+(?:\.\d+)?(?:万)?$/.test(text) ||
    /(?:魂玉|勾玉|金币|售价|价格).*\d|\d.*(?:魂玉|勾玉|金币)/.test(text)
  );
}
/** Numeric entry evidence explains a refusal; OCR does not establish its exact price. */
export function hasPricedDailyGiftEntry(f: Frame): boolean {
  const hits = dailyGiftCardHits(f);
  return (
    hits.some((hit) => hit.score >= 0.9 && dailyGiftPriceText(hit.text)) &&
    !hits.some((hit) => /^(?:领取|已领取)$/.test(hit.text.replace(/\s/g, "")))
  );
}
/** The only permitted shop action is `领取` inside the first 每日礼包 card. */
export function dailyGiftAction(f: Frame) {
  const hits = dailyGiftCardHits(f);
  if (hits.some((hit) => dailyGiftPriceText(hit.text))) return undefined;
  return hits.find((hit) => /^领取$/.test(hit.text.replace(/\s/g, "")));
}

export const isDailyGiftReward = (f: Frame) =>
  !!findText(f, /^获得奖励$/, [500, 150, 900, 400]) &&
  !!findText(f, /^每日礼包$/, [250, 80, 520, 260]);

export const isDailyGiftDetail = (f: Frame) =>
  !!findText(f, /^每日礼包$/, [250, 80, 520, 260]) &&
  !!findText(f, /^免费$/, [300, 620, 420, 220]);

export const isGuild = (f: Frame) =>
  !!findText(f, /^阴阳[寮察]$/, [600, 0, 700, 140]);

/** 2026-10-14 周三更新后的「寮境」页面（左上角是返回，右侧竖排 寮境/装扮）。
 *  它的底部功能栏变成神社/祈愿/结界/寮信息，庭院锚点（探索/召唤/式神录）全部消失：
 *  实拍帧的离线 OCR 只能读出右下角「寮信息」（0.848）与左侧集体任务面板。
 *  停在寮境时所有庭院技能都会一直等到超时，必须先返回上一层。 */
export const isGuildRealm = (f: Frame) =>
  !!findText(f, /^寮信息$/, [1560, 900, 360, 180]) &&
  !!findText(f, /^集体任务/, [0, 150, 340, 640]) &&
  !isCourtyard(f);

export const isShrine = (f: Frame) =>
  !!findText(f, /^.?神社$/, [1650, 430, 260, 360]) &&
  (!!findText(f, /^狩猎战$/, [200, 500, 420, 260]) ||
    (!!findText(f, /^集体任务$/, [200, 180, 430, 240]) &&
      !!findText(f, /^道馆$/, [620, 180, 320, 240])));

export const isKirinHunt = (f: Frame) =>
  !!findText(f, /^狩猎战$/, [100, 0, 420, 150]) &&
  !!findText(f, /麒麟$/, [400, 200, 320, 380]);

export const isKirinVictory = (f: Frame) =>
  !!findText(f, /^[胜生]利$/, [900, 80, 700, 400]) &&
  !!findText(f, /^本次伤害$/, [650, 400, 650, 260]) &&
  !findText(f, /失败|战败/, [800, 80, 900, 450]);

export function isGuildKirinWindow(now = new Date()) {
  const china = new Date(now.getTime() + 8 * 3600000);
  const weekday = china.getUTCDay();
  const hour = china.getUTCHours();
  return weekday >= 1 && weekday <= 4 && hour >= 6 && hour < 23;
}

export const isCollectiveTaskPage = (f: Frame) =>
  !!findText(f, /^集体任务[！!]?$/, [650, 0, 700, 180]) &&
  !!findText(f, /今日已完|已达上限|领取奖励|提交/, [150, 500, 1550, 420]);

/**
 * 「退出游戏」确认框：误触返回键就会弹出来（2026-10-15 实测）。
 *
 * 危险点在于**框后面的庭院仍然会被 isCourtyard 认出来**，于是技能会以为一切正常、
 * 把点击打在框上。所以必须单独识别，而且只点「取消」——「确认」永远不碰。
 * 同时要求「取消」和「确认」都在，避免把别的对话框当成它。
 */
export function quitGameCancelPoint(f: Frame): [number, number] | undefined {
  const title = findText(f, /^退出游戏$/, [500, 350, 500, 120]);
  const ask = findText(f, /确定要退出游戏/, [450, 450, 500, 120]);
  const cancel = findText(f, /^取消$/, [1050, 590, 260, 120]);
  const confirm = findText(f, /^确认$/, [1240, 590, 260, 120]);
  if (!title || !ask || !cancel || !confirm) return undefined;
  return [cancel.box[0] + cancel.box[2] / 2, cancel.box[1] + cancel.box[3] / 2];
}

/**
 * 逢魔之时页（2026-10-16 实机取证，lane-a：标题 + 今日挑战次数 2/2 + 现世逢魔 0/4）。
 *
 * 存在的意义：`courtyard()` 只给"委派页/好友页/探索页/邮箱…"留了退路，
 * **没有逢魔之时**——一旦技能或人的点击把游戏带进这一页，`courtyard()` 就永远回不到庭院，
 * 整条阴阳师日常报「进入庭院检查每日签到失败」（当天 lane-a 就是这么卡的 ✓）。
 * 只认标题 + 底部两处稳定元素，避免命中探索页里同名的入口文字。
 */
export const isMakaiHourPage = (f: Frame) =>
  !!findText(f, /^逢魔之时$/, [600, 0, 700, 120]) &&
  (!!findText(f, /今日挑战次数/, [560, 60, 560, 110]) ||
    !!findText(f, /现世逢魔/, [1400, 960, 500, 120]));

/**
 * 「领取成功」签到奖励弹窗（2026-10-16 实机取证，lane-a）。
 *
 * 现场帧写着「领取成功」「第839签 半吉」「点击空白处关闭」——**奖励已经发放**，
 * 但弹窗盖住庭院，`courtyard()` 因此认不出庭院，整条阴阳师日常报
 * "进入庭院检查每日签到失败"（当天两个账号都被这一句挡住）。
 *
 * 按仓库既有范式处理（文字确权 + 固定关闭点）：
 *  - 三处文字**全部**命中才认，缺一不认（避免把别的弹窗误判成签到奖励）；
 *  - 只点右上角的 **✕**（帧里可点的关闭控件），**绝不**点空白区或奖励区；
 *  - 关闭点是固定坐标，由上面三处文字担保。
 */
export function signInRewardClosePoint(f: Frame): [number, number] | undefined {
  // 「领取成功」是会淡出的标题（实测：稍后再看就没了），所以拿三处**稳定**元素确权：
  // 第N签 + 累计奖励 + 底部提示。缺一不认。
  const ordinal = findText(f, /^第\d+签$/, [520, 130, 380, 110]);
  const totals = findText(f, /^累计奖励$/, [560, 660, 320, 120]);
  const hint = findText(f, /点击空白处关闭/, [600, 930, 700, 150]);
  if (!ordinal || !totals || !hint) return undefined;
  // 1280×720 实测里 ✕ 位于 (880,105)，换算到 1920×1080 约 (1320,158)。
  return [1320, 158];
}

/**
 * 式神委派页（探索 → 式神委派）。
 *
 * 存在的意义是**认出"已经在游戏里"**：2026-10-15 实测，游戏停在委派页时 `loggedIn`
 * 的白名单里没有它 → login 判定"没进游戏" → 重启游戏 → 启动等待超时 → 整条日常报废。
 * 只认标题全等，避免命中探索页底部那行「式神委派秘闻副本地域鬼王…」的合并文本。
 */
export const isShikigamiDispatch = (f: Frame) =>
  !!findText(f, /^式神委派$/, [100, 0, 600, 130]);
/** 好友页（吉闻 + 好友计数），人可能手动停在上面。 */
export const isFriendPage = (f: Frame) =>
  !!findText(f, /^好友$/, [850, 40, 320, 90]) &&
  !!findText(f, /好友[：:]\s*\d+\s*\/\s*\d+/, [200, 180, 700, 120]);
export const collectiveTaskTarget = (f: Frame) =>
  isCollectiveTaskPage(f)
    ? findText(f, /^提供N阶式神1个$/, [200, 150, 900, 600])
    : undefined;

/**
 * 新版集体任务三张卡的按钮（2026-10-15 实测）：
 *  - 「领取奖励」= 已完成的指定任务，零成本，可以领；
 *  - 「提交」= 选卡，要提供 N 阶式神（消耗式神），是否做由大人决定，这里只识别不点击。
 * 两者都只在确认是集体任务页时才返回，避免在别的弹窗上误判。
 */
export const collectiveClaimAction = (f: Frame) =>
  isCollectiveTaskPage(f)
    ? findText(f, /^领取奖励$/, [150, 500, 1550, 420])
    : undefined;

export const collectiveSubmitAction = (f: Frame) =>
  isCollectiveTaskPage(f) ? findText(f, /^提交$/, [150, 500, 1550, 420]) : undefined;

export function collectiveProgress(f: Frame) {
  const hit = findText(
    f,
    /(?:今日已完成(?:次数)?)[（(]?\d+\/\d+[）)]?(?:次)?/,
    [0, 150, 1920, 850],
  );
  const values = hit?.text.match(/(\d+)\s*\/\s*(\d+)/);
  if (!values) return undefined;
  const completed = Number(values[1]);
  const total = Number(values[2]);
  if (
    !Number.isSafeInteger(completed) ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    completed < 0 ||
    completed > total
  )
    return undefined;
  return { completed, total };
}

export type FosterCandidate = {
  kind: "taiko" | "douyu";
  stars: number;
  page: number;
  row: number;
};

export function chooseFosterCandidate(candidates: FosterCandidate[]) {
  return candidates
    .filter(
      (candidate) =>
        Number.isSafeInteger(candidate.stars) &&
        candidate.stars >= 1 &&
        candidate.stars <= 6,
    )
    .sort(
      (a, b) =>
        Number(b.kind === "taiko") - Number(a.kind === "taiko") ||
        b.stars - a.stars ||
        a.page - b.page ||
        a.row - b.row,
    )[0];
}

export const isFosterFriendList = (f: Frame) =>
  !!findText(f, /^式神育成$/, [0, 0, 450, 180]) &&
  !!findText(f, /^好友$/, [250, 100, 350, 200]) &&
  !!findText(f, /进入好友结界寄养式神/, [900, 100, 750, 180]) &&
  !!findText(f, /^进入结界$/, [1050, 700, 500, 260]);

export function fosterCardKind(f: Frame): "taiko" | "douyu" | undefined {
  if (!isFosterFriendList(f)) return undefined;
  if (
    findText(f, /^太鼓$/, [1100, 500, 450, 90]) &&
    findText(f, /^勾玉\+\d+$/, [1100, 590, 450, 150])
  )
    return "taiko";
  if (
    findText(f, /^斗鱼$/, [1100, 500, 450, 90]) &&
    findText(f, /^体力\+\d+$/, [1100, 590, 450, 150])
  )
    return "douyu";
}

export function fosterNames(f: Frame) {
  if (!isFosterFriendList(f)) return [];
  const names = f.texts.filter(
    (hit) =>
      hit.score >= 0.8 &&
      hit.box[0] >= 450 &&
      hit.box[0] <= 780 &&
      hit.box[1] >= 220 &&
      hit.box[1] <= 920 &&
      !/^(好友|跨区|最近寄养)$/.test(hit.text.trim()) &&
      /[\u4e00-\u9fffA-Za-z]/.test(hit.text) &&
      hit.text.length <= 30,
  );
  return names.map((name) => ({
    name: name.text.normalize("NFKC").replace(/\s/g, ""),
    y: Math.round(name.box[1] + name.box[3] / 2),
  }));
}

export const isHanaPage = (f: Frame) =>
  !!findText(f, /^花合战$/, [0, 0, 500, 180]) &&
  !!findText(f, /今日|任务|奖励/, [150, 50, 1770, 850]);

/** Monthly introduction, not the reward/task page or an unknown confirmation. */
export function hanaPromotionClosePoint(f: Frame): [number, number] | null {
  if (
    centralConfirmation(f) ||
    findText(f, /^(确认|确定)$/, [650, 400, 650, 400]) ||
    findText(
      f,
      /购买|支付|消耗|密码|验证码|实名认证|扫码登录|继续刚才的战斗|退出战斗/,
    )
  )
    return null;
  const title = findText(f, /^花合战[·・:：].+月$/, [1320, 40, 320, 430]);
  const date = findText(
    f,
    /^\d{2}\/\d{2}[-—–]\d{2}\/\d{2}$/,
    [1320, 40, 220, 430],
  );
  // M is the only spurious prefix observed in the real captured prompt.
  const hint = findText(f, /^M?点击空白处关闭此界面$/, [500, 930, 1000, 150]);
  if (
    !title ||
    !date ||
    !hint ||
    [title, date, hint].some((h) => h.score < 0.9)
  )
    return null;
  const [month, day, endMonth, endDay] = date.text
    .replace(/\s/g, "")
    .split(/[\/—–-]/)
    .map(Number);
  const days = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    endMonth !== month ||
    day < 1 ||
    endDay < day ||
    endDay > days[month]
  )
    return null;
  return [1700, 900];
}

/**
 * 过期活动邀请函浮层：2026-10-15 实测「诞生庆典·邀请函」（活动期 10.10–10.12，过期后
 * 仍会挂在庭院上）把庭院事务入口挡住，`check-in` 因此报「画面未进入预期状态」。
 * 它的关闭按钮是无文字的右上角 ×，只能按实测坐标点。
 *
 * 沿用花合战宣传页同样的安全约定：画面上只要出现确认/购买/消耗类文字就一律不动，
 * 宁可停下等人核对，也不赌一个坐标。
 */
export function promoInvitationClosePoint(f: Frame): [number, number] | null {
  if (
    centralConfirmation(f) ||
    findText(f, /^(确认|确定)$/, [650, 400, 650, 400]) ||
    findText(
      f,
      /购买|支付|消耗|密码|验证码|实名认证|扫码登录|继续刚才的战斗|退出战斗/,
    )
  )
    return null;
  const title = findText(f, /邀请函$/, [900, 300, 700, 140]);
  const enter = findText(f, /^前往庆典$/, [1500, 350, 300, 450]);
  // 活动期形如 10.10(20:00) / 10.10（20:00）。
  const period = findText(
    f,
    /^\d{2}\.\d{2}\s*[（(]\d{2}:\d{2}[）)]$/,
    [1450, 200, 380, 150],
  );
  if (!title || !enter || !period) return null;
  if ([title, enter, period].some((hit) => hit.score < 0.9)) return null;
  return [1801, 176];
}

export function hanaClaimAction(f: Frame) {  if (!isHanaPage(f)) return undefined;
  const joined = findText(f, /^全部领取$/, [1200, 650, 650, 400]);
  if (joined) return joined;
  const top = findText(f, /^全部$/, [1250, 800, 400, 220]);
  const bottom = findText(f, /^领取$/, [1250, 850, 400, 200]);
  if (
    top &&
    bottom &&
    bottom.box[1] > top.box[1] &&
    bottom.box[1] - top.box[1] <= 85 &&
    Math.abs(top.box[0] + top.box[2] / 2 - bottom.box[0] - bottom.box[2] / 2) <=
      40
  )
    return bottom;
  return undefined;
}

export const isHanaTaskPage = (f: Frame) =>
  isHanaPage(f) && !!findText(f, /今日|每日任务/, [300, 100, 1450, 750]);

export function hanaTaskState(f: Frame): "claim" | "empty" | null {
  if (!isHanaTaskPage(f)) return null;
  if (hanaClaimAction(f)) return "claim";
  if (findText(f, /^(领取|领取奖励|可领取)$/, [650, 220, 1100, 700]))
    return null;
  // Missing OCR alone is not proof that rewards have been collected. Require
  // the rendered task list and its non-claimable row controls, or an explicit message.
  if (
    findText(f, /暂无可领取奖励|全部已领取|奖励已领取/, [650, 220, 1100, 700])
  )
    return "empty";
  const rows = f.texts.filter(
    (h) =>
      h.score >= 0.85 &&
      /^(前往|已领取|已完成)$/.test(h.text.trim()) &&
      h.box[0] >= 1400 &&
      h.box[0] < 1740 &&
      h.box[1] >= 300 &&
      h.box[1] < 820,
  );
  return new Set(rows.map((h) => Math.round(h.box[1] / 70))).size >= 2
    ? "empty"
    : null;
}

export const isHanaReward = (f: Frame) =>
  !!findText(f, /^获得奖励$/, [500, 100, 950, 500]);

export const isTrainingPage = (f: Frame) =>
  !!findText(f, /^式神育成$/, [0, 0, 450, 180]) &&
  !!findText(f, /可寄养式神|我的寄养/, [1500, 0, 400, 280]);

/**
 * 结界页的三块木牌：左「结界防守」、中「式神育成」、右「结界卡」。
 *
 * 2026-10-15 lane-b（账号二）实测：木牌会随场景轻微摆动，竖排美术字 OCR 时好时坏——
 * 左牌被读成「结界陵守」（防→陵，0.798），中牌整块读不出。所以：
 *  - 判据容忍已观测到的 OCR 变体（只认「防守」会让整块育成入口找不到）；
 *  - 「是不是结界页」只靠左右两块能读到的牌子判断，中间入口用两者中点推算（见 ownTrainingEntry）。
 */
export const isRealmSignsPage = (f: Frame) =>
  !!findText(f, /^结界[防陵]守$/, [300, 300, 400, 500]) &&
  !!findText(f, /^(结界[卡上]|熊界卡)$/, [1100, 300, 450, 500]);

const realmSigns = (f: Frame) => ({
  left: findText(f, /^结界[防陵]守$/, [300, 300, 400, 500]),
  // Both variants were observed on the two realm skins; require the left sign too.
  right: findText(f, /^(结界[卡上]|熊界卡)$/, [1100, 300, 450, 500]),
});

export function ownTrainingEntry(f: Frame): [number, number] | null {
  const { left, right } = realmSigns(f);
  if (!left || !right || Math.abs(left.box[1] - right.box[1]) > 100)
    return null;
  return [
    (left.box[0] + left.box[2] / 2 + right.box[0] + right.box[2] / 2) / 2,
    (left.box[1] + left.box[3] / 2 + right.box[1] + right.box[3] / 2) / 2,
  ];
}

// The tooltip sits above the first slot when the second one is still locked.
const hasEmptyFriendFosterSlot = (f: Frame) =>
  !!findText(f, /^可放置式神寄养$/, [1250, 0, 650, 160]);

export const isFriendRealm = (f: Frame) =>
  !!findText(f, /^式神育成$/, [0, 0, 450, 180]) &&
  !!findText(f, /的结界$/, [600, 0, 700, 160]) &&
  hasEmptyFriendFosterSlot(f);

export const isFosterActive = (f: Frame) =>
  !!findText(f, /^式神育成$/, [0, 0, 450, 180]) &&
  !!findText(f, /的结界$/, [600, 0, 700, 160]) &&
  !!findText(f, /^好友寄养$/, [1250, 0, 500, 260]) &&
  !hasEmptyFriendFosterSlot(f) &&
  !!findText(f, /^\d{2}[:：]\d{2}[:：]\d{2}$/, [1450, 0, 470, 300]);
export function isChoreComplete(f: Frame, name: RegExp) {
  const task = findText(f, name, [380, 130, 1000, 850]);
  if (!task) return false;
  const taskY = task.box[1] + task.box[3] / 2;
  return f.texts.some((hit) => {
    const statusY = hit.box[1] + hit.box[3] / 2;
    return (
      hit.score >= 0.7 &&
      /^已完成$/.test(hit.text.replace(/\s/g, "")) &&
      hit.box[0] >= 1400 &&
      Math.abs(statusY - taskY) <= 80
    );
  });
}
export function personalScore(f: Frame): number | null {
  const hit = findText(f, /评分\d+/, [1400, 610, 320, 140]);
  if (!hit) {
    // The personal score label and orange digits can be separate OCR boxes.
    // Require one confident number immediately right of the label on its row;
    // world/group ranks and the lower leaderboard player's score are excluded.
    const label = findText(f, /^评分$/, [1400, 610, 320, 140]);
    if (label) {
      const numbers = f.texts.filter(
        (h) =>
          h.score >= 0.8 &&
          /^\d+$/.test(h.text.trim()) &&
          h.box[0] >= Math.max(1550, label.box[0] + label.box[2] * 0.6) &&
          h.box[0] + h.box[2] <= 1720 &&
          Math.abs(
            h.box[1] + h.box[3] / 2 - (label.box[1] + label.box[3] / 2),
          ) <=
            label.box[3] * 0.6,
      );
      if (numbers.length > 1) return null;
      if (numbers.length === 1) {
        const value = Number(numbers[0].text.trim());
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
      }
    }
    // Observed zero-score layout splits the small 0 from its label. Both
    // independent unranked markers are required; missing OCR is never zero.
    if (
      findText(f, /^评分$/, [1400, 610, 320, 140]) &&
      findText(f, /^无$/, [1060, 625, 125, 100]) &&
      findText(f, /^无$/, [1330, 625, 125, 100])
    )
      return 0;
    return null;
  }
  const value = Number(hit.text.replace(/\s/g, "").match(/评分(\d+)/)?.[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function bossName(f: Frame) {
  const name =
    findText(
      f,
      /^[\u4e00-\u9fff]{2,12}[!！]?$/,
      [170, 40, 430, 120],
    )?.text.replace(/[\s!！]/g, "") ?? null;
  // Observed on the same 鸟巢 detail before/after settlement (2026-09-30).
  // Canonicalize only this complete OCR alias, including for today's deduplication.
  return name === "乌巢" ? "鸟巢" : name;
}
export const gameDay = (now = new Date()) =>
  new Date(now.getTime() + 2 * 3600000).toISOString().slice(0, 10);
export const isVictory = (f: Frame) =>
  !!findText(f, /^[胜生]利$/, [900, 80, 720, 420]) &&
  !!findText(f, /本次评分/, [1050, 800, 600, 190]) &&
  !findText(f, /失败|战败/, [800, 80, 900, 450]);

/** 胧车（八岐大蛇·悲鸣）挂机任务卡：标题是最强锚点，覆盖两页卡片与结算弹窗。 */
export const oborogurumaTitle = (f: Frame) =>
  findText(f, /八岐大蛇/, [420, 30, 1500, 320]);
export const isOborogurumaActivity = (f: Frame) =>
  !!findText(f, /胧车探索/, [0, 0, 500, 160]);
export const isOborogurumaCard = (f: Frame) =>
  !!oborogurumaTitle(f) &&
  !!(
    findText(f, /^下一步$/) ||
    findText(f, /^出发$/) ||
    // 金色装饰按钮的美术字 OCR 常读不出；用两页各自必有、OCR 实测可读的
    // 面板标签补足判据（第一页「使用胧车」，第二页「累计消耗」）。
    findText(f, /^使用胧车$/) ||
    findText(f, /^累计消耗$/)
  );
/** 自动上阵提示：仅当三个锚点齐全才允许点确定，避免把其他确认弹窗当成配置。 */
export const oborogurumaAutoEquipDialog = (f: Frame) =>
  findText(f, /自动上阵/, [420, 260, 1080, 480]) &&
  findText(f, /^重新配置$/, [560, 560, 420, 220]) &&
  findText(f, /^确定$/, [1020, 560, 420, 220]);
export const oborogurumaNextStep = (f: Frame) =>
  isOborogurumaCard(f) ? findText(f, /^下一步$/) : undefined;
export const oborogurumaDepart = (f: Frame) =>
  isOborogurumaCard(f) ? findText(f, /^出发$/) : undefined;
/** 卡片第二页左侧的加成入口；庭院同名词在固定 ROI 内，用卡片锚点区分。 */
export const oborogurumaBuffButton = (f: Frame) =>
  isOborogurumaCard(f) ? findText(f, /^加成$/) : undefined;
/** 加成面板：多行剩余天数且无出发按钮；行文本必须含八岐大蛇。 */
export const isOborogurumaBuffPanel = (f: Frame) =>
  !findText(f, /^出发$/) &&
  !findText(f, /^下一步$/) &&
  f.texts.filter((h) => h.score >= 0.7 && /^\d{1,3}天$/.test(h.text)).length >=
    3;
export const oborogurumaBuffRow = (f: Frame) =>
  isOborogurumaBuffPanel(f) ? findText(f, /八岐大蛇/) : undefined;
/** 行内剩余天数角标；用于向右定位该行的使用按钮。 */
export function oborogurumaBuffChip(f: Frame, row: TextHit) {
  return f.texts
    .filter(
      (h) =>
        h.score >= 0.7 &&
        /^\d{1,3}天$/.test(h.text) &&
        Math.abs(
          h.box[1] + h.box[3] / 2 - (row.box[1] + row.box[3] / 2),
        ) <=
          row.box[3] &&
        h.box[0] > row.box[0],
    )
    .sort((a, b) => a.box[0] - b.box[0])
    .at(-1);
}
/** 次数读数：优先整段 N/M，其次限定在卡片下半区的组合命中。 */
export function oborogurumaCount(
  f: Frame,
): { done: number; total: number; box: [number, number, number, number] } | null {
  const parse = (hit: TextHit) => {
    const match = hit.text.replace(/\s/g, "").match(/(\d{1,3})\/(\d{1,3})$/);
    if (!match) return null;
    const done = Number(match[1]);
    const total = Number(match[2]);
    return Number.isSafeInteger(done) &&
      Number.isSafeInteger(total) &&
      total > 0 &&
      done >= 0 &&
      done <= total
      ? {
          done,
          total,
          box: [hit.box[0], hit.box[1], hit.box[2], hit.box[3]] as [
            number,
            number,
            number,
            number,
          ],
        }
      : null;
  };
  const whole = f.texts.find(
    (h) => h.score >= 0.7 && /^(\d{1,3})\/(\d{1,3})$/.test(h.text.replace(/\s/g, "")),
  );
  if (whole) return parse(whole);
  const combined = f.texts
    .filter((h) => h.score >= 0.7 && /(\d{1,3})\/(\d{1,3})/.test(h.text))
    .map((h) => parse(h))
    .find(Boolean);
  return combined ?? null;
}
/** 挂机结算弹窗：八岐大蛇标题 + 探索结束/完成 + 确认，三者齐全才可视为已完成轮次。 */
/**
 * 结算页（探索完成）。2026-10-15 实机：标题「探索完成」在 y≈83、确认按钮在 x≈1502，
 * 旧的 ROI（y≥100 / x≤1160）两条都落空，导致结算页根本认不出来、技能转而去庭院然后失败。
 */
export const oborogurumaSettlementConfirm = (f: Frame) =>
  oborogurumaTitle(f)
    ? findText(f, /^确认$/, [1350, 760, 480, 240])
    : undefined;
export const oborogurumaSettlement = (f: Frame) =>
  !!oborogurumaTitle(f) &&
  !!findText(f, /探索(结束|完成)/, [400, 0, 1200, 800]) &&
  !!oborogurumaSettlementConfirm(f);
