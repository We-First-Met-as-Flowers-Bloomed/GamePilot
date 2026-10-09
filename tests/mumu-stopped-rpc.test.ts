import { expect, it, vi } from "vitest";
import {
  closeOwnedMuMu,
  currentMuMuDevice,
  ensureMuMu,
  parseMuMuInfo,
  parseMuMuInstances,
} from "../apps/desktop/main/mumu";

const manager = String.raw`D:\MuMu\nx_main\MuMuManager.exe`;
// Native info -v 0 / info -v all, 2026-10-04 20:42, while instance 0 was stopped.
const stopped = {
  android_version: "15.0",
  created_timestamp: 1789391494039652,
  disk_size_bytes: 44044727883,
  error_code: 900,
  hyperv_enabled: false,
  index: "0",
  info_source: "rpc",
  is_android_started: false,
  is_main: false,
  is_process_started: false,
  name: "MuMu安卓设备",
};
const healthy = {
  index: "1",
  error_code: 0,
  info_source: "rpc",
  is_android_started: true,
  is_process_started: true,
  name: "MuMu安卓设备-1",
  adb_port: 16416,
  pid: 3912,
};

it("recognizes the exact RPC 900 stopped record without inventing readiness, PID or ADB address", () => {
  expect(parseMuMuInfo(JSON.stringify(stopped), 0)).toEqual({
    pid: undefined,
    running: false,
    ready: false,
    address: "",
  });
  expect(parseMuMuInfo(JSON.stringify([stopped, healthy]), 0)).toEqual({
    pid: undefined,
    running: false,
    ready: false,
    address: "",
  });
});

it("keeps RPC 900 stopped identity unready even with stale PID and invalid ADB port", () => {
  const stale = { ...stopped, pid: 1234, adb_port: "stale" };
  expect(parseMuMuInfo(JSON.stringify(stale), 0)).toEqual({
    pid: undefined,
    running: false,
    ready: false,
    address: "",
  });
  expect(parseMuMuInstances(JSON.stringify({ "0": stale }))[0]).toMatchObject({
    instance: 0,
    running: false,
    ready: false,
    address: "",
  });
});

it("preserves discovery of a healthy instance alongside the real stopped RPC 900 instance", () => {
  expect(
    parseMuMuInstances(JSON.stringify({ "0": stopped, "1": healthy })),
  ).toEqual([
    {
      instance: 0,
      name: stopped.name,
      running: false,
      ready: false,
      address: "",
      arknights: null,
      onmyoji: false,
    },
    {
      instance: 1,
      name: healthy.name,
      running: true,
      ready: true,
      address: "127.0.0.1:16416",
      arknights: null,
      onmyoji: false,
    },
  ]);
});

it("launches the confirmed stopped instance once and obtains its new PID and reported dynamic ADB port", async () => {
  let launched = false;
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "info")
      return JSON.stringify(
        launched
          ? { ...healthy, index: "0", pid: 4123, adb_port: 25232 }
          : stopped,
      );
    if (args[0] === "control") {
      launched = true;
      return '{"errcode":0}';
    }
    if (args[0] === "connect") return "connected";
    return "1";
  });
  const result = await ensureMuMu(
    manager,
    0,
    new AbortController().signal,
    () => {},
    run,
    async () => {},
  );
  expect(result).toEqual({
    startedByUs: true,
    pid: 4123,
    instance: 0,
    managerPath: manager,
    adbPath: String.raw`D:\MuMu\nx_main\adb.exe`,
    address: "127.0.0.1:25232",
  });
  expect(run.mock.calls.map(([, args]) => args)).toEqual([
    ["info", "-v", "0"],
    ["control", "-v", "0", "launch"],
    ["info", "-v", "0"],
    ["connect", "127.0.0.1:25232"],
    ["-s", "127.0.0.1:25232", "shell", "getprop", "sys.boot_completed"],
  ]);
});

it("retains read-only lookup's offline rejection without launching the stopped instance", async () => {
  const run = vi.fn(async () => JSON.stringify(stopped));
  await expect(currentMuMuDevice(manager, 0, run)).rejects.toThrow(
    "原模拟器未就绪",
  );
  expect(run).toHaveBeenCalledExactlyOnceWith(manager, ["info", "-v", "0"]);
});

it("recognizes RPC 900 stop evidence only after shutting down the previously owned PID", async () => {
  let shutdown = false;
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "control") {
      shutdown = true;
      return '{"errcode":0}';
    }
    return JSON.stringify(
      shutdown ? stopped : { ...healthy, index: "0", pid: 4123 },
    );
  });
  expect(
    await closeOwnedMuMu(
      { managerPath: manager, instance: 0, startedByUs: true, pid: 4123 },
      run,
    ),
  ).toBe(true);
  expect(run.mock.calls.map(([, args]) => args)).toEqual([
    ["info", "-v", "0"],
    ["control", "-v", "0", "shutdown"],
    ["info", "-v", "0"],
  ]);
});

const invalidStopped: Array<{
  label: string;
  patch: Record<string, unknown>;
}> = [
  { label: "other error", patch: { error_code: 901 } },
  { label: "coerced string error", patch: { error_code: "900" } },
  { label: "second nonzero error", patch: { errcode: -200 } },
  { label: "not RPC", patch: { info_source: "file" } },
  { label: "missing source", patch: { info_source: undefined } },
  { label: "process running", patch: { is_process_started: true } },
  { label: "Android ready", patch: { is_android_started: true } },
  { label: "missing process flag", patch: { is_process_started: undefined } },
  { label: "missing Android flag", patch: { is_android_started: undefined } },
  { label: "coerced false process", patch: { is_process_started: "false" } },
  { label: "coerced false Android", patch: { is_android_started: 0 } },
  { label: "different index", patch: { index: "1" } },
  { label: "missing index", patch: { index: undefined } },
];
it.each(invalidStopped)(
  "rejects the $label RPC 900 record instead of inferring stopped state",
  ({ patch }) => {
    const invalid = { ...stopped, ...patch };
    expect(() => parseMuMuInfo(JSON.stringify(invalid), 0)).toThrow();
    expect(() =>
      parseMuMuInstances(JSON.stringify({ "0": invalid, "1": healthy })),
    ).toThrow();
  },
);

it("rejects the real nonexistent-instance -200 manager response without reaching launch", async () => {
  const raw = JSON.stringify({
    errcode: -200,
    errmsg: "player index not found",
    info_source: "rpc",
  });
  expect(() => parseMuMuInfo(raw, 0)).toThrow();
  expect(() => parseMuMuInstances(raw)).toThrow();
  const run = vi.fn(async () => raw);
  await expect(
    ensureMuMu(
      manager,
      0,
      new AbortController().signal,
      () => {},
      run,
      async () => {},
    ),
  ).rejects.toMatchObject({ fault: { code: "mumu-state-unavailable" } });
  expect(run).toHaveBeenCalledExactlyOnceWith(manager, ["info", "-v", "0"]);
});

it.each(invalidStopped)(
  "never reaches launch for the $label state",
  async ({ patch }) => {
    const run = vi.fn(async () => JSON.stringify({ ...stopped, ...patch }));
    await expect(
      ensureMuMu(
        manager,
        0,
        new AbortController().signal,
        () => {},
        run,
        async () => {},
      ),
    ).rejects.toMatchObject({ fault: { code: "mumu-state-unavailable" } });
    expect(run).toHaveBeenCalledExactlyOnceWith(manager, ["info", "-v", "0"]);
  },
);
