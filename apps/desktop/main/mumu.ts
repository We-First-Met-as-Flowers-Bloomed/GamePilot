import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import { win32 as path } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { recoverConnection } from "../../../packages/runtime/connection-recovery";
import { StartupFaultError } from "../../../packages/protocol/startup-fault";
import type {
  MuMuInstallation,
  MuMuInstance,
} from "../../../packages/protocol";
const execute = promisify(execFile);
async function command(file: string, args: string[]) {
  return (
    await execute(file, args, {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    })
  ).stdout;
}
/** Native RPC 900 means a known stopped instance only with both explicit flags.
 * It is never ready, nor permission to reuse an old PID or guessed ADB address. */
function isStoppedRpcInfo(info: Record<string, unknown>, instance: number) {
  return (
    Number.isInteger(instance) &&
    instance >= 0 &&
    info.error_code === 900 &&
    info.info_source === "rpc" &&
    String(info.index) === String(instance) &&
    info.is_process_started === false &&
    info.is_android_started === false &&
    Number(info.errcode ?? 0) === 0
  );
}
function validInstance(value: unknown): boolean {
  return (
    (typeof value === "number" ||
      (typeof value === "string" && /^(0|[1-9]\d{0,2})$/.test(value))) &&
    Number.isInteger(Number(value)) &&
    Number(value) >= 0 &&
    Number(value) <= 999
  );
}
function parseMuMuRecord(raw: unknown, instance: number) {
  const info = raw as Record<string, unknown> | null;
  const stopped =
    !!info && typeof info === "object" && isStoppedRpcInfo(info, instance);
  if (
    !info ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    !validInstance(instance) ||
    !validInstance(info.index) ||
    (info.error_code !== undefined && info.error_code !== 0 && !stopped) ||
    (info.errcode !== undefined && info.errcode !== 0) ||
    String(info.index) !== String(instance) ||
    typeof info.is_process_started !== "boolean" ||
    typeof info.is_android_started !== "boolean" ||
    (info.is_android_started && !info.is_process_started) ||
    (info.player_state !== undefined && typeof info.player_state !== "string")
  )
    throw new Error("无法读取指定 MuMu 实例，请核对实例编号");
  const playerState =
    typeof info.player_state === "string"
      ? { playerState: info.player_state }
      : {};
  if (stopped)
    return {
      pid: undefined,
      running: false,
      ready: false,
      address: "",
      ...playerState,
    };
  const ready = info.is_android_started === true;
  const port = info.adb_port;
  if (
    ready &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  )
    throw new Error("MuMu 未返回有效 ADB 端口，请在模拟器设置中启用 ADB");
  if (
    info.pid !== undefined &&
    (typeof info.pid !== "number" ||
      !Number.isSafeInteger(info.pid) ||
      info.pid < 0 ||
      (info.is_process_started && info.pid === 0))
  )
    throw new Error("MuMu 未返回有效进程编号");
  return {
    pid: typeof info.pid === "number" ? info.pid : undefined,
    running: info.is_process_started === true,
    ready,
    address: ready ? `127.0.0.1:${port}` : "",
    ...playerState,
  };
}
export function parseMuMuInfo(text: string, instance: number) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) return parseMuMuRecord(data, instance);
  const matches = data.filter(
    (info) => info && String(info.index) === String(instance),
  );
  if (matches.length !== 1)
    throw new Error("无法唯一识别指定 MuMu 实例，请核对实例编号");
  return parseMuMuRecord(matches[0], instance);
}

