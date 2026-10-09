import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import Chat from "../apps/desktop/renderer/views/Chat";
import { goalResultReport } from "../games/goal-report";

const test = vi.hoisted(() => ({
  reads: 0,
  goals: [] as any[],
  cancel: vi.fn(),
}));
vi.mock("../apps/desktop/renderer/hooks/useGoals", () => ({
  useGoals: () => {
    test.reads++;
    return {
      state: { revision: 1, goals: test.goals },
      available: true,
      pending: [],
      error: "",
      cancel: test.cancel,
    };
  },
}));
vi.mock("../apps/desktop/renderer/hooks/usePlanner", () => ({
  usePlanner: () => ({
    ready: true,
    state: { revision: 0, status: "idle" },
    pending: false,
    cancel: vi.fn(),
  }),
}));
vi.mock("../apps/desktop/renderer/components/AgentRunTrace", () => ({
  AgentRunTrace: () => null,
}));
vi.mock("../apps/desktop/renderer/components/ChatActivity", () => ({
  default: () =>
    createElement("div", { "data-test-device-panel": true }, "其他设备任务"),
}));
const at = "2026-10-07T08:00:00Z";
function goal(id: string, sessionId: string, status = "waiting") {
  return {
    version: 1,
    id,
    revision: 1,
    sessionId,
    turnId: "turn-0",
    prompt: `需求${id}`,
    status,
    createdAt: at,
    updatedAt: at,
    message: `状态${id}`,
    selection: { kind: "custom" },
    grant: { scopes: [], maxRetries: 2 },
    requests: [],
    retryCount: 0,
    flowComplete: false,
    goalSatisfied: null,
    attempts: [],
  };
}
function props(count = 12) {
  return {
    desktop: {
      api: {},
      view: "chat",
      setView: vi.fn(),
      clearEntryTarget: vi.fn(),
      snapshot: { executions: [] },
      deviceLanes: { lanes: [] },
      taskRecords: [],
      laneDailyStates: {},
    },
    chat: {
      state: {
        revision: 1,
        selectedSessionId: "session-a",
        sessions: [
          {
            id: "session-a",
            title: "会话A",
            turns: Array.from({ length: count }, (_, i) => ({
              id: `turn-${i}`,
              prompt: `问题${i}`,
              source: "recorded",
              createdAt: at,
              planner: {
                revision: 1,
                status: "completed",
                requestId: `model-${i}`,
                result: {
                  status: "answer",
                  modelText: "已受理说明",
                  trace: [],
                  elapsedMs: 1,
                },
              },
            })),
          },
        ],
      },
      ready: true,
      pending: false,
      archive: vi.fn(),
      select: vi.fn(),
      error: "",
    },
    onOpenExecution: vi.fn(),
  } as any;
}
beforeEach(() => {
  test.reads = 0;
  test.goals = [];
});
it("reads one shared goal controller for a twelve-turn chat", () => {
  renderToStaticMarkup(createElement(Chat, props()));
  expect(test.reads).toBe(1);
});
it("concentrates the current session goal and does not borrow another session's same-turn goal", () => {
  test.goals = [
    goal("own-goal", "session-a", "needs-user"),
    goal("foreign-goal", "session-b"),
  ];
  const html = renderToStaticMarkup(createElement(Chat, props()));
  expect(html).toContain('aria-label="本会话交办任务"');
  expect(html.match(/data-goal-id="own-goal"/g)).toHaveLength(1);
  expect(html).not.toContain('data-goal-id="foreign-goal"');
  expect(html).toContain("需要你处理");
});
it("separates and lazily opens other devices without mounting their diagnostic workspace", () => {
  const html = renderToStaticMarkup(createElement(Chat, props(0)));
  expect(html).toContain('aria-label="设备任务与定时任务"');
  expect(html).not.toContain("data-test-device-panel");
});
it("puts reference data into advanced composer controls instead of pretending it is a game scope", () => {
  const html = renderToStaticMarkup(createElement(Chat, props(0)));
  expect(html).toContain('aria-label="参考数据"');
  expect(html).not.toContain('aria-label="任务范围"');
  expect(html).toContain("高级选项");
});
it("does not say no game started when an accepted goal outlives its cancelled model turn", () => {
  test.goals = [goal("own-goal", "session-a", "waiting")];
  const p = props(1);
  p.chat.state.sessions[0].turns[0].planner.status = "cancelled";
  const html = renderToStaticMarkup(createElement(Chat, p));
  expect(html.includes("没有通过这条需求启动游戏")).toBe(false);
  expect(html).toContain("正在执行");
  expect(test.cancel).not.toHaveBeenCalled();
});
it("keeps ongoing stop controls reachable when more than sixteen old unknown goals need attention", () => {
  test.goals = [
    {
      ...goal("still-running", "session-a", "waiting"),
      createdAt: "2026-10-06T08:00:00Z",
    },
    ...Array.from({ length: 24 }, (_, i) =>
      goal(`old-unknown-${i}`, "session-a", "unknown"),
    ),
  ];
  const html = renderToStaticMarkup(createElement(Chat, props(1)));
  expect(html.includes('data-goal-id="still-running"')).toBe(true);
  expect(html).toContain("停止目标");
});

