import { expect, it, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import { gamePlugins } from "../games/registry";
import type { Frame, GameDevice } from "../packages/runtime/device";
import { validStructuredSkillOutcome } from "../packages/protocol";
import {
  reduceTaskRecords,
  type TaskRecord,
} from "../packages/protocol/task-record";
import { evaluateGameSkillOutcome } from "../games/goal-outcome";
import {
  previewDailyContinuation,
  continuationPlans,
} from "../games/continuation";
import house from "./fixtures/onmyoji/gift-house-shifted-tabs-20261007.json";

const at = "2026-10-07T04:00:00.000Z";
const frame = (...rows: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: rows.map(([text, x, y]) => ({
    text,
    score: 0.99,
    box: [x, y, 100, 40],
  })),
});
const home = frame(["加成", 546, 49], ["商店", 900, 900]);
const shop = frame(["热门推荐", 200, 30], ["礼包屋", 1690, 1000]);
const list = frame(
  ["每日礼包", 300, 200],
  ["推荐", 200, 100],
  ["礼包屋", 1690, 1000],
  ["领取", 320, 450],
);
const claimed = frame(
  ["每日礼包", 300, 200],
  ["推荐", 200, 100],
  ["礼包屋", 1690, 1000],
  ["已领取", 320, 450],
);
const reward = frame(["每日礼包", 350, 150], ["获得奖励", 700, 250]);

function setup(failure: "navigation" | "settlement" | "already-completed") {
  let current = home;
  let records: TaskRecord[] = [];
  const checkpoints: unknown[] = [];
  const emit = (
    type: "status" | "step" | "log",
    fields: Record<string, unknown>,
  ) => {
    records = reduceTaskRecords(records, {
      runId: "effect-run",
      gameId: "onmyoji",
      type,
      at,
      message: "fixture",
      ...fields,
    } as never);
  };
  emit("status", {
    status: "queued",
    plan: { gameId: "onmyoji", mode: "live", skillIds: ["daily-gift"] },
  });
  emit("status", { status: "running" });
  emit("step", { skillId: "daily-gift", stepStatus: "running" });
  const d = {
    observe: vi.fn(async () => current),
    click: vi.fn(async (x: number) => {
      if (current === home) current = shop;
      else if (current === shop) current = house as Frame;
      else if (current === house)
        current = failure === "already-completed" ? claimed : list;
      else if (current === list && x > 200 && x < 600) {
        expect((records[0].steps[0].result as any)?.onmyoji?.phase).toBe(
          "submitted",
        );
        if (failure !== "settlement") current = reward;
      } else if (current === reward) current = claimed;
      else if (current === claimed && x < 100)
        throw Error("return-to-courtyard-failed");
    }),
    matchTemplate: vi.fn(async () => null),
  } as unknown as GameDevice;
  const adapter = new OnmyojiDaily(
    d,
    (message, result) => {
      if (result) checkpoints.push(result);
      emit("log", { skillId: "daily-gift", message, result });
    },
    async () => {},
    () => new Date(at),
  );
  return {
    d,
    adapter,
    checkpoints,
    records: () => records,
    fail: () => {
      emit("step", { skillId: "daily-gift", stepStatus: "failed" });
      emit("status", { status: "failed" });
    },
  };
}

it("persists confirmed gift effects when final navigation fails, while keeping the step failed", async () => {
  const x = setup("navigation");
  await expect(
    x.adapter.dailyGift(new AbortController().signal),
  ).rejects.toThrow("return-to-courtyard-failed");
  x.fail();
  const task = x.records()[0],
    step = task.steps[0];
  expect(step.status).toBe("failed");
  expect(step.result).toMatchObject({
    onmyoji: {
      phase: "confirmed",
      skillId: "daily-gift",
      effects: [{ kind: "free-daily-gift" }],
    },
  });
  expect(step.result?.goalSatisfied).not.toBe(true);
  const recovery = gamePlugins.get("onmyoji").recovery as any;
  expect(recovery.retainedStep?.(step)).toBe(true);
  expect(recovery.allowRetry(task, "unknown", 0)).toBe(false);
});

