import { expect, it, vi } from "vitest";
import { ensureMuMu, parseMuMuInfo } from "../apps/desktop/main/mumu";

const manager = "D:/MuMu/nx_main/MuMuManager.exe";
const state = (running = false) =>
  JSON.stringify({
    index: "0",
    error_code: 0,
    is_process_started: running,
    is_android_started: running,
    adb_port: 16384,
    pid: 123,
  });
const stopping = JSON.stringify({
  index: "0",
  error_code: 0,
  is_process_started: true,
  is_android_started: false,
  player_state: "stopping",
  adb_port: 16384,
});

it("preserves the manager stopping state rather than treating it as Android boot", () => {
  expect(parseMuMuInfo(stopping, 0)).toMatchObject({
    running: true,
    ready: false,
    playerState: "stopping",
  });
});

it("waits for a stopping instance to be confirmed stopped before launching it once", async () => {
  let reads = 0;
  let launched = false;
  const log = vi.fn();
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "info") {
      reads++;
      return launched ? state(true) : reads < 3 ? stopping : state(false);
    }
    if (args[0] === "control") {
      expect(reads).toBeGreaterThanOrEqual(3);
      launched = true;
      return '{"errcode":0}';
    }
    return "1";
  });
  const result = await ensureMuMu(
    manager,
    0,
    new AbortController().signal,
    log,
    run,
    async () => {},
  );
  expect(result).toMatchObject({
    startedByUs: true,
    address: "127.0.0.1:16384",
  });
  expect(run.mock.calls.filter(([, args]) => args[0] === "control")).toEqual([
    [manager, ["control", "-v", "0", "launch"]],
  ]);
  expect(log.mock.calls[0][0]).toContain("停止");
});

it("classifies a persistently stopping instance without any launch or ADB command", async () => {
  const run = vi.fn(async (_file: string, _args: string[]) => stopping);
  const pause = vi.fn(async () => {});
  await expect(
    ensureMuMu(manager, 0, new AbortController().signal, () => {}, run, pause),
  ).rejects.toMatchObject({
    message: expect.stringContaining("停止"),
    fault: { code: "mumu-stopping-timeout" },
  });
  expect(pause.mock.calls.length).toBeGreaterThan(0);
  expect(pause.mock.calls.length).toBeLessThanOrEqual(15);
  expect(run.mock.calls.every(([, args]) => args[0] === "info")).toBe(true);
});

it("does not launch after cancellation while waiting for the previous stop", async () => {
  const controller = new AbortController();
  const run = vi.fn(async () => stopping);
  await expect(
    ensureMuMu(
      manager,
      0,
      controller.signal,
      () => {},
      run,
      async () => {
        controller.abort();
      },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(run).toHaveBeenCalledExactlyOnceWith(manager, ["info", "-v", "0"]);
});

it.each(["is_process_started", "is_android_started"])(
  "does not infer a completed stop from a missing %s flag",
  async (missing) => {
    let reads = 0;
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] !== "info") throw Error("must not launch or use ADB");
      if (++reads === 1) return stopping;
      const incomplete = JSON.parse(state(false));
      delete incomplete[missing];
      return JSON.stringify(incomplete);
    });
    await expect(
      ensureMuMu(
        manager,
        0,
        new AbortController().signal,
        () => {},
        run,
        async () => {},
      ),
    ).rejects.toMatchObject({ fault: { code: "mumu-startup-interrupted" } });
    expect(run.mock.calls.every(([, args]) => args[0] === "info")).toBe(true);
  },
);

it.each([false, true])(
  "never relaunches after a failed response enters stopping (running=%s)",
  async (running) => {
    let launches = 0;
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "info")
        return launches
          ? JSON.stringify({
              ...JSON.parse(stopping),
              is_process_started: running,
            })
          : state(false);
      if (args[0] === "control") {
        launches++;
        throw Error("RPC unavailable");
      }
      throw Error("must not use ADB while stopping");
    });
    await expect(
      ensureMuMu(
        manager,
        0,
        new AbortController().signal,
        () => {},
        run,
        async () => {},
      ),
    ).rejects.toMatchObject({ fault: { code: "mumu-stopping-timeout" } });
    expect(launches).toBe(1);
  },
);

