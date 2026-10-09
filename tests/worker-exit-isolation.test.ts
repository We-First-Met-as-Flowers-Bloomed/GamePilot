import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionCoordinator,
  mumuResource,
} from "../apps/desktop/main/execution-coordinator";
import { LaneRuntimeManager } from "../apps/desktop/main/lane-runtime";
import { runWorkerPlan } from "../apps/desktop/main/lane-plan";
import type { DeviceLane } from "../packages/protocol";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork } }));
import { WorkerClient } from "../apps/desktop/main/worker-client";

class Child extends EventEmitter {
  sent: { id: string; method: string }[] = [];
  postMessage(message: { id: string; method: string }) {
    this.sent.push(message);
  }
  kill() {
    return false;
  }
}
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  fork.mockReset();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "gp-worker-isolation-"));
  directories.push(directory);
  const executions = new ExecutionCoordinator(directory);
  await executions.load();
  return executions;
}
async function ready(worker: WorkerClient, child: Child) {
  const ping = worker.request("ping");
  child.emit("message", { id: child.sent.at(-1)!.id, result: true });
  await ping;
}
const request = (id: string, resource = "device-a") => ({
  id,
  source: "daily" as const,
  resources: [resource],
  snapshot: {},
});

it("keeps a watchdog-failed device isolated after its unknown receipt is saved, until actual exit", async () => {
  const executions = await setup();
  const child = new Child();
  fork.mockReturnValue(child);
  const worker = new WorkerClient("unused", "unused");
  executions.trackWorker(worker, () => ["device-a"]);
  const lease = await executions.begin(request("failed"));
  await ready(worker, child);
  vi.useFakeTimers();
  child.emit("message", {
    nativeWait: { id: "stalled", operation: "screencap", phase: "begin" },
  });
  await vi.advanceTimersByTimeAsync(15_001);
  await lease.finish("unknown", "worker timed out");
  expect(worker.exitPending).toBe(true);
  expect(executions.get("failed").status).toBe("unknown");
  expect(executions.active).toBe(true);
  expect(executions.hasUnconfirmedExit(["device-a"])).toBe(true);
  await expect(
    executions.inspect(["device-a"], async () => "unsafe"),
  ).rejects.toThrow(/退出未确认/);
  await expect(executions.inspect(["*"], async () => "unsafe")).rejects.toThrow(
    /退出未确认/,
  );
  await expect(executions.begin(request("replacement"))).rejects.toThrow(
    /退出未确认/,
  );
  await expect(executions.resolve("failed", "结束处理")).rejects.toThrow(
    /退出未确认/,
  );
  await expect(
    executions.inspect(["device-b"], async () => "independent"),
  ).resolves.toBe("independent");
  child.emit("exit", 1);
  expect(executions.active).toBe(false);
  expect(executions.hasUnconfirmedExit(["device-a"])).toBe(false);
  expect(executions.get("failed").status).toBe("unknown");
  await expect(
    executions.inspect(["device-a"], async () => "safe"),
  ).resolves.toBe("safe");
});

it("does not clear another worker's isolation or accept a stale exit from a previous child", async () => {
  const executions = await setup();
  const oldChild = new Child(),
    newChild = new Child(),
    otherChild = new Child();
  fork
    .mockReturnValueOnce(oldChild)
    .mockReturnValueOnce(otherChild)
    .mockReturnValueOnce(newChild);
  const worker = new WorkerClient("unused", "unused"),
    other = new WorkerClient("unused", "unused");
  executions.trackWorker(worker, () => ["device-a"]);
  executions.trackWorker(other, () => ["device-a"]);
  await ready(worker, oldChild);
  await ready(other, otherChild);
  worker.close();
  other.close();
  oldChild.emit("exit", 1);
  expect(executions.hasUnconfirmedExit(["device-a"])).toBe(true);
  await ready(worker, newChild);
  worker.close();
  oldChild.emit("exit", 1);
  otherChild.emit("exit", 1);
  expect(executions.hasUnconfirmedExit(["device-a"])).toBe(true);
  newChild.emit("exit", 1);
  expect(executions.hasUnconfirmedExit(["device-a"])).toBe(false);
});