export function parseMuMuInstances(text: string): MuMuInstance[] {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("MuMu 实例列表格式无效");
  const seenInstances = new Set<number>();
  const seenAddresses = new Set<string>();
  return Object.entries(data)
    .map(([key, raw]) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("MuMu 实例信息无效");
      const info = raw as Record<string, unknown>;
      const instance = Number(info.index);
      if (
        !validInstance(key) ||
        String(info.index) !== key ||
        seenInstances.has(instance)
      )
        throw new Error("MuMu 实例信息无效");
      const state = parseMuMuRecord(info, instance);
      if (state.ready && seenAddresses.has(state.address))
        throw new Error("MuMu 实例的 ADB 端口冲突，无法唯一识别设备");
      seenInstances.add(instance);
      if (state.ready) seenAddresses.add(state.address);
      return {
        instance,
        name:
          typeof info.name === "string" && info.name.trim()
            ? info.name.trim()
            : `MuMu ${instance}`,
        running: state.running,
        ready: state.ready,
        address: state.address,
        arknights: null,
        onmyoji: false,
        supportedGames: [],
        automationReady: false,
      } satisfies MuMuInstance;
    })
    .sort((a, b) => a.instance - b.instance);
}

/** 当前 app 已具备自动化能力的游戏；阴阳师底层技能未完成，暂不列入。 */
export const AUTOMATABLE_GAMES = ["arknights"] as const;
export type AutomatableGame = (typeof AUTOMATABLE_GAMES)[number];

export function classifyGamePackages(packages: string[]) {
  const installed = new Set(packages.map((value) => value.trim()));
  return {
    arknights: installed.has("com.hypergryph.arknights.bilibili")
      ? ("Bilibili" as const)
      : installed.has("com.hypergryph.arknights")
        ? ("Official" as const)
        : null,
    onmyoji: [...installed].some((name) =>
      name.startsWith("com.netease.onmyoji"),
    ),
  };
}

