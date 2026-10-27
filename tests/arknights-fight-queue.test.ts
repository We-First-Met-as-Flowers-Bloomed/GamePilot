import { expect, it, vi } from "vitest";
import {
  fightTasksFor,
  defaultArknightsConfig,
} from "../games/arknights/config";
import { executeArknightsFightQueue } from "../games/arknights/fight-queue";

function setup() {
  const tasks = fightTasksFor({
    ...defaultArknightsConfig,
    stage: "LS-6",
    taskOptions: {
      fight: {
        stages: ["LS-5", "1-7", "AP-5"],
        times: 4,
        series: 2,
        medicine: 3,
        stone: 2,
        drops: { "30011": 10 },
      },
    },
  });
  let id = 0;
  const runTask = vi.fn(
    async (
      _type: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal,
      log: (line: string) => void,
    ) => {
      id++;
      const event = (code: number, fields: object = {}) =>
        log(
          `MAA ${code}: ${JSON.stringify({ taskchain: "Fight", taskid: id, ...fields })}`,
        );
      event(10001);
      if (id === 1) {
        event(20002, {
          subtask: "ProcessTask",
          details: { task: "StoneConfirm", exec_times: 1 },
        });
        event(20003, {
          what: "UseMedicine",
          details: { count: 2, is_expiring: false },
        });
        event(20003, {
          what: "StageDrops",
          details: {
            stage: { stageCode: "LS-6" },
            stars: 3,
            stats: [{ itemId: "30011", quantity: 4 }],
          },
        });
      }
      if (id === 2)
        event(20003, {
          what: "StageDrops",
          details: {
            stage: { stageCode: "1-7" },
            stars: 3,
            stats: [{ itemId: "30011", quantity: 6 }],
          },
        });
      event(10002);
    },
  );
  const core = {
    connect: vi.fn(async () => {}),
    runTask,
    close: vi.fn(async () => {}),
  };
  const options = {
    device: { name: "test", adbPath: "fake", address: "fake" },
    tasks,
    signal: new AbortController().signal,
    log: vi.fn(),
    maxRunMinutes: 120,
    createCore: () => core,
  };
  return { options, runTask };
}
it("runs the ordered queue with the App primary stage and a single shared supply/drop budget", async () => {
  const { options, runTask } = setup();
  expect(options.tasks.map((task) => task.params.stage)).toEqual([
    "LS-6",
    "1-7",
    "AP-5",
  ]);
  const result = await executeArknightsFightQueue(options);
  expect(runTask).toHaveBeenCalledTimes(2);
  expect(runTask.mock.calls[0][1]).toMatchObject({
    medicine: 3,
    stone: 2,
    drops: { "30011": 10 },
    series: 2,
    times: 4,
  });
  expect(runTask.mock.calls[1][1]).toMatchObject({
    medicine: 1,
    stone: 1,
    drops: { "30011": 6 },
  });
  expect(result.summary).toMatch(/2\/3/);
});
it("does not continue after a missing completion callback or a cancelled native task", async () => {
  const { options, runTask } = setup();
  runTask.mockImplementationOnce(async () => {});
  await expect(executeArknightsFightQueue(options)).rejects.toThrow(/完成回调/);
  expect(runTask).toHaveBeenCalledOnce();
});
it("does not reuse medicines if a confirm callback exists without a counted consumption report", async () => {
  const { options, runTask } = setup();
  options.tasks = options.tasks.map((task) => ({
    ...task,
    params: { ...task.params, drops: {} },
  }));
  runTask.mockImplementationOnce(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    log(
      'MAA 20002: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"MedicineConfirm","exec_times":1}}',
    );
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
  });
  await executeArknightsFightQueue(options);
  expect(runTask.mock.calls[1][1].medicine).toBe(0);
});

