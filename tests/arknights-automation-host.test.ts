import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defaultDeviceLanes, type DeviceLane } from "../packages/protocol";
import { defaultArknightsProfiles } from "../games/arknights/config";
import type { ArknightsJob } from "../packages/protocol/arknights-automation";
import {
  ArknightsAutomationService,
  type ArknightsAutomationDocument,
} from "../apps/desktop/main/arknights-automation";
import { freezeArknightsJob } from "../apps/desktop/main/arknights-job-snapshot";
import {
  ExecutionCoordinator,
  mumuResource,
} from "../apps/desktop/main/execution-coordinator";
import {
  LaneRuntimeManager,
  type LaneWorker,
} from "../apps/desktop/main/lane-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function lane() {
  const value = structuredClone(
    defaultDeviceLanes({
      managerPath: "D:/MuMu/MuMuManager.exe",
      instance: 0,
      closeEmulatorAfterSuccess: false,
    }).lanes[0],
  );
  value.enabled = true;
  value.arknights.enabled = true;
  return value;
}
const clock = (hours: number, day = 25) => new Date(2026, 9, day, hours);
const job = (laneId = "lane-a"): ArknightsJob => ({
  id: "morning",
  name: "早班",
  laneId,
  enabled: true,
  time: "08:00",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  skillIds: ["recruit", "award"],
  catchUp: true,
});
async function load() {
  const module =
    await import("../apps/desktop/main/arknights-automation-host").catch(
      () => undefined,
    );
  expect(module?.createArknightsAutomationRun).toBeTypeOf("function");
  return module!;
}

it("uses the saved job's account and steps, freezes parameters, and retains its due period", async () => {
  const { createArknightsAutomationRun } = await load();
  const account = lane();
  const profiles = structuredClone(defaultArknightsProfiles);
  const selected = job(account.id);
  const dueAt = clock(8),
    controller = new AbortController();
  const ended = deferred<void>();
  const execution = new ExecutionCoordinator(
    await mkdtemp(join(tmpdir(), "gp-ark-host-")),
  );
  await execution.load();
  let frozen: ReturnType<typeof freezeArknightsJob> | undefined;
  const run = createArknightsAutomationRun({
    readLanes: async () => [account],
    isPreview: () => false,
    readExecution: (id) => execution.get(id),
    launchLane: async (
      target,
      batchId,
      maintenance,
      signal,
      occurrence,
      game,
      gameSlot,
      automationJob,
    ) => {
      expect(maintenance).toBe(false);
      expect(signal).toBe(controller.signal);
      expect(game).toBe("arknights");
      expect(gameSlot).toBeUndefined();
      expect(occurrence).toEqual({ slot: "secondary", dueAt });
      frozen = freezeArknightsJob(target, profiles, automationJob!, clock(9));
      const lease = await execution.begin({
        id: `${batchId}:${target.id}`,
        source: "daily",
        laneId: target.id,
        batchId,
        resources: [
          mumuResource(frozen.lane.managerPath, frozen.lane.instance),
        ],
        snapshot: {
          ...frozen,
          schedule: { ...occurrence, dueAt: occurrence!.dueAt.toISOString() },
        },
      });
      return {
        job: ended.promise.then(() =>
          lease.finish("succeeded", "账号计划已执行"),
        ),
      };
    },
  });
  const admitted = await run(
    selected,
    dueAt,
    controller.signal,
    "manual-frozen",
  );
  selected.skillIds.splice(0, selected.skillIds.length, "fight");
  profiles.profiles[0].stage = "1-7";
  account.arknights.profileId = "changed-after-admission";
  expect(frozen?.arknightsPlan?.skillIds).toEqual([
    "login",
    "recruit",
    "award",
  ]);
  expect(frozen?.profile?.stage).not.toBe("1-7");
  expect(
    execution.get(`manual-frozen:${account.id}`).snapshot.schedule,
  ).toMatchObject({ slot: "secondary", dueAt: dueAt.toISOString() });
  ended.resolve();
  expect(await admitted.completion).toEqual({
    status: "succeeded",
    message: "账号计划已执行",
  });
  expect(admitted.batchId).toBe("manual-frozen");
});

it.each(["succeeded", "failed", "cancelled", "unknown"] as const)(
  "preserves a recorded %s outcome and message when the runtime promise rejects",
  async (status) => {
    const { createArknightsAutomationRun } = await load();
    const run = createArknightsAutomationRun({
      readLanes: async () => [lane()],
      isPreview: () => false,
      readExecution: () => ({ status, message: "原生任务的真实回执" }),
      launchLane: async () => ({
        job: Promise.reject(Error("transport wrapper error")),
      }),
    });
    const admitted = await run(
      job(),
      clock(8),
      new AbortController().signal,
      "manual-rejected",
    );
    expect(await admitted.completion).toEqual({
      status,
      message: "原生任务的真实回执",
    });
  },
);

