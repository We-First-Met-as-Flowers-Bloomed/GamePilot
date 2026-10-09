import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("../apps/desktop/renderer/hooks/usePlanner", () => ({
  usePlanner: () => ({
    ready: true,
    state: { revision: 0, status: "idle" },
    pending: false,
    cancel: vi.fn(),
  }),
}));
vi.mock("../apps/desktop/renderer/components/ChatActivity", () => ({
  default: () => null,
}));
vi.mock("../apps/desktop/renderer/components/AgentRunTrace", () => ({
  AgentRunTrace: () => null,
}));

function props(turns: any[] = []) {
  return {
    desktop: {
      api: {},
      view: "chat",
      snapshot: { executions: [] },
      setView: vi.fn(),
      clearEntryTarget: vi.fn(),
    },
    chat: {
      state: {
        revision: 1,
        selectedSessionId: "session-a",
        sessions: [{ id: "session-a", title: "当前会话", turns }],
      },
      ready: true,
      pending: false,
      error: "",
      archive: vi.fn(),
    },
    onOpenExecution: vi.fn(),
  } as any;
}
it("mounts saved daily, explicit request controls and readonly archives in the chat workspace", async () => {
  const { default: Chat } = await import("../apps/desktop/renderer/views/Chat");
  const html = renderToStaticMarkup(createElement(Chat, props()));
  expect(html).toContain("运行保存的日常");
  expect(html).toContain("继续原失败请求");
  expect(html).toContain("当前步骤结束后暂停");
  expect(html).toContain("会话记录与归档");
  expect(html).toContain("当前预览继续保留已有聊天记录");
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-label="对话与轨迹"');
  expect(html).toContain('aria-controls="chat-conversation-panel"');
  expect(html).toContain('aria-controls="chat-trajectory-panel"');
  expect(html).toContain('id="chat-prompt"');
});
it("places host facts first and folds the model explanation and detailed record", async () => {
  const { default: Chat } = await import("../apps/desktop/renderer/views/Chat");
  const records = [
    {
      requestId: "original-a",
      laneId: "账号一",
      recordedStatus: "failed",
      startedAt: "2026-10-04T03:00:00Z",
      recordedConclusion: "failed",
      tasks: [],
      warnings: [],
    },
  ];
  const turn = {
    id: "turn-a",
    prompt: "查询当前记录",
    source: "recorded",
    createdAt: "2026-10-04T03:00:00Z",
    planner: {
      revision: 2,
      requestId: "model-a",
      status: "completed",
      result: {
        kind: "query",
        modelText: "模型解释内容",
        records,
        trace: [],
        elapsedMs: 1,
        model: "fixture",
      },
    },
  };
  const html = renderToStaticMarkup(createElement(Chat, props([turn])));
  expect(html.indexOf("宿主核对结果")).toBeLessThan(
    html.indexOf("模型解释内容"),
  );
  expect(html).toMatch(
    /<details class="chat-response-details chat-model-explanation"><summary/,
  );
  expect(html).toMatch(
    /<details class="chat-response-details chat-record-details"><summary/,
  );
});

it("shows admitted goal execution without the legacy readonly-only assessment", async () => {
  const { default: Chat } = await import("../apps/desktop/renderer/views/Chat");
  const turn = {
    id: "turn-goal",
    prompt: "现在运行登录任务",
    source: "recorded",
    createdAt: "2026-10-05T09:00:00Z",
    planner: {
      revision: 2,
      requestId: "model-goal",
      status: "completed",
      result: {
        status: "answer",
        execution: "managed-by-goal",
        goalIds: ["goal-a"],
        modelText: "目标已受理",
        trace: [],
        elapsedMs: 1,
        historyAssessment: {
          scope: "bounded-ledger",
          dailyCompletion: "unknown",
          missingRecordMeans: "unknown",
          canInferNotRun: false,
          canAuthorizeReplay: false,
        },
      },
    },
  };
  const html = renderToStaticMarkup(createElement(Chat, props([turn])));
  expect(html).toContain("目标已受理");
  expect(html).not.toContain("本轮只查询");
  expect(html).not.toContain("查询已完成");
});
