import { expect, it } from "vitest";
import {
  previewDailyContinuation,
  continuationPlans,
} from "../games/continuation";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ContinuationInput } from "../packages/protocol/continuation";
const now = new Date("2026-10-03T04:00:00.000Z");
const ids = ["login", "recruit", "fight", "infrastructure", "friends", "award"];
function fixture() {
  const parent: ExecutionRecord = {
    version: 1,
    id: "original:lane-a",
    source: "daily",
    resources: ["mumu-0"],
    laneId: "lane-a",
    batchId: "original",
    fingerprint: "original-fingerprint",
    status: "unknown",
    startedAt: "2026-10-03T01:00:00.000Z",
    finishedAt: "2026-10-03T01:05:00.000Z",
    message: "failed",
    snapshot: {},
  };
  const detail: ExecutionDetail = {
    request: { ...parent, laneName: "账号一" },
    warnings: [],
    games: [
      {
        plan: { gameId: "arknights", mode: "live", skillIds: ids },
        record: {
          version: 1,
          runId: "old-run",
          executionId: parent.id,
          laneId: parent.laneId,
          batchId: parent.batchId,
          gameId: "arknights",
          plan: { gameId: "arknights", mode: "live", skillIds: ids },
          status: "failed",
          startedAt: parent.startedAt,
          updatedAt: parent.finishedAt!,
          finishedAt: parent.finishedAt,
          message: "failed",
          steps: ids.map((skillId, i) => ({
            skillId,
            status: i < 2 ? "succeeded" : i === 2 ? "failed" : "not-run",
            message: "recorded",
            diagnostics: [],
          })),
        },
      },
    ],
  };
  return { parent, detail };
}
function input(
  p: ReturnType<typeof previewDailyContinuation>,
): ContinuationInput {
  return {
    parentId: p.parentId,
    fingerprint: p.fingerprint,
    selections: p.defaults,
    acknowledgePartial: true,
  };
}
it("retains completed business steps and retries failed then remaining steps in original order", () => {
  const { parent, detail } = fixture();
  const p = previewDailyContinuation(detail, parent, now);
  expect(p.canContinue).toBe(true);
  expect(
    p.steps.filter((s) => s.status === "retained").map((s) => s.skillId),
  ).toEqual(["login", "recruit"]);
  expect(p.needsAcknowledgement).toBe(true);
  expect(continuationPlans(p, input(p))).toEqual([
    {
      gameId: "arknights",
      mode: "live",
      skillIds: ["login", "fight", "infrastructure", "friends", "award"],
    },
  ]);
});
it("can deselect the failed step without altering future routines or replaying succeeded tasks", () => {
  const { parent, detail } = fixture();
  const before = structuredClone(detail);
  const p = previewDailyContinuation(detail, parent, now);
  const choice = input(p);
  choice.selections = [{ gameId: "arknights", skillIds: ["award", "friends"] }];
  expect(continuationPlans(p, choice)[0].skillIds).toEqual([
    "login",
    "friends",
    "award",
  ]);
  expect(detail).toEqual(before);
});
it("requires explicit acknowledgement of partially executed failure", () => {
  const { parent, detail } = fixture();
  const p = previewDailyContinuation(detail, parent, now);
  expect(() =>
    continuationPlans(p, { ...input(p), acknowledgePartial: false }),
  ).toThrow("核对");
});
it.each(["running", "succeeded"] as const)("blocks %s parent", (status) => {
  const { parent, detail } = fixture();
  parent.status = status;
  expect(previewDailyContinuation(detail, parent, now).canContinue).toBe(false);
});
it("blocks expired progress after the game's daily reset", () => {
  const { parent, detail } = fixture();
  expect(
    previewDailyContinuation(
      detail,
      parent,
      new Date("2026-10-04T04:00:00Z"),
    ).reasons.join(" "),
  ).toMatch(/跨|游戏日/);
});
it("rejects replay, unknown skills, duplicates, a changed fingerprint and empty business work", () => {
  const { parent, detail } = fixture();
  const p = previewDailyContinuation(detail, parent, now);
  for (const skillIds of [
    ["recruit"],
    ["fight", "fight"],
    ["unknown"],
    [],
    ["login"],
  ])
    expect(() =>
      continuationPlans(p, {
        ...input(p),
        selections: [{ gameId: "arknights", skillIds }],
      }),
    ).toThrow();
  expect(() =>
    continuationPlans(p, { ...input(p), fingerprint: "changed" }),
  ).toThrow();
});
it("preserves a completed game while enabling a reliable failed following game", () => {
  const { parent, detail } = fixture();
  detail.games[0].record!.status = "succeeded";
  detail.games[0].record!.steps.forEach((s) => (s.status = "succeeded"));
  detail.games.push({
    plan: {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["login", "mail", "hana-claim"],
    },
    record: {
      ...detail.games[0].record!,
      runId: "yys",
      gameId: "onmyoji",
      plan: {
        gameId: "onmyoji",
        mode: "live",
        skillIds: ["login", "mail", "hana-claim"],
      },
      status: "failed",
      steps: [
        {
          skillId: "login",
          status: "succeeded",
          message: "ok",
          diagnostics: [],
        },
        {
          skillId: "mail",
          status: "succeeded",
          message: "ok",
          diagnostics: [],
        },
        {
          skillId: "hana-claim",
          status: "failed",
          message: "popup",
          diagnostics: [],
        },
      ],
    },
  });
  const p = previewDailyContinuation(detail, parent, now);
  expect(continuationPlans(p, input(p))).toEqual([
    { gameId: "onmyoji", mode: "live", skillIds: ["login", "hana-claim"] },
  ]);
});
it("does not infer an unrecorded game was never executed", () => {
  const { parent, detail } = fixture();
  delete detail.games[0].record;
  expect(previewDailyContinuation(detail, parent, now).canContinue).toBe(false);
});
it("includes an unstarted subsequent game only after a proven earlier failure stops the serial lane", () => {
  const { parent, detail } = fixture();
  detail.games.push({
    plan: {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["login", "mail", "hana-claim"],
    },
    issue: "缺少记录",
  });
  const p = previewDailyContinuation(detail, parent, now);
  expect(continuationPlans(p, input(p)).map((p) => p.gameId)).toEqual([
    "arknights",
    "onmyoji",
  ]);
});
