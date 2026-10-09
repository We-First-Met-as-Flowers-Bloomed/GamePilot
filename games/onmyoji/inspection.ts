import type { Frame } from "../../packages/runtime/device";
import type { IncidentScreen } from "../../packages/protocol/incident-agent";
import {
  choreClaimClosePoint,
  dailySignClosePoint,
  hanaPromotionClosePoint,
  isCourtyard,
  isCourtyardReward,
  isDailyGiftList,
  isDailyGiftReward,
  isGiftHouse,
  isIllustrationReward,
  isMailbox,
  isMailReward,
  isShop,
  isShopDistrict,
} from "./policy";

/** Classification only. No OCR text, coordinates or account-proof claim leave the worker. */
export function classifyOnmyojiFrame(frame: Frame): IncidentScreen {
  if (
    frame.width !== 1920 ||
    frame.height !== 1080 ||
    !Array.isArray(frame.texts) ||
    frame.texts.some(
      (hit) =>
        !Number.isFinite(hit.score) ||
        typeof hit.text !== "string" ||
        hit.box.length !== 4 ||
        !hit.box.every(Number.isFinite) ||
        hit.box[0] < 0 ||
        hit.box[1] < 0 ||
        hit.box[2] <= 0 ||
        hit.box[3] <= 0 ||
        hit.box[0] + hit.box[2] > frame.width ||
        hit.box[1] + hit.box[3] > frame.height,
    )
  )
    return "unknown";
  const texts = frame.texts
    .filter((hit) => hit.score >= 0.7)
    .map((hit) => hit.text.replace(/\s/g, ""));
  if (texts.some((text) => /验证码|安全验证|滑动验证|拖动滑块/.test(text)))
    return "verification-code";
  if (
    texts.some((text) =>
      /密码|实名认证|扫码登录|请输入(?:账号|手机)|^(?:登录|立即登录|账号登录|手机号登录)$/.test(
        text,
      ),
    )
  )
    return "identity-input";
  if (
    texts.some((text) =>
      /支付|付款|确认购买|是否购买|充值确认|是否消耗/.test(text),
    )
  )
    return "payment";
  if (
    texts.some((text) =>
      /^(?:确认|确定|取消)$|是否继续刚才的战斗|退出战斗/.test(text),
    )
  )
    return "unknown-confirmation";
  const safe = {
    ...frame,
    texts: frame.texts.filter((hit) => hit.score >= 0.9),
  };
  if (choreClaimClosePoint(safe)) return "onmyoji-chore-reward";
  if (hanaPromotionClosePoint(safe)) return "onmyoji-hana-promotion";
  if (dailySignClosePoint(safe)) return "onmyoji-sign-reward";
  if (isMailReward(safe)) return "onmyoji-mail-reward";
  if (isIllustrationReward(safe)) return "onmyoji-illustration-reward";
  if (isDailyGiftReward(safe)) return "onmyoji-gift-reward";
  if (isCourtyardReward(safe)) return "onmyoji-courtyard-reward";
  if (isDailyGiftList(safe)) return "onmyoji-daily-gift-list";
  if (isGiftHouse(safe)) return "onmyoji-gift-house";
  if (isShop(safe) || isShopDistrict(safe)) return "onmyoji-shop";
  if (isMailbox(safe)) return "onmyoji-mailbox";
  if (
    isCourtyard(safe) &&
    safe.texts.length >= 2 &&
    safe.texts.some((hit) => /^(探索|探)$/.test(hit.text.replace(/\s/g, "")))
  )
    return "onmyoji-courtyard";
  return "unknown";
}
