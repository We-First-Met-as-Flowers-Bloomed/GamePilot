import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PlannerRecords } from "../apps/desktop/renderer/components/PlannerRecords";
import type { AgentRunSummary } from "../packages/protocol/agent";

const fixture = (): AgentRunSummary => ({
  requestId: "request-1",
  laneId: "lane-a",
  requestSource: "daily",
  recordedStatus: "failed",
  recordedConclusion: "failed",
  complete: true,
  inGameCompletion: "not-verified",
  warnings: [],
  notes: [],
  tasks: [
    {
      runId: "task-1",
      gameId: "arknights",
      gameDay: "2026-10-03",
      mode: "live",
      status: "failed",
      steps: [{ skillId: "friends", status: "failed" }],
      resultSummary: {
        version: 1,
        mode: "live",
        counts: {
          completed: 0,
          skipped: 0,
          failed: 1,
          unknown: 0,
          notRun: 0,
          running: 0,
          pending: 0,
          cancelled: 0,
        },
        items: [
          {
            id: "shopping",
            label: "信用购物",
            value: "购买确认 6 次",
            note: "购物后双帧核对余额 290。部分观测，任务未确认完成。",
            status: "failed",
          },
        ],
        issues: [],
        scopeNote: "仅本次请求的记录。",
      },
    },
  ],
  recordedProgress: {
    version: 1,
    requestId: "request-1",
    rootId: "request-1",
    latestId: "request-2",
    laneId: "lane-a",
    source: "daily",
    originalStatus: "failed",
    outcome: "recovered",
    wholePlanComplete: true,
    startedAt: "2026-10-03T01:00:00Z",
    requests: [
      { id: "request-1", status: "failed", startedAt: "2026-10-03T01:00:00Z" },
      {
        id: "request-2",
        status: "succeeded",
        startedAt: "2026-10-03T02:00:00Z",
      },
    ],
    steps: [
      {
        gameId: "arknights",
        skillId: "friends",
        status: "succeeded",
        sourceId: "request-2",
        continued: true,
      },
    ],
    counts: { total: 1, completed: 1, skipped: 0, excluded: 0, remaining: 0 },
    warnings: [],
  },
});
it("shows host quantities and merged progress beside the unchanged original failure", () => {
  const html = renderToStaticMarkup(
    createElement(PlannerRecords, { records: [fixture()] }),
  );
  expect(html).toContain("购买确认 6 次");
  expect(html).toContain("余额 290");
  expect(html).toContain("原计划已补齐");
  expect(html).toContain("记录失败");
  expect(html).toContain("当前游戏");
  expect(html).toContain("部分观测");
});
it("shows missing facts as unknown rather than zero", () => {
  const r = fixture();
  delete r.tasks[0].resultSummary;
  delete r.recordedProgress;
  const html = renderToStaticMarkup(
    createElement(PlannerRecords, { records: [r] }),
  );
  expect(html).toContain("未记录结果汇总");
  expect(html).not.toContain("购买确认 0 次");
});
