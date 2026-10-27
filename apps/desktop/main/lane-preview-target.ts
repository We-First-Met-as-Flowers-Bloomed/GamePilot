import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import type { DeviceLane } from "../../../packages/protocol";
import type { LanePreviewTarget } from "./lane-preview";
import { readMuMuInstanceInfo } from "./mumu";

const execute = promisify(execFile);
type InstanceInfo = {
  pid?: number;
  running: boolean;
  ready: boolean;
  address: string;
};
async function readGeneration(pid: number): Promise<string> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid < 1)
    throw Error("无法核实模拟器进程世代");
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
    ],
    { windowsHide: true, timeout: 2500, maxBuffer: 8192, encoding: "utf8" },
  );
  const ticks = stdout.trim();
  if (!/^\d{16,20}$/.test(ticks)) throw Error("模拟器进程世代无效");
  return ticks;
}
/** Main-owned binding from configured MuMu instance facts, never renderer addresses. */
export async function resolveMuMuPreviewTarget(
  lane: DeviceLane,
  dependencies: {
    readInfo?: (manager: string, instance: number) => Promise<InstanceInfo>;
    readGeneration?: (pid: number) => Promise<string>;
  } = {},
): Promise<LanePreviewTarget> {
  const readInfo = dependencies.readInfo ?? readMuMuInstanceInfo;
  const generation = dependencies.readGeneration ?? readGeneration;
  const initial = await readInfo(lane.managerPath, lane.instance);
  if (
    !initial.ready ||
    !initial.running ||
    !Number.isSafeInteger(initial.pid) ||
    (initial.pid ?? 0) < 1
  )
    throw Error("对应模拟器未就绪，或进程身份尚未核实");
  const pid = initial.pid!;
  const created = await generation(pid);
  return {
    adbPath: win32.join(win32.dirname(lane.managerPath), "adb.exe"),
    address: initial.address,
    identityKey: JSON.stringify([
      lane.managerPath.toLowerCase(),
      lane.instance,
      initial.address,
      pid,
      created,
    ]),
    isCurrent: async () => {
      try {
        const current = await readInfo(lane.managerPath, lane.instance);
        return (
          current.running &&
          current.ready &&
          current.pid === pid &&
          current.address === initial.address &&
          (await generation(pid)) === created
        );
      } catch {
        return false;
      }
    },
  };
}
