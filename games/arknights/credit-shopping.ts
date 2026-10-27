import type { Frame } from "../../packages/runtime/device";
import type { Device, SkillResult } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import type { Rect, TextHit, VisualHit } from "../../packages/runtime/device";
import { arknightsPackage, type ArknightsConfig } from "./config";
import { validArknightsEvidence } from "./evidence";
import type { TaskStepRecord } from "../../packages/protocol/task-record";

/** Completed native shopping can be excluded from a partial continuation,
 * even when the wallet is unknown. It is never counted as verified completion. */
export function preserveCreditShoppingStep(step: TaskStepRecord): boolean {
  const e = step.result?.arknights;
  return (
    step.skillId === "friends" &&
    ["failed", "cancelled"].includes(step.status) &&
    validArknightsEvidence(e) &&
    e.taskType === "Mall" &&
    e.submission === "submitted" &&
    e.completion === "native-confirmed" &&
    !!e.statistics?.mall &&
    Number.isFinite(Date.parse(step.startedAt ?? "")) &&
    Number.isFinite(Date.parse(step.finishedAt ?? "")) &&
    Date.parse(e.observedAt) >= Date.parse(step.startedAt!) &&
    Date.parse(e.observedAt) <= Date.parse(step.finishedAt!)
  );
}

/** Read-only wallet recognition; accepts only the verified shop overview. */
export function creditShopBalance(frame: Frame): number | undefined {
  if (
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    Math.abs(frame.width / frame.height - 16 / 9) > 0.02
  )
    return undefined;
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
      x: (h.box[0] * 1920) / frame.width,
      y: (h.box[1] * 1080) / frame.height,
    }));
  if (
    !hits.some(
      (h) => h.text === "信用交易所" && h.x >= 1640 && h.y >= 110 && h.y <= 200,
    ) ||
    !hits.some(
      (h) =>
        h.text === "信用获取规则" && h.x >= 350 && h.x <= 700 && h.y >= 980,
    ) ||
    !hits.some(
      (h) => /^库存更新倒计时/.test(h.text) && h.x >= 1350 && h.y >= 980,
    )
  )
    return undefined;
  const wallet = hits.filter(
    (h) =>
      h.score >= 0.95 && h.x >= 1700 && h.x <= 1890 && h.y >= 20 && h.y <= 90,
  );
  const merged = wallet.filter((h) => /^\d{1,6}\/300$/.test(h.text));
  const numbers = wallet.filter((h) => /^\d{1,6}$/.test(h.text));
  if (merged.length)
    return merged.length === 1 && !numbers.length
      ? Number(merged[0].text.split("/")[0])
      : undefined;
  const limit = wallet.filter((h) => h.text === "/300");
  if (
    numbers.length !== 1 ||
    limit.length !== 1 ||
    numbers[0].x >= limit[0].x ||
    Math.abs(numbers[0].y - limit[0].y) > 12
  )
    return undefined;
  return Number(numbers[0].text);
}

export interface CreditShopFrame {
  frame: Frame;
  address: string;
  foregroundPackage?: string;
  observedAt: string;
  rewardConfirmation?: VisualHit;
}
interface CreditShoppingPorts {
  inspect(): Promise<CreditShopFrame>;
  wait(): Promise<unknown>;
  publish(result: SkillResult): void;
  returnHome(): Promise<DeviceInspection>;
  /** Only a freshly verified reward-result confirmation; never submits Mall. */
  dismissReward?(point: [number, number]): Promise<void>;
  /** Back from a verified credit product detail only; never presses Buy. */
  dismissProductDetail?(): Promise<void>;
}

function creditProductDetail(frame: Frame): string | undefined {
  if (
    frame.width !== 1920 ||
    frame.height !== 1080 ||
    frame.texts.some((h) => /是否|确认消耗|充值|支付|购买成功/.test(h.text))
  )
    return;
  const inRegion = (
    h: TextHit,
    x: number,
    y: number,
    w: number,
    height: number,
  ) =>
    h.box.every(Number.isFinite) &&
    h.box[2] > 0 &&
    h.box[3] > 0 &&
    h.box[0] >= x &&
    h.box[1] >= y &&
    h.box[0] + h.box[2] <= x + w &&
    h.box[1] + h.box[3] <= y + height;
  const find = (pattern: RegExp, region: Rect, minimum = 0.95) =>
    frame.texts.filter(
      (h) =>
        Number.isFinite(h.score) &&
        h.score >= minimum &&
        h.score <= 1 &&
        pattern.test(h.text.replace(/\s/g, "")) &&
        inRegion(h, ...region),
    );
  const wallet = find(/^\d{1,6}\/300$/, [1700, 20, 200, 80]);
  const price = find(/^\d{1,6}$/, [1380, 280, 150, 90]);
  const title = find(/\S+/, [250, 240, 700, 110]);
  if (
    wallet.length !== 1 ||
    price.length !== 1 ||
    title.length !== 1 ||
    find(/^售价$/, [1200, 280, 160, 90]).length !== 1 ||
    find(/^商品内容$/, [1250, 480, 300, 100]).length !== 1 ||
    find(/^[a-z]?购买物品$/i, [1150, 800, 450, 150], 0.8).length !== 1
  )
    return;
  return JSON.stringify([wallet[0].text, price[0].text, title[0].text]);
}

