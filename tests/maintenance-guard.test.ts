import { expect, it } from "vitest";
import { assertMaintenanceClear } from "../apps/desktop/main/maintenance-guard";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
const lane = createFixtureSnapshot().lanes!.lanes[0];
const at = "2026-09-28T03:09:55.000Z";
const now = new Date("2026-10-06T00:00:00Z");
function receipt(): ExecutionRecord {
  return {
    version: 1,
    id: "daily",
    fingerprint: "test",
    source: "daily",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    laneId: lane.id,
    snapshot: {},
    status: "failed",
    startedAt: at,
    finishedAt: at,
    message: "timeout",
  };
}
function task(): TaskRecord {
  return {
    version: 1,
    executionId: "daily",
    runId: "foster-run",
    laneId: lane.id,
    gameId: "onmyoji",
    plan: { gameId: "onmyoji", mode: "live", skillIds: ["foster"] },
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    status: "unknown",
    message: "timeout",
    steps: [
      {
        skillId: "foster",
        status: "unknown",
        startedAt: at,
        finishedAt: at,
        message: "",
        diagnostics: [],
      },
    ],
  };
}
it("blocks daily-to-maintenance replay from persisted unknown foster, without mutating records", () => {
  const runs = [task()],
    requests = [receipt()];
  const before = JSON.stringify({ runs, requests });
  expect(() => assertMaintenanceClear(lane, requests, runs)).toThrow(
    /寄养.*未确认/,
  );
  expect(JSON.stringify({ runs, requests })).toBe(before);
});
it("matches renamed lanes by device and isolates another physical instance", () => {
  const r = receipt(),
    t = task();
  r.laneId = t.laneId = "old-name";
  expect(() => assertMaintenanceClear(lane, [r], [t])).toThrow();
  r.resources = [mumuResource(lane.managerPath, lane.instance + 1)];
  expect(() => assertMaintenanceClear(lane, [r], [t])).not.toThrow();
});
it("does not turn failed login or rehearsal into uncertain foster", () => {
  const t = task();
  t.steps[0].status = "not-run";
  expect(() => assertMaintenanceClear(lane, [receipt()], [t])).not.toThrow();
  t.steps[0].status = "unknown";
  t.plan.mode = "rehearsal";
  expect(() => assertMaintenanceClear(lane, [receipt()], [t])).not.toThrow();
});
it("honors explicit disposition and blocks missing receipts conservatively", () => {
  const r = receipt();
  r.resolution = { action: "abandoned", at, note: "用户确认" };
  expect(() => assertMaintenanceClear(lane, [r], [task()])).not.toThrow();
  expect(() => assertMaintenanceClear(lane, [], [task()])).toThrow();
});
it("a later confirmed active foster resolves current state but a log alone cannot", () => {
  const prior = task(),
    fresh = task();
  fresh.runId = "new";
  fresh.executionId = "new";
  fresh.startedAt = fresh.steps[0].startedAt = "2026-09-28T03:20:00Z";
  fresh.updatedAt =
    fresh.finishedAt =
    fresh.steps[0].finishedAt =
      "2026-09-28T03:21:00Z";
  fresh.status = "succeeded";
  fresh.steps[0].status = "succeeded";
  fresh.steps[0].evidence = "adapter-result";
  fresh.steps[0].result = {
    outcome: "active",
    observedAt: "2026-09-28T03:20:30Z",
    nextRunAt: "2026-09-28T08:00:00Z",
  };
  const r = { ...receipt(), id: "new", status: "succeeded" as const };
  expect(() =>
    assertMaintenanceClear(lane, [receipt(), r], [prior, fresh]),
  ).not.toThrow();
  fresh.steps[0].status = "unknown";
  expect(() =>
    assertMaintenanceClear(lane, [receipt(), r], [prior, fresh]),
  ).toThrow();
});
it("accepts the evidence value a real foster result actually carries", () => {
  // packages/runtime/runner.ts 只在结果带 status 时写 "adapter-result"，
  // 否则写 "adapter-return"；而 fosterScheduleResult() 只返回
  // outcome/observedAt/nextRunAt，不带 status —— 所以实机上寄养步骤写入的
  // **永远是 "adapter-return"**。上面那个用例用 "adapter-result" 描述"已确认的
  // 寄养"，那个取值在真机上不会出现：测试通过，线上第二道闸门却永远无法放行。
  const prior = task(),
    fresh = task();
  fresh.runId = "new";
  fresh.executionId = "new";
  fresh.startedAt = fresh.steps[0].startedAt = "2026-09-28T03:20:00Z";
  fresh.updatedAt =
    fresh.finishedAt =
    fresh.steps[0].finishedAt =
      "2026-09-28T03:21:00Z";
  fresh.status = "succeeded";
  fresh.steps[0].status = "succeeded";
  fresh.steps[0].evidence = "adapter-return";
  fresh.steps[0].result = {
    outcome: "active",
    observedAt: "2026-09-28T03:20:30Z",
    nextRunAt: "2026-09-28T08:00:00Z",
  };
  const r = { ...receipt(), id: "new", status: "succeeded" as const };
  expect(() =>
    assertMaintenanceClear(lane, [receipt(), r], [prior, fresh]),
  ).not.toThrow();
});
it("still refuses rehearsal evidence as proof of a live foster result", () => {
  const prior = task(),
    fresh = task();
  fresh.runId = "new";
  fresh.executionId = "new";
  fresh.startedAt = fresh.steps[0].startedAt = "2026-09-28T03:20:00Z";
  fresh.updatedAt =
    fresh.finishedAt =
    fresh.steps[0].finishedAt =
      "2026-09-28T03:21:00Z";
  fresh.status = "succeeded";
  fresh.steps[0].status = "succeeded";
  fresh.steps[0].evidence = "rehearsal";
  fresh.steps[0].result = {
    outcome: "active",
    observedAt: "2026-09-28T03:20:30Z",
    nextRunAt: "2026-09-28T08:00:00Z",
  };
  const r = { ...receipt(), id: "new", status: "succeeded" as const };
  expect(() =>
    assertMaintenanceClear(lane, [receipt(), r], [prior, fresh]),
  ).toThrow(/寄养.*未确认/);
});

