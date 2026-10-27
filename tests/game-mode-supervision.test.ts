import { describe, expect, it } from "vitest";
import * as recovery from "../scripts/game-mode/recovery-device";
import * as catchup from "../scripts/game-mode/catchup";
import * as actors from "../scripts/actors/runtime";
import {
  planDisposition,
  taskEvidenceIsTerminal,
} from "../scripts/game-mode/disposition";
import * as disposition from "../scripts/game-mode/disposition";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { planFor } from "../scripts/game-mode/plans";
import {
  mergeStatus,
  renderDailyReport,
  renderStatus,
} from "../scripts/game-mode/status";
import { summarizeRun } from "../scripts/game-mode/report";
import { completionState } from "../scripts/game-mode/outcome";
import {
  addressForLane,
  selectCliCombos,
  selectCliLane,
} from "../scripts/shared/cli-target.mjs";

const combo = (lane: string, game: "arknights" | "onmyoji") => ({
  lane,
  laneName: "同名账号",
  game,
  skills: ["login"],
  labels: ["上号"],
});
const pending = {
  lane: "lane-a",
  laneName: "账号一",
  game: "onmyoji" as const,
  items: [
    {
      skill: "login",
      label: "上号",
      required: true,
      state: "pending" as const,
      source: "none" as const,
      detail: "",
    },
  ],
  done: 0,
  missing: ["上号"],
};

