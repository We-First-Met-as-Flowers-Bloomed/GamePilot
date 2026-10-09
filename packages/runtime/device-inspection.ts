import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateDevice, type Device } from "../protocol";
import type { DeviceInspection } from "../protocol/recovery";
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

/** Transport inspection only. No app launch, tap, navigation or task dispatch. */
export async function inspectDevice(
  input: Device,
  run: ReadCommand = readCommand,
): Promise<DeviceInspection> {
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
  const windows = (await command("shell", "dumpsys", "window")).toString();
  const foregroundPackage =
    /mCurrentFocus=Window\{[^\r\n]*?\bu\d+\s+([a-zA-Z0-9_.]+)\//.exec(
      windows,
    )?.[1];
  const screenshot = await command("exec-out", "screencap", "-p");
  if (
    screenshot.length < 45 ||
    screenshot.length > 24 * 1024 * 1024 ||
    !screenshot.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    screenshot.toString("ascii", 12, 16) !== "IHDR" ||
    screenshot.readUInt32BE(16) < 1 ||
    screenshot.readUInt32BE(20) < 1 ||
    screenshot.readUInt32BE(16) > 16384 ||
    screenshot.readUInt32BE(20) > 16384 ||
    screenshot.toString(
      "ascii",
      screenshot.length - 8,
      screenshot.length - 4,
    ) !== "IEND"
  )
    throw Error("设备截图不是有效的 PNG，未将其作为核对依据");
  return {
    observedAt: new Date().toISOString(),
    address: device.address,
    foregroundPackage,
    image: `data:image/png;base64,${screenshot.toString("base64")}`,
    accountVerified: false,
    pageVerified: false,
  };
}
