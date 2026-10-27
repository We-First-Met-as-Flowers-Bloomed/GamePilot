import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 as path } from "node:path";
import type { Device } from "../protocol";
import { resolveAndroidDisplay } from "./android-display";

export interface MumuConnection {
  path: string;
  index: number;
}

export interface MumuConnectionMetadata extends MumuConnection {
  libraryPath: string;
  appPackage: string;
}

/** Accept only MuMu's known installation layout and documented instance ports. */
export function deriveMumuConnection(
  adbPath: string,
  address: string,
): MumuConnection | undefined {
  if (
    !/^[A-Za-z]:[\\/]/.test(adbPath) ||
    /[\x00-\x1f]/.test(adbPath) ||
    adbPath.split(/[\\/]/).some((part) => part === "." || part === "..")
  )
    return undefined;
  const normalized = path.normalize(adbPath);
  const match = /^(.*)\\(nx_main|shell)\\adb\.exe$/i.exec(normalized);
  if (
    !match ||
    (match[2].toLowerCase() === "shell" &&
      !/mumu/i.test(match[1]) &&
      !/\\nx_device\\\d+(?:\.\d+)*$/i.test(match[1]))
  )
    return undefined;
  const port = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(address)?.[1];
  const index = port ? (Number(port) - 16384) / 32 : -1;
  if (!Number.isInteger(index) || index < 0 || index > 999)
    throw Error("MuMu ADB 地址不能对应唯一实例，未连接其他实例");
  return { path: match[1], index };
}

function readDump(device: Device, service: "window" | "display") {
  return new Promise<string>((resolve, reject) => {
    execFile(
      device.adbPath,
      ["-s", device.address, "shell", "dumpsys", service],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Read-only metadata; never launches an app or injects input. */
export async function resolveMumuConnection(
  device: Device,
): Promise<MumuConnectionMetadata | undefined> {
  const connection = deriveMumuConnection(device.adbPath, device.address);
  if (!connection) return undefined;
  let libraryPath: string | undefined;
  for (const directory of ["nx_main", "shell"]) {
    const candidate = path.join(
      connection.path,
      directory,
      "sdk",
      "external_renderer_ipc.dll",
    );
    try {
      if ((await stat(candidate)).isFile()) {
        libraryPath = candidate;
        break;
      }
    } catch {
      // Another supported MuMu layout may contain the same SDK.
    }
  }
  if (!libraryPath) throw Error("MuMu 显示路由 SDK 不可用，未回退到默认桌面");
  const windows = await readDump(device, "window");
  const displays = await readDump(device, "display");
  const { foregroundPackage } = resolveAndroidDisplay(windows, displays);
  if (!foregroundPackage)
    throw Error("MuMu 当前显示屏没有可确认的前台应用，未连接默认桌面");
  return { ...connection, libraryPath, appPackage: foregroundPackage };
}