describe("supervised catchup safety", () => {
  it("recovers each device's own failed predecessor after interleaved lanes", async () => {
    const calls: string[] = [];
    const execute = (catchup as any).executeCatchupQueue;
    expect(execute).toBeTypeOf("function");
    const results = await execute(
      [
        combo("lane-a", "arknights"),
        combo("lane-b", "arknights"),
        combo("lane-a", "onmyoji"),
        combo("lane-b", "onmyoji"),
      ],
      {
        run: async (item: any) => {
          calls.push(`run:${item.lane}:${item.game}`);
          return item.game === "arknights" ? 1 : 0;
        },
        recover: async (previous: any, next: any) => {
          calls.push(`recover:${previous.lane}:${next.game}`);
        },
      },
    );
    expect(calls).toEqual([
      "run:lane-a:arknights",
      "run:lane-b:arknights",
      "recover:lane-a:onmyoji",
      "run:lane-a:onmyoji",
      "recover:lane-b:onmyoji",
      "run:lane-b:onmyoji",
    ]);
    expect(results).toHaveLength(4);
  });

  it("blocks the next actor when device recovery fails while preserving other lanes", async () => {
    const ran: string[] = [];
    const execute = (catchup as any).executeCatchupQueue;
    expect(execute).toBeTypeOf("function");
    const results = await execute(
      [
        combo("lane-a", "arknights"),
        combo("lane-a", "onmyoji"),
        combo("lane-b", "onmyoji"),
      ],
      {
        run: async (item: any) => {
          ran.push(`${item.lane}:${item.game}`);
          return item.game === "arknights" ? 1 : 0;
        },
        recover: async () => {
          throw Error("进程仍在运行");
        },
      },
    );
    expect(ran).toEqual(["lane-a:arknights", "lane-b:onmyoji"]);
    expect(results[1]).toMatchObject({
      code: 1,
      blocked: true,
      message: "进程仍在运行",
    });
  });

  it("keeps a device blocked after an unknown child outcome without stopping other devices", async () => {
    const ran: string[] = [];
    const execute = (catchup as any).executeCatchupQueue;
    await execute(
      [
        combo("lane-a", "arknights"),
        combo("lane-a", "onmyoji"),
        combo("lane-b", "onmyoji"),
      ],
      {
        run: async (item: any) => {
          ran.push(`${item.lane}:${item.game}`);
          if (item.lane === "lane-a") throw Error("结果未知");
          return 0;
        },
        recover: async () => {
          throw Error("unknown 不应恢复");
        },
      },
    );
    expect(ran).toEqual(["lane-a:arknights", "lane-b:onmyoji"]);
  });

  it("recovers the shared physical predecessor across different channel IDs only", async () => {
    const calls: string[] = [];
    const resources: Record<string, string> = {
      "ark-a": "mumu:manager#0",
      "ark-b": "mumu:manager#1",
      "onm-a": "mumu:manager#0",
      "onm-b": "mumu:manager#3",
    };
    await catchup.executeCatchupQueue(
      [
        combo("ark-a", "arknights"),
        combo("ark-b", "arknights"),
        combo("onm-a", "onmyoji"),
        combo("onm-b", "onmyoji"),
      ],
      {
        resourceKey: (item) => resources[item.lane],
        run: async (item) => {
          calls.push(`run:${item.lane}`);
          return item.game === "arknights" ? 1 : 0;
        },
        recover: async (previous, next) => {
          calls.push(`recover:${previous.lane}:${next.lane}`);
        },
      },
    );
    expect(calls).toEqual([
      "run:ark-a",
      "run:ark-b",
      "recover:ark-a:onm-a",
      "run:onm-a",
      "run:onm-b",
    ]);
  });

  it("does not recover between different game instances on the same original lane", async () => {
    const recovered: string[] = [];
    await catchup.executeCatchupQueue(
      [combo("lane-a", "arknights"), combo("lane-a", "onmyoji")],
      {
        resourceKey: (item) =>
          `mumu:manager#${item.game === "arknights" ? 0 : 2}`,
        run: async (item) => (item.game === "arknights" ? 1 : 0),
        recover: async (_previous, next) => {
          recovered.push(next.lane);
        },
      },
    );
    expect(recovered).toEqual([]);
  });

  it("keeps an unknown device blocked across channel IDs while allowing a different instance", async () => {
    const ran: string[] = [];
    const results = await catchup.executeCatchupQueue(
      [
        combo("ark-a", "arknights"),
        combo("onm-a", "onmyoji"),
        combo("onm-b", "onmyoji"),
      ],
      {
        resourceKey: (item) =>
          item.lane === "onm-b" ? "mumu:manager#3" : "mumu:manager#0",
        run: async (item) => {
          ran.push(item.lane);
          if (item.lane === "ark-a") throw Error("unknown device outcome");
          return 0;
        },
        recover: async () => {
          throw Error("Unknown outcomes cannot be recovered automatically");
        },
      },
    );
    expect(ran).toEqual(["ark-a", "onm-b"]);
    expect(results[1]).toMatchObject({
      blocked: true,
      message: "unknown device outcome",
    });
    expect(results[2].code).toBe(0);
  });

  it("requires the requested serial instead of accepting a different live emulator", () => {
    const reachable = (recovery as any).deviceIsReachable;
    expect(reachable).toBeTypeOf("function");
    expect(
      reachable(
        "List of devices attached\n127.0.0.1:16416 device\n",
        "127.0.0.1:16384",
      ),
    ).toBe(false);
    expect(
      reachable(
        "127.0.0.1:16384 offline\n127.0.0.1:16416 device",
        "127.0.0.1:16384",
      ),
    ).toBe(false);
    expect(reachable("127.0.0.1:16384 device\n", "127.0.0.1:16384")).toBe(true);
  });

  it.each(["stop-error", "alive", "foreground", "offline", "pid-error"])(
    "refuses recovery when %s is not confirmed",
    async (failure) => {
      const execute = (recovery as any).executeDeviceRecovery;
      expect(execute).toBeTypeOf("function");
      const steps = recovery.planRecovery({
        previous: {
          game: "arknights",
          packageName: "com.hypergryph.arknights",
          status: "failed",
        },
        next: { game: "onmyoji" },
        reachable: true,
        instance: 0,
      });
      await expect(
        execute(steps, {
          reachable: async () => failure !== "offline",
          restart: async () => {},
          installedPackage: async () => "com.hypergryph.arknights.bilibili",
          stopGame: async () => {
            if (failure === "stop-error") throw Error("stop rejected");
          },
          running: async () => {
            if (failure === "pid-error") throw Error("read failed");
            return failure === "alive";
          },
          foreground: async () =>
            failure === "foreground"
              ? "com.hypergryph.arknights.bilibili"
              : "com.mumu.launcher",
        }),
      ).rejects.toThrow();
    },
  );

  it("requires a known foreground and successful exit before handing the device over", async () => {
    const execute = (recovery as any).executeDeviceRecovery;
    expect(execute).toBeTypeOf("function");
    const steps = recovery.planRecovery({
      previous: {
        game: "arknights",
        packageName: "com.hypergryph.arknights",
        status: "failed",
      },
      next: { game: "onmyoji" },
      reachable: false,
      instance: 0,
    });
    const calls: string[] = [];
    let ready = false;
    await execute(steps, {
      reachable: async () => ready,
      restart: async () => {
        calls.push("restart");
        ready = true;
      },
      installedPackage: async () => "com.hypergryph.arknights.bilibili",
      stopGame: async () => {
        calls.push("stop");
      },
      running: async () => false,
      foreground: async () => "com.mumu.launcher",
    });
    expect(calls).toEqual(["restart", "stop"]);
  });
});