it("retains inspection isolation when closeAndWait times out and releases it on a late exit", async () => {
  const executions = await setup();
  const child = new Child();
  fork.mockReturnValue(child);
  const worker = new WorkerClient("unused", "unused");
  executions.trackWorker(worker, () => ["device-a"]);
  await ready(worker, child);
  vi.useFakeTimers();
  const inspection = executions.inspect(["device-a"], () =>
    worker.closeAndWait(100),
  );
  const rejected = expect(inspection).rejects.toThrow(/退出未确认/);
  await vi.advanceTimersByTimeAsync(101);
  await rejected;
  expect(executions.active).toBe(true);
  await expect(
    executions.inspect(["device-a"], async () => {}),
  ).rejects.toThrow(/退出未确认/);
  child.emit("exit", 1);
  expect(executions.active).toBe(false);
});

it("freezes the terminating worker's resources and keeps an independent active lease after exit", async () => {
  const executions = await setup();
  const child = new Child();
  fork.mockReturnValue(child);
  const worker = new WorkerClient("unused", "unused");
  let resources = ["device-a"];
  executions.trackWorker(worker, () => resources);
  const lease = await executions.begin(request("original"));
  await ready(worker, child);
  worker.close();
  resources = ["device-b"];
  worker.close();
  expect(executions.hasUnconfirmedExit(["device-a"])).toBe(true);
  expect(executions.hasUnconfirmedExit(["device-b"])).toBe(false);
  child.emit("exit", 1);
  expect(executions.active).toBe(true);
  await expect(
    executions.inspect(["device-a"], async () => {}),
  ).rejects.toThrow(/占用/);
  await lease.finish("unknown", "exit did not determine the game result");
  expect(executions.active).toBe(false);
});

it.each(["empty", "throws"])(
  "isolates all devices when a terminating worker's binding is %s",
  async (kind) => {
    const executions = await setup();
    const child = new Child();
    fork.mockReturnValue(child);
    const worker = new WorkerClient("unused", "unused");
    executions.trackWorker(worker, () => {
      if (kind === "throws") throw Error("binding unavailable");
      return [];
    });
    await ready(worker, child);
    worker.close();
    expect(executions.hasUnconfirmedExit(["unrelated-device"])).toBe(true);
    await expect(
      executions.inspect(["device-a"], async () => {}),
    ).rejects.toThrow(/退出未确认/);
    child.emit("exit", 1);
    expect(executions.hasUnconfirmedExit()).toBe(false);
  },
);

it("keeps lane resources isolated after run completion without treating the failed receipt as exit proof", async () => {
  const executions = await setup();
  const lane: DeviceLane = {
    id: "lane-a",
    name: "A",
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    enabled: true,
    arknights: { enabled: false, profileId: "default" },
    onmyoji: { enabled: true },
    closeEmulatorAfterSuccess: false,
  };
  const resource = mumuResource(lane.managerPath, lane.instance);
  const child = new Child();
  fork.mockReturnValue(child);
  const worker = new WorkerClient("unused", "unused", 10);
  const manager = new LaneRuntimeManager(
    "unused",
    "unused",
    () => worker,
    (created, resources) => executions.trackWorker(created, resources),
  );
  const lease = await executions.begin({
    ...request("batch:lane-a", resource),
    laneId: lane.id,
    batchId: "batch",
  });
  vi.useFakeTimers();
  const task = manager.run(
    lane,
    async (_lane, engine, signal) => {
      try {
        await runWorkerPlan(
          engine,
          { gameId: "onmyoji", mode: "live", skillIds: ["login"] },
          signal,
        );
      } catch (error) {
        await lease.finish("unknown", String(error));
        throw error;
      }
    },
    "batch",
  );
  const failed = expect(task).rejects.toThrow(/超时/);
  child.emit("message", {
    event: {
      runId: "run",
      gameId: "onmyoji",
      type: "status",
      status: "running",
      at: new Date().toISOString(),
      message: "",
    },
  });
  child.emit("message", { id: child.sent[0].id, result: { runId: "run" } });
  await vi.advanceTimersByTimeAsync(11);
  await failed;
  expect(manager.isRunningBatch(lane.id, "batch")).toBe(false);
  expect(executions.get("batch:lane-a").status).toBe("unknown");
  expect(executions.hasUnconfirmedExit([resource])).toBe(true);
  await expect(executions.inspect([resource], async () => {})).rejects.toThrow(
    /退出未确认/,
  );
  await expect(manager.run(lane, async () => {})).rejects.toThrow(
    /退出未确认|终止/,
  );
  child.emit("exit", 1);
  expect(executions.hasUnconfirmedExit([resource])).toBe(false);
});
