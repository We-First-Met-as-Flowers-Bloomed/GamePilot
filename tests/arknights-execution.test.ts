import { afterEach, expect, it, vi } from "vitest";
import {
  executeArknightsTask,
  type ArknightsExecutionOptions,
} from "../games/arknights/execution";
import { ConnectionUnavailableError } from "../packages/protocol/failure";

afterEach(() => vi.useRealTimers());
it("shows the latest settlement batch in the result without claiming it is the run total", async () => {
  const { options, cores } = setup();
  cores[0].runTask.mockImplementation(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    log(
      'MAA 20003: {"taskchain":"Fight","taskid":1,"what":"StageDrops","details":{"stage":{"stageCode":"LS-6"},"stars":3,"cur_times":3}}',
    );
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
  });
  const result = await executeArknightsTask(options);
  expect(result.summary).toContain("最近一次结算：LS-6 · 3 星 · 本批 3 次");
  expect(result.arknights?.lastSettlement).toEqual({
    stage: "LS-6",
    stars: 3,
    batchRuns: 3,
  });
});
function setup() {
  const controller = new AbortController();
  const calls: string[] = [];
  const cores = Array.from({ length: 3 }, (_, i) => ({
    connect: vi.fn(async () => {
      calls.push(`connect-${i}`);
    }),
    runTask: vi.fn(
      async (
        ..._args: Parameters<
          ReturnType<ArknightsExecutionOptions["createCore"]>["runTask"]
        >
      ) => {
        calls.push(`task-${i}`);
        _args[3](
          `MAA 10001: ${JSON.stringify({ taskchain: _args[0], taskid: 1 })}`,
        );
        _args[3](
          `MAA 10002: ${JSON.stringify({ taskchain: _args[0], taskid: 1 })}`,
        );
      },
    ),
    close: vi.fn(async () => {
      calls.push(`close-${i}`);
    }),
  }));
  let next = 0;
  const options: ArknightsExecutionOptions = {
    device: { name: "test", adbPath: "fake-adb", address: "fake-address" },
    task: { type: "Fight", params: { stage: "1-7", medicine: 0, stone: 0 } },
    signal: controller.signal,
    log: vi.fn(),
    maxRunMinutes: 120,
    createCore: vi.fn(() => cores[next++]),
    checkReady: vi.fn(async () => {
      calls.push("recheck");
    }),
    pause: vi.fn(async () => {
      calls.push("pause");
    }),
  };
  return { controller, calls, cores, options };
}
it("rechecks after a failed connection, creates a fresh bridge and submits the task once", async () => {
  const { cores, calls, options } = setup();
  cores[0].connect.mockImplementationOnce(async () => {
    calls.push("connect-0");
    throw new ConnectionUnavailableError("offline");
  });
  await executeArknightsTask(options);
  expect(calls).toEqual([
    "connect-0",
    "close-0",
    "pause",
    "recheck",
    "connect-1",
    "task-1",
    "close-1",
  ]);
  expect(options.checkReady).toHaveBeenCalledWith(
    options.device,
    options.signal,
  );
  expect(cores[1].connect).toHaveBeenCalledWith("fake-adb", "fake-address");
  expect(cores[0].runTask).not.toHaveBeenCalled();
  expect(cores[1].runTask).toHaveBeenCalledExactlyOnceWith(
    "Fight",
    options.task.params,
    options.signal,
    expect.any(Function),
    7_260_000,
  );
  expect(options.createCore).toHaveBeenCalledTimes(2);
});
it("does not retry unknown connection failures", async () => {
  const { cores, options } = setup();
  const error = new Error("native fault");
  cores[0].connect.mockRejectedValue(error);
  await expect(executeArknightsTask(options)).rejects.toBe(error);
  expect(options.createCore).toHaveBeenCalledOnce();
  expect(options.checkReady).not.toHaveBeenCalled();
  expect(options.pause).not.toHaveBeenCalled();
  expect(cores[0].close).toHaveBeenCalledOnce();
  expect(cores[0].runTask).not.toHaveBeenCalled();
});
it("does not retry task failures even if their error is connection-classified", async () => {
  const { cores, options } = setup();
  const error = new ConnectionUnavailableError("failure after task submission");
  cores[0].runTask.mockRejectedValue(error);
  await expect(executeArknightsTask(options)).rejects.toBe(error);
  expect(options.createCore).toHaveBeenCalledOnce();
  expect(options.pause).not.toHaveBeenCalled();
  expect(cores[0].runTask).toHaveBeenCalledOnce();
  expect(cores[0].close).toHaveBeenCalledOnce();
});
it("allows at most two extra connection attempts and closes every bridge", async () => {
  const { cores, options } = setup();
  cores.forEach((core) =>
    core.connect.mockRejectedValue(new ConnectionUnavailableError("offline")),
  );
  await expect(executeArknightsTask(options)).rejects.toThrow("offline");
  expect(options.createCore).toHaveBeenCalledTimes(3);
  expect(options.checkReady).toHaveBeenCalledTimes(2);
  expect(options.pause).toHaveBeenCalledTimes(2);
  for (const core of cores) {
    expect(core.close).toHaveBeenCalledOnce();
    expect(core.runTask).not.toHaveBeenCalled();
  }
});
it.each(["parent", "total-deadline"])(
  "never submits a task if %s cancels during connection retry",
  async (source) => {
    vi.useFakeTimers();
    const { cores, options, controller } = setup();
    const deadline = new AbortController();
    options.signal = AbortSignal.any([controller.signal, deadline.signal]);
    cores[0].connect.mockRejectedValue(
      new ConnectionUnavailableError("offline"),
    );
    options.pause = undefined; // Exercise the real abortable recovery delay.
    const reason = new Error(source);
    setTimeout(
      () => (source === "parent" ? controller : deadline).abort(reason),
      100,
    );
    const outcome = executeArknightsTask(options).catch((error) => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await outcome).toBeInstanceOf(Error);
    expect(options.createCore).toHaveBeenCalledOnce();
    expect(options.checkReady).not.toHaveBeenCalled();
    expect(cores[0].close).toHaveBeenCalledOnce();
    cores.forEach((core) => expect(core.runTask).not.toHaveBeenCalled());
  },
);
it.each(["entry", "connected", "task-return", "close-return"])(
  "checks cancellation at %s",
  async (point) => {
    const { cores, options, controller } = setup();
    const reason = new Error("cancelled");
    if (point === "entry") controller.abort(reason);
    if (point === "connected")
      cores[0].connect.mockImplementationOnce(async () => {
        controller.abort(reason);
      });
    if (point === "task-return")
      cores[0].runTask.mockImplementationOnce(async () => {
        controller.abort(reason);
      });
    if (point === "close-return")
      cores[0].close.mockImplementationOnce(async () => {
        controller.abort(reason);
      });
    await expect(executeArknightsTask(options)).rejects.toBe(reason);
    if (point === "entry") expect(options.createCore).not.toHaveBeenCalled();
    else expect(cores[0].close).toHaveBeenCalledOnce();
    if (point === "entry" || point === "connected")
      expect(cores[0].runTask).not.toHaveBeenCalled();
  },
);
it("rejects OfflineConfirm even when the bridge task reports success", async () => {
  const { cores, options } = setup();
  const message =
    'MAA 20001: {"taskchain":"Fight","details":{"task":"OfflineConfirm"}}';
  cores[0].runTask.mockImplementationOnce(
    async (_type, _params, _signal, log) => {
      log(message);
    },
  );
  const evidence: unknown[] = [];
  options.publishEvidence = (value) => evidence.push(value);
  const error = await executeArknightsTask(options).catch(
    (error: Error) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("异常确认页面");
  expect((error as Error).message).not.toMatch(/网络|连接中断|重试/);
  expect(evidence.at(-1)).toMatchObject({
    submission: "submitted",
    completion: "unknown",
  });
  expect(options.log).toHaveBeenCalledWith(message);
  expect(cores[0].close).toHaveBeenCalledOnce();
  expect(options.createCore).toHaveBeenCalledOnce();
});
it("passes the configured six-hour budget plus stop grace to the bridge", async () => {
  const { cores, options } = setup();
  options.maxRunMinutes = 360;
  await executeArknightsTask(options);
  expect(cores[0].runTask).toHaveBeenCalledExactlyOnceWith(
    "Fight",
    options.task.params,
    options.signal,
    expect.any(Function),
    21_660_000,
  );
  expect(cores[0].close).toHaveBeenCalledOnce();
});
it("emits final not-submitted evidence when preparation fails, retaining the original error", async () => {
  const { cores, options } = setup();
  const evidence: any[] = [];
  options.publishEvidence = (e) => evidence.push(e);
  const error = new Error("prepare failed");
  cores[0].connect.mockRejectedValue(error);
  await expect(executeArknightsTask(options)).rejects.toBe(error);
  expect(evidence.at(-1)).toMatchObject({
    submission: "not-submitted",
    completion: "not-started",
  });
});
it("returns matched native evidence and marks ambiguous dispatch failures unknown", async () => {
  const { cores, options } = setup();
  const evidence: any[] = [];
  options.publishEvidence = (e) => evidence.push(e);
  cores[0].runTask.mockImplementation(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
  });
  const result = await executeArknightsTask(options);
  expect(result.arknights).toMatchObject({
    completion: "native-confirmed",
    submission: "submitted",
  });
  const failed = setup();
  failed.options.publishEvidence = (e) => evidence.push(e);
  failed.cores[0].runTask.mockRejectedValue(new Error("timeout"));
  await expect(executeArknightsTask(failed.options)).rejects.toThrow("timeout");
  expect(evidence.at(-1)).toMatchObject({
    completion: "unknown",
    submission: "submitted",
  });
});
it("stops if the native bridge returns without a matching task completion callback", async () => {
  const { cores, options } = setup();
  cores[0].runTask.mockImplementation(async () => {});
  await expect(executeArknightsTask(options)).rejects.toThrow("完成回调");
});
