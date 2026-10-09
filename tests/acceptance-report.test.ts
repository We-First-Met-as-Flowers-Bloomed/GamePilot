import { expect, it } from "vitest";
import { inspectDaily } from "../packages/acceptance/report";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
const at = "2026-09-26T00:00:00.000Z";
const expected = {
  date: "2026-09-26",
  laneId: "lane-a",
  instance: 0,
  plans: [
    { gameId: "arknights", mode: "live" as const, skillIds: ["login"] },
    { gameId: "onmyoji", mode: "live" as const, skillIds: ["login"] },
  ],
};
const request = (): ExecutionRecord => ({
  version: 1,
  id: "batch:lane-a",
  laneId: "lane-a",
  batchId: "batch",
  source: "daily",
  resources: ["x"],
  fingerprint: "x",
  snapshot: {
    appVersion: "0.12.8",
    lane: { instance: 0 },
    arknightsPlan: expected.plans[0],
    onmyojiPlan: expected.plans[1],
  },
  status: "succeeded",
  startedAt: at,
  finishedAt: "2026-09-26T00:02:00.000Z",
  message: "ok",
});
const tasks = (): TaskRecord[] =>
  expected.plans.map((plan, i) => ({
    version: 1,
    executionId: "batch:lane-a",
    laneId: "lane-a",
    batchId: "batch",
    runId: plan.gameId,
    instance: 0,
    gameId: plan.gameId,
    plan,
    status: "succeeded",
    startedAt: i ? "2026-09-26T00:01:00.000Z" : at,
    finishedAt: i ? "2026-09-26T00:02:00.000Z" : "2026-09-26T00:00:30.000Z",
    updatedAt: "2026-09-26T00:02:00.000Z",
    message: "ok",
    steps: [
      { skillId: "login", status: "succeeded", message: "ok", diagnostics: [] },
    ],
  }));
const now = new Date("2026-09-26T03:00:00Z");
it("keeps an authorized second round separate from legacy morning acceptance", () => {
  const evening = request();
  evening.id = "evening:lane-a";
  evening.snapshot = {
    ...evening.snapshot,
    schedule: { slot: "secondary", dueAt: "2026-09-26T12:00:00Z" },
  };
  const rows = [request(), evening];
  expect(inspectDaily(expected, rows, tasks(), now).requestIds).toEqual([
    "batch:lane-a",
  ]);
  const second = {
    ...expected,
    slot: "secondary" as const,
    dueTime: "20:00",
    plans: [expected.plans[0]],
  };
  expect(inspectDaily(second, [], [], now).state).toBe("pending");
  expect(
    inspectDaily(second, [], [], new Date("2026-09-26T12:00:00Z")).state,
  ).toBe("missing");
  delete evening.snapshot.onmyojiPlan;
  const t = tasks()[0];
  t.executionId = evening.id;
  evening.startedAt = t.startedAt = "2026-09-26T12:00:00Z";
  evening.finishedAt = t.finishedAt = t.updatedAt = "2026-09-26T12:01:00Z";
  expect(
    inspectDaily(second, rows, [t], new Date("2026-09-26T12:02:00Z")).state,
  ).toBe("flow-ended");
});
it("distinguishes a future date, a missing run and a structural complete chain without claiming acceptance", () => {
  expect(
    inspectDaily(expected, [], [], new Date("2026-09-25T12:00:00Z")).state,
  ).toBe("pending");
  expect(inspectDaily(expected, [], [], now).state).toBe("missing");
  const row = inspectDaily(expected, [request()], tasks(), now);
  expect(row.state).toBe("flow-ended");
  expect(row.reviewRequired).toBe(true);
  expect(row.notes.join(" ")).toContain("身份");
});
it("does not count maintenance, rehearsal, another lane or pre-reset work as today's daily", () => {
  for (const r of [
    { ...request(), source: "maintenance" as const },
    { ...request(), laneId: "lane-b" },
    { ...request(), startedAt: "2026-09-25T18:00:00Z" },
  ])
    expect(inspectDaily(expected, [r], tasks(), now).state).toBe("missing");
  const r = request();
  r.snapshot.arknightsPlan = { ...expected.plans[0], mode: "rehearsal" };
  expect(inspectDaily(expected, [r], tasks(), now).state).toBe("incomplete");
});
it("preserves failure/unknown and refuses duplicate requests or ambiguous task correlation", () => {
  for (const status of ["failed", "cancelled", "unknown"] as const)
    expect(
      inspectDaily(expected, [{ ...request(), status }], tasks(), now).state,
    ).toBe(status === "unknown" ? "unknown" : "failed");
  expect(
    inspectDaily(
      expected,
      [request(), { ...request(), id: "duplicate" }],
      tasks(),
      now,
    ).state,
  ).toBe("incomplete");
  expect(
    inspectDaily(expected, [request()], [...tasks(), tasks()[0]], now).state,
  ).toBe("incomplete");
  const wrong = tasks();
  wrong[0].batchId = "different";
  expect(inspectDaily(expected, [request()], wrong, now).state).toBe(
    "incomplete",
  );
});
it("requires both original plans, matching steps and chronological game handoff", () => {
  for (const change of [
    (t: TaskRecord[]) => {
      t[1].startedAt = at;
    },
    (t: TaskRecord[]) => {
      t[1].steps[0].status = "not-run";
    },
    (t: TaskRecord[]) => {
      t[0].plan = { ...t[0].plan, skillIds: ["award"] };
    },
    (t: TaskRecord[]) => {
      t[0].instance = 1;
    },
  ]) {
    const t = tasks();
    change(t);
    expect(inspectDaily(expected, [request()], t, now).state).toBe(
      "incomplete",
    );
  }
  const r = request();
  delete r.snapshot.onmyojiPlan;
  expect(inspectDaily(expected, [r], tasks(), now).state).toBe("incomplete");
});
it("shows running records as unconfirmed and does not use a newer day's receipts", () => {
  const r = { ...request(), status: "running" as const, finishedAt: undefined };
  expect(inspectDaily(expected, [r], tasks(), now).state).toBe("running");
  expect(
    inspectDaily(expected, [r], tasks(), new Date("2026-09-27T03:00:00Z"))
      .state,
  ).toBe("unknown");
  expect(
    inspectDaily(
      expected,
      [{ ...request(), startedAt: "2026-09-27T00:00:00Z" }],
      tasks(),
      now,
    ).state,
  ).toBe("missing");
});
