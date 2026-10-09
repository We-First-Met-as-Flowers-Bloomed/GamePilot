import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Device } from "../protocol";
import { ConnectionUnavailableError } from "../protocol/failure";
const execute = promisify(execFile);
type Probe = (
  file: string,
  args: string[],
  signal: AbortSignal,
) => Promise<string>;
export async function checkDeviceReady(
  device: Device,
  signal: AbortSignal,
  probe: Probe = async (file, args, signal) =>
    (
      await execute(file, args, {
        signal,
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 65536,
      })
    ).stdout,
): Promise<void> {
  signal.throwIfAborted();
  try {
    const state = (
      await probe(device.adbPath, ["-s", device.address, "get-state"], signal)
    ).trim();
    signal.throwIfAborted();
    if (state === "offline")
      throw new ConnectionUnavailableError("设备仍离线，尚未提交游戏动作");
    if (state !== "device") throw new Error(`无法确认设备连接状态：${state}`);
    const boot = (
      await probe(
        device.adbPath,
        ["-s", device.address, "shell", "getprop", "sys.boot_completed"],
        signal,
      )
    ).trim();
    signal.throwIfAborted();
    if (boot === "0" || boot === "")
      throw new ConnectionUnavailableError(
        "Android 尚未就绪，尚未提交游戏动作",
      );
    if (boot !== "1") throw new Error(`无法确认 Android 启动状态：${boot}`);
  } catch (error) {
    signal.throwIfAborted();
    const stderr = (error as { stderr?: unknown })?.stderr;
    if (
      typeof stderr === "string" &&
      /device offline|device '[^']+' not found|no devices\/emulators found/.test(
        stderr,
      )
    )
      throw new ConnectionUnavailableError(
        "ADB 设备暂时不可用，尚未提交游戏动作",
        { cause: error },
      );
    throw error;
  }
}
