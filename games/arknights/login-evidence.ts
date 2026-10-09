import type { SkillResult } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import { arknightsPackage, type ArknightsConfig } from "./config";
import { validArknightsEvidence } from "./evidence";

function isFreshCapture(capture: DeviceInspection, started: number): boolean {
  const at = Date.parse(capture.observedAt),
    now = Date.now();
  return Number.isFinite(at) && at >= started && at <= now && now - at <= 15000;
}

export async function verifyArknightsLogin(
  result: SkillResult,
  config: ArknightsConfig,
  inspect: () => Promise<DeviceInspection>,
  signal: AbortSignal,
  returnFromProfile?: () => Promise<void>,
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
  let started = Date.now();
  let capture = await inspect();
  signal.throwIfAborted();
  if (
    returnFromProfile &&
    !capture.recognitionError &&
    isFreshCapture(capture, started) &&
    capture.foregroundPackage === arknightsPackage(config) &&
    capture.pageVerified &&
    capture.accountVerified === false &&
    capture.arknights?.page === "profile" &&
    capture.arknights.pageVerified &&
    capture.arknights.accountVerified === false &&
    capture.arknights.account === "unknown" &&
    capture.arknights.observedUid === undefined &&
    capture.arknights.expectedUid === config.expectedUid &&
    capture.arknights.frames.length === 2 &&
    capture.arknights.frames.every(
      (f) => f.page === "profile" && f.uid === config.expectedUid,
    )
  ) {
    await returnFromProfile();
    signal.throwIfAborted();
    started = Date.now();
    capture = await inspect();
  }
  let retries = 0;
  while (true) {
    signal.throwIfAborted();
    const account = capture.arknights;
    if (
      !isFreshCapture(capture, started) ||
      capture.recognitionError ||
      capture.foregroundPackage !== arknightsPackage(config) ||
      !capture.pageVerified ||
      !account?.pageVerified ||
      account.page !== "home" ||
      account.expectedUid !== config.expectedUid ||
      account.frames.length !== 2 ||
      account.frames.some(
        (f) =>
          f.page !== "home" ||
          (f.uid !== undefined && f.uid !== config.expectedUid),
      )
    )
      break;
    if (
      capture.accountVerified &&
      account.accountVerified &&
      account.account === "matched" &&
      account.observedUid === config.expectedUid &&
      account.frames.every((f) => f.uid === config.expectedUid)
    )
      return {
        ...result,
        status: "succeeded",
        summary:
          "登录完成，双帧主页 UID 与预设账号一致" +
          (retries ? `（只读复核 ${retries} 次）` : ""),
        arknights: {
          ...evidence,
          login: {
            expectedUid: config.expectedUid,
            observedUid: account.observedUid,
            observedAt: capture.observedAt,
            home: true,
          },
        },
      };
    // Only a missing UID in an otherwise verified home pair permits a new read.
    // Each retry must independently provide a complete pair; never merge frames.
    if (
      retries >= 2 ||
      capture.accountVerified !== false ||
      account.accountVerified !== false ||
      account.account !== "unknown" ||
      account.observedUid !== undefined ||
      !account.frames.some((f) => f.uid === config.expectedUid) ||
      !account.frames.some((f) => f.uid === undefined)
    )
      break;
    retries++;
    signal.throwIfAborted();
    started = Date.now();
    capture = await inspect();
  }
  throw Error(
    "登录后账号或主页未通过新鲜双帧核验，已停止后续任务，请查看当前游戏账号",
  );
}
