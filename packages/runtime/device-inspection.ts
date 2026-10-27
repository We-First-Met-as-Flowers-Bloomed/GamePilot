import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateDevice, type Device } from "../protocol";
import type { DeviceInspection } from "../protocol/recovery";
import { captureAndroidDisplay, captureAndroidDisplayCandidates } from "./android-capture";
const execute = promisify(execFile);
type ReadCommand = (file: string, args: string[]) => Promise<Buffer>;
const readCommand: ReadCommand = async (file, args) =>
  (
    await execute(file, args, {
      encoding: "buffer",
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 24 * 1024 * 1024,
    })
  ).stdout;

export interface InspectDeviceOptions {
  /** 就绪探测的尝试次数（默认 3）。adb 在 MuMu 刚唤醒/多实例切换时会瞬时 offline。 */
  attempts?: number;
  /** 第 n 次失败后的等待毫秒。 */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Transport inspection only. No app launch, tap, navigation or task dispatch. */
export async function inspectDevice(
  input: Device,
  run: ReadCommand = readCommand,
  options: InspectDeviceOptions = {},
): Promise<DeviceInspection> {
  const device = validateDevice(input);
  const command = (...args: string[]) =>
    run(device.adbPath, ["-s", device.address, ...args]);
  const attempts = Math.max(1, options.attempts ?? 3);
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const backoff = options.backoffMs ?? ((attempt: number) => 600 * attempt + 300);

  let lastReason = "设备未就绪，未执行任何游戏操作";
  let ready = false;
  for (let attempt = 1; attempt <= attempts && !ready; attempt += 1) {
    try {
      await run(device.adbPath, ["connect", device.address]);
      if ((await command("get-state")).toString().trim() !== "device") {
        lastReason = "设备未就绪，未执行任何游戏操作";
      } else if (
        (await command("shell", "getprop", "sys.boot_completed"))
          .toString()
          .trim() !== "1"
      ) {
        lastReason = "设备尚未完成启动";
      } else {
        ready = true;
      }
    } catch (error) {
      lastReason =
        error instanceof Error && error.message
          ? error.message
          : "设备未就绪，未执行任何游戏操作";
    }
    if (!ready && attempt < attempts) await sleep(backoff(attempt));
  }
  if (!ready) throw Error(lastReason);
  // 就绪后才抓帧；抓帧期间显示变化属于真实检测失败，不在本轮重试。
  const {image: screenshot, display} = await captureAndroidDisplay(device, run);
  return {
    observedAt: new Date().toISOString(),
    address: device.address,
    foregroundPackage: display.foregroundPackage,
    displayId: display.logicalId,
    image: `data:image/png;base64,${screenshot.toString("base64")}`,
    accountVerified: false,
    pageVerified: false,
  };
}

/**
 * 抓帧并挑出**前台就是 `expectedPackage`** 的那块显示（多显示设备专用，2026-10-16）。
 *
 * 这就是方舟登录核验的取图入口：MuMu 15 把 App 分在不同 `mumuscreenNNN` 显示上，
 * 而"聚焦显示"解析到的是桌面，于是 `foregroundPackage` 永远不是方舟 → 核验永远失败。
 * 这里逐个显示抓帧、按包名精确挑选；**一个显示都不匹配就报错**（宁可大声失败，
 * 也不要拿桌面的帧去冒充游戏画面）。单显示设备上与原行为等价。
 */
export async function inspectDeviceForPackage(
  input: Device,
  expectedPackage: string,
  run: ReadCommand = readCommand,
): Promise<DeviceInspection> {
  const candidates = await inspectDeviceCandidates(input, run);
  const matched = candidates.find(
    (candidate) => candidate.foregroundPackage === expectedPackage,
  );
  if (matched) return matched;
  if (candidates.length === 1) return candidates[0]!;
  const seen = candidates
    .map((candidate) => candidate.foregroundPackage ?? "（无前台应用）")
    .join("、");
  throw Error(
    `设备上没有前台为 ${expectedPackage} 的显示（当前：${seen}）；未将其作为核对依据`,
  );
}

/**
 * 逐个显示抓帧并返回候选（多显示设备专用，2026-10-16）。
 *
 * MuMu 15 会把不同 App 放到不同的 `mumuscreenNNN` 显示上，而"聚焦显示"常常解析到桌面，
 * 于是基于 adb 的核验看不到目标游戏。这里把所有能抓到的显示都返回，
 * **由调用方用它原有的判据（前台包名/页面/UID）挑选**——安全判据完全不放松。
 *
 * 单显示设备上返回一个候选，与 `inspectDevice` 等价。
 */
export async function inspectDeviceCandidates(
  input: Device,
  run: ReadCommand = readCommand,
): Promise<DeviceInspection[]> {
  const device = validateDevice(input);
  const command = (...args: string[]) =>
    run(device.adbPath, ["-s", device.address, ...args]);
  await run(device.adbPath, ["connect", device.address]);
  if ((await command("get-state")).toString().trim() !== "device")
    throw Error("设备未就绪，未执行任何游戏操作");
  if (
    (await command("shell", "getprop", "sys.boot_completed"))
      .toString()
      .trim() !== "1"
  )
    throw Error("设备尚未完成启动");
  const candidates = await captureAndroidDisplayCandidates(device, run);
  if (!candidates.length)
    throw Error("设备截图不是有效的 PNG，未将其作为核对依据");
  const observedAt = new Date().toISOString();
  return candidates.map(({ image, display }) => ({
    observedAt,
    address: device.address,
    foregroundPackage: display.foregroundPackage,
    displayId: display.logicalId,
    image: `data:image/png;base64,${image.toString("base64")}`,
    accountVerified: false,
    pageVerified: false,
  }));
}