function verifiedGoal() {
  const scope = {
    laneId: "lane-b",
    gameId: "onmyoji",
    skillIds: ["mail"],
    resources: {},
  };
  const review = {
    id: "review-new",
    fingerprint: "fingerprint-new",
    reviewedAt: at,
    expiresAt: at,
    frozenPlan: { kind: "custom" as const, hash: "hash-new" },
    scopes: [scope],
    summary: [],
  };
  return {
    ...goal("new-goal", "session-a", "completed"),
    grant: { scopes: [scope], maxRetries: 2 },
    originalReview: review,
    attempts: [
      {
        review,
        submission: {
          attempt: 1,
          batchId: "batch-new",
          requestIds: ["batch-new:lane-b"],
          acceptedAt: at,
          state: "received" as const,
        },
      },
    ],
    flowComplete: true,
    goalSatisfied: true,
    requests: [
      {
        requestId: "batch-new:lane-b",
        laneId: "lane-b",
        gameId: "onmyoji",
        status: "succeeded" as const,
        flowComplete: true,
        goalSatisfied: true,
        skills: [
          {
            skillId: "mail",
            gameId: "onmyoji",
            status: "succeeded",
            goalSatisfied: true,
            evidenceTimestamp: at,
            evidenceReference: "record-new",
            summary: "邮件已领取",
          },
        ],
      },
    ],
  };
}
function oldRecord() {
  return {
    requestId: "old-parent-request",
    laneId: "账号二",
    recordedStatus: "unknown",
    recordedConclusion: "unknown",
    startedAt: "2026-10-06T08:00:00Z",
    requestSource: "daily",
    complete: true,
    tasks: [],
    warnings: [],
  };
}
function currentTurnHtml(p: ReturnType<typeof props>) {
  const html = renderToStaticMarkup(createElement(Chat, p));
  return html.slice(html.indexOf('data-chat-turn-id="turn-0"'));
}

it("puts the current turn's verified Goal report before collapsed historical unknown records", () => {
  const current = verifiedGoal();
  const parent = {
    ...goal("old-parent-goal", "session-a", "unknown"),
    turnId: "turn-old",
  };
  test.goals = [parent, current, verifiedGoalWithForeignOwner()];
  const p = props(1);
  const result = p.chat.state.sessions[0].turns[0].planner.result;
  result.records = [oldRecord()];
  result.modelText = "旧模型受理时的说明";
  const snapshot = structuredClone([test.goals, result]);
  const html = currentTurnHtml(p);
  expect(html).toContain('aria-label="本轮交办结果"');
  expect(html).toContain('data-goal-result-id="new-goal"');
  expect(html).toContain(goalResultReport(current as any).text);
  expect(html).not.toContain('data-goal-result-id="old-parent-goal"');
  expect(html).not.toContain('data-goal-result-id="foreign-goal"');
  const history = html.indexOf(
    'class="chat-response-details chat-record-details chat-history-reference"',
  );
  expect(history).toBeGreaterThan(html.indexOf('aria-label="本轮交办结果"'));
  expect(html).toMatch(
    /<details class="chat-response-details chat-record-details chat-history-reference"><summary/,
  );
  expect(html.indexOf('aria-label="宿主核对结果"')).toBeGreaterThan(history);
  expect(html).toContain("历史参考");
  expect(html).toContain("不代表本次交办的最新结果");
  expect(html).toContain("old-parent-request");
  expect(html).toContain("查看交办任务");
  expect(html).toMatch(
    /<details class="chat-response-details chat-model-explanation"><summary/,
  );
  expect([test.goals, result]).toEqual(snapshot);
});

function verifiedGoalWithForeignOwner() {
  return { ...verifiedGoal(), id: "foreign-goal", sessionId: "session-b" };
}

it("refreshes the inline report from live Goal facts instead of a stale model reply", () => {
  const current = verifiedGoal();
  const waiting = {
    ...current,
    status: "waiting",
    flowComplete: false,
    goalSatisfied: null,
    requests: [],
  };
  const p = props(1);
  test.goals = [waiting];
  const before = currentTurnHtml(p);
  expect(before).toContain(goalResultReport(waiting as any).text);
  expect(before).not.toContain("本次交办的 1 项任务已核验完成");
  test.goals = [current];
  const after = currentTurnHtml(p);
  expect(after).toContain(goalResultReport(current as any).text);
  expect(after).toContain("本次交办的 1 项任务已核验完成");
  expect(after).toMatch(
    /<details class="chat-response-details chat-model-explanation"><summary/,
  );
});

it("keeps a failed current Goal and its handling entry visible even without a planner result", () => {
  test.goals = [goal("failed-current", "session-a", "failed")];
  const p = props(1);
  delete p.chat.state.sessions[0].turns[0].planner.result;
  p.chat.state.sessions[0].turns[0].planner.error = {
    code: "MODEL_FAILED",
    message: "模型说明未返回",
  };
  const html = currentTurnHtml(p);
  expect(html).toContain('data-goal-result-id="failed-current"');
  expect(html).toContain("任务需要处理，本次交办未完整完成");
  expect(html).toContain("失败画面和处理入口");
  expect(html).toContain("查看交办任务");
  expect(html).toContain("模型说明未返回");
  expect(html).not.toContain("chat-history-reference");
});

it("retains prominent query facts when the current turn owns no Goal", () => {
  test.goals = [{ ...goal("old-only", "session-a"), turnId: "another-turn" }];
  const p = props(1);
  p.chat.state.sessions[0].turns[0].planner.result.records = [oldRecord()];
  const html = currentTurnHtml(p);
  expect(html).toContain('aria-label="宿主核对结果"');
  expect(html).toContain("完整执行记录");
  expect(html).not.toContain("chat-history-reference");
  expect(html).not.toContain('aria-label="本轮交办结果"');
});