it("persists submitted but unconfirmed evidence before the gift click and blocks re-claim", async () => {
  const x = setup("settlement");
  await expect(
    x.adapter.dailyGift(new AbortController().signal),
  ).rejects.toThrow();
  x.fail();
  const task = x.records()[0];
  expect(task.steps[0].result).toMatchObject({
    onmyoji: { phase: "submitted", effects: [] },
  });
  expect(
    (gamePlugins.get("onmyoji").recovery as any).replayBlockers?.(task),
  ).toEqual([expect.stringMatching(/未确认/)]);
  expect(x.d.click).toHaveBeenCalledTimes(4);
});

function remainingPreview(task: TaskRecord) {
  const plan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login", "daily-gift", "mail"],
  };
  const record = {
    ...task,
    plan,
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        message: "login",
        diagnostics: [],
      },
      ...task.steps,
      {
        skillId: "mail",
        status: "not-run",
        message: "pending",
        diagnostics: [],
      },
    ],
  };
  const request = {
    id: "request-a",
    laneId: "lane-a",
    source: "lane",
    status: "failed",
    startedAt: at,
    finishedAt: at,
    fingerprint: "fp",
  };
  return previewDailyContinuation(
    { request, games: [{ plan, record }], warnings: [] } as never,
    request as never,
    new Date(at),
  );
}

it("keeps a confirmed effect out of acknowledged continuation without calling the failed flow completed", async () => {
  const x = setup("navigation");
  await expect(
    x.adapter.dailyGift(new AbortController().signal),
  ).rejects.toThrow();
  x.fail();
  const step = x.records()[0].steps[0];
  const outcome = evaluateGameSkillOutcome("onmyoji", step) as any;
  expect(outcome.goalSatisfied).toBe(false);
  expect(outcome.effectEvidence).toEqual([
    expect.objectContaining({
      kind: "free-daily-gift",
      summary: "每日免费礼包领取效果已核对",
      evidenceReference: "onmyoji:daily-gift:effect:1",
    }),
  ]);
  const preview = remainingPreview(x.records()[0]);
  expect(preview.steps.find((s) => s.skillId === "daily-gift")?.status).toBe(
    "excluded",
  );
  expect(preview.defaults).toEqual([{ gameId: "onmyoji", skillIds: ["mail"] }]);
  expect(() =>
    continuationPlans(preview, {
      parentId: preview.parentId,
      fingerprint: preview.fingerprint,
      acknowledgePartial: true,
      selections: [{ gameId: "onmyoji", skillIds: ["daily-gift"] }],
    }),
  ).toThrow();
});

it("cannot acknowledge away submitted unconfirmed effects in the continuation UI", async () => {
  const x = setup("settlement");
  await expect(
    x.adapter.dailyGift(new AbortController().signal),
  ).rejects.toThrow();
  x.fail();
  const preview = remainingPreview(x.records()[0]);
  expect(preview.canContinue).toBe(false);
  expect(preview.steps.find((s) => s.skillId === "daily-gift")?.status).toBe(
    "blocked",
  );
});

it("does not expose effects from an out-of-step observation or a localized success summary", async () => {
  const x = setup("navigation");
  await expect(
    x.adapter.dailyGift(new AbortController().signal),
  ).rejects.toThrow();
  x.fail();
  const step = structuredClone(x.records()[0].steps[0]);
  step.result!.onmyoji!.observedAt = "2000-01-01T00:00:00Z";
  step.result!.summary = "全部任务已经成功";
  expect(
    (evaluateGameSkillOutcome("onmyoji", step) as any).effectEvidence,
  ).toBeUndefined();
});
it("rejects a declared satisfied outcome with submitted but unconfirmed Onmyoji effects", () => {
  expect(
    validStructuredSkillOutcome({
      goalSatisfied: true,
      evidenceTimestamp: at,
      evidenceReference: "forged-completion",
      onmyoji: {
        version: 1,
        skillId: "daily-gift",
        phase: "submitted",
        observedAt: at,
        effects: [],
      },
    }),
  ).toBe(false);
});
it("writes valid evidence snapshots when a prior completed marker needs no claim input", async () => {
  const x = setup("already-completed");
  await expect(
    x.adapter.dailyGift(new AbortController().signal),
  ).rejects.toThrow("return-to-courtyard-failed");
  expect(
    x.checkpoints.every((value) => validStructuredSkillOutcome(value as never)),
  ).toBe(true);
  expect(x.d.click).toHaveBeenCalledTimes(4);
});
