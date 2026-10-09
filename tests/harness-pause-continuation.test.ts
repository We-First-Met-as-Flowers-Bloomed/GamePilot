import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { executeLanePlan, runWorkerPlan } from "../apps/desktop/main/lane-plan";
import type { LaneWorker } from "../apps/desktop/main/lane-runtime";
import {
  continuationPlans,
  previewDailyContinuation,
} from "../games/continuation";
import { agentHistoryTouchesDay } from "../games/agent-execution";
import type { DeviceLane, Game, Plan, RunEvent } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import {
  reduceTaskRecords,
  validateTaskRecord,
} from "../packages/protocol/task-record";
import { Runner } from "../packages/runtime/runner";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("an applied pause at the last Arknights step propagates through the worker and serial lane before Onmyoji can start", async () => {
  const lane: DeviceLane = {
    id: "lane-a",
    name: "software test",
    instance: 0,
    managerPath: "D:\\test\\MuMuManager.exe",
    enabled: true,
    arknights: { enabled: true, profileId: "test" },
    onmyoji: { enabled: true },
    closeEmulatorAfterSuccess: false,
  };
  const plan: Plan = {
    gameId: "arknights",
    skillIds: ["login", "award"],
    mode: "live",
  };
  const game: Game = {
    id: "arknights",
    name: "software test",
    subtitle: "",
    skills: plan.skillIds.map((id) => ({
      id,
      title: id,
      description: "",
      ready: true,
    })),
  };
  const lastStep = deferred(),
    complete = deferred();
  const events: RunEvent[] = [],
    executed: string[] = [];
  let runId = "",
    finished!: Promise<void>;
  const emitter = new EventEmitter();
  const runner = new Runner(
    [game],
    (event) => {
      events.push(event);
      emitter.emit("event", event);
    },
    async (skillId) => {
      executed.push(skillId);
      if (skillId === "award") {
        lastStep.resolve();
        await complete.promise;
      }
    },
  );
  const worker: LaneWorker = Object.assign(emitter, {
    request: async <T>(method: string, input?: unknown): Promise<T> => {
      if (method !== "start") throw Error("unexpected software worker command");
      const started = runner.start(input as Plan);
      runId = started.runId;
      finished = started.finished;
      return { runId } as T;
    },
    close: () => {},
  });
  const closeArknights = vi.fn(async () => {}),
    onmyoji = vi.fn(async () => {});
  const task = executeLanePlan(lane, {
    prepare: async () => {},
    arknights: async () => runWorkerPlan(worker, plan),
    closeArknights,
    onmyoji,
  });
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  await lastStep.promise;
  expect(runner.pauseAfterStep({ runId, revision: 1 }).status).toBe("queued");
  complete.resolve();
  await rejected;
  await finished;
  expect(executed).toEqual(["login", "award"]);
  expect(events.at(-1)).toMatchObject({
    status: "cancelled",
    stepControl: { status: "applied" },
  });
  const record = validateTaskRecord(events.reduce(reduceTaskRecords, [])[0]);
  expect(record.status).toBe("cancelled");
  expect(record.steps.map((step) => step.status)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(closeArknights).not.toHaveBeenCalled();
  expect(onmyoji).not.toHaveBeenCalled();
  expect(worker.listenerCount("event")).toBe(0);
  expect(worker.listenerCount("exit")).toBe(0);
});

it("a terminal paused Arknights record with every step successful proves the subsequent Onmyoji plan is unstarted", () => {
  const plan: Plan = {
    gameId: "arknights",
    skillIds: ["login", "award"],
    mode: "live",
  };
  const parent: ExecutionRecord = {
    version: 1,
    id: "paused:lane-a",
    source: "daily",
    laneId: "lane-a",
    resources: ["software-device"],
    batchId: "paused",
    fingerprint: "paused-fingerprint",
    status: "cancelled",
    startedAt: "2026-10-03T01:00:00.000Z",
    finishedAt: "2026-10-03T01:05:00.000Z",
    message: "步骤边界暂停",
    snapshot: {},
  };
  const detail: ExecutionDetail = {
    request: parent,
    warnings: [],
    games: [
      {
        plan,
        record: {
          version: 1,
          runId: "paused-run",
          executionId: parent.id,
          laneId: parent.laneId,
          gameId: plan.gameId,
          plan,
          status: "cancelled",
          startedAt: parent.startedAt,
          updatedAt: parent.finishedAt!,
          finishedAt: parent.finishedAt,
          message: parent.message,
          steps: plan.skillIds.map((skillId) => ({
            skillId,
            status: "succeeded",
            message: "completed",
            diagnostics: [],
          })),
        },
      },
      {
        plan: {
          gameId: "onmyoji",
          skillIds: ["login", "mail", "hana-claim"],
          mode: "live",
        },
        issue: "尚未开始，缺少步骤记录",
      },
    ],
  };
  const before = structuredClone(detail);
  const preview = previewDailyContinuation(
    detail,
    parent,
    new Date("2026-10-03T04:00:00.000Z"),
  );
  expect(preview.canContinue).toBe(true);
  expect(preview.defaults).toEqual([
    { gameId: "onmyoji", skillIds: ["mail", "hana-claim"] },
  ]);
  expect(
    preview.steps
      .filter((step) => step.gameId === "arknights")
      .every((step) => step.status === "retained"),
  ).toBe(true);
  expect(
    continuationPlans(preview, {
      parentId: preview.parentId,
      fingerprint: preview.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: false,
    }),
  ).toEqual([
    {
      gameId: "onmyoji",
      skillIds: ["login", "mail", "hana-claim"],
      mode: "live",
    },
  ]);
  expect(detail).toEqual(before);
  detail.games[0].record!.finishedAt = undefined;
  expect(
    previewDailyContinuation(
      detail,
      parent,
      new Date("2026-10-03T04:00:00.000Z"),
    ).canContinue,
  ).toBe(false);
});

it("uses the selected game's reset when testing historical execution day overlap", () => {
  // Beijing 05:00 -> 07:00 crosses Onmyoji's 06:00 reset, but not Arknights' 04:00 reset.
  const start = "2026-10-03T21:00:00.000Z",
    end = "2026-10-03T21:05:00.000Z";
  const afterSix = new Date("2026-10-03T23:00:00.000Z");
  expect(agentHistoryTouchesDay(start, end, afterSix, "onmyoji")).toBe(false);
  expect(agentHistoryTouchesDay(start, end, afterSix, "arknights")).toBe(true);
  expect(agentHistoryTouchesDay(start, end, afterSix)).toBe(true);
  // Beijing 03:00 -> 05:00 crosses only Arknights' reset.
  expect(
    agentHistoryTouchesDay(
      "2026-10-03T19:00:00.000Z",
      "2026-10-03T19:05:00.000Z",
      new Date(start),
      "onmyoji",
    ),
  ).toBe(true);
  expect(
    agentHistoryTouchesDay(
      "2026-10-03T19:00:00.000Z",
      "2026-10-03T19:05:00.000Z",
      new Date(start),
      "arknights",
    ),
  ).toBe(false);
  expect(
    agentHistoryTouchesDay(
      "2026-10-03T21:50:00.000Z",
      "2026-10-03T22:10:00.000Z",
      afterSix,
      "onmyoji",
    ),
  ).toBe(true);
  expect(agentHistoryTouchesDay(start, undefined, afterSix, "onmyoji")).toBe(
    true,
  );
});
