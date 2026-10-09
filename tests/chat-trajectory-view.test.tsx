import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentEvent } from "../packages/protocol/agent-events";

const event = (value: Record<string, unknown>): AgentEvent =>
  ({
    seq: 1,
    at: "2026-10-04T04:00:00Z",
    requestId: "model-a",
    callId: "call-a",
    tool: "get_run",
    kind: "tool-result",
    status: "succeeded",
    text: "读取记录已返回",
    ...value,
  }) as AgentEvent;

it("keeps positive durations below one millisecond distinct from real zero and missing measurements", async () => {
  const { measuredDuration, AgentEventTimeline } =
    await import("../apps/desktop/renderer/components/AgentRunTrace");
  expect(measuredDuration(0.1)).toBe("小于 1 毫秒");
  expect(measuredDuration(0.99)).toBe("小于 1 毫秒");
  expect(measuredDuration(0)).toBe("0 毫秒");
  expect(measuredDuration(undefined)).toBe("耗时未记录");
  expect(measuredDuration(1)).toBe("1 毫秒");
  const html = renderToStaticMarkup(
    createElement(AgentEventTimeline, {
      events: [event({ details: { durationMs: 0.1 } })],
    }),
  );
  expect(html).toContain("小于 1 毫秒");
  expect(html).not.toContain("0 毫秒");
});

it("shows public recorded arguments, results and measured duration within one call", async () => {
  const { AgentEventTimeline } =
    await import("../apps/desktop/renderer/components/AgentRunTrace");
  const events = [
    event({
      seq: 1,
      kind: "tool-started",
      details: { arguments: '{"requestId":"original-a"}' },
    }),
    event({
      seq: 2,
      details: { result: '{"status":"failed"}', durationMs: 1250 },
    }),
  ];
  const html = renderToStaticMarkup(
    createElement(AgentEventTimeline, { events }),
  );
  expect(html).toContain("调用参数");
  expect(html).toContain("original-a");
  expect(html).toContain("返回摘要");
  expect(html).toContain("failed");
  expect(html).toContain("1.25 秒");
  expect((html.match(/data-agent-call-id="call-a"/g) ?? []).length).toBe(1);
});

it("labels missing historic details as unrecorded without deriving duration from journal timestamps", async () => {
  const { AgentEventTimeline } =
    await import("../apps/desktop/renderer/components/AgentRunTrace");
  const html = renderToStaticMarkup(
    createElement(AgentEventTimeline, {
      events: [
        event({ seq: 1, kind: "tool-started", at: "2026-10-04T04:00:00Z" }),
        event({ seq: 2, at: "2026-10-04T04:00:20Z" }),
      ],
    }),
  );
  expect(html).toContain("未记录");
  expect(html).not.toContain("20 秒");
  expect(html).not.toContain("20.00 秒");
});

it("renders a current session trajectory from original turns rather than inventing game completion", async () => {
  const { default: ChatTrajectory } =
    await import("../apps/desktop/renderer/components/ChatTrajectory");
  const html = renderToStaticMarkup(
    createElement(ChatTrajectory, {
      session: {
        id: "session-a",
        title: "当前会话",
        createdAt: "2026-10-04T04:00:00Z",
        updatedAt: "2026-10-04T04:00:00Z",
        turns: [
          {
            id: "turn-a",
            prompt: "检查两个账号",
            source: "recorded",
            at: "2026-10-04T04:00:00Z",
            createdAt: "2026-10-04T04:00:00Z",
            planner: {
              revision: 2,
              requestId: "model-a",
              status: "completed",
              result: {
                status: "answer",
                modelText: "只读回答",
                trace: [],
                elapsedMs: 1250,
                model: "fixture",
              },
            },
          },
        ],
      } as any,
    }),
  );
  expect(html).toContain("检查两个账号");
  expect(html).toContain("查询已完成");
  expect(html).toContain("游戏完成以执行回执为准");
  expect(html).not.toContain("日常全部完成");
});

it("binds a command to both its original turn and planner request while isolating other sessions", async () => {
  const { trajectoryCommandScope } =
    await import("../apps/desktop/renderer/components/ChatTrajectory");
  const session = {
    id: "session-a",
    turns: [{ id: "turn-a", planner: { requestId: "model-a" } }],
  } as any;
  const command = (
    reviewId: string,
    sessionId = "session-a",
    origin?: Record<string, string>,
  ) => ({ reviewId, sessionId, origin }) as any;
  const values = [
    command("own", "session-a", {
      turnId: "turn-a",
      plannerRequestId: "model-a",
    }),
    command("foreign", "session-b", {
      turnId: "turn-a",
      plannerRequestId: "model-a",
    }),
    command("legacy"),
    command("mismatched", "session-a", {
      turnId: "turn-a",
      plannerRequestId: "other-model",
    }),
  ];
  const scope = trajectoryCommandScope(values, session);
  expect(
    scope.forTurn("turn-a", "model-a").map((view) => view.reviewId),
  ).toEqual(["own"]);
  expect(scope.standalone.map((view) => view.reviewId)).toEqual([
    "legacy",
    "mismatched",
  ]);
  expect(
    trajectoryCommandScope(values, { ...session, id: "new-session" }).forTurn(
      "turn-a",
      "model-a",
    ),
  ).toEqual([]);
});