export async function discoverMuMuInstances(
  manager: string,
  run = command,
): Promise<MuMuInstance[]> {
  const instances = parseMuMuInstances(
    await run(manager, ["info", "-v", "all"]),
  );
  const adb = path.join(path.dirname(manager), "adb.exe");
  return Promise.all(
    instances.map(async (instance) => {
      if (!instance.ready) return instance;
      try {
        await run(adb, ["connect", instance.address]);
        const output = await run(adb, [
          "-s",
          instance.address,
          "shell",
          "pm",
          "list",
          "packages",
        ]);
        const packages = output
          .split(/\r?\n/)
          .map((line) => line.replace(/^package:/, "").trim())
          .filter(Boolean);
        const games = classifyGamePackages(packages);
        const supportedGames: AutomatableGame[] = [];
        if (games.arknights) supportedGames.push("arknights");
        return {
          ...instance,
          ...games,
          supportedGames,
          automationReady: instance.running && supportedGames.length > 0,
        };
      } catch {
        return instance;
      }
    }),
  );
}
/** Read-only instance facts; does not launch, reconnect or modify the instance. */
export async function readMuMuInstanceInfo(
  manager: string,
  instance: number,
  run = command,
) {
  if (
    !/^[A-Za-z]:[\\/].*[\\/]MuMuManager\.exe$/i.test(manager) ||
    !Number.isInteger(instance) ||
    instance < 0 ||
    instance > 999
  )
    throw Error("原请求的 MuMu 绑定不完整，无法核对设备");
  return parseMuMuInfo(
    await run(manager, ["info", "-v", String(instance)]),
    instance,
  );
}
/** Read-only lookup for recovery: never launch a stopped instance. */
export async function currentMuMuDevice(
  manager: string,
  instance: number,
  run = command,
) {
  const info = await readMuMuInstanceInfo(manager, instance, run);
  if (!info.running || !info.ready)
    throw Error("原模拟器未就绪，请先手动打开对应实例；此次核对不会启动游戏");
  return {
    name: `MuMu ${instance}`,
    adbPath: path.join(path.dirname(manager), "adb.exe"),
    address: info.address,
  };
}
export async function ensureMuMu(
  manager: string,
  instance: number,
  signal: AbortSignal,
  log: (text: string) => void,
  run = command,
  pause: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, s) =>
    delay(ms, undefined, { signal: s }),
) {
  signal.throwIfAborted();
  async function readState() {
    try {
      return parseMuMuInfo(
        await run(manager, ["info", "-v", String(instance)]),
        instance,
      );
    } catch (error) {
      signal.throwIfAborted();
      throw new StartupFaultError(
        "mumu-state-unavailable",
        String(error),
        error,
      );
    }
  }
  async function waitForStopped(info: Awaited<ReturnType<typeof readState>>) {
    if (info.playerState !== "stopping") return info;
    log("MuMu 实例正在停止，等待原实例停止完成");
    for (let i = 0; i < 15; i++) {
      await pause(2000, signal);
      signal.throwIfAborted();
      try {
        info = await readState();
      } catch (error) {
        signal.throwIfAborted();
        throw new StartupFaultError(
          "mumu-startup-interrupted",
          "MuMu 已进入停止过程，但无法确认停止结果；已中止启动，请先核对模拟器状态",
          error,
        );
      }
      signal.throwIfAborted();
      if (!info.running && !info.ready && info.playerState !== "stopping")
        return info;
    }
    throw new StartupFaultError(
      "mumu-stopping-timeout",
      "等待 MuMu 原实例停止超时，尚未确认停止完成；不会继续启动，请先核对模拟器状态",
    );
  }
  let info = await waitForStopped(await readState());
  signal.throwIfAborted();
  let startedByUs = false;
  if (!info.running) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      log(
        "启动 MuMu 实例 " + instance + (attempt ? `，重试 ${attempt}/2` : ""),
      );
      try {
        const output = await run(manager, [
          "control",
          "-v",
          String(instance),
          "launch",
        ]);
        if (output.trim().startsWith("{")) {
          const result = JSON.parse(output);
          if (Number(result.errcode ?? result.error_code ?? 0) !== 0)
            throw Error("MuMu 启动返回失败：" + output.slice(0, 800));
        }
        signal.throwIfAborted();
        startedByUs = true;
        break;
      } catch (error) {
        signal.throwIfAborted();
        const detail = error as {
          code?: string | number;
          stderr?: string;
          stdout?: string;
        };
        log(
          `MuMu 实例 ${instance} 启动响应失败：${String(error)} ${String(detail.stderr ?? detail.stdout ?? "").slice(0, 800)}`,
        );
        if (["ENOENT", "EACCES", "EPERM"].includes(String(detail.code)))
          throw new StartupFaultError(
            "mumu-launch-failed",
            String(error),
            error,
          );
        // A failed response can still have started Android. Never blindly relaunch.
        await pause(2000, signal);
        signal.throwIfAborted();
        info = await waitForStopped(await readState());
        signal.throwIfAborted();
        if (info.running) {
          log(
            "启动响应未确认，但实例已经运行，继续等待 Android；不取得自动关闭所有权",
          );
          break;
        }
        if (attempt === 2)
          throw new StartupFaultError(
            "mumu-launch-failed",
            `MuMu 实例 ${instance} 启动失败（已重试两次）：${String(error)} ${String(detail.stderr ?? detail.stdout ?? "").slice(0, 800)}`,
            error,
          );
      }
    }
  }
  log("等待 Android 启动完成");
  for (let i = 0; i < 90; i++) {
    signal.throwIfAborted();
    if (info.ready) {
      const adb = path.join(path.dirname(manager), "adb.exe");
      try {
        await run(adb, ["connect", info.address]);
        signal.throwIfAborted();
        const boot = await run(adb, [
          "-s",
          info.address,
          "shell",
          "getprop",
          "sys.boot_completed",
        ]);
        if (boot.trim() === "1")
          return {
            startedByUs,
            pid: info.pid,
            instance,
            managerPath: manager,
            adbPath: adb,
            address: info.address,
          };
      } catch {
        signal.throwIfAborted();
      }
    }
    await pause(2000, signal);
    info = await readState();
    if (info.playerState === "stopping") {
      await waitForStopped(info);
      throw new StartupFaultError(
        "mumu-startup-interrupted",
        "MuMu 在等待 Android 启动时进入停止过程；已中止本轮，不会重新启动实例",
      );
    }
  }
  signal.throwIfAborted();
  throw new StartupFaultError(
    "mumu-boot-timeout",
    "等待 MuMu 启动超时，请检查模拟器后重试",
  );
}

