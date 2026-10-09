import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Daily from "../apps/desktop/renderer/views/Daily";
import type { DesktopController } from "../apps/desktop/renderer/hooks/useDesktop";
import type { DeviceLane, RunEvent } from "../packages/protocol";
import { deviceLanePlanKey } from "../packages/protocol";
import { dailyLaneState } from "../apps/desktop/renderer/daily-state";
import type { ExecutionRecord } from "../packages/protocol/execution";
import { runMessage } from "../apps/desktop/renderer/run-message";

const lane: DeviceLane = {
  id: "a",
  name: "账号 A",
  instance: 0,
  managerPath: "",
  enabled: true,
  arknights: { enabled: true, profileId: "default" },
  onmyoji: { enabled: false },
  closeEmulatorAfterSuccess: false,
};
const previous: RunEvent = {
  runId: "batch",
  batchId: "batch",
  laneId: "a",
  type: "status",
  status: "succeeded",
  executionSource: "daily",
  planKey: deviceLanePlanKey(lane),
  message: "全部完成",
  at: "2026-09-23T08:00:00+08:00",
};
const now = new Date("2026-09-24T08:00:00+08:00");
it("does not label an old plan success as completion of a newly customized plan", () => {
  const updated = {
    ...lane,
    onmyoji: {
      enabled: true,
      routine: {
        version: 1 as const,
        steps: [{ skillId: "mail", enabled: true }],
      },
    },
  };
  const done = {
    ...previous,
    startedAt: now.toISOString(),
    at: now.toISOString(),
  };
  expect(dailyLaneState(updated, [done], now).status).toBeNull();
  expect(
    dailyLaneState(
      updated,
      [{ ...done, planKey: deviceLanePlanKey(lane) }],
      now,
    ).status,
  ).toBeNull();
  expect(
    dailyLaneState(
      updated,
      [{ ...done, planKey: deviceLanePlanKey(updated) }],
      now,
    ).status,
  ).toBe("succeeded");
});
const run = (
  status: RunEvent["status"],
  startedAt: string,
  at = startedAt,
): RunEvent => ({
  ...previous,
  status,
  startedAt,
  at,
});

it("uses the start day after the completion crosses the 04:00 reset", () => {
  const event = run(
    "succeeded",
    "2026-09-24T03:59:00+08:00",
    "2026-09-24T04:05:00+08:00",
  );
  expect(dailyLaneState(lane, [event], now)).toEqual({
    status: null,
    lastRun: event,
    gameDay: "2026-09-23",
  });
});
it.each(["running", "queued", "stopping"] as const)(
  "keeps %s visible across reset",
  (status) => {
    const event = run(status, "2026-09-24T03:59:00+08:00");
    expect(dailyLaneState(lane, [event], now).status).toBe(status);
  },
);
it("shows today's own completed run", () => {
  expect(
    dailyLaneState(lane, [run("succeeded", "2026-09-24T04:01:00+08:00")], now)
      .status,
  ).toBe("succeeded");
});
it("follows the existing 06:00 reset when Onmyoji is enabled", () => {
  const event = run("succeeded", "2026-09-24T05:00:00+08:00");
  expect(
    dailyLaneState({ ...lane, onmyoji: { enabled: true } }, [event], now)
      .status,
  ).toBeNull();
});
it("uses a visible old-format start event, but never guesses from completion time alone", () => {
  const start = {
    ...previous,
    status: "running" as const,
    at: "2026-09-24T04:01:00+08:00",
  };
  const done = { ...previous, at: "2026-09-24T04:05:00+08:00" };
  expect(dailyLaneState(lane, [start, done], now).status).toBe("succeeded");
  expect(dailyLaneState(lane, [done], now).status).toBeNull();
});
it("does not count a maintenance success as completion of the daily plan", () => {
  const maintenance = {
    ...run("succeeded", "2026-09-24T07:00:00+08:00"),
    maintenance: true,
  };
  expect(dailyLaneState(lane, [maintenance], now).status).toBeNull();
});
it("does not count a successful selected continuation as a complete daily plan", () => {
  const event = run("succeeded", now.toISOString());
  const request = {
    id: "batch:a",
    laneId: "a",
    batchId: "batch",
    source: "daily",
    snapshot: { continuation: { parentId: "failed-parent" } },
  } as unknown as ExecutionRecord;
  expect(dailyLaneState(lane, [event], now, [request]).status).toBeNull();
  expect(
    dailyLaneState(lane, [{ ...event, status: "running" }], now, [request])
      .status,
  ).toBe("running");
});
it("retains today's daily completion after a maintenance run", () => {
  const done = run("succeeded", "2026-09-24T05:00:00+08:00");
  const maintenance = {
    ...run("succeeded", "2026-09-24T07:00:00+08:00"),
    runId: "maintenance",
    batchId: "maintenance",
    maintenance: true,
  };
  expect(dailyLaneState(lane, [done, maintenance], now).status).toBe(
    "succeeded",
  );
});
it("ignores another lane and child skill status events", () => {
  const child = {
    ...run("succeeded", "2026-09-24T07:00:00+08:00"),
    runId: "skill",
  };
  const otherLane = {
    ...run("succeeded", "2026-09-24T07:00:00+08:00"),
    laneId: "b",
  };
  expect(dailyLaneState(lane, [child, otherLane], now).status).toBeNull();
});