/** Recognizes the observed recruitment-permit reward, not a purchase dialog. */
export function creditRewardConfirmation(
  capture: CreditShopFrame,
): [number, number] | undefined {
  const { frame, rewardConfirmation: button } = capture;
  if (
    !button ||
    !Number.isFinite(button.score) ||
    button.score < 0.95 ||
    button.score > 1 ||
    !Number.isFinite(frame.width) ||
    !Number.isFinite(frame.height) ||
    frame.width <= 0 ||
    frame.height <= 0 ||
    Math.abs(frame.width / frame.height - 16 / 9) > 0.02
  )
    return;
  const valid = frame.texts.filter(
    (h) =>
      Number.isFinite(h.score) &&
      h.score >= 0.95 &&
      h.score <= 1 &&
      h.box.every(Number.isFinite) &&
      h.box[0] >= 0 &&
      h.box[1] >= 0 &&
      h.box[2] > 0 &&
      h.box[3] > 0 &&
      h.box[0] + h.box[2] <= frame.width &&
      h.box[1] + h.box[3] <= frame.height,
  );
  const inside = (box: Rect, region: Rect) =>
    box[0] >= region[0] &&
    box[1] >= region[1] &&
    box[0] + box[2] <= region[0] + region[2] &&
    box[1] + box[3] <= region[1] + region[3];
  const scaled = (box: Rect): Rect => [
    box[0] / frame.width,
    box[1] / frame.height,
    box[2] / frame.width,
    box[3] / frame.height,
  ];
  if (
    valid.filter(
      (h) =>
        h.text.replace(/\s/g, "") === "获得物资" &&
        inside(scaled(h.box), [0.4, 0.15, 0.2, 0.12]),
    ).length !== 1 ||
    valid.filter(
      (h) =>
        h.text.replace(/\s/g, "") === "招聘许可" &&
        inside(scaled(h.box), [0.4, 0.55, 0.2, 0.13]),
    ).length !== 1 ||
    frame.texts.some((h) => /购买|兑换|确认消耗|是否|信用交易所/.test(h.text))
  )
    return;
  if (
    !button.box.every(Number.isFinite) ||
    button.box[2] <= 0 ||
    button.box[3] <= 0 ||
    !inside(scaled(button.box), [0.45, 0.8, 0.1, 0.15])
  )
    return;
  return [
    Math.round(button.box[0] + button.box[2] / 2),
    Math.round(button.box[1] + button.box[3] / 2),
  ];
}

/** Fresh login may settle the same verified leftover overlay. No Mall is started,
 * and the original failure/unknown record remains unchanged. */
export async function dismissCreditRewardBeforeLogin(
  device: Device,
  config: ArknightsConfig,
  signal: AbortSignal,
  ports: Pick<CreditShoppingPorts, "inspect" | "wait" | "returnHome"> & {
    dismissReward(point: [number, number]): Promise<void>;
    dismissProductDetail?(): Promise<void>;
  },
): Promise<boolean> {
  const started = Date.now();
  const read = async () => {
    signal.throwIfAborted();
    const c = await ports.inspect();
    signal.throwIfAborted();
    const at = Date.parse(c.observedAt);
    if (
      c.address !== device.address ||
      !Number.isFinite(at) ||
      at < started ||
      at > Date.now() ||
      Date.now() - at > 15000
    )
      throw Error("登录前物资收尾现场已变化，停止输入");
    return c;
  };
  const first = await read();
  if (first.foregroundPackage !== arknightsPackage(config)) return false;
  const a = creditRewardConfirmation(first);
  const product =
    ports.dismissProductDetail && creditProductDetail(first.frame);
  if (!a && !product) return false;
  await ports.wait();
  const second = await read();
  const b = creditRewardConfirmation(second);
  if (
    second.foregroundPackage !== arknightsPackage(config) ||
    (product ? creditProductDetail(second.frame) !== product : !b) ||
    Date.parse(second.observedAt) <= Date.parse(first.observedAt) ||
    first.frame.width !== second.frame.width ||
    first.frame.height !== second.frame.height ||
    (a && b && (Math.abs(a[0] - b[0]) > 3 || Math.abs(a[1] - b[1]) > 3))
  )
    throw Error("登录前物资结果双帧不一致，停止输入");
  signal.throwIfAborted();
  if (product) await ports.dismissProductDetail!();
  else await ports.dismissReward(b!);
  signal.throwIfAborted();
  const home = await ports.returnHome();
  signal.throwIfAborted();
  if (
    home.address !== device.address ||
    home.foregroundPackage !== arknightsPackage(config) ||
    !home.pageVerified ||
    home.recognitionError ||
    !home.arknights?.pageVerified ||
    home.arknights.page !== "home" ||
    home.arknights.expectedUid !== config.expectedUid ||
    home.arknights.frames.length !== 2 ||
    home.arknights.frames.some(
      (f) =>
        f.page !== "home" ||
        (config.expectedUid && f.uid && f.uid !== config.expectedUid),
    ) ||
    Date.parse(home.observedAt) < Date.parse(second.observedAt) ||
    Date.parse(home.observedAt) > Date.now() ||
    Date.now() - Date.parse(home.observedAt) > 15000 ||
    !Number.isFinite(Date.parse(home.observedAt))
  )
    throw Error("物资弹窗收尾后尚未双帧确认主页，停止后续登录");
  return true;
}