it("does not reuse medicine after a later confirmation starts without its consumption report", async () => {
  const { options, runTask } = setup();
  options.tasks = options.tasks.map((task) => ({
    ...task,
    params: { ...task.params, drops: {} },
  }));
  runTask.mockImplementationOnce(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    log(
      'MAA 20001: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"MedicineConfirm","exec_times":1}}',
    );
    log(
      'MAA 20002: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"MedicineConfirm","exec_times":1}}',
    );
    log(
      'MAA 20003: {"taskchain":"Fight","taskid":1,"what":"UseMedicine","details":{"count":1}}',
    );
    log(
      'MAA 20001: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"MedicineConfirm","exec_times":1}}',
    );
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
  });
  await executeArknightsFightQueue(options);
  expect(runTask.mock.calls[1][1].medicine).toBe(0);
});

it("counts completed stone confirmations even if a ProcessTask counter restarts", async () => {
  const { options, runTask } = setup();
  options.tasks = options.tasks.map((task) => ({
    ...task,
    params: { ...task.params, drops: {} },
  }));
  runTask.mockImplementationOnce(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    for (let i = 0; i < 2; i++) {
      log(
        'MAA 20001: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"StoneConfirm","exec_times":1}}',
      );
      log(
        'MAA 20002: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"StoneConfirm","exec_times":1}}',
      );
    }
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
  });
  await executeArknightsFightQueue(options);
  expect(runTask.mock.calls[1][1].stone).toBe(0);
});

it("does not reuse stone after a later confirmation starts without completing", async () => {
  const { options, runTask } = setup();
  options.tasks = options.tasks.map((task) => ({
    ...task,
    params: { ...task.params, drops: {} },
  }));
  runTask.mockImplementationOnce(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    log(
      'MAA 20001: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"StoneConfirm","exec_times":1}}',
    );
    log(
      'MAA 20002: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"StoneConfirm","exec_times":1}}',
    );
    log(
      'MAA 20001: {"taskchain":"Fight","taskid":1,"subtask":"ProcessTask","details":{"task":"StoneConfirm","exec_times":2}}',
    );
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
  });
  await executeArknightsFightQueue(options);
  expect(runTask.mock.calls[1][1].stone).toBe(0);
});

it("uses one queue deadline and does not start another stage after the shared budget expires", async () => {
  const { options, runTask } = setup();
  options.tasks = options.tasks.map((task) => ({
    ...task,
    params: { ...task.params, drops: {} },
  }));
  options.maxRunMinutes = 2;
  let elapsed = 0;
  const original = runTask.getMockImplementation()!;
  runTask.mockImplementation(async (...args) => {
    await original(...args);
    elapsed += 60_000;
  });
  await expect(
    executeArknightsFightQueue({ ...options, now: () => elapsed }),
  ).rejects.toThrow(/共享运行时长/);
  expect(runTask).toHaveBeenCalledTimes(2);
  expect((runTask.mock.calls[0] as unknown[])[4]).toBe(180_000);
  expect((runTask.mock.calls[1] as unknown[])[4]).toBe(120_000);
});

it("ignores other task IDs and late callbacks when carrying the remaining medicine budget", async () => {
  const { options, runTask } = setup();
  options.tasks = options.tasks.map((task) => ({
    ...task,
    params: { ...task.params, drops: {} },
  }));
  runTask.mockImplementationOnce(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    log(
      'MAA 20003: {"taskchain":"Fight","taskid":999,"what":"UseMedicine","details":{"count":9}}',
    );
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
    log(
      'MAA 20003: {"taskchain":"Fight","taskid":1,"what":"UseMedicine","details":{"count":9}}',
    );
  });
  await executeArknightsFightQueue(options);
  expect(runTask.mock.calls[1][1].medicine).toBe(3);
});

it("stops rather than resetting a drop target after unrecognized cumulative drops", async () => {
  const { options, runTask } = setup();
  runTask.mockImplementationOnce(async (_type, _params, _signal, log) => {
    log('MAA 10001: {"taskchain":"Fight","taskid":1}');
    log('MAA 10002: {"taskchain":"Fight","taskid":1}');
  });
  await expect(executeArknightsFightQueue(options)).rejects.toThrow(/累计掉落/);
  expect(runTask).toHaveBeenCalledOnce();
});
