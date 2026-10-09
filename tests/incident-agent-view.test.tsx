import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IncidentTimeline } from "../apps/desktop/renderer/components/IncidentAgentPanel";
it("shows diagnostic evidence, host action and historical result separately", () => {
  const html = renderToStaticMarkup(
    <IncidentTimeline
      session={{
        requestId: "req",
        status: "resumed",
        automatic: true,
        startedAt: "2026-10-03T12:00:00Z",
        updatedAt: "2026-10-03T12:01:00Z",
        events: [
          {
            seq: 1,
            at: "2026-10-03T12:00:00Z",
            kind: "model",
            status: "running",
            text: "模型正在分析证据",
          },
          {
            seq: 2,
            at: "2026-10-03T12:01:00Z",
            kind: "resume",
            status: "succeeded",
            text: "已接受续跑，尚不代表任务完成",
          },
        ],
        diagnosis: {
          summary: "登录网络异常",
          basis: ["screen-1"],
          action: "retry-remaining",
        },
      }}
    />,
  );
  expect(html).toContain("诊断摘要");
  expect(html).toContain("screen-1");
  expect(html).toContain("尚不代表任务完成");
  expect(html).toContain("模型正在分析证据");
});
it.each(["failed", "unknown", "cancelled", "partial", "succeeded"] as const)(
  "does not draw a game success check for %s when the original plan is incomplete",
  (outcome) => {
    const html = renderToStaticMarkup(
      <IncidentTimeline
        session={{
          requestId: "req",
          status: "resumed",
          automatic: true,
          startedAt: "2026-10-03T12:00:00Z",
          updatedAt: "2026-10-03T12:00:00Z",
          events: [
            {
              seq: 1,
              at: "2026-10-03T12:00:00Z",
              kind: "result",
              status: "succeeded",
              text: "已读取续跑结果",
              result: {
                outcome,
                wholePlanComplete: false,
                summary: "原计划未补齐",
                evidenceRefs: ["child:ledger"],
              },
            } as never,
          ],
        }}
      />,
    );
    expect(html).not.toContain("lucide-check");
    expect(html).toContain("已读取续跑结果");
    expect(html).toContain("原计划尚未补齐");
    if (outcome === "failed") expect(html).toContain("续跑失败");
    if (outcome === "unknown") expect(html).toContain("续跑结果未知");
    if (outcome === "cancelled") expect(html).toContain("续跑已停止");
    if (outcome === "partial") expect(html).toContain("续跑部分完成");
  },
);
it("does not trust a legacy successful result icon without structured ledger confirmation", () => {
  const html = renderToStaticMarkup(
    <IncidentTimeline
      session={{
        requestId: "req",
        status: "resumed",
        automatic: true,
        startedAt: "2026-10-03T12:00:00Z",
        updatedAt: "2026-10-03T12:00:00Z",
        events: [
          {
            seq: 1,
            at: "2026-10-03T12:00:00Z",
            kind: "result",
            status: "succeeded",
            text: "旧续跑结果",
          },
        ],
      }}
    />,
  );
  expect(html).not.toContain("lucide-check");
  expect(html).toContain("原计划完成情况待账本核对");
});
it("shows later verified original-plan coverage without giving a failed successor a success icon", () => {
  const html = renderToStaticMarkup(
    <IncidentTimeline
      session={{
        requestId: "req",
        status: "resumed",
        automatic: true,
        startedAt: "2026-10-03T12:00:00Z",
        updatedAt: "2026-10-03T12:00:00Z",
        events: [
          {
            seq: 1,
            at: "2026-10-03T12:00:00Z",
            kind: "result",
            status: "failed",
            text: "原失败保留",
            result: {
              outcome: "failed",
              wholePlanComplete: true,
              summary: "后续账本已补齐",
              evidenceRefs: ["later-child:ledger"],
            },
          },
        ],
      }}
    />,
  );
  expect(html).not.toContain("lucide-check");
  expect(html).toContain("原计划已补齐");
  expect(html).not.toContain("原计划尚未补齐");
});
it("shows the host's bounded navigation proposal before the user confirms continuation", () => {
  const html = renderToStaticMarkup(
    <IncidentTimeline
      session={{
        requestId: "req",
        status: "awaiting-user",
        automatic: false,
        startedAt: "2026-10-03T12:00:00Z",
        updatedAt: "2026-10-03T12:00:00Z",
        events: [],
        recovery: {
          kind: "return-arknights-home",
          runId: "original-run",
          gameId: "arknights",
          fromPage: "friends-list",
        },
      }}
    />,
  );
  expect(html).toContain("受限恢复提案");
  expect(html).toContain("返回主页");
  expect(html).toContain("原设备");
  expect(html).toContain("重新登录核对UID");
});
