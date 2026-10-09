import type { Frame, Rect, TextHit } from "../../packages/runtime/device";

const text = (hit: TextHit) => hit.text.normalize("NFKC").replace(/\s/g, "");
const inside = (hit: TextHit, [x, y, width, height]: Rect) =>
  hit.box[0] >= x &&
  hit.box[1] >= y &&
  hit.box[0] + hit.box[2] <= x + width &&
  hit.box[1] + hit.box[3] <= y + height;
const intersects = (hit: TextHit, [x, y, width, height]: Rect) =>
  hit.box[0] < x + width &&
  hit.box[1] < y + height &&
  hit.box[0] + hit.box[2] > x &&
  hit.box[1] + hit.box[3] > y;
function valid(frame: Frame) {
  return (
    frame.width === 1920 &&
    frame.height === 1080 &&
    frame.texts.every(
      (hit) =>
        typeof hit.text === "string" &&
        Number.isFinite(hit.score) &&
        hit.score >= 0 &&
        hit.score <= 1 &&
        hit.box.length === 4 &&
        hit.box.every(Number.isFinite) &&
        hit.box[2] > 0 &&
        hit.box[3] > 0 &&
        inside(hit, [0, 0, 1920, 1080]),
    )
  );
}
function unique(frame: Frame, pattern: RegExp, roi: Rect) {
  const hits = frame.texts.filter((hit) => pattern.test(text(hit)));
  return hits.length === 1 && hits[0].score >= 0.9 && inside(hits[0], roi)
    ? hits[0]
    : undefined;
}

/** No account, payment or unknown confirmation can be hidden by background login text. */
export function unsafeLoginUpdateFrame(frame: Frame) {
  return (
    !valid(frame) ||
    frame.texts.some(
      (hit) =>
        intersects(hit, [300, 150, 1320, 600]) &&
        /密码|验证码|实名认证|扫码登录|支付|购买|充值|必须更新|立即更新|确认|确定|取消/.test(
          text(hit),
        ),
    )
  );
}
export function hasCentralLoginPrompt(frame: Frame) {
  return frame.texts.some(
    (hit) =>
      intersects(hit, [650, 350, 650, 380]) &&
      /^(提示|警告|注意)$/.test(text(hit)),
  );
}

/** Anchors actually present in the captured OCR; no server or account name is assumed. */
export function isEngineUpdateLoginBackground(frame: Frame) {
  const footer = (pattern: RegExp, roi: Rect) =>
    frame.texts.some(
      (hit) => hit.score >= 0.9 && inside(hit, roi) && pattern.test(text(hit)),
    );
  return (
    valid(frame) &&
    Boolean(
      unique(frame, /^进入游戏$/, [750, 820, 450, 130]) &&
      unique(frame, /^用户协议与隐私政策$/, [1600, 0, 320, 100]) &&
      footer(
        /客户端[:：]\d+(?:\.\d+)+引擎[:：]\d+(?:\.\d+)+/,
        [40, 1000, 1840, 80],
      ) &&
      footer(/著作权人[:：]网易/, [40, 1030, 1840, 50]),
    )
  );
}

type UpdateDecision =
  | { kind: "absent" }
  | { kind: "blocked" }
  | { kind: "optional"; skip: TextHit };

/** This is the observed optional engine dialog, never a generic cancel/download rule. */
export function loginEngineUpdate(frame: Frame): UpdateDecision {
  if (!valid(frame)) return { kind: "blocked" };
  const possible =
    frame.texts.some(
      (hit) =>
        intersects(hit, [650, 350, 650, 380]) &&
        /更新|引擎|后台下载/.test(text(hit)),
    ) ||
    (hasCentralLoginPrompt(frame) &&
      frame.texts.some(
        (hit) =>
          intersects(hit, [650, 780, 650, 220]) &&
          /^(进入游戏|开始游戏|点击(?:屏幕)?进入游戏)$/.test(text(hit)),
      ));
  if (!possible) return { kind: "absent" };
  if (unsafeLoginUpdateFrame(frame) || !isEngineUpdateLoginBackground(frame))
    return { kind: "blocked" };
  const skip = unique(frame, /^暂不更新$/, [720, 600, 230, 75]);
  const download = unique(frame, /^后台下载$/, [980, 600, 235, 75]);
  const title = unique(frame, /^提示$/, [850, 390, 230, 75]);
  const body = frame.texts.filter((hit) => inside(hit, [710, 460, 490, 135]));
  const message = body
    .slice()
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
    .map(text)
    .join("");
  if (
    !skip ||
    !download ||
    !title ||
    !body.length ||
    body.some((hit) => hit.score < 0.9) ||
    Math.abs(
      skip.box[1] + skip.box[3] / 2 - download.box[1] - download.box[3] / 2,
    ) > 25 ||
    !/^发现全新的引擎版本[!！]更新包大小为\d+(?:\.\d+)?MB[。.]本次升级将提高游戏的稳定性和流畅性[,，]为了获得最佳的游戏体验[,，]建议更新[。.]?$/.test(
      message,
    )
  )
    return { kind: "blocked" };
  return { kind: "optional", skip };
}