function confirmedTask(): TaskRecord {
  const fresh = task();
  fresh.executionId = "confirmed";
  fresh.runId = "confirmed-run";
  fresh.status = "succeeded";
  fresh.startedAt = fresh.steps[0].startedAt = "2026-09-28T03:20:00Z";
  fresh.finishedAt =
    fresh.updatedAt =
    fresh.steps[0].finishedAt =
      "2026-09-28T03:21:00Z";
  fresh.steps[0].status = "succeeded";
  fresh.steps[0].evidence = "adapter-return";
  fresh.steps[0].result = {
    outcome: "active",
    observedAt: "2026-09-28T03:20:30Z",
    nextRunAt: "2026-09-28T08:00:00Z",
  };
  return fresh;
}

it.each(["unknown", "failed", "cancelled", "running"] as const)(
  "blocks a %s maintenance receipt even when task details are missing",
  (status) => {
    const request = { ...receipt(), source: "maintenance" as const, status };
    const before = JSON.stringify(request);
    expect(() => assertMaintenanceClear(lane, [request], [], now)).toThrow(
      /寄养.*未确认/,
    );
    expect(JSON.stringify(request)).toBe(before);
  },
);

it("allows explicit abandonment of a request with no task details", () => {
  const request = {
    ...receipt(),
    source: "maintenance" as const,
    status: "unknown" as const,
  };
  request.resolution = { action: "abandoned", at, note: "已核对现场" };
  expect(() => assertMaintenanceClear(lane, [request], [], now)).not.toThrow();
});

it("covers a receipt-only unknown with later actual foster evidence on the same device", () => {
  const prior = {
    ...receipt(),
    source: "maintenance" as const,
    status: "unknown" as const,
  };
  const fresh = confirmedTask();
  const confirmed = {
    ...receipt(),
    id: "confirmed",
    status: "succeeded" as const,
  };
  expect(() =>
    assertMaintenanceClear(lane, [prior, confirmed], [fresh], now),
  ).not.toThrow();
  confirmed.resources = [mumuResource(lane.managerPath, lane.instance + 1)];
  expect(() =>
    assertMaintenanceClear(lane, [prior, confirmed], [fresh], now),
  ).toThrow();
});

it.each(["orphan", "generic-success", "future", "older", "wildcard-proof"])(
  "refuses %s evidence for a receipt-only unknown",
  (kind) => {
    const prior = {
      ...receipt(),
      source: "maintenance" as const,
      status: "unknown" as const,
    };
    const fresh = confirmedTask();
    const confirmed = {
      ...receipt(),
      id: "confirmed",
      status: "succeeded" as const,
    };
    if (kind === "orphan") delete fresh.executionId;
    if (kind === "generic-success") delete fresh.steps[0].result;
    if (kind === "future") {
      fresh.startedAt = fresh.steps[0].startedAt = "2030-01-01T00:00:00Z";
      fresh.finishedAt =
        fresh.updatedAt =
        fresh.steps[0].finishedAt =
          "2030-01-01T00:01:00Z";
      fresh.steps[0].result!.observedAt = "2030-01-01T00:00:30Z";
      fresh.steps[0].result!.nextRunAt = "2030-01-01T05:00:00Z";
    }
    if (kind === "older") prior.finishedAt = "2026-09-28T03:30:00Z";
    if (kind === "wildcard-proof") confirmed.resources = ["*"];
    expect(() =>
      assertMaintenanceClear(lane, [prior, confirmed], [fresh], now),
    ).toThrow(/寄养.*未确认/);
  },
);

it("guards foster frozen in a live request but allows an ordinary failed daily login", () => {
  const request = {
    ...receipt(),
    status: "unknown" as const,
    snapshot: {
      onmyojiPlan: { gameId: "onmyoji", mode: "live", skillIds: ["foster"] },
    },
  };
  expect(() => assertMaintenanceClear(lane, [request], [], now)).toThrow();
  expect(() =>
    assertMaintenanceClear(lane, [receipt()], [], now),
  ).not.toThrow();
});

it("never lets a confirmed observation release a still running request", () => {
  const prior = {
    ...receipt(),
    source: "maintenance" as const,
    status: "running" as const,
  };
  const confirmed = {
    ...receipt(),
    id: "confirmed",
    status: "succeeded" as const,
  };
  expect(() =>
    assertMaintenanceClear(lane, [prior, confirmed], [confirmedTask()], now),
  ).toThrow();
});
