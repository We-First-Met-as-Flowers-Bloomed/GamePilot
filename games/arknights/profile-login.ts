import type { SkillResult } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import { arknightsPackage, type ArknightsConfig } from "./config";
import { validArknightsEvidence } from "./evidence";

export interface ProfileLoginNavigation {
  openProfile(point: [number, number]): Promise<void>;
  returnHome(): Promise<void>;
}

/** Identity is read from our own profile; home OCR only establishes the navigation scene. */
export async function verifyArknightsProfileLogin(
  result: SkillResult,
  config: ArknightsConfig,
  inspect: () => Promise<DeviceInspection>,
  signal: AbortSignal,
  navigation: ProfileLoginNavigation,
): Promise<SkillResult> {
  signal.throwIfAborted();
  if (!config.expectedUid) return result;
  const evidence = result.arknights;
  if (
    !validArknightsEvidence(evidence) ||
    evidence.taskType !== "StartUp" ||
    evidence.completion !== "native-confirmed"
  )
    throw Error("登录缺少匹配的原生完成证据，已停止后续任务");

  const read = async () => {
    signal.throwIfAborted();
    const started = Date.now();
    const capture = await inspect();
    signal.throwIfAborted();
    const at = Date.parse(capture.observedAt),
      now = Date.now();
    const account = capture.arknights;
    if (
      !Number.isFinite(at) ||
      at < started ||
      at > now ||
      now - at > 15000 ||
      capture.recognitionError ||
      capture.foregroundPackage !== arknightsPackage(config) ||
      !capture.pageVerified ||
      !account?.pageVerified ||
      account.expectedUid !== config.expectedUid ||
      account.frames.length !== 2 ||
      account.frames.some((f) => f.page !== account.page) ||
      !["home", "profile"].includes(account.page)
    )
      throw Error(
        "登录核验未得到新鲜、同一客户端的双帧主页或个人名片，已停止后续任务",
      );
    return capture;
  };
  let capture = await read();
  if (capture.arknights!.page === "home") {
    const [first, second] = capture.arknights!.frames.map(
      (f) => f.friendsEntry,
    );
    if (
      !first ||
      !second ||
      first.length !== 2 ||
      second.length !== 2 ||
      [...first, ...second].some((n) => !Number.isFinite(n) || n < 0) ||
      Math.abs(first[0] - second[0]) > 8 ||
      Math.abs(first[1] - second[1]) > 8
    )
      throw Error(
        "主页未能稳定识别好友入口，无法打开自己的个人名片，已停止后续任务",
      );
    signal.throwIfAborted();
    await navigation.openProfile(second);
    signal.throwIfAborted();
    capture = await read();
  }

  let retries = 0;
  while (true) {
    const account = capture.arknights!;
    if (account.page !== "profile")
      throw Error("未进入自己的个人名片，已停止账号核验与后续任务");
    if (
      account.frames.some(
        (f) => f.uid !== undefined && f.uid !== config.expectedUid,
      )
    )
      throw Error("个人名片 UID 与预设账号不符，已停止后续任务");
    if (account.frames.every((f) => f.uid === config.expectedUid)) break;
    if (retries >= 2)
      throw Error("个人名片未能读到两帧一致的完整 UID，已停止后续任务");
    retries++;
    capture = await read();
  }
  const profileObservedAt = capture.observedAt;
  signal.throwIfAborted();
  await navigation.returnHome();
  signal.throwIfAborted();
  const home = await read();
  if (home.arknights!.page !== "home")
    throw Error("个人名片 UID 已核对，但尚未确认返回主页，已停止后续任务");
  return {
    ...result,
    status: "succeeded",
    summary:
      "登录完成，个人名片双帧 UID 与预设账号一致，已返回主页" +
      (retries ? `（只读复核 ${retries} 次）` : ""),
    arknights: {
      ...evidence,
      login: {
        expectedUid: config.expectedUid,
        observedUid: config.expectedUid,
        observedAt: profileObservedAt,
        method: "profile",
        homeObservedAt: home.observedAt,
        home: true,
      },
    },
  };
}
