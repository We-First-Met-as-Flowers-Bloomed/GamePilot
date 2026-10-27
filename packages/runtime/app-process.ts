import { execFile } from "node:child_process";
import { promisify } from "node:util";

type ProcessOutput = { stdout: string; stderr: string };
type ProcessRunner = (file: string, args: string[]) => Promise<ProcessOutput>;
const execute = promisify(execFile);

/** Absence is evidence only while ADB remains connected on both sides of the check. */
export async function appProcessRunning(
  device: { adbPath: string; address: string },
  packageName: string,
  signal: AbortSignal,
  run: ProcessRunner = async (file, args) =>
    execute(file, args, {
      windowsHide: true,
      timeout: 15000,
      signal,
      encoding: "utf8",
    }),
): Promise<boolean> {
  signal.throwIfAborted();
  if (
    !device.adbPath ||
    !device.address ||
    !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(packageName)
  )
    throw new Error("无效的设备或游戏包名");
  const invoke = async (args: string[]) => {
    signal.throwIfAborted();
    const result = await run(device.adbPath, ["-s", device.address, ...args]);
    signal.throwIfAborted();
    if (
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      result.stderr.trim()
    )
      throw new Error("ADB 返回了异常输出");
    return result.stdout;
  };
  const connected = async () => {
    if ((await invoke(["get-state"])).trim() !== "device")
      throw new Error("ADB 设备未连接，无法判断游戏进程");
  };
  await connected();
  let running: boolean;
  try {
    const stdout = (await invoke(["shell", "pidof", packageName])).replace(
      /\r?\n$/,
      "",
    );
    const pids = stdout.split(" ");
    if (
      !/^[1-9]\d*(?: [1-9]\d*)*$/.test(stdout) ||
      pids.length > 16 ||
      pids.some((pid) => Number(pid) > 4294967295)
    )
      throw new Error("ADB 返回了无效进程编号");
    running = true;
  } catch (error) {
    signal.throwIfAborted();
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    if (failure?.code !== 1 || failure.stdout !== "" || failure.stderr !== "")
      throw new Error("ADB 进程检查失败，无法证明游戏退出", { cause: error });
    running = false;
  }
  await connected();
  return running;
}
