import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { ExecutionCoordinator } from "../apps/desktop/main/execution-coordinator";

const source = readFileSync(
  new URL("../apps/desktop/main/index.ts", import.meta.url),
  "utf8",
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
class ExitSource extends EventEmitter {
  exitPending = false;
  terminate() {
    this.exitPending = true;
    this.emit("terminating");
  }
  exit() {
    this.exitPending = false;
    this.emit("exit");
  }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "gp-device-ipc-"));
  directories.push(directory);
  const executions = new ExecutionCoordinator(directory);
  await executions.load();
  return executions;
}
// Execute the actual IPC registration without booting Electron or copying its guards.
function handler(
  channel: string,
  executions: ExecutionCoordinator,
  request: (method: string, ...args: unknown[]) => Promise<unknown>,
) {
  const start = source.indexOf(`handle("${channel}",`);
  const end = source.indexOf("\n      });", start);
  if (start < 0 || end < 0) throw Error(`IPC registration missing: ${channel}`);
  const registration = source.slice(start, end + "\n      });".length);
  const body = transformSync(
    `
    let action;
    const handle = (_channel, callback) => { action = callback; };
    const worker = { request };
    const settings = { read: async () => ({ adbPath: 'D:/fake/adb.exe' }), save: async (value) => value };
    const history = { active: false };
    const validateDevice = (value) => value;
    let starting = false, connecting = false, finishing = false, configuring = false;
    let automaticReserved = false, startupInspectionRunning = false;
    let lastEngine = null, connectedDevice, engineError;
    ${registration}
    return action;
  `,
    { loader: "ts" },
  ).code;
  return new Function("executions", "request", body)(executions, request) as (
    input?: unknown,
  ) => Promise<unknown>;
}
const device = {
  name: "MuMu",
  adbPath: "D:/fake/adb.exe",
  address: "127.0.0.1:16384",
};

it.each(["gp:capture", "gp:discover", "gp:connect", "gp:arknights-probe"])(
  "%s sends no RPC until the other worker's actual exit",
  async (channel) => {
    const executions = await setup();
    const lane = new ExitSource();
    executions.trackWorker(lane, () => ["same-device"]);
    lane.terminate();
    const request = vi.fn(async () => ({ connected: true }));
    const invoke = handler(channel, executions, request);
    await expect(
      Promise.resolve().then(() => invoke(device)),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(executions.hasUnconfirmedExit()).toBe(true);
    lane.exit();
    await invoke(device);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it.each(["gp:capture", "gp:discover", "gp:connect", "gp:arknights-probe"])(
  "%s holds an inspection lease across the pending RPC",
  async (channel) => {
    const executions = await setup();
    let finish!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const invoke = handler(channel, executions, request);
    const operation = invoke(device);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(executions.active).toBe(true);
    await expect(
      executions.inspect(["same-device"], async () => {}),
    ).rejects.toThrow(/占用/);
    finish({ connected: true });
    await operation;
    expect(executions.active).toBe(false);
    expect(executions.snapshot()).toHaveLength(0);
  },
);
