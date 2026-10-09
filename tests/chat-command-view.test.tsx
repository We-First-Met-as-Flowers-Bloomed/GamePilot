import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ChatCommandView } from "../packages/protocol/chat-commands";
const review = (
  status: ChatCommandView["status"] = "review",
): ChatCommandView => ({
  reviewId: "review-a",
  sessionId: "session-a",
  revision: 3,
  kind: "saved-daily",
  text: "运行保存的日常",
  createdAt: "2026-10-04T03:00:00Z",
  expiresAt: "2099-10-04T04:00:00Z",
  status,
  fingerprint: "host",
  summary: [
    {
      laneName: "账号一",
      games: [
        {
          gameId: "arknights",
          title: "明日方舟",
          steps: [
            "启动与上号",
            "LS-6，零药零源石",
            "领取每日和每周任务奖励，含邮件",
          ],
        },
        {
          gameId: "onmyoji",
          title: "阴阳师",
          steps: ["每日签到", "花合战最后"],
        },
      ],
    },
  ],
});
it("shows the real host default list before allowing an exact bound confirmation", async () => {
  const { ChatCommandReviewCard, confirmReviewedCommand } =
    await import("../apps/desktop/renderer/components/ChatCommandCards");
  const view = review();
  const html = renderToStaticMarkup(
    createElement(ChatCommandReviewCard, {
      view,
      sessionId: "session-a",
      pending: false,
      onConfirm: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(html).toContain("账号一");
  expect(html).toContain("LS-6，零药零源石");
  expect(html).toContain("花合战最后");
  expect(html).toContain("确认运行保存日常");
  const confirmChatCommand = vi.fn(async () => ({
    ...view,
    status: "submitted" as const,
  }));
  await confirmReviewedCommand(
    { confirmChatCommand } as any,
    "session-a",
    view,
  );
  expect(confirmChatCommand).toHaveBeenCalledWith({
    sessionId: "session-a",
    reviewId: "review-a",
    revision: 3,
  });
});
it.each(["submitted", "unknown", "blocked"] as const)(
  "does not offer another launch after the %s receipt",
  async (status) => {
    const { ChatCommandReviewCard, confirmReviewedCommand } =
      await import("../apps/desktop/renderer/components/ChatCommandCards");
    const view = review(status);
    const html = renderToStaticMarkup(
      createElement(ChatCommandReviewCard, {
        view,
        sessionId: "session-a",
        pending: false,
        onConfirm: () => {},
        onOpenExecution: () => {},
      }),
    );
    expect(html).not.toContain("确认运行保存日常");
    const confirmChatCommand = vi.fn();
    await expect(
      confirmReviewedCommand({ confirmChatCommand } as any, "session-a", view),
    ).rejects.toThrow();
    expect(confirmChatCommand).not.toHaveBeenCalled();
    if (status === "unknown") expect(html).toContain("未确认");
  },
);
it("rejects another session and asks users to choose the original request before continuation", async () => {
  const {
    ChatCommandReviewCard,
    ChatCommandRequestPicker,
    confirmReviewedCommand,
  } = await import("../apps/desktop/renderer/components/ChatCommandCards");
  const html = renderToStaticMarkup(
    createElement(ChatCommandReviewCard, {
      view: review(),
      sessionId: "session-b",
      pending: false,
      onConfirm: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(html).not.toContain("确认运行保存日常");
  const confirmChatCommand = vi.fn();
  await expect(
    confirmReviewedCommand(
      { confirmChatCommand } as any,
      "session-b",
      review(),
    ),
  ).rejects.toThrow();
  expect(confirmChatCommand).not.toHaveBeenCalled();
  const picker = renderToStaticMarkup(
    createElement(ChatCommandRequestPicker, {
      kind: "continue",
      requests: [
        {
          id: "original-a",
          status: "failed",
          laneId: "lane-a",
          startedAt: "2026-10-04T04:00:00Z",
        },
      ] as any,
      selectedId: "",
      pending: false,
      onSelect: () => {},
      onReview: () => {},
    }),
  );
  expect(picker).toContain("请选择原失败请求");
  expect(picker).toContain("original-a");
  expect(picker).toContain("已完成步骤保留");
  expect(picker).toMatch(/button[^>]*disabled/);
});
it("labels a queued pause as awaiting the step boundary instead of already applied", async () => {
  const { ChatPauseReceipt } =
    await import("../apps/desktop/renderer/components/ChatCommandCards");
  const queued = renderToStaticMarkup(
    createElement(ChatPauseReceipt, {
      receipt: { runId: "run-a", revision: 1, status: "queued" },
    }),
  );
  expect(queued).toContain("等待当前步骤结束");
  expect(queued).toContain("尚未确认暂停生效");
  expect(queued).not.toContain("已在步骤边界暂停");
  const applied = renderToStaticMarkup(
    createElement(ChatPauseReceipt, {
      receipt: { runId: "run-a", revision: 1, status: "applied" },
    }),
  );
  expect(applied).toContain("已在步骤边界暂停");
});
it("requires an explicit acknowledgement of partial execution before confirming continuation", async () => {
  const { ChatCommandReviewCard, confirmReviewedCommand } =
    await import("../apps/desktop/renderer/components/ChatCommandCards");
  const view: ChatCommandView = {
    ...review(),
    kind: "continue",
    needsAcknowledgement: true,
    parentId: "original-a",
  };
  const html = renderToStaticMarkup(
    createElement(ChatCommandReviewCard, {
      view,
      sessionId: "session-a",
      pending: false,
      onConfirm: () => {},
      onOpenExecution: () => {},
    }),
  );
  expect(html).toContain("我已核对失败步骤的部分执行情况");
  expect(html).toMatch(/button[^>]*disabled/);
  const confirmChatCommand = vi.fn(async () => ({
    ...view,
    status: "submitted" as const,
  }));
  await expect(
    confirmReviewedCommand({ confirmChatCommand } as any, "session-a", view),
  ).rejects.toThrow("部分执行");
  expect(confirmChatCommand).not.toHaveBeenCalled();
  await confirmReviewedCommand(
    { confirmChatCommand } as any,
    "session-a",
    view,
    true,
  );
  expect(confirmChatCommand).toHaveBeenCalledWith({
    sessionId: "session-a",
    reviewId: "review-a",
    revision: 3,
    acknowledgePartial: true,
  });
});
it("applies a pause only from a successful correction bound to the exact request and run", async () => {
  const { pauseAppliedByEvent } =
    await import("../apps/desktop/renderer/components/ChatCommandCards");
  const receipt = { runId: "task-a", revision: 1, status: "queued" } as const;
  const event = {
    requestId: "request-a",
    runId: "task-a",
    kind: "correction",
    status: "succeeded",
  } as any;
  expect(pauseAppliedByEvent(receipt, "request-a", event)).toBe(true);
  for (const invalid of [
    { ...event, requestId: "request-b" },
    { ...event, runId: "task-b" },
    { ...event, kind: "game-result", status: "cancelled" },
    { ...event, status: "running" },
  ])
    expect(pauseAppliedByEvent(receipt, "request-a", invalid)).toBe(false);
});
