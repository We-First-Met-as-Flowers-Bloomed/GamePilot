import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { GoalRun, GoalView } from "../packages/protocol/agent-goal";
import {
  GoalCard,
  GoalCards,
} from "../apps/desktop/renderer/components/GoalCards";
import {
  cancelCurrentGoal,
  watchGoalState,
} from "../apps/desktop/renderer/hooks/useGoals";

const owner = { sessionId: "session-a", turnId: "turn-a" };
const goal = (status: GoalRun["status"] = "waiting"): GoalRun => ({
  version: 1,
  id: "goal-a",
  revision: 2,
  ...owner,
  prompt: "只给账号二领阴阳师邮件",
  selection: { kind: "saved-daily" },
  grant: {
    id: "grant-private",
    source: "user-message",
    ...owner,
    issuedAt: "2026-10-05T01:00:00Z",
    expiresAt: "2026-10-05T02:00:00Z",
    maxRetries: 2,
    scopes: [
      {
        laneId: "lane-b",
        gameId: "onmyoji",
        skillIds: ["mail"],
        resources: { medicine: 0 },
      },
    ],
  },
  createdAt: "2026-10-05T01:00:00Z",
  updatedAt: "2026-10-05T01:01:00Z",
  status,
  message: "本次执行流程已结束；邮件领取结果尚未确认",
  attempts: [],
  retryCount: 0,
  requests: [
    {
      requestId: "request-b",
      laneId: "lane-b",
      gameId: "onmyoji",
      status: "succeeded",
      flowComplete: true,
      goalSatisfied: null,
      skills: [
        {
          skillId: "mail",
          status: "skipped",
          goalSatisfied: null,
          skipReason: "unknown",
          summary: "邮件领取未确认",
        },
      ],
    },
  ],
  flowComplete: true,
  goalSatisfied: null,
});
it("subscribes before reading goal state and rejects older or duplicate revision deliveries", async () => {
  let push!: (v: GoalView) => void;
  let resolve!: (v: GoalView) => void;
  const order: string[] = [];
  const unsubscribe = vi.fn();
  const close = watchGoalState(
    {
      onGoalState: (listener) => {
        order.push("subscribe");
        push = listener;
        return unsubscribe;
      },
      goalSnapshot: () => {
        order.push("read");
        return new Promise((yes) => {
          resolve = yes;
        });
      },
    },
    owner.sessionId,
    (v) => received.push(v),
    vi.fn(),
  );
  const received: GoalView[] = [];
  expect(order).toEqual(["subscribe", "read"]);
  push({ revision: 8, goals: [goal()] });
  push({ revision: 8, goals: [goal()] });
  resolve({ revision: 7, goals: [] });
  await Promise.resolve();
  await Promise.resolve();
  expect(received.map((v) => v.revision)).toEqual([8]);
  close();
  push({ revision: 9, goals: [] });
  expect(received).toHaveLength(1);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("filters events by session and suppresses obsolete read failures after a push", async () => {
  let push!: (v: GoalView) => void;
  let reject!: (e: Error) => void;
  const errors = vi.fn(),
    states = vi.fn();
  const close = watchGoalState(
    {
      onGoalState: (listener) => {
        push = listener;
        return () => {};
      },
      goalSnapshot: () =>
        new Promise((_yes, no) => {
          reject = no;
        }),
    },
    owner.sessionId,
    states,
    errors,
  );
  push({
    revision: 3,
    goals: [goal(), { ...goal(), id: "goal-b", sessionId: "another-session" }],
  });
  reject(Error("obsolete"));
  await Promise.resolve();
  await Promise.resolve();
  expect(states.mock.calls[0][0].goals).toHaveLength(1);
  expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("无法读取"));
  close();
});
it("stops a bound goal directly with the host API and refuses another session", async () => {
  const cancelGoal = vi.fn(async () => goal("cancelled"));
  await cancelCurrentGoal({ cancelGoal }, owner.sessionId, goal());
  expect(cancelGoal).toHaveBeenCalledWith({
    goalId: "goal-a",
    sessionId: owner.sessionId,
  });
  await expect(
    cancelCurrentGoal({ cancelGoal }, "another-session", goal()),
  ).rejects.toThrow();
  expect(cancelGoal).toHaveBeenCalledOnce();
});
it.each(["unknown", "cancelled", "needs-user", "failed"] as const)(
  "keeps %s truthful and separates the public model reply from actual outcomes",
  (status) => {
    const html = renderToStaticMarkup(
      createElement(GoalCard, {
        goal: {
          ...goal(status),
          publicReply: {
            text: "模型建议先核对邮件",
            at: "2026-10-05T01:02:00Z",
            model: "offline-test-model",
          },
        },
        pending: false,
        onCancel: () => {},
        onOpenExecution: () => {},
      }),
    );
    expect(html).toContain("目标满足情况未确认");
    expect(html).toContain("实际结果");
    expect(html).toContain("模型答复");
    expect(html).toContain("邮件领取未确认");
    expect(html).not.toContain("目标已核验完成");
    expect(html).not.toContain("grant-private");
  },
);
it.each([
  { model: "offline-test-model", label: "模型答复", absent: "宿主结果摘要" },
  { model: undefined, label: "宿主结果摘要", absent: "模型答复" },
])("attributes public result text to $label", ({ model, label, absent }) => {
  const html = renderToStaticMarkup(
    createElement(GoalCard, {
      goal: {
        ...goal("unknown"),
        publicReply: {
          text: "邮件结果尚未核对",
          at: "2026-10-05T01:02:00Z",
          model,
        },
      },
      pending: false,
      onCancel: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(html).toContain(label);
  expect(html).not.toContain(absent);
  expect(html).toContain("目标满足情况未确认");
});
it("shows a direct Stop action for ongoing goals and a verified completion only for satisfied goals", () => {
  const ongoing = renderToStaticMarkup(
    createElement(GoalCard, {
      goal: goal(),
      pending: false,
      onCancel: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(ongoing).toContain("停止目标");
  const completed = renderToStaticMarkup(
    createElement(GoalCard, {
      goal: { ...goal("completed"), goalSatisfied: true },
      pending: false,
      onCancel: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(completed).toContain("目标已核验完成");
  expect(completed).not.toContain("停止目标");
});
it("renders nothing for legacy previews with no goal API", () => {
  expect(
    renderToStaticMarkup(
      createElement(GoalCards, {
        sessionId: "session-a",
        onOpenExecution: () => {},
      }),
    ),
  ).toBe("");
});
it("allows direct stop when an accepted goal still has an unknown outcome", () => {
  const value = {
    ...goal("unknown"),
    submission: {
      batchId: "batch-a",
      requestIds: ["request-b"],
      attempt: 0,
      acceptedAt: "2026-10-05T01:00:00Z",
      state: "unknown" as const,
    },
  };
  const html = renderToStaticMarkup(
    createElement(GoalCard, {
      goal: value,
      pending: false,
      onCancel: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(html).toContain("停止目标");
});
it("does not replace a synchronously delivered current state with an initial read failure", async () => {
  const errors = vi.fn();
  const close = watchGoalState(
    {
      onGoalState: (listener) => {
        listener({ revision: 3, goals: [] });
        return () => {};
      },
      goalSnapshot: async () => {
        throw Error("read failed");
      },
    },
    owner.sessionId,
    vi.fn(),
    errors,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("无法读取"));
  close();
});

it("does not promote an overall unknown goal even if its aggregate satisfaction contradicts that status", () => {
  const value = { ...goal("unknown"), goalSatisfied: true };
  const html = renderToStaticMarkup(
    createElement(GoalCard, {
      goal: value,
      pending: false,
      onCancel: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(html).toContain("结果尚未确认");
  expect(html).toContain("目标满足情况未确认");
  expect(html).not.toContain("目标已核验满足");
});
