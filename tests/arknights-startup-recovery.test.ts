import { expect, it } from "vitest";
import {
  startupCrash,
  readStartupState,
} from "../games/arknights/startup-recovery";
import {
  executeArknightsTask,
  type ArknightsExecutionOptions,
} from "../games/arknights/execution";

const pkg = "com.hypergryph.arknights";
const device = { name: "MuMu", adbPath: "adb", address: "127.0.0.1:16416" };
const exit = (n: number, process = pkg, reason = "2 (SIGNALED)") =>
  `ApplicationExitInfo #0:\n timestamp=2026-09-28 10:46:5${n}.294 pid=${2138 + n} realUid=10051\n process=${process} reason=${reason} subreason=0 (UNKNOWN) status=11`;
async function state(
  n: number,
  running = false,
  foreground = "com.mumu.launcher",
) {
  return readStartupState(
    device,
    "Official",
    new AbortController().signal,
    async (_file, args) => {
      if (args.includes("exit-info"))
        return "ACTIVITY MANAGER PROCESS EXIT INFO\n" + exit(n);
      if (args.includes("ps"))
        return (
          "USER PID PPID VSZ RSS WCHAN ADDR S NAME\n" +
          (running ? `u0_a1 1 0 0 0 0 0 S ${pkg}` : "")
        );
      if (args.includes("window"))
        return `mCurrentFocus=Window{123 u0 ${foreground}/.Main}`;
      return "com.mumu.launcher/.Launcher";
    },
  );
}
it("requires a new main-process signal 11 exit, absent process and known launcher", async () => {
  const before = await state(0),
    after = await state(1);
  expect(startupCrash(before, after)).toBe(true);
  expect(startupCrash(before, before)).toBe(false);
  expect(startupCrash(before, await state(1, true))).toBe(false);
  expect(startupCrash(before, await state(1, false, "com.other.app"))).toBe(
    false,
  );
  expect(startupCrash(undefined, after)).toBe(false);
  expect(
    startupCrash(before, {
      ...after,
      latestExit: { ...after.latestExit!, process: pkg + ":pushcore" },
    }),
  ).toBe(false);
  expect(
    startupCrash(before, {
      ...after,
      latestExit: { ...after.latestExit!, reason: 10 },
    }),
  ).toBe(false);
});
it("fails closed for unsupported Android diagnostics", async () => {
  await expect(
    readStartupState(
      device,
      "Official",
      new AbortController().signal,
      async () => "unsupported",
    ),
  ).rejects.toThrow();
});
async function setup(failures: number, type = "StartUp") {
  let attempt = 0;
  const calls: string[] = [];
  const controller = new AbortController();
  const options: ArknightsExecutionOptions = {
    device,
    task: {
      type,
      params: { client_type: "Official", start_game_enabled: true },
    },
    maxRunMinutes: 120,
    signal: controller.signal,
    log: () => {},
    readStartup: async () => state(attempt),
    checkReady: async () => {
      calls.push("ready");
    },
    pause: async () => {
      calls.push("pause");
    },
    createCore: () => ({
      connect: async () => {
        calls.push("connect");
      },
      runTask: async (_type, _params, _signal, log) => {
        attempt++;
        calls.push(`task-${attempt}`);
        log(`MAA 10001: {"taskchain":"${type}","taskid":${attempt}}`);
        if (attempt <= failures) throw Error("native failure");
        log(`MAA 10002: {"taskchain":"${type}","taskid":${attempt}}`);
      },
      close: async () => {
        calls.push("close");
      },
    }),
  };
  return { options, calls, controller };
}
it("closes the old bridge, rechecks, then retries only login and confirms the new native task", async () => {
  const { options, calls } = await setup(1);
  const result = await executeArknightsTask(options);
  expect(result.arknights?.completion).toBe("native-confirmed");
  expect(calls).toEqual([
    "connect",
    "task-1",
    "close",
    "pause",
    "ready",
    "connect",
    "task-2",
    "close",
  ]);
});
it("limits crash recovery to two retries", async () => {
  const { options, calls } = await setup(4);
  await expect(executeArknightsTask(options)).rejects.toThrow(/崩溃.*2/);
  expect(calls.filter((s) => s.startsWith("task-"))).toHaveLength(3);
});
it.each(["Fight", "Recruit", "Infrast"])(
  "never retries submitted %s even with crash evidence",
  async (type) => {
    const { options, calls } = await setup(3, type);
    await expect(executeArknightsTask(options)).rejects.toThrow(
      "native failure",
    );
    expect(calls).toEqual(["connect", "task-1", "close"]);
  },
);
it("preserves unknown errors when diagnostics are unavailable or stale", async () => {
  const { options, calls } = await setup(1);
  options.readStartup = async () => state(0);
  await expect(executeArknightsTask(options)).rejects.toThrow("native failure");
  expect(calls).toHaveLength(3);
});
it("never retries cancellation or a foreground change during the recovery delay", async () => {
  const a = await setup(1);
  a.options.pause = async () => {
    a.controller.abort(Error("user stop"));
  };
  await expect(executeArknightsTask(a.options)).rejects.toThrow("user stop");
  expect(a.calls.filter((s) => s.startsWith("task-"))).toHaveLength(1);
  const b = await setup(1);
  b.options.pause = async () => {
    b.options.readStartup = async () => state(1, false, "com.other.app");
  };
  await expect(executeArknightsTask(b.options)).rejects.toThrow(
    "native failure",
  );
  expect(b.calls.filter((s) => s.startsWith("task-"))).toHaveLength(1);
});
