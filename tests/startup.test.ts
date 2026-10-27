import { describe, it, expect } from "vitest";
import { validateAutomation } from "../packages/protocol";
import {
  parseMuMuInfo,
  ensureMuMu,
  connectWhenReady,
} from "../apps/desktop/main/mumu";

describe("startup automation", () => {
  it("migrates empty config to opt-in defaults and rejects unsafe values", () => {
    expect(validateAutomation({})).toEqual({
      managerPath: "",
      instance: 0,
      launchEmulator: false,
      runOnLaunch: false,
      openAtLogin: false,
      scheduleEnabled: false,
      scheduleTime: "08:00",
      secondScheduleEnabled: false,
      secondScheduleTime: "20:00",
      fosterScheduleEnabled: false,
      closeToTray: false,
      notifyResults: false,
      closeEmulatorAfterSuccess: false,
    followActivityStage: false,
    });
    expect(() => validateAutomation({ instance: -1 })).toThrow();
    expect(() => validateAutomation({ runOnLaunch: "true" })).toThrow();
    expect(() => validateAutomation({ managerPath: "cmd.exe" })).toThrow();
    expect(() => validateAutomation({ extra: true })).toThrow();
    expect(() => validateAutomation({ scheduleTime: "24:00" })).toThrow();
    expect(() => validateAutomation({ scheduleEnabled: "true" })).toThrow();
    expect(() => validateAutomation({ secondScheduleTime: "24:00" })).toThrow();
    expect(() =>
      validateAutomation({ secondScheduleEnabled: "true" }),
    ).toThrow();
    expect(() =>
      validateAutomation({
        secondScheduleEnabled: true,
        secondScheduleTime: "08:00",
      }),
    ).toThrow();
    expect(() =>
      validateAutomation({
        secondScheduleEnabled: true,
        secondScheduleTime: "07:00",
      }),
    ).toThrow();
  });
  it("reads the actual instance port and rejects mismatches", () => {
    const info = {
      index: "2",
      error_code: 0,
      is_android_started: true,
      is_process_started: true,
      adb_port: 16448,
    };
    expect(parseMuMuInfo(JSON.stringify(info), 2).address).toBe(
      "127.0.0.1:16448",
    );
    expect(() => parseMuMuInfo(JSON.stringify(info), 0)).toThrow();
    expect(() =>
      parseMuMuInfo(JSON.stringify({ ...info, adb_port: 70000 }), 2),
    ).toThrow();
  });
  it("starts a stopped emulator once and waits for Android", async () => {
    const calls: string[][] = [];
    let reads = 0;
    const run = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args.includes("getprop")) return "1";
      if (args[0] === "connect") return "connected";
      if (args[0] === "control") return "";
      return JSON.stringify({
        index: "0",
        error_code: 0,
        is_process_started: ++reads > 1,
        is_android_started: reads > 1,
        adb_port: 16384,
      });
    };
    const result = await ensureMuMu(
      "D:\\MuMu\\nx_main\\MuMuManager.exe",
      0,
      new AbortController().signal,
      () => {},
      run,
      async () => {},
    );
    expect(result.address).toBe("127.0.0.1:16384");
    expect(calls.filter((a) => a[0] === "control")).toEqual([
      ["control", "-v", "0", "launch"],
    ]);
  });
  it("does not launch or continue after cancellation", async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    await expect(
      ensureMuMu(
        "x",
        0,
        abort.signal,
        () => {},
        async () => {
          calls++;
          return "";
        },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

it("retries transient startup connection failure but bounds retries", async () => {
  let count = 0;
  const signal = new AbortController().signal;
  expect(
    await connectWhenReady(
      async () => {
        if (++count < 3)
          throw Object.assign(Error("warming up"), {
            code: "connection-unavailable",
          });
        return "ready";
      },
      signal,
      async () => {},
    ),
  ).toBe("ready");
  count = 0;
  await expect(
    connectWhenReady(
      async () => {
        count++;
        throw Object.assign(Error("failed"), {
          code: "connection-unavailable",
        });
      },
      signal,
      async () => {},
    ),
  ).rejects.toThrow("failed");
  expect(count).toBe(3);
});
it("does not retry unknown failures or invalid setup", async () => {
  let count = 0;
  await expect(
    connectWhenReady(
      async () => {
        count++;
        throw Error("invalid resource version");
      },
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toThrow("invalid resource");
  expect(count).toBe(1);
});
it("rechecks the device before each extra connection attempt", async () => {
  const calls: string[] = [];
  let count = 0;
  await expect(
    connectWhenReady(
      async () => {
        calls.push("connect");
        if (++count < 3)
          throw Object.assign(Error("offline"), {
            code: "connection-unavailable",
          });
        return "ready";
      },
      new AbortController().signal,
      async () => {},
      async (retry: number) => {
        calls.push(`recheck-${retry}`);
      },
    ),
  ).resolves.toBe("ready");
  expect(calls).toEqual([
    "connect",
    "recheck-1",
    "connect",
    "recheck-2",
    "connect",
  ]);
});
it("stops connection retry immediately when cancelled", async () => {
  const c = new AbortController();
  let count = 0;
  await expect(
    connectWhenReady(
      async () => {
        count++;
        c.abort();
        throw Error("stop");
      },
      c.signal,
      async () => {},
    ),
  ).rejects.toThrow();
  expect(count).toBe(1);
});