/** Verify the wallet, then return home once. Never replay purchasing to resolve uncertainty. */
export async function verifyCreditShopping(
  result: SkillResult,
  config: ArknightsConfig,
  device: Device,
  signal: AbortSignal,
  ports: CreditShoppingPorts,
): Promise<SkillResult> {
  signal.throwIfAborted();
  if (!config.creditShopping) return result;
  const evidence = result.arknights;
  if (
    !validArknightsEvidence(evidence) ||
    evidence.taskType !== "Mall" ||
    evidence.completion !== "native-confirmed" ||
    !evidence.statistics?.mall
  )
    throw Error("信用购物原生结果未确认，停止核验");
  ports.publish(result);
  const started = Date.now();
  const read = async () => {
    signal.throwIfAborted();
    const capture = await ports.inspect();
    signal.throwIfAborted();
    const at = Date.parse(capture.observedAt);
    if (
      capture.address !== device.address ||
      capture.foregroundPackage !== arknightsPackage(config) ||
      !Number.isFinite(at) ||
      at < started ||
      at > Date.now()
    )
      throw Error("信用余额核验现场已变化或截图不新鲜，停止且不重复购买");
    return { value: creditShopBalance(capture.frame), at, capture };
  };
  let dismissed = false;
  let productDismissed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await read();
    await ports.wait();
    const second = await read();
    const product = creditProductDetail(first.capture.frame);
    if (
      !productDismissed &&
      ports.dismissProductDetail &&
      product &&
      product === creditProductDetail(second.capture.frame) &&
      second.at > first.at
    ) {
      signal.throwIfAborted();
      await ports.dismissProductDetail();
      signal.throwIfAborted();
      productDismissed = true;
      await ports.wait();
      attempt--;
      continue;
    }
    const firstButton = creditRewardConfirmation(first.capture),
      secondButton = creditRewardConfirmation(second.capture);
    if (
      !dismissed &&
      ports.dismissReward &&
      firstButton &&
      secondButton &&
      second.at > first.at &&
      first.capture.frame.width === second.capture.frame.width &&
      first.capture.frame.height === second.capture.frame.height &&
      Math.abs(firstButton[0] - secondButton[0]) <= 3 &&
      Math.abs(firstButton[1] - secondButton[1]) <= 3
    ) {
      // This is a navigation action after native completion. It does not turn
      // a missed purchase callback into an item count or repeat the purchase.
      signal.throwIfAborted();
      await ports.dismissReward(secondButton);
      signal.throwIfAborted();
      dismissed = true;
      await ports.wait();
      attempt--; // Keep the original three read-only wallet pairs after closing once.
      continue;
    }
    if (
      first.value !== undefined &&
      first.value === second.value &&
      second.at > first.at
    ) {
      const credit = second.value;
      const verified: SkillResult = {
        ...result,
        summary: `信用购物已核对，余额 ${credit}${credit < 300 ? "（已低于300）" : credit === 300 ? "（未超过次日保留上限）" : "（仍超过300，需处理）"}`,
        arknights: {
          ...evidence,
          observedAt: second.capture.observedAt,
          statistics: {
            ...evidence.statistics,
            mall: { ...evidence.statistics.mall, finalCredit: credit },
          },
        },
      };
      ports.publish(verified);
      if (credit > 300)
        throw Error(
          `购物后信用仍为 ${credit}，超过300；请检查剩余商品或购买识别，停止且不重复购买`,
        );
      signal.throwIfAborted();
      const navigationStarted = Date.now();
      const home = await ports.returnHome();
      signal.throwIfAborted();
      const homeAt = Date.parse(home.observedAt);
      if (
        home.address !== device.address ||
        home.foregroundPackage !== arknightsPackage(config) ||
        home.recognitionError ||
        !Number.isFinite(homeAt) ||
        homeAt < navigationStarted ||
        homeAt > Date.now() ||
        !home.pageVerified ||
        !home.arknights?.pageVerified ||
        home.arknights.page !== "home" ||
        home.arknights.expectedUid !== config.expectedUid ||
        home.arknights.frames.length !== 2 ||
        home.arknights.frames.some(
          (f) =>
            f.page !== "home" ||
            (config.expectedUid && f.uid && f.uid !== config.expectedUid),
        )
      )
        throw Error(
          `信用余额 ${credit} 已核对，但未确认返回主页；停止后续任务且不重复购买`,
        );
      return { ...verified, summary: verified.summary + "，已核对返回主页" };
    }
  }
  throw Error("购物后无法双帧核对信用余额（已重检两次），停止且不重复购买");
}
