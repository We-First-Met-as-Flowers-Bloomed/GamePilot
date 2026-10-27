import type { Device } from "../protocol";
import {
  foregroundPackagesByDisplay,
  listAndroidDisplays,
  resolveAndroidDisplay,
  type AndroidDisplay,
} from "./android-display";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type AndroidReadCommand = (file: string, args: string[]) => Promise<Buffer>;

export function validScreenshot(image: Buffer, maxBytes = 24 * 1024 * 1024): boolean {
  if (!Buffer.isBuffer(image) || image.length < 45 || image.length > maxBytes ||
    !image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    image.readUInt32BE(8) !== 13 || image.toString("ascii", 12, 16) !== "IHDR") return false;
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) return false;
  let data = false;
  for (let offset = 8; offset + 12 <= image.length;) {
    const size = image.readUInt32BE(offset), end = offset + 12 + size;
    if (end > image.length) return false;
    const kind = image.toString("ascii", offset + 4, offset + 8);
    if (kind === "IHDR" && offset !== 8) return false;
    if (kind === "IDAT") data = true;
    if (kind === "IEND") return size === 0 && data && end === image.length;
    offset = end;
  }
  return false;
}

export async function readAndroidDisplay(device: Pick<Device, "adbPath" | "address">, run: AndroidReadCommand): Promise<AndroidDisplay> {
  const command = (...args: string[]) => run(device.adbPath, ["-s", device.address, ...args]);
  const windows = await command("shell", "dumpsys", "window");
  const displays = await command("shell", "dumpsys", "display");
  return resolveAndroidDisplay(windows.toString("utf8"), displays.toString("utf8"));
}

/** Screenshot only: both the image and foreground package refer to the same focused display. */
export async function captureAndroidDisplay(device: Pick<Device, "adbPath" | "address">, run: AndroidReadCommand, maxBytes?: number): Promise<{image: Buffer; display: AndroidDisplay}> {
  const display = await readAndroidDisplay(device, run);
  const image = await run(device.adbPath, ["-s", device.address, "exec-out", "screencap", "-p", "-d", display.physicalId]);
  if (!validScreenshot(image, maxBytes)) throw Error("设备截图不是有效的 PNG，未将其作为核对依据");
  const after = await readAndroidDisplay(device, run);
  if (JSON.stringify(display) !== JSON.stringify(after)) throw Error("Android display: 采图期间前台或显示映射改变，已丢弃截图");
  if ((display.width && image.readUInt32BE(16) !== display.width) || (display.height && image.readUInt32BE(20) !== display.height))
    throw Error("Android display: 截图尺寸与目标显示不一致");
  return {image, display};
}

/**
 * 逐个显示抓帧（多显示设备专用）。
 *
 * 为什么需要它（2026-10-16 实测）：MuMu 15 把不同 App 放在不同的 `mumuscreenNNN` 显示上，
 * 而"聚焦显示"解析出来的往往是桌面（额外显示上 `mCurrentFocus` 是 null），
 * 于是方舟/阴阳师走 adb 的核验永远看不到游戏。这里把每个显示的帧都抓下来，
 * 由调用方用**现有判据**（前台包名、页面、UID）挑选——判据一个都不放松。
 *
 * 每个候选都带该显示的前台包名；单显示设备上只有一个条目，与旧行为等价。
 */
export async function captureAndroidDisplayCandidates(
  device: Pick<Device, "adbPath" | "address">,
  run: AndroidReadCommand,
  maxBytes?: number,
): Promise<{ image: Buffer; display: AndroidDisplay }[]> {
  const command = (...args: string[]) => run(device.adbPath, ["-s", device.address, ...args]);
  const windows = (await command("shell", "dumpsys", "window", "displays")).toString("utf8");
  const displays = (await command("shell", "dumpsys", "display")).toString("utf8");
  const packages = foregroundPackagesByDisplay(windows);
  const results: { image: Buffer; display: AndroidDisplay }[] = [];
  for (const entry of listAndroidDisplays(displays)) {
    try {
      const image = await run(device.adbPath, [
        "-s",
        device.address,
        "exec-out",
        "screencap",
        "-p",
        "-d",
        entry.physicalId,
      ]);
      if (!validScreenshot(image, maxBytes)) continue;
      const foregroundPackage = packages.get(entry.logicalId);
      results.push({
        image,
        display: {
          logicalId: entry.logicalId,
          physicalId: entry.physicalId,
          ...(foregroundPackage ? { foregroundPackage } : {}),
          ...(entry.width ? { width: entry.width } : {}),
          ...(entry.height ? { height: entry.height } : {}),
        },
      });
    } catch {
      // 单个显示抓不到就跳过：只要还有一个可用显示，核验就还有机会。
    }
  }
  return results;
}

/** Navigation only; never send a back key to a different foreground application. */
export async function pressAndroidBack(device: Pick<Device, "adbPath" | "address">, expectedPackage: string, signal: AbortSignal, command?: AndroidReadCommand): Promise<void> {
  signal.throwIfAborted();
  const run: AndroidReadCommand = command ?? (async (file, args) => (await promisify(execFile)(file, args, {
    encoding: "buffer", windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024, signal,
  })).stdout);
  const display = await readAndroidDisplay(device, (file, args) => {
    signal.throwIfAborted();
    return run(file, args);
  });
  signal.throwIfAborted();
  if (!expectedPackage || display.foregroundPackage !== expectedPackage) throw Error("前台应用已改变，未发送返回操作");
  await run(device.adbPath, ["-s", device.address, "shell", "input", "-d", String(display.logicalId), "keyevent", "4"]);
  signal.throwIfAborted();
}
