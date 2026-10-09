import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { ChatArchiveTurnsPage } from "../packages/protocol/agent-chat";
it("renders archived turns and drafts as read-only history with their original source", async () => {
  const { ChatArchiveTranscript } =
    await import("../apps/desktop/renderer/components/ChatArchives");
  const page: ChatArchiveTurnsPage = {
    scope: "historical-only",
    canExecute: false,
    archive: {
      version: 1,
      id: "session-a",
      sessionId: "session-a",
      title: "过去的计划",
      turnCount: 1,
      sources: ["recorded"],
      createdAt: "2026-10-03T01:00:00Z",
      updatedAt: "2026-10-03T01:00:00Z",
      archivedAt: "2026-10-04T01:00:00Z",
    },
    session: {
      id: "session-a",
      title: "过去的计划",
      createdAt: "2026-10-03T01:00:00Z",
      updatedAt: "2026-10-03T01:00:00Z",
    },
    turns: [
      {
        id: "turn-a",
        prompt: "只查询旧计划",
        source: "recorded",
        at: "2026-10-03T01:00:00Z",
        createdAt: "2026-10-03T01:00:00Z",
        planner: {
          revision: 1,
          status: "completed",
          result: {
            status: "draft",
            source: "recorded",
            modelText: "原计划草稿",
            execution: "not-started",
            canExecute: false,
            trace: [],
            model: "test",
            codexVersion: "",
            elapsedMs: 1,
            draft: {
              status: "valid",
              canExecute: false,
              catalogRevision: "old",
              environmentRevision: "old",
              at: "2026-10-03T01:00:00Z",
              lanes: [],
              reasons: [],
              preconditions: [],
            },
          },
        },
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(ChatArchiveTranscript, { page }),
  );
  expect(html).toContain("只读历史");
  expect(html).toContain("当前账号与记录");
  expect(html).toContain("原计划草稿");
  expect(html).toContain("旧草稿");
  expect(html).not.toContain("确认执行");
  expect(html).not.toContain("开始运行");
  expect(html).not.toContain("agent-execution");
});
it("keeps deterministic summary folded and marks its facts as historical rather than current", async () => {
  const { ChatSessionSummaryCard } =
    await import("../apps/desktop/renderer/components/ChatArchives");
  const html = renderToStaticMarkup(
    createElement(ChatSessionSummaryCard, {
      summary: {
        version: 1,
        scope: "historical-tools-only",
        currentState: "unknown",
        canAuthorizeExecution: false,
        objectives: [
          {
            turnId: "turn-a",
            source: "recorded",
            at: "2026-10-03T01:00:00Z",
            text: "不要吃药",
            truncated: false,
          },
        ],
        facts: [
          {
            turnId: "turn-a",
            source: "recorded",
            at: "2026-10-03T01:00:00Z",
            originTool: "get_run",
            kind: "recorded-run",
            requestId: "request-a",
            recordedConclusion: "unknown",
            inGameCompletion: "not-verified",
          },
        ],
      },
    }),
  );
  expect(html).toContain("会话目标与已核对事实");
  expect(html).toContain("不要吃药");
  expect(html).toContain("request-a");
  expect(html).toContain("当前状态仍需本轮工具核对");
  expect(html).not.toMatch(/<details[^>]* open/);
});
