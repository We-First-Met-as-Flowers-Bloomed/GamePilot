import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import TaskProgress, {
  TaskRecordProgress,
} from "../apps/desktop/renderer/components/TaskProgress";
import { reduceTaskRecords } from "../packages/protocol/task-record";
const records = reduceTaskRecords([], {
  laneId: "a",
  batchId: "old",
  runId: "r",
  gameId: "onmyoji",
  type: "status",
  status: "queued",
  at: "2026-09-24T01:00:00.000Z",
  message: "start",
  plan: { gameId: "onmyoji", skillIds: ["mail"], mode: "rehearsal" },
});
it("does not pick a later success when request ownership is ambiguous", () => {
  const first = {
    ...records[0],
    executionId: "original",
    status: "unknown" as const,
  };
  const later = {
    ...records[0],
    executionId: "other",
    runId: "other-run",
    startedAt: "2026-09-24T02:00:00.000Z",
    status: "succeeded" as const,
    steps: records[0].steps.map((step) => ({
      ...step,
      status: "succeeded" as const,
    })),
  };
  for (const candidates of [
    [first, later],
    [later, first],
  ]) {
    const html = renderToStaticMarkup(
      createElement(TaskProgress, {
        records: candidates,
        laneId: "a",
        batchId: "old",
        gameId: "onmyoji",
      }),
    );
    expect(html).toContain("记录关联待核对");
    expect(html).not.toContain("演练完成");
    expect(html).not.toContain("task-steps");
  }
});
it("does not show an old batch or another device as the current game result", () => {
  const html = renderToStaticMarkup(
    createElement(TaskProgress, {
      records,
      laneId: "a",
      batchId: "new",
      gameId: "onmyoji",
    }),
  );
  expect(html).toContain("暂无本轮分步记录");
  expect(html).not.toContain("09/24");
  expect(
    renderToStaticMarkup(
      createElement(TaskProgress, {
        records,
        laneId: "b",
        batchId: "old",
        gameId: "onmyoji",
      }),
    ),
  ).toContain("暂无本轮分步记录");
});
it("labels rehearsal and renders a confirmed skip with its evidence", () => {
  const updated = reduceTaskRecords(records, {
    laneId: "a",
    runId: "r",
    gameId: "onmyoji",
    type: "step",
    skillId: "mail",
    stepStatus: "skipped",
    message: "没有待领取奖励",
    at: "2026-09-24T01:01:00.000Z",
  });
  const html = renderToStaticMarkup(
    createElement(TaskProgress, {
      records: updated,
      laneId: "a",
      batchId: "old",
      gameId: "onmyoji",
    }),
  );
  expect(html).toContain("演练记录");
  expect(html).toContain("已跳过");
  expect(html).toContain("没有待领取奖励");
});

it("can render the exact selected record without choosing by lane or batch", () => {
  const html = renderToStaticMarkup(
    createElement(TaskRecordProgress, {
      record: {
        ...records[0],
        laneId: undefined,
        batchId: undefined,
        message: "准确的旧请求记录",
      },
    }),
  );
  expect(html).toContain("准确的旧请求记录");
  expect(html).toContain("演练记录 · 未操作游戏");
  expect(html).not.toContain("暂无本轮分步记录");
});
