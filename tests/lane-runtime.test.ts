import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { LaneRuntimeManager, type LaneWorker } from "../apps/desktop/main/lane-runtime";
import type { DeviceLane, RunEvent } from "../packages/protocol";
import { freezeLaneExecutionForGame } from "../apps/desktop/main/lane-snapshot";
import { defaultArknightsProfiles } from "../games/arknights/config";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";

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
  it("runs four isolated devices together and stops only the selected channel", async () => {
    const workers = new Map<string, FakeWorker>();
    const resources = new Map<LaneWorker, () => string[]>();
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      (id) => {
        const worker = new FakeWorker();
        workers.set(id, worker);
        return worker;
      },
      (worker, owned) => resources.set(worker, owned),
      { maxConcurrent: 4, minFreeMemoryBytes: 1024, availableMemory: () => 4096 },
    );
    const releases: (() => void)[] = [];
    const running = [0, 1, 2, 3].map((instance) =>
      manager.run(lane(`channel-${instance}`, instance), () =>
        new Promise<void>((done) => releases.push(done)),
      ),
    );
    try {
      expect(workers.size).toBe(4);
      expect(new Set([...resources.values()].map((read) => read()[0])).size).toBe(4);
      await manager.stop("channel-2");
      expect(workers.get("channel-2")!.requests).toEqual(["stop"]);
      for (const id of ["channel-0", "channel-1", "channel-3"])
        expect(workers.get(id)!.requests).toEqual([]);
    } finally {
      releases.forEach((done) => done());
      await Promise.all(running);
    }
    expect(manager.active).toBe(false);
  });

  it("cancels queued work when the owning batch is aborted", async () => {
    const created: string[] = [];
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      (id) => {
        created.push(id);
        return new FakeWorker();
      },
      undefined,
      { maxConcurrent: 1 },
    );
    let release!: () => void;
    const first = manager.run(
      lane("a", 0),
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const batch = new AbortController();
    const second = manager.run(
      lane("b", 1),
      async () => {},
      "batch",
      false,
      batch.signal,
    );
    const outcome = second.then(
      () => undefined,
      (error) => error,
    );
    batch.abort();
    release();
    await first;
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(created).toEqual(["a"]);
  });
  it("queues worker creation behind the configured execution limit", async () => {
    const workers = new Map<string, FakeWorker>();
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      (id) => {
        const worker = new FakeWorker();
        workers.set(id, worker);
        return worker;
      },
      undefined,
      { maxConcurrent: 1 },
    );
    let release!: () => void;
    const first = manager.run(
      lane("a", 0),
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const second = manager.run(lane("b", 1), async () => "second");
    expect([...workers.keys()]).toEqual(["a"]);
    expect(manager.isRunning("b")).toBe(true);
    expect(workers.get("a")!.requests).toEqual([]);
    release();
    await first;
    expect(await second).toBe("second");
    expect([...workers.keys()]).toEqual(["a", "b"]);
    expect(workers.get("a")!.requests).toEqual([]);
  });

  it("cancels a queued lane without creating its worker or stopping another lane", async () => {
    const workers = new Map<string, FakeWorker>();
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      (id) => {
        const worker = new FakeWorker();
        workers.set(id, worker);
        return worker;
      },
      undefined,
      { maxConcurrent: 1 },
    );
    let release!: () => void;
    const first = manager.run(
      lane("a", 0),
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const second = manager.run(lane("b", 1), async () => {});
    const rejected = expect(second).rejects.toMatchObject({
      name: "AbortError",
    });
    await manager.stop("b");
    await rejected;
    expect(manager.isRunning("b")).toBe(false);
    expect(workers.has("b")).toBe(false);
    expect(workers.get("a")!.requests).toEqual([]);
    release();
    await first;
  });

  it("waits for free memory, then resumes without preempting existing workers", async () => {
    vi.useFakeTimers();
    try {
      let free = 10;
      const worker = new FakeWorker();
      let created = 0;
      const manager = new LaneRuntimeManager(
        "worker.js",
        "data",
        () => {
          created++;
          return worker;
        },
        undefined,
        {
          maxConcurrent: 1,
          availableMemory: () => free,
          minFreeMemoryBytes: 100,
          pollIntervalMs: 50,
          waitTimeoutMs: 500,
        },
      );
      const running = manager.run(lane("a", 0), async () => "done");
      expect(created).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(created).toBe(0);
      free = 100;
      await vi.advanceTimersByTimeAsync(50);
      expect(await running).toBe("done");
      expect(created).toBe(1);
      expect(worker.requests).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out memory waits without creating or stopping workers", async () => {
    vi.useFakeTimers();
    try {
      let created = 0;
      const manager = new LaneRuntimeManager(
        "worker.js",
        "data",
        () => {
          created++;
          return new FakeWorker();
        },
        undefined,
        {
          availableMemory: () => 0,
          minFreeMemoryBytes: 100,
          pollIntervalMs: 50,
          waitTimeoutMs: 100,
        },
      );
      const running = manager.run(lane("a", 0), async () => {});
      const rejected = expect(running).rejects.toThrow(/等待.*资源.*超时/);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(created).toBe(0);
      expect(manager.active).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopAll cancels memory-queued lanes that have no workers", async () => {
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      () => new FakeWorker(),
      undefined,
      { availableMemory: () => 0, minFreeMemoryBytes: 100 },
    );
    const running = manager.run(lane("a", 0), async () => {});
    const rejected = expect(running).rejects.toMatchObject({
      name: "AbortError",
    });
    await manager.stopAll();
    await rejected;
    expect(manager.active).toBe(false);
  });
  it("uses the frozen game device for worker preparation, isolation and events", async () => {
    const configured = lane("a", 0);
    configured.deviceInstances = { onmyoji: 2 };
    const frozen = freezeLaneExecutionForGame(
      configured,
      defaultArknightsProfiles,
      "onmyoji",
      false,
    )!;
    const worker = new FakeWorker();
    let tracked!: () => string[];
    const events: RunEvent[] = [];
    const manager = new LaneRuntimeManager(
      "worker.js",
      "data",
      () => worker,
      (_worker, resources) => {
        tracked = resources;
      },
    );
    manager.on("event", (event) => events.push(event));
    await manager.run(frozen.lane, async (selected) => {
      expect(selected.instance).toBe(2);
      expect(tracked()).toEqual([mumuResource(configured.managerPath, 2)]);
      worker.emit("event", {
        runId: "r",
        gameId: "onmyoji",
        type: "log",
        at: new Date().toISOString(),
        message: "ready",
        instance: 0,
      });
    });
    expect(events[0].instance).toBe(2);
  });

  it("rejects unresolved game overrides before creating a worker", async () => {
    let created = false;
    const manager = new LaneRuntimeManager("worker.js", "data", () => {
      created = true;
      return new FakeWorker();
    });
    const configured = lane("a", 0);
    configured.deviceInstances = { onmyoji: 2 };
    await expect(manager.run(configured, async () => {})).rejects.toThrow(
      /冻结/,
    );
    expect(created).toBe(false);
    expect(manager.active).toBe(false);
  });
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
