import type { Frame, Rect } from "../../packages/runtime/device";
import { arknightsPackage, type ArknightsConfig } from "./config";
import { creditShopBalance } from "./credit-shopping";

export type ArknightsPage =
  | "home"
  | "profile"
  | "friends-list"
  | "credit-shop"
  | "battle"
  | "settlement"
  | "login"
  | "network-error"
  | "unknown"
  | "other-app";
export interface ArknightsFrameEvidence {
  page: ArknightsPage;
  uid?: string;
  anchors: string[];
  /** Exact home Friends entry center, in this captured frame's physical pixels. */
  friendsEntry?: [number, number];
}
export interface ArknightsInspection {
  page: ArknightsPage;
  pageVerified: boolean;
  accountVerified: boolean;
  account: "matched" | "mismatch" | "unknown" | "unbound";
  observedUid?: string;
  expectedUid: string;
  frames: ArknightsFrameEvidence[];
  message: string;
}
export const arknightsPageLabels: Record<ArknightsPage, string> = {
  home: "主页",
  profile: "个人名片",
  "friends-list": "好友列表",
  "credit-shop": "信用商店",
  battle: "战斗中",
  settlement: "结算页",
  login: "登录页或登录提示",
  "network-error": "网络异常提示",
  unknown: "无法确认",
  "other-app": "非目标明日方舟客户端",
};
/** Evidence for inspection only; never a task completion assertion. Coordinates normalize to 1920x1080. */
export function classifyArknightsFrame(
  frame: Frame,
  foregroundPackage: string | undefined,
  config: ArknightsConfig,
): ArknightsFrameEvidence {
  if (foregroundPackage !== arknightsPackage(config))
    return { page: "other-app", anchors: [] };
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    Math.abs(frame.width / frame.height - 16 / 9) > 0.02
  )
    return { page: "unknown", anchors: [] };
  const hits = frame.texts
    .filter(
      (h) =>
        Number.isFinite(h.score) &&
        h.score >= 0.9 &&
        h.box.every(Number.isFinite) &&
        h.box[0] >= 0 &&
        h.box[1] >= 0 &&
        h.box[2] > 0 &&
        h.box[3] > 0 &&
        h.box[0] + h.box[2] <= frame.width &&
        h.box[1] + h.box[3] <= frame.height,
    )
    .map((h) => ({
      ...h,
      text: h.text.replace(/\s/g, ""),
      box: [
        (h.box[0] * 1920) / frame.width,
        (h.box[1] * 1080) / frame.height,
        (h.box[2] * 1920) / frame.width,
        (h.box[3] * 1080) / frame.height,
      ] as Rect,
    }));
  const anchors: string[] = [];
  const has = (pattern: RegExp, roi: Rect = [0, 0, 1920, 1080]) => {
    const h = hits.find(
      (h) =>
        pattern.test(h.text) &&
        h.box[0] >= roi[0] &&
        h.box[1] >= roi[1] &&
        h.box[0] + h.box[2] <= roi[0] + roi[2] &&
        h.box[1] + h.box[3] <= roi[1] + roi[3],
    );
    if (h) anchors.push(h.text);
    return Boolean(h);
  };
  if (
    has(
      /(?:网络|连接|通讯).*(?:失败|异常|中断|错误)|无法连接服务器/,
      [300, 220, 1320, 650],
    )
  )
    return { page: "network-error", anchors };
  if (
    has(
      /请重新登录|登录失效|账号.*(?:异地|其他设备)|账号登录|密码登录|验证码登录/,
      [300, 160, 1320, 780],
    ) ||
    has(/^START$/i, [400, 600, 1100, 450])
  )
    return { page: "login", anchors };
  if (has(/^(?:确认|确定|取消|返回登录|重新连接)$/, [400, 250, 1120, 650]))
    return { page: "unknown", anchors };
  if (
    has(
      /^(?:确认购买|购买)$|是否.*(?:购买|退出|返回|放弃)|确认.*(?:购买|消耗|兑换)|(?:源石|理智药).*(?:兑换|恢复)/,
      [400, 250, 1120, 650],
    )
  )
    return { page: "unknown", anchors };
  if (creditShopBalance(frame) !== undefined)
    return {
      page: "credit-shop",
      anchors: ["信用交易所", "信用获取规则", "库存更新倒计时"],
    };
  if (
    has(/^我的信息$/, [1000, 20, 280, 100]) &&
    [/^1?个人名片$/, /^好友列表$/, /^添加好友$/, /^助战干员$/].every((p) =>
      has(p, [20, 140, 310, 525]),
    ) &&
    has(/^好友\d{1,3}\/\d{1,3}$/, [0, 950, 400, 130])
  )
    return { page: "friends-list", anchors };
  if (
    has(/^我的信息$/, [1000, 20, 280, 100]) &&
    [/^个人名片$/, /^好友列表$/, /^添加好友$/, /^助战干员$/].every((p) =>
      has(p, [20, 140, 310, 525]),
    )
  ) {
    const ids = hits
      .filter(
        (h) =>
          h.score >= 0.95 &&
          h.box[0] >= 1200 &&
          h.box[1] >= 275 &&
          h.box[0] + h.box[2] <= 1550 &&
          h.box[1] + h.box[3] <= 380,
      )
      .map((h) => /^(?:ID|UID)[：:]?([0-9]{6,12})$/i.exec(h.text)?.[1])
      .filter((id): id is string => Boolean(id));
    if (new Set(ids).size > 1) return { page: "unknown", anchors };
    return {
      page: "profile",
      uid: ids.length === 1 ? ids[0] : undefined,
      anchors,
    };
  }
  const battle =
    has(/接管作战/, [350, 800, 1100, 280]) &&
    has(/^\d+\/\d+$/, [600, 0, 700, 160]) &&
    has(/剩余可放置角色/, [1250, 680, 670, 300]);
  if (battle) return { page: "battle", anchors };
  if (
    has(/^(?:行动结束|MISSIONACCOMPLISHED)$/i) &&
    has(/^(?:获得物资|获得报酬|作战报酬|EXP)$/i)
  )
    return { page: "settlement", anchors };
  const homeAnchors = [
    /^(?:任务[：:]?|Mission)$/i,
    /^(?:基建[：:]?|Base)$/i,
    /^公开招募$/,
    /^(?:干员[：:]?|Operator)$/i,
  ].filter((p) => has(p, [950, 400, 970, 640]));
  if (homeAnchors.length < 3) return { page: "unknown", anchors };
  const ids = hits
    .filter(
      (h) =>
        h.score >= 0.95 &&
        h.box[0] < 450 &&
        h.box[1] >= 420 &&
        h.box[1] + h.box[3] <= 780,
    )
    .map((h) => {
      const labelled = /^(?:UID|ID)[：:]?([0-9]{6,12})$/i.exec(h.text)?.[1];
      if (labelled) {
        // Home OCR can truncate the white ID. A strict prefix is incomplete,
        // not identity proof; let the existing same-image crop read the full ID.
        return config.expectedUid &&
          labelled.length < config.expectedUid.length &&
          config.expectedUid.startsWith(labelled)
          ? undefined
          : labelled;
      }
      // Verified 16:9 home ID digits crop. Never interpret arbitrary numbers as identity.
      return h.score >= 0.98 &&
        /^[0-9]{9}$/.test(h.text) &&
        h.box[0] >= 112 &&
        h.box[0] <= 116 &&
        h.box[1] >= 633 &&
        h.box[1] <= 637 &&
        h.box[2] >= 124 &&
        h.box[2] <= 128 &&
        h.box[3] >= 22 &&
        h.box[3] <= 26
        ? h.text
        : undefined;
    })
    .filter((x): x is string => Boolean(x));
  // A contradictory identity is unsafe, not simply a missing home UID.
  if (new Set(ids).size > 1) return { page: "unknown", anchors };
  const uid = ids.length === 1 ? ids[0] : undefined;
  const friends = hits.filter(
    (h) =>
      /^(?:好友|Friends)$/i.test(h.text) &&
      h.box[0] >= 350 &&
      h.box[1] >= 700 &&
      h.box[0] + h.box[2] <= 800 &&
      h.box[1] + h.box[3] <= 940,
  );
  const chinese = friends.filter((h) => h.text === "好友");
  const candidates = chinese.length ? chinese : friends;
  const target = candidates.length === 1 ? candidates[0] : undefined;
  const friendsEntry: [number, number] | undefined = target
    ? [
        Math.round(((target.box[0] + target.box[2] / 2) * frame.width) / 1920),
        Math.round(((target.box[1] + target.box[3] / 2) * frame.height) / 1080),
      ]
    : undefined;
  return {
    page: "home",
    uid,
    anchors,
    ...(friendsEntry ? { friendsEntry } : {}),
  };
}
export function compareArknightsFrames(
  first: ArknightsFrameEvidence,
  second: ArknightsFrameEvidence,
  config: ArknightsConfig,
): ArknightsInspection {
  const stable = first.page === second.page;
  const page = stable ? second.page : "unknown";
  const pageVerified = stable && page !== "unknown" && page !== "other-app";
  const observedUid =
    page === "home" && first.uid && first.uid === second.uid
      ? second.uid
      : undefined;
  const account = !config.expectedUid
    ? "unbound"
    : !observedUid
      ? "unknown"
      : observedUid === config.expectedUid
        ? "matched"
        : "mismatch";
  const message =
    account === "matched"
      ? "两帧主页 UID 与预设账号一致；此结果仅反映读取时的身份，不证明任务已完成。"
      : account === "mismatch"
        ? "当前 UID 与预设账号不符，禁止据此续跑。"
        : account === "unbound"
          ? "未设置核验 UID；不会将当前读取到的账号自动设为可信账号。"
          : "没有两帧一致的主页 UID，账号身份尚未核验。";
  return {
    page,
    pageVerified,
    accountVerified: account === "matched",
    account,
    observedUid,
    expectedUid: config.expectedUid,
    frames: [first, second],
    message,
  };
}