export interface OwnedMuMu {
  managerPath: string;
  instance: number;
  startedByUs: boolean;
  pid?: number;
}
export async function closeOwnedMuMu(
  owned: OwnedMuMu,
  run = command,
): Promise<boolean> {
  if (!owned.startedByUs || !owned.pid) return false;
  const current = parseMuMuInfo(
    await run(owned.managerPath, ["info", "-v", String(owned.instance)]),
    owned.instance,
  );
  if (!current.running || current.pid !== owned.pid) return false;
  const result = JSON.parse(
    await run(owned.managerPath, [
      "control",
      "-v",
      String(owned.instance),
      "shutdown",
    ]),
  );
  if (Number(result.errcode ?? result.error_code ?? -1) !== 0)
    throw Error("MuMu 关闭请求失败");
  for (let i = 0; i < 15; i++) {
    const state = parseMuMuInfo(
      await run(owned.managerPath, ["info", "-v", String(owned.instance)]),
      owned.instance,
    );
    if (!state.running) return true;
    if (state.pid !== owned.pid) return false;
    await delay(1000);
  }
  throw Error("MuMu 未在预期时间关闭，请检查模拟器");
}

export async function connectWhenReady<T>(
  connect: () => Promise<T>,
  signal: AbortSignal,
  pause: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, s) =>
    delay(ms, undefined, { signal: s }),
  beforeRetry: (retry: number) => Promise<void> = async () => {},
): Promise<T> {
  return recoverConnection(connect, signal, pause, beforeRetry);
}
// Constant PowerShell program: paths remain data, never executable script text.
export const mumuDiscoveryScript = String.raw`[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='SilentlyContinue'; $r=@(); Get-CimInstance Win32_Process | Where-Object {$_.Name -match '^MuMu.*\.exe$'} | ForEach-Object {$r+=$_.ExecutablePath}; Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object {$_.DisplayName -match 'MuMu'} | ForEach-Object {$r+=$_.InstallLocation}; ConvertTo-Json -Compress -InputObject @($r | Where-Object {$_})`;

export async function detectMuMu(
  savedManager = "",
  savedAdb = "",
): Promise<MuMuInstallation[]> {
  if (savedManager) {
    const adbPath = path.join(path.dirname(savedManager), "adb.exe");
    try {
      await access(savedManager);
      await access(adbPath);
      return [{ managerPath: savedManager, adbPath }];
    } catch {
      // A moved installation needs discovery again.
    }
  }
  let discovered: string[] = [];
  try {
    const raw = JSON.parse(
      await command("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(mumuDiscoveryScript, "utf16le").toString("base64"),
      ]),
    );
    discovered = Array.isArray(raw) ? raw : [];
  } catch {
    /* Saved configuration still works when registry access is unavailable. */
  }
  const candidates = new Set<string>();
  for (const source of [savedManager, savedAdb, ...discovered]) {
    if (!source) continue;
    let root = source;
    for (let depth = 0; depth < 5; depth++) {
      for (const suffix of [
        "MuMuManager.exe",
        "nx_main/MuMuManager.exe",
        "shell/MuMuManager.exe",
      ])
        candidates.add(path.join(root, suffix));
      const parent = path.dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  const result: MuMuInstallation[] = [];
  for (const managerPath of candidates) {
    const adbPath = path.join(path.dirname(managerPath), "adb.exe");
    try {
      await access(managerPath);
      await access(adbPath);
      if (
        !result.some(
          (r) => r.managerPath.toLowerCase() === managerPath.toLowerCase(),
        )
      )
        result.push({ managerPath, adbPath });
    } catch {}
  }
  return result;
}

export async function resolveMuMu(
  savedManager = "",
  savedAdb = "",
  detect = detectMuMu,
): Promise<MuMuInstallation> {
  const candidates = await detect(savedManager, savedAdb);
  const saved = candidates.find(
    (item) => item.managerPath.toLowerCase() === savedManager.toLowerCase(),
  );
  if (saved) return saved;
  if (!candidates.length)
    throw new Error("未检测到 MuMu，请在设置中检测并选择安装位置");
  if (candidates.length !== 1)
    throw new Error("检测到多个 MuMu 安装，请在设置中选择安装位置");
  return candidates[0];
}
