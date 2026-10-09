import { describe, expect, it } from "vitest";
import { executeLanePlan, runWorkerPlan } from "../apps/desktop/main/lane-plan";
import { EventEmitter } from "node:events";
import type { DeviceLane, MuMuInstance, RunEvent } from "../packages/protocol";
import {
  SkillResultQueue,
  findFosterLane,
} from "../apps/desktop/main/skill-results";

const lane = (onmyoji = true): DeviceLane => ({
  id: "lane-a",
  name: "MuMu 0",
  managerPath: "D:\\MuMu\\nx_main\\MuMuManager.exe",
  instance: 0,
  enabled: true,
  arknights: { enabled: true, profileId: "b-account" },
  onmyoji: { enabled: onmyoji },
  closeEmulatorAfterSuccess: false,
});

describe("per-lane plan", () => {
  it("attributes a later game's failure to that game after the first game succeeds", async () => {
    const started: string[] = [];
    await expect(
      executeLanePlan(lane(), {
        prepare: async () => {},
        gameStarted: (id) => {
          started.push(id);
        },
        arknights: async () => {},
        closeArknights: async () => {},
        onmyoji: async () => {
          throw new Error("sign overlay did not close");
        },
      }),
    ).rejects.toThrow("sign overlay did not close");
    expect(started).toEqual(["arknights", "onmyoji"]);
    expect(started.at(-1)).toBe("onmyoji");
  });
  it("lets each simulator enter Onmyoji after its own Arknights finishes", async () => {
    const actions: string[] = [];
    const releases: Record<string, () => void> = {};
    const entered: Record<string, () => void> = {};
    const ready = (id: string) =>
      new Promise<void>((r) => {
        entered[id] = r;
      });
    const readyA = ready("a"),
      readyB = ready("b");
    const run = (id: string) =>
      executeLanePlan(
        { ...lane(), id },
        {
          prepare: async () => {},
          arknights: async () => {
            actions.push(id + ":arknights");
            await new Promise<void>((r) => {
              releases[id] = r;
              entered[id]();
            });
          },
          closeArknights: async () => {
            actions.push(id + ":close");
          },
          onmyoji: async () => {
            actions.push(id + ":onmyoji");
          },
        },
      );
    const a = run("a"),
      b = run("b");
    await Promise.all([readyA, readyB]);
    releases.a();
    await a;
    expect(actions).toEqual([
      "a:arknights",
      "b:arknights",
      "a:close",
      "a:onmyoji",
    ]);
    releases.b();
    await b;
    expect(actions.slice(-2)).toEqual(["b:close", "b:onmyoji"]);
  });
  it("writes a result while later worker steps are still running", async () => {
    const worker = Object.assign(new EventEmitter(), {
      request: async <T>() => ({ runId: "r" }) as T,
      close: () => {},
    });
    const writes: string[] = [];
    const run = runWorkerPlan(
      worker,
      { gameId: "onmyoji", skillIds: ["foster"], mode: "live" },
      undefined,
      async (event) => {
        writes.push(event.runId);
      },
    );
    await Promise.resolve();
    worker.emit("event", {
      runId: "r",
      gameId: "onmyoji",
      skillId: "foster",
      type: "log",
      result: { outcome: "active" },
    });
    await Promise.resolve();
    expect(writes).toEqual(["r"]);
    worker.emit("event", { runId: "r", status: "succeeded" });
    await run;
  });
  it("ignores rehearsal, wrong game, wrong skill and unrelated runs", async () => {
    const writes: string[] = [];
    const make = (mode: "live" | "rehearsal") =>
      new SkillResultQueue(
        { gameId: "onmyoji", skillIds: ["foster"], mode },
        async (event) => {
          writes.push(event.runId);
        },
      );
    for (const queue of [make("live"), make("rehearsal")]) {
      queue.bind("r");
      for (const wrong of [
        { gameId: "arknights" },
        { skillId: "login" },
        { runId: "old" },
      ])
        queue.accept({
          runId: "r",
          gameId: "onmyoji",
          skillId: "foster",
          type: "log",
          result: { outcome: "active" },
          ...wrong,
        } as RunEvent);
      await queue.flush();
    }
    expect(writes).toEqual([]);
  });
  it("matches legacy launches by manager and instance, and attached devices by discovered address", async () => {
    const a = lane(),
      b = { ...lane(), id: "lane-b", instance: 2 };
    const config = {
      launchEmulator: true,
      managerPath: a.managerPath.toLowerCase().replaceAll("\\", "/"),
      instance: 2,
    };
    const discover = async () => [
      { instance: 2, address: "127.0.0.1:2000" } as MuMuInstance,
    ];
    expect(await findFosterLane([a, b], config, undefined, discover)).toEqual(
      b,
    );
    expect(
      await findFosterLane(
        [a, b],
        { ...config, launchEmulator: false },
        "127.0.0.1:2000",
        discover,
      ),
    ).toEqual(b);
    expect(
      await findFosterLane(
        [a, b],
        { ...config, launchEmulator: false },
        "unrelated",
        discover,
      ),
    ).toBeUndefined();
  });
  it("persists only this run's skill result before reporting a later failure, including early events", async () => {
    const seen: string[] = [];
    const worker = Object.assign(new EventEmitter(), {
      request: async <T>() => {
        for (const runId of ["other", "r"])
          worker.emit("event", {
            runId,
            gameId: "onmyoji",
            skillId: "foster",
            type: "log",
            message: "result",
            at: "now",
            result: { outcome: runId },
          });
        worker.emit("event", {
          runId: "r",
          status: "failed",
          message: "later task failed",
        });
        return { runId: "r" } as T;
      },
      close: () => {},
    });
    await expect(
      runWorkerPlan(
        worker,
        {
          gameId: "onmyoji",
          skillIds: ["foster", "hana-claim"],
          mode: "live",
        },
        undefined,
        async (event) => {
          await Promise.resolve();
          seen.push(event.result!.outcome!);
        },
      ),
    ).rejects.toThrow("later task failed");
    expect(seen).toEqual(["r"]);
  });
  it("waits for result persistence and surfaces storage errors", async () => {
    const worker = Object.assign(new EventEmitter(), {
      request: async <T>() => {
        worker.emit("event", {
          runId: "r",
          gameId: "onmyoji",
          skillId: "foster",
          result: { outcome: "active" },
          type: "log",
        });
        worker.emit("event", { runId: "r", status: "succeeded" });
        return { runId: "r" } as T;
      },
      close: () => {},
    });
    await expect(
      runWorkerPlan(
        worker,
        { gameId: "onmyoji", skillIds: ["foster"], mode: "live" },
        undefined,
        async () => {
          throw new Error("disk full");
        },
      ),
    ).rejects.toThrow("disk full");
  });
  it("does not start a game when stop arrives while its configuration is pending", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const configured = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const worker = Object.assign(new EventEmitter(), {
      request: async <T>(method: string) => {
        calls.push(method);
        return { runId: "r" } as T;
      },
      close: () => {},
    });
    const task = executeLanePlan(
      lane(),
      {
        prepare: async () => {},
        arknights: async () => {
          await configured;
          await runWorkerPlan(
            worker,
            { gameId: "arknights", skillIds: ["login"], mode: "live" },
            controller.signal,
          );
        },
        closeArknights: async () => {},
        onmyoji: async () => {},
      },
      controller.signal,
    );
    const cancelled = expect(task).rejects.toThrow();
    controller.abort();
    release();
    await cancelled;
    expect(calls).not.toContain("start");
  });
  it("rejects a worker exit instead of waiting forever for a terminal event", async () => {
    const worker = Object.assign(new EventEmitter(), {
      request: async <T>() => ({ runId: "r" }) as T,
      close: () => {},
    });
    const job = runWorkerPlan(worker, {
      gameId: "arknights",
      skillIds: ["login"],
      mode: "live",
    });
    const result = expect(job).rejects.toThrow("退出");
    await Promise.resolve();
    worker.emit("exit");
    await result;
    expect(worker.listenerCount("event")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  });
  it("does not enter the next game when cancelled between steps", async () => {
    const abort = new AbortController();
    const actions: string[] = [];
    await expect(
      executeLanePlan(
        lane(),
        {
          prepare: async () => {},
          arknights: async () => {},
          closeArknights: async () => {
            abort.abort();
          },
          onmyoji: async () => {
            actions.push("onmyoji");
          },
        },
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(actions).toEqual([]);
  });
  it("runs Arknights, confirms close, then runs Onmyoji", async () => {
    const actions: string[] = [];
    const result = await executeLanePlan(lane(), {
      prepare: async () => void actions.push("prepare"),
      arknights: async () => void actions.push("arknights"),
      closeArknights: async () => void actions.push("close"),
      onmyoji: async () => void actions.push("onmyoji"),
    });
    expect(actions).toEqual(["prepare", "arknights", "close", "onmyoji"]);
    expect(result).toEqual({
      arknights: "succeeded",
      closeArknights: "succeeded",
      onmyoji: "succeeded",
    });
  });

  it("finishes after closing Arknights when Onmyoji is disabled", async () => {
    const actions: string[] = [];
    const result = await executeLanePlan(lane(false), {
      prepare: async () => void actions.push("prepare"),
      arknights: async () => void actions.push("arknights"),
      closeArknights: async () => void actions.push("close"),
      onmyoji: async () => void actions.push("onmyoji"),
    });
    expect(actions).toEqual(["prepare", "arknights", "close"]);
    expect(result.onmyoji).toBe("skipped");
  });

  it("never closes or starts Onmyoji after Arknights failure", async () => {
    const actions: string[] = [];
    await expect(
      executeLanePlan(lane(), {
        prepare: async () => void actions.push("prepare"),
        arknights: async () => {
          actions.push("arknights");
          throw new Error("ark failed");
        },
        closeArknights: async () => void actions.push("close"),
        onmyoji: async () => void actions.push("onmyoji"),
      }),
    ).rejects.toThrow("ark failed");
    expect(actions).toEqual(["prepare", "arknights"]);
  });

  it("never starts Onmyoji when client exit is unconfirmed", async () => {
    const actions: string[] = [];
    await expect(
      executeLanePlan(lane(), {
        prepare: async () => void actions.push("prepare"),
        arknights: async () => void actions.push("arknights"),
        closeArknights: async () => {
          actions.push("close");
          throw new Error("still running");
        },
        onmyoji: async () => void actions.push("onmyoji"),
      }),
    ).rejects.toThrow("still running");
    expect(actions).toEqual(["prepare", "arknights", "close"]);
  });
});
