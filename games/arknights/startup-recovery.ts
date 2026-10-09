import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Device } from "../../packages/protocol";

const execute = promisify(execFile);
type Exit = { key: string; process: string; reason: number; status: number };
export interface StartupState {
  packageName: string;
  running: boolean;
  foreground?: string;
  launcher: string;
  exitKeys: string[];
  latestExit?: Exit;
}
type Probe = (
  file: string,
  args: string[],
  signal: AbortSignal,
) => Promise<string>;
export async function readStartupState(
  device: Device,
  clientType: unknown,
  signal: AbortSignal,
  probe: Probe = async (file, args, s) =>
    (
      await execute(file, args, {
        signal: s,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout,
): Promise<StartupState> {
  if (clientType !== "Official" && clientType !== "Bilibili")
    throw Error("无法识别启动客户端");
  const packageName =
    clientType === "Official"
      ? "com.hypergryph.arknights"
      : "com.hypergryph.arknights.bilibili";
  const read = async (...args: string[]) => {
    signal.throwIfAborted();
    const output = await probe(
      device.adbPath,
      ["-s", device.address, "shell", ...args],
      signal,
    );
    signal.throwIfAborted();
    return output;
  };
  const exits = await read("dumpsys", "activity", "exit-info", packageName);
  const processes = await read("ps", "-A");
  const home = await read(
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.HOME",
  );
  const windows = await read("dumpsys", "window");
  const launcher = /^([a-zA-Z0-9_.]+)\/[\w.$]+\s*$/m.exec(home)?.[1];
  if (
    !exits.includes("ACTIVITY MANAGER PROCESS EXIT INFO") ||
    !/^USER\s+PID\b/m.test(processes) ||
    !launcher
  )
    throw Error("设备未提供可核验的进程退出诊断，不能自动重试登录");
  const entries: Exit[] = [];
  for (const block of exits.split(/ApplicationExitInfo #\d+:/).slice(1)) {
    const process = /\bprocess=(\S+)/.exec(block)?.[1];
    const stamp = /timestamp=([^\r\n]+?)\s+pid=(\d+)/.exec(block);
    const reason = /\breason=(\d+)/.exec(block)?.[1];
    const status = /\bstatus=(\d+)/.exec(block)?.[1];
    if (
      process === packageName &&
      stamp &&
      reason !== undefined &&
      status !== undefined
    )
      entries.push({
        key: `${stamp[1]}:${stamp[2]}`,
        process,
        reason: Number(reason),
        status: Number(status),
      });
  }
  entries.sort((a, b) => b.key.localeCompare(a.key));
  return {
    packageName,
    launcher,
    running: processes
      .split(/\r?\n/)
      .some((line) => line.trim().split(/\s+/).at(-1) === packageName),
    foreground:
      /mCurrentFocus=Window\{[^\r\n]*?\bu\d+\s+([a-zA-Z0-9_.]+)\//.exec(
        windows,
      )?.[1],
    exitKeys: entries.map((entry) => entry.key),
    latestExit: entries[0],
  };
}

/** Fresh Android evidence only: an old crash or a launcher screenshot alone is insufficient. */
export function startupCrash(
  before: StartupState | undefined,
  after: StartupState | undefined,
): boolean {
  const exit = after?.latestExit;
  return Boolean(
    before &&
    after &&
    before.packageName === after.packageName &&
    exit &&
    exit.process === after.packageName &&
    exit.reason === 2 &&
    exit.status === 11 &&
    !before.exitKeys.includes(exit.key) &&
    !after.running &&
    after.foreground === after.launcher,
  );
}