describe("real actor attempt accounting", () => {
  it("sorts App and CLI attempts by actual start time and includes repeated CLI runs", () => {
    const derive = (actors as any).deriveActorStats;
    expect(derive).toBeTypeOf("function");
    const result = derive(
      "lane-a",
      "arknights",
      [
        {
          requestId: "late",
          laneId: "lane-a",
          startedAt: "2026-10-16T03:00:00Z",
          games: { arknights: { result: "failed" } },
        },
        {
          requestId: "early",
          laneId: "lane-a",
          startedAt: "2026-10-16T01:00:00Z",
          games: { arknights: { result: "succeeded" } },
        },
      ],
      [
        {
          id: "cli-1",
          lane: "lane-a",
          game: "arknights",
          startedAt: "2026-10-16T02:00:00Z",
          result: "failed",
        },
        {
          id: "cli-2",
          lane: "lane-a",
          game: "arknights",
          startedAt: "2026-10-16T04:00:00Z",
          result: "failed",
        },
        {
          id: "other",
          lane: "lane-b",
          game: "arknights",
          startedAt: "2026-10-16T05:00:00Z",
          result: "failed",
        },
      ],
    );
    expect(result).toMatchObject({
      attempts: 4,
      consecutiveFailures: 3,
      unresolved: false,
    });
    expect(
      actors.planActors(
        [{ ...combo("lane-a", "arknights"), state: "failed", required: true }],
        { now: 0, attempts: { "lane-a:arknights": result.attempts } },
      ).queued,
    ).toEqual([]);
  });

  it("does not silently retry a CLI attempt whose process ended without a terminal receipt", () => {
    const derive = (actors as any).deriveActorStats;
    expect(derive).toBeTypeOf("function");
    expect(
      derive(
        "lane-a",
        "onmyoji",
        [],
        [
          {
            id: "interrupted",
            lane: "lane-a",
            game: "onmyoji",
            startedAt: "2026-10-16T01:00:00Z",
            result: "running",
          },
        ],
      ),
    ).toMatchObject({ attempts: 1, unresolved: true });
  });
});

describe("persistent CLI attempt reservations", () => {
  it("persists before dispatch, counts repeated runs after restart and leaves an interrupted run unresolved", async () => {
    const modulePath = "../scripts/game-mode/attempts";
    let store: any;
    try {
      store = await import(modulePath);
    } catch {
      store = {};
    }
    expect(store.reserveActorAttempt).toBeTypeOf("function");
    const folder = mkdtempSync(join(tmpdir(), "gp-attempt-test-"));
    const first = store.reserveActorAttempt(folder, combo("lane-a", "onmyoji"));
    expect(JSON.parse(readFileSync(first.file, "utf8")).result).toBe("running");
    store.finishActorAttempt(first.file, "failed");
    store.reserveActorAttempt(folder, combo("lane-a", "onmyoji"));
    const attempts = store.readActorAttempts(folder);
    expect(attempts).toHaveLength(2);
    expect(
      (actors as any).deriveActorStats("lane-a", "onmyoji", [], attempts),
    ).toMatchObject({ attempts: 2, unresolved: true });
    writeFileSync(join(folder, "damaged.json"), "{");
    expect(() => store.readActorAttempts(folder)).toThrow();
  });
});