it.each(["missing", "throwing", "running"])(
  "marks %s execution evidence unknown after a resolved runtime",
  async (mode) => {
    const { createArknightsAutomationRun } = await load();
    const run = createArknightsAutomationRun({
      readLanes: async () => [lane()],
      isPreview: () => false,
      readExecution: () => {
        if (mode === "throwing") throw Error("账本读取失败");
        return mode === "missing"
          ? undefined
          : { status: "running", message: "仍在等待结果" };
      },
      launchLane: async () => ({ job: Promise.resolve() }),
    });
    const admitted = await run(
      job(),
      clock(8),
      new AbortController().signal,
      "manual-no-evidence",
    );
    expect(await admitted.completion).toMatchObject({ status: "unknown" });
  },
);

it("rejects preview and missing accounts before admitting a device", async () => {
  const { createArknightsAutomationRun } = await load();
  const launchLane = vi.fn();
  const readLanes = vi.fn(async () => [] as DeviceLane[]);
  const options = {
    readLanes,
    isPreview: () => true,
    readExecution: () => undefined,
    launchLane,
  };
  const preview = createArknightsAutomationRun(options);
  await expect(
    preview(job(), clock(8), new AbortController().signal, "preview"),
  ).rejects.toThrow(/预览/);
  expect(readLanes).not.toHaveBeenCalled();
  await expect(
    createArknightsAutomationRun({ ...options, isPreview: () => false })(
      job(),
      clock(8),
      new AbortController().signal,
      "missing",
    ),
  ).rejects.toThrow(/不存在/);
  expect(launchLane).not.toHaveBeenCalled();
});

it("honors shutdown while the saved-account read is pending and never admits the late job", async () => {
  const { createArknightsAutomationRun } = await load();
  const accounts = deferred<DeviceLane[]>();
  const launchLane = vi.fn();
  let saved: ArknightsAutomationDocument = {
    version: 1,
    config: { version: 1, enabled: true, jobs: [job()] },
    runs: [],
  };
  const readLanes = vi.fn(() => accounts.promise);
  const service = new ArknightsAutomationService({
    now: () => clock(9),
    store: {
      read: async () => structuredClone(saved),
      save: async (value) => {
        saved = structuredClone(value);
      },
    },
    run: createArknightsAutomationRun({
      readLanes,
      isPreview: () => false,
      readExecution: () => undefined,
      launchLane,
    }),
  });
  const ticking = service.tick(clock(9));
  await vi.waitFor(() => expect(readLanes).toHaveBeenCalledTimes(1));
  await service.stop();
  accounts.resolve([lane()]);
  expect(await ticking).toEqual([]);
  expect(launchLane).not.toHaveBeenCalled();
  expect((await service.state()).runs[0].status).toBe("unknown");
});

it("honors ordinary stop before a lane has entered preparation and keeps the next day eligible", async () => {
  const { createArknightsAutomationRun } = await load();
  const accounts = deferred<DeviceLane[]>();
  const readLanes = vi.fn(() => accounts.promise);
  const launchLane = vi.fn(async () => ({ job: Promise.resolve() }));
  let saved: ArknightsAutomationDocument = {
    version: 1,
    config: { version: 1, enabled: true, jobs: [job()] },
    runs: [],
  };
  const service = new ArknightsAutomationService({
    now: () => clock(9),
    store: {
      read: async () => structuredClone(saved),
      save: async (value) => {
        saved = structuredClone(value);
      },
    },
    run: createArknightsAutomationRun({
      readLanes,
      isPreview: () => false,
      readExecution: () => ({ status: "succeeded", message: "finished" }),
      launchLane,
    }),
  });
  const ticking = service.tick(clock(9));
  await vi.waitFor(() => expect(readLanes).toHaveBeenCalledTimes(1));
  service.cancelActive();
  accounts.resolve([lane()]);
  expect(await ticking).toEqual([]);
  expect(launchLane).not.toHaveBeenCalled();
  expect((await service.state()).runs[0].status).toBe("unknown");
  expect((await service.read()).enabled).toBe(true);
  await service.tick(clock(9, 26));
  expect(launchLane).toHaveBeenCalledTimes(1);
});

