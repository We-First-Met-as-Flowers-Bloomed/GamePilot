import type { Frame } from "../../packages/runtime/device";
import type { Device, SkillResult } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import { arknightsPackage, type ArknightsConfig } from "./config";
import { validArknightsEvidence } from "./evidence";

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
}
interface CreditShoppingPorts {
  inspect(): Promise<CreditShopFrame>;
  wait(): Promise<unknown>;
  publish(result: SkillResult): void;
  returnHome(): Promise<DeviceInspection>;
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
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await read();
    await ports.wait();
    const second = await read();
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
