import type { Frame, Rect } from "../../packages/runtime/device";
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

export const isShopDistrict = (f: Frame) =>
  !!findText(f, /^周边屋$/, [0, 930, 280, 150]) &&
  !!findText(f, /^魂玉屋$/, [1350, 930, 300, 150]) &&
  !!findText(f, /^礼包屋$/, [1550, 930, 300, 150]);

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

export const collectiveTaskTarget = (f: Frame) =>
  isCollectiveTaskPage(f)
    ? findText(f, /^提供N阶式神1个$/, [200, 150, 900, 600])
    : undefined;

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

export function hanaClaimAction(f: Frame) {
  if (!isHanaPage(f)) return undefined;
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

export function ownTrainingEntry(f: Frame): [number, number] | null {
  const left = findText(f, /^结界防守$/, [300, 300, 400, 500]);
  // Both variants were observed on the two realm skins; require the left sign too.
  const right = findText(f, /^(结界[卡上]|熊界卡)$/, [1100, 300, 450, 500]);
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