it("passes cancellation to queued runtime admission without creating an engine worker", async () => {
  const { createArknightsAutomationRun } = await load();
  const workers: string[] = [];
  const runtime = new LaneRuntimeManager(
    "unused",
    "unused",
    (id) => {
      workers.push(id);
      return Object.assign(new EventEmitter(), {
        request: async () => undefined,
        close() {},
      }) as LaneWorker;
    },
    () => {},
    { maxConcurrent: 1 },
  );
  const occupied = lane();
  occupied.id = "occupied";
  const blocking = deferred<void>();
  const active = runtime.run(
    freezeArknightsJob(occupied, defaultArknightsProfiles, job(occupied.id))
      .lane,
    () => blocking.promise,
    "occupied-batch",
  );
  await vi.waitFor(() => expect(workers).toEqual(["occupied"]));
  const controller = new AbortController();
  let record: { status: "running" | "cancelled"; message: string } = {
    status: "running",
    message: "排队中",
  };
  const run = createArknightsAutomationRun({
    readLanes: async () => [lane()],
    isPreview: () => false,
    readExecution: () => record,
    launchLane: async (
      target,
      batchId,
      _maintenance,
      signal,
      _occurrence,
      _game,
      _slot,
      automationJob,
    ) => {
      const frozen = freezeArknightsJob(
        target,
        defaultArknightsProfiles,
        automationJob!,
      );
      return {
        job: runtime
          .run(
            frozen.lane,
            async () => {
              throw Error("cancelled admission must never run");
            },
            batchId,
            false,
            signal,
          )
          .catch((error) => {
            record = { status: "cancelled", message: "排队已取消" };
            throw error;
          }),
      };
    },
  });
  const admitted = await run(job(), clock(8), controller.signal, "queued");
  controller.abort();
  expect(await admitted.completion).toEqual({
    status: "cancelled",
    message: "排队已取消",
  });
  expect(workers).toEqual(["occupied"]);
  blocking.resolve();
  await active;
  runtime.close();
});

it.each([false, true])(
  "shares App resource exclusion across scheduled accounts (same device: %s)",
  async (sameDevice) => {
    const { createArknightsAutomationRun } = await load();
    const accountA = lane(),
      accountB = lane();
    accountB.id = "ark-b";
    accountB.instance = sameDevice ? accountA.instance : accountA.instance + 1;
    const execution = new ExecutionCoordinator(
      await mkdtemp(join(tmpdir(), "gp-ark-lock-")),
    );
    await execution.load();
    const ended = deferred<void>();
    let saved: ArknightsAutomationDocument = {
      version: 1,
      config: {
        version: 1,
        enabled: true,
        jobs: [job(accountA.id), { ...job(accountB.id), id: "b-morning" }],
      },
      runs: [],
    };
    const service = new ArknightsAutomationService({
      now: () => clock(9),
      store: {
        read: async () => structuredClone(saved),
        save: async (value) => {
          saved = structuredClone(value);
        },
      },
      run: createArknightsAutomationRun({
        readLanes: async () => [accountA, accountB],
        isPreview: () => false,
        readExecution: (id) => execution.get(id),
        launchLane: async (
          target,
          batchId,
          _maintenance,
          signal,
          _occurrence,
          _game,
          _slot,
          automationJob,
        ) => {
          const frozen = freezeArknightsJob(
            target,
            defaultArknightsProfiles,
            automationJob!,
          );
          const lease = await execution.begin(
            {
              id: `${batchId}:${target.id}`,
              source: "daily",
              laneId: target.id,
              batchId,
              resources: [
                mumuResource(frozen.lane.managerPath, frozen.lane.instance),
              ],
              snapshot: { ...frozen },
            },
            signal,
          );
          return {
            job: ended.promise.then(() => lease.finish("succeeded", "done")),
          };
        },
      }),
    });
    expect(await service.tick(clock(9))).toHaveLength(sameDevice ? 1 : 2);
    expect(
      execution.snapshot().filter((record) => record.status === "running"),
    ).toHaveLength(sameDevice ? 1 : 2);
    const state = await service.state();
    if (sameDevice)
      expect(state.runs.find((run) => run.laneId === accountB.id)?.status).toBe(
        "unknown",
      );
    else
      expect(new Set(state.runs.map((run) => run.laneId))).toEqual(
        new Set([accountA.id, accountB.id]),
      );
    ended.resolve();
    await vi.waitFor(async () =>
      expect(
        (await service.state()).runs.every((run) => run.status !== "running"),
      ).toBe(true),
    );
  },
);

it.each([159, 160, 161])(
  "validates the combined execution ID length %i before calling App admission",
  async (length) => {
    const { createArknightsAutomationRun } = await load();
    const account = lane();
    account.id = "a".repeat(64);
    const requestId = "r".repeat(length - account.id.length - 1);
    const launchLane = vi.fn(async () => ({ job: Promise.resolve() }));
    const run = createArknightsAutomationRun({
      readLanes: async () => [account],
      launchLane,
      isPreview: () => false,
      readExecution: () => ({ status: "succeeded", message: "done" }),
    });
    const admission = run(
      job(account.id),
      clock(8),
      new AbortController().signal,
      requestId,
    );
    if (length > 160) {
      await expect(admission).rejects.toThrow(/编号/);
      expect(launchLane).not.toHaveBeenCalled();
    } else {
      expect((await admission).batchId).toBe(requestId);
      expect(launchLane).toHaveBeenCalledTimes(1);
    }
  },
);