describe("conservative record disposition", () => {
  it("never treats unknown or invented step statuses as conclusive terminal evidence", () => {
    for (const status of ["unknown", "mystery", "blocked"])
      expect(
        taskEvidenceIsTerminal({
          status: "failed",
          steps: [{ skillId: "login", status }],
        }),
      ).toBe(false);
    expect(
      planDisposition({
        statuses: [pending],
        requests: [{ id: "r", laneId: "lane-a", status: "failed" }],
        tasks: [
          {
            executionId: "r",
            gameId: "arknights",
            status: "failed",
            steps: [{ skillId: "login", status: "unknown" }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not dispose a failed request merely because its own game has pending work", () => {
    expect(
      planDisposition({
        statuses: [{ ...pending, game: "arknights" }],
        requests: [{ id: "r", laneId: "lane-a", status: "failed" }],
        tasks: [
          {
            executionId: "r",
            gameId: "arknights",
            status: "failed",
            steps: [{ skillId: "login", status: "failed" }],
          },
        ],
      }),
    ).toEqual([]);
  });

  it("does not describe a partially successful request as having no effects", () => {
    const result = planDisposition({
      statuses: [pending],
      requests: [{ id: "r", laneId: "lane-a", status: "failed" }],
      tasks: [
        {
          executionId: "r",
          gameId: "arknights",
          status: "failed",
          steps: [
            { skillId: "login", status: "succeeded" },
            { skillId: "fight", status: "failed" },
          ],
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.note).not.toContain('判定为"未生效"');
    expect(result[0]!.note).toContain("已成功步骤不重放");
  });

  it("connects only complete conclusive host reports to the disposition policy", () => {
    const fromReport = (disposition as any).dispositionsFromReport;
    expect(fromReport).toBeTypeOf("function");
    const request = {
      requestId: "r",
      laneId: "lane-a",
      status: "failed",
      eventsRead: true,
      finishedAt: "2026-10-16T02:00:00Z",
      games: {
        arknights: {
          result: "failed",
          steps: [{ stepId: "login", status: "failed" }],
        },
      },
      attention: [],
    };
    expect(fromReport([pending], [request])).toHaveLength(1);
    for (const change of [
      { status: "unknown" },
      { eventsRead: false },
      { finishedAt: undefined },
      { attention: [{ kind: "paging", status: "truncated" }] },
      {
        games: {
          arknights: {
            result: "failed",
            steps: [{ stepId: "login", status: "unknown" }],
          },
        },
      },
    ])
      expect(fromReport([pending], [{ ...request, ...change }])).toEqual([]);
  });
});

describe("App-owned CLI supervision", () => {
  it("delegates due selection for both games without resolving history or submitting temporary steps", async () => {
    const { runGameMode } = await import("../scripts/game-mode.mjs");
    const calls: string[] = [];
    const code = await runGameMode(["--catchup"], {
      request: async (_data, method, params) => {
        calls.push(`${method}:${params.gameId}`);
        return { ok: true, result: { batches: [] } };
      },
      log: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["game-tick:arknights", "game-tick:onmyoji"]);
  });
  it("preserves an uncertain App refusal without disposition or retries", async () => {
    const { runGameMode } = await import("../scripts/game-mode.mjs");
    let calls = 0;
    expect(
      await runGameMode(["--catchup", "--game", "onmyoji"], {
        request: async () => {
          calls++;
          return { ok: false, error: { code: "OUTCOME_UNKNOWN" } };
        },
        log: () => {},
      }),
    ).toBe(1);
    expect(calls).toBe(1);
  });
  it("queries plans read-only and rejects a lane-scoped due trigger rather than running other accounts", async () => {
    const { runGameMode } = await import("../scripts/game-mode.mjs");
    const calls: string[] = [];
    await runGameMode(["--dry"], {
      request: async (_data, method) => {
        calls.push(method);
        return { ok: true, result: {} };
      },
      log: () => {},
    });
    expect(calls).toEqual(["game-automation", "game-automation"]);
    await expect(runGameMode(["--catchup", "--lane", "a"])).rejects.toThrow(
      /App/,
    );
  });
});
