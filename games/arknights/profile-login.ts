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
  /**
   * 点开个人名片后立刻取两帧，很容易跨在入场动画上：两次截图分别落在主页与名片，
   * 于是被判成"未得到新鲜、同一客户端的双帧主页或个人名片"。
   * 2026-10-15 lane-a 因此在双账号同时开跑时整条方舟日常报废（08:12，同一秒两条 lane 起跑）。
   * 这里只**重读**，绝不重新点击：验收条件、UID 比对与安全边界都不变，只是多给现场两次机会。
   */
  const readStable = async (): Promise<DeviceInspection> => {
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await read();
      } catch (error) {
        last = error;
        signal.throwIfAborted();
      }
    }
    throw last;
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
    // 2026-10-15 实机（lane-a 走游戏模式直跑）：点击好友入口后有时还停在主页——两次截图
    // 都稳定地是主页，于是 read() 正常返回、代码却直接判「未进入自己的个人名片」，整条
    // 日常报废。这里只重读、不重新点击：给转场最多四次机会，最终判定仍要求 page === "profile"。
    for (let attempt = 0; attempt < 4; attempt++) {
      capture = await readStable();
      if (capture.arknights?.page === "profile") break;
    }
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
    capture = await readStable();
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