it.each([false, true])(
  "never treats stopping during Android boot as a retryable boot failure (eventuallyStopped=%s)",
  async (eventuallyStopped) => {
    let reads = 0;
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] !== "info") throw Error("must not launch or use ADB");
      reads++;
      if (reads === 1)
        return JSON.stringify({
          ...JSON.parse(stopping),
          player_state: "starting",
        });
      return eventuallyStopped && reads > 2 ? state(false) : stopping;
    });
    await expect(
      ensureMuMu(
        manager,
        0,
        new AbortController().signal,
        () => {},
        run,
        async () => {},
      ),
    ).rejects.toMatchObject({
      fault: {
        code: eventuallyStopped
          ? "mumu-startup-interrupted"
          : "mumu-stopping-timeout",
      },
    });
    expect(run.mock.calls.every(([, args]) => args[0] === "info")).toBe(true);
  },
);

it("keeps an unconfirmed stop nonretryable when its state read fails", async () => {
  let reads = 0;
  const run = vi.fn(async () => {
    if (++reads === 1) return stopping;
    throw Error("RPC unavailable");
  });
  await expect(
    ensureMuMu(
      manager,
      0,
      new AbortController().signal,
      () => {},
      run,
      async () => {},
    ),
  ).rejects.toMatchObject({ fault: { code: "mumu-startup-interrupted" } });
});

it("rechecks after a failed launch and does not relaunch an instance that started", async () => {
  let running = false;
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "info") return state(running);
    if (args[0] === "control") {
      running = true;
      throw Error("RPC disconnected");
    }
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
  expect(result.address).toBe("127.0.0.1:16384");
  expect(result.startedByUs).toBe(false); // A failed response is not proof of ownership.
  expect(run.mock.calls.filter(([, a]) => a[0] === "control")).toHaveLength(1);
});
it("retries a confirmed stopped instance at most twice, preserving command diagnostics", async () => {
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "info") return state();
    throw Object.assign(Error("launch failed"), {
      code: 7,
      stderr: "RPC not ready",
    });
  });
  await expect(
    ensureMuMu(
      manager,
      0,
      new AbortController().signal,
      () => {},
      run,
      async () => {},
    ),
  ).rejects.toThrow("RPC not ready");
  expect(run.mock.calls.filter(([, a]) => a[0] === "control")).toHaveLength(3);
});
it("treats nonzero manager JSON as failure and can recover after state check", async () => {
  let launches = 0;
  const run = async (_file: string, args: string[]) => {
    if (args[0] === "info") return state(launches === 2);
    if (args[0] === "control")
      return JSON.stringify({ errcode: ++launches === 1 ? 7 : 0 });
    return "1";
  };
  expect(
    (
      await ensureMuMu(
        manager,
        0,
        new AbortController().signal,
        () => {},
        run,
        async () => {},
      )
    ).startedByUs,
  ).toBe(true);
  expect(launches).toBe(2);
});
it("cancellation during launch recovery prevents further management actions", async () => {
  const abort = new AbortController();
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === "info") return state();
    throw Error("RPC unavailable");
  });
  await expect(
    ensureMuMu(
      manager,
      0,
      abort.signal,
      () => {},
      run,
      async () => {
        abort.abort();
      },
    ),
  ).rejects.toThrow();
  expect(run.mock.calls.filter(([, a]) => a[0] === "control")).toHaveLength(1);
});

it("records structured startup stages without treating cancellation as a fault", async () => {
  for (const scenario of ["query", "launch", "boot"] as const) {
    const run = async (_file: string, args: string[]) => {
      if (scenario === "query")
        throw Object.assign(Error("private manager path"), { code: "ENOENT" });
      if (args[0] === "info") return state(scenario === "boot");
      if (scenario === "launch") throw Error("failed");
      return "0";
    };
    await expect(
      ensureMuMu(
        manager,
        0,
        new AbortController().signal,
        () => {},
        run,
        async () => {},
      ),
    ).rejects.toMatchObject({
      fault: {
        version: 1,
        source: "startup",
        code: {
          query: "mumu-state-unavailable",
          launch: "mumu-launch-failed",
          boot: "mumu-boot-timeout",
        }[scenario],
      },
    });
  }
  const controller = new AbortController();
  controller.abort();
  await ensureMuMu(manager, 0, controller.signal, () => {}).catch((error) =>
    expect(error.fault).toBeUndefined(),
  );
});
