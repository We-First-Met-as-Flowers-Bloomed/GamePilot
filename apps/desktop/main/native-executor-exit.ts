import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentToolError,
  agentDate,
  agentObject,
} from "../../../packages/protocol/agent";
import { canonical } from "../../../packages/acceptance/files";

const processName = "GamePilot.MaaBridge.exe";
const inventoryScript = String.raw`
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$ProgressPreference='SilentlyContinue'
$ErrorActionPreference='Stop'
try {
  $nativeBridgeProcesses=@(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'GamePilot.MaaBridge.exe'" -ErrorAction Stop)
  $nativeBridgeRows=@($nativeBridgeProcesses | ForEach-Object { [pscustomobject]@{ name=[string]$_.Name; processId=[long]$_.ProcessId } })
  [pscustomobject]@{ version=1; complete=$true; processName='GamePilot.MaaBridge.exe'; processes=$nativeBridgeRows } | ConvertTo-Json -Depth 4 -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine('Native executor process inventory unavailable.')
  exit 1
}`;

function unconfirmed() {
  return new AgentToolError(
    "NATIVE_EXECUTOR_EXIT_UNCONFIRMED",
    "无法核实原生执行器已退出；暂不允许新的执行。",
  );
}
function assertActive(signal: AbortSignal) {
  if (signal.aborted)
    throw new AgentToolError("CANCELLED", "原生执行器退出核验已取消。");
}
function validateInventory(input: unknown): NativeExecutorInventory {
  const value = agentObject(input, [
    "version",
    "complete",
    "processName",
    "processes",
  ]);
  if (
    value.version !== 1 ||
    value.complete !== true ||
    value.processName !== processName ||
    !Array.isArray(value.processes)
  )
    throw unconfirmed();
  const processes = value.processes.map((raw) => {
    const row = agentObject(raw, ["name", "processId"]);
    if (
      typeof row.name !== "string" ||
      row.name.toLowerCase() !== processName.toLowerCase() ||
      !Number.isSafeInteger(row.processId) ||
      Number(row.processId) <= 0
    )
      throw unconfirmed();
    return { name: row.name, processId: Number(row.processId) };
  });
  return { version: 1, complete: true, processName, processes };
}
async function readInventory(
  signal: AbortSignal,
): Promise<NativeExecutorInventory> {
  assertActive(signal);
  if (process.platform !== "win32") throw unconfirmed();
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      win32.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", inventoryScript],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
        signal,
      },
      (error, output, stderr) => {
        if (error || typeof output !== "string" || stderr.trim())
          reject(unconfirmed());
        else resolve(output);
      },
    );
  });
  assertActive(signal);
  return validateInventory(JSON.parse(stdout.replace(/^\uFEFF/, "")));
}

export interface NativeExecutorInventory {
  version: 1;
  complete: true;
  processName: "GamePilot.MaaBridge.exe";
  processes: { name: string; processId: number }[];
}
export interface NativeExecutorExitDependencies {
  inventory?(signal: AbortSignal): Promise<NativeExecutorInventory>;
  clock?(): string;
  pause?(ms: number, signal: AbortSignal): Promise<void>;
}
export interface NativeExecutorExitProof {
  verified: true;
  observedAt: string;
  evidenceReference: string;
}
export async function verifyNativeExecutorExit(
  signal: AbortSignal,
  deps: NativeExecutorExitDependencies = {},
): Promise<NativeExecutorExitProof> {
  assertActive(signal);
  const inventory = deps.inventory ?? readInventory;
  const clock = deps.clock ?? (() => new Date().toISOString());
  const pause =
    deps.pause ??
    ((ms, cancellation) => delay(ms, undefined, { signal: cancellation }));
  try {
    const observations: { observedAt: string; processes: [] }[] = [];
    for (let index = 0; index < 2; index++) {
      assertActive(signal);
      const snapshot = validateInventory(await inventory(signal));
      assertActive(signal);
      if (snapshot.processes.length) throw unconfirmed();
      const observedAt = agentDate(clock());
      assertActive(signal);
      if (
        observations.length &&
        Date.parse(observedAt) < Date.parse(observations[0].observedAt)
      )
        throw unconfirmed();
      observations.push({ observedAt, processes: [] });
      if (index === 0) {
        await pause(250, signal);
        assertActive(signal);
      }
    }
    const digest = createHash("sha256")
      .update(canonical({ version: 1, processName, observations }))
      .digest("hex");
    assertActive(signal);
    return {
      verified: true,
      observedAt: observations[1].observedAt,
      evidenceReference: `native-executor-exit:sha256:${digest}`,
    };
  } catch {
    assertActive(signal);
    throw unconfirmed();
  }
}