it("labels an earlier game day's completion as the last result, not today's completion", () => {
  const desktop = {
    deviceLanes: { version: 1, lanes: [lane] },
    arknightsProfiles: { profiles: [] },
    laneStatuses: { a: "succeeded" },
    laneDailyStates: {
      a: { status: null, lastRun: previous, gameDay: "2026-09-23" },
    },
    allEvents: [previous],
  } as unknown as DesktopController;
  const html = renderToStaticMarkup(createElement(Daily, { desktop }));
  expect(html).toContain("今日日常待核对");
  expect(html).toContain("上次日常请求：已完成");
});

it("does not replace the daily result with a later single-request success", () => {
  const done = run("succeeded", "2026-09-24T05:00:00+08:00");
  const single = {
    ...run("succeeded", "2026-09-24T07:00:00+08:00"),
    runId: "login",
    batchId: "login",
    executionSource: "single" as const,
  };
  expect(dailyLaneState(lane, [done, single], now).lastRun).toEqual(done);
  expect(dailyLaneState(lane, [single], now).status).toBeNull();
  expect(
    dailyLaneState(lane, [{ ...single, status: "running" }], now).status,
  ).toBe("running");
});

it("uses matching legacy receipts but refuses missing or conflicting scope", () => {
  const event = {
    ...run("succeeded", now.toISOString()),
    executionSource: undefined,
  };
  const receipt = {
    id: "receipt",
    batchId: event.batchId,
    laneId: lane.id,
    source: "single",
  } as ExecutionRecord;
  expect(dailyLaneState(lane, [event], now).status).toBeNull();
  expect(dailyLaneState(lane, [event], now, [receipt]).status).toBeNull();
  expect(
    dailyLaneState(lane, [event], now, [{ ...receipt, source: "daily" }])
      .status,
  ).toBe("succeeded");
  expect(
    dailyLaneState(lane, [{ ...event, executionSource: "daily" }], now, [
      receipt,
    ]).status,
  ).toBeNull();
  expect(
    dailyLaneState(lane, [event], now, [
      { ...receipt, source: "daily", laneId: "other" },
    ]).status,
  ).toBeNull();
  expect(
    dailyLaneState(lane, [{ ...event, planKey: undefined }], now, [
      { ...receipt, source: "daily" },
    ]).status,
  ).toBeNull();
});

it("shows a completed single request with its scope and preserves the raw log", () => {
  const event = {
    ...run("succeeded", now.toISOString()),
    executionSource: "single" as const,
    message: "账号 A 全部任务已完成",
  };
  const desktop = {
    deviceLanes: { version: 1, lanes: [lane] },
    arknightsProfiles: { profiles: [] },
    laneStatuses: { a: "succeeded" },
    laneDailyStates: { a: dailyLaneState(lane, [event], now) },
    allEvents: [event],
  } as unknown as DesktopController;
  const html = renderToStaticMarkup(createElement(Daily, { desktop }));
  expect(html).toContain("最近单项请求：已完成");
  expect(html).toContain("今日日常待核对");
  expect(html).not.toContain("全部任务已完成");
  expect(runMessage(event)).toBe("账号 A 本次请求已完成");
  expect(event.message).toBe("账号 A 全部任务已完成");
});
