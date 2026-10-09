import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { LaneRuntimeManager } from "../apps/desktop/main/lane-runtime";
import type { DeviceLane, RunEvent } from "../packages/protocol";

class FakeWorker extends EventEmitter {
  requests: string[] = [];
  async request<T>(method: string): Promise<T> {
    this.requests.push(method);
    return null as T;
  }
  close() {
    this.requests.push("close");
  }
  async closeAndWait() {
    this.close();
  }
}

const lane = (id: string, instance: number): DeviceLane => ({
  id,
  name: id,
  managerPath: "D:\\MuMu\\nx_main\\MuMuManager.exe",
  instance,
  enabled: true,
  arknights: { enabled: true, profileId: "default" },
  onmyoji: { enabled: instance === 0 },
  closeEmulatorAfterSuccess: false,
});

describe("lane runtime manager", () => {
  it("does not recreate a worker after close while its exit is still unconfirmed", async () => {
    const old = new FakeWorker();
    const manager = new LaneRuntimeManager("worker.js", "data", () => old);
    manager.get("a");
    manager.close();
    expect(() => manager.get("a")).toThrow(/退出/);
    await expect(manager.run(lane("a", 0), async () => {})).rejects.toThrow(
      /退出/,
    );
  });
  it("awaits idle worker exit before recreating a lane", async () => {
    let release!: () => void;
    const old = new FakeWorker();
    old.closeAndWait = () =>
      new Promise<void>((done) => {
        release = done;
      });
    const manager = new LaneRuntimeManager("worker.js", "data", () => old);
    manager.get("a");
    const closing = manager.disposeIdle();
    expect(() => manager.get("a")).toThrow();
    await expect(manager.run(lane("a", 0), async () => {})).rejects.toThrow();
    release();
    await closing;
    expect(() => manager.get("a")).not.toThrow();
  });
  it("refuses to dispose active workers or claim an unconfirmed exit", async () => {
    const old = new FakeWorker();
    const manager = new LaneRuntimeManager("worker.js", "data", () => old);
    let release!: () => void;
    const job = manager.run(
      lane("a", 0),
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    await expect(manager.disposeIdle()).rejects.toThrow();
    expect(old.requests).not.toContain("close");
    release();
    await job;
    old.closeAndWait = async () => {
      throw new Error("exit unconfirmed");
    };
    await expect(manager.disposeIdle()).rejects.toThrow("exit unconfirmed");
  });
  it("tracks batch ownership after a lane is reused", async () => {
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      () => new FakeWorker(),
    );
    let release!: () => void;
    const first = manager.run(
      lane("lane-a", 0),
      async () => {
        await new Promise<void>((done) => {
          release = done;
        });
      },
      "first",
    );
    expect(manager.isRunningBatch("lane-a", "first")).toBe(true);
    expect(manager.isRunningBatch("lane-a", "other")).toBe(false);
    release();
    await first;
    expect(manager.isRunningBatch("lane-a", "first")).toBe(false);
    const second = manager.run(
      lane("lane-a", 0),
      async () => {
        await new Promise<void>((done) => {
          release = done;
        });
      },
      "second",
    );
    expect(manager.isRunningBatch("lane-a", "first")).toBe(false);
    expect(manager.isRunningBatch("lane-a", "second")).toBe(true);
    release();
    await second;
    manager.close();
  });
  it("starts both lanes before either finishes and tags their events", async () => {
    const workers = new Map<string, FakeWorker>();
    const events: RunEvent[] = [];
    const manager = new LaneRuntimeManager("worker.js", "data", (id) => {
      const worker = new FakeWorker();
      workers.set(id, worker);
      return worker;
    });
    manager.on("event", (event) => events.push(event));
    const entered: string[] = [];
    const releases = new Map<string, () => void>();
    const running = manager.runAll(
      [lane("lane-a", 0), lane("lane-b", 1)],
      async (item) => {
        entered.push(item.id);
        await new Promise<void>((resolve) => releases.set(item.id, resolve));
        return item.id;
      },
    );
    await Promise.resolve();
    expect(new Set(entered)).toEqual(new Set(["lane-a", "lane-b"]));
    workers.get("lane-a")!.emit("event", {
      runId: "run-a",
      type: "log",
      message: "A",
      at: new Date().toISOString(),
    });
    expect(events[0].laneId).toBe("lane-a");
    expect(events[0].laneName).toBe("lane-a");
    expect(events[0].instance).toBe(0);
    releases.get("lane-a")!();
    releases.get("lane-b")!();
    expect((await running).map((item) => item.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("stops one lane without stopping the other", async () => {
    const workers = new Map<string, FakeWorker>();
    const manager = new LaneRuntimeManager("worker.js", "data", (id) => {
      const worker = new FakeWorker();
      workers.set(id, worker);
      return worker;
    });
    manager.get("lane-a");
    manager.get("lane-b");
    await manager.stop("lane-a");
    expect(workers.get("lane-a")!.requests).toEqual(["stop"]);
    expect(workers.get("lane-b")!.requests).toEqual([]);
  });

  it("rejects overlapping work on the same lane", async () => {
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      () => new FakeWorker(),
    );
    let release!: () => void;
    const first = manager.run(
      lane("lane-a", 0),
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await expect(
      manager.run(lane("lane-a", 0), async () => {}),
    ).rejects.toThrow("正在运行");
    release();
    await first;
  });
});
