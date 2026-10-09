import { describe, expect, it, vi } from "vitest";
import { ChatIntentReviewService } from "../apps/desktop/main/chat-intent-review";
import { ChatCommandService } from "../apps/desktop/main/chat-commands";
import { AgentToolError } from "../packages/protocol/agent";
import type { ChatView } from "../packages/protocol/agent-chat";
import type { PlannerViewState } from "../packages/protocol/agent-planner";
import type { ChatCommandStore } from "../packages/protocol/chat-commands";

function fixture() {
  const planner: PlannerViewState = {
    revision: 3,
    status: "completed",
    requestId: "request",
    source: "recorded",
    result: {
      status: "saved-daily",
      source: "recorded",
      modelText: "检查保存日常",
      execution: "not-started",
      canExecute: false,
      trace: [],
      model: "fixture",
      codexVersion: "none",
      elapsedMs: 10,
    },
  };
  const chat: ChatView = {
    revision: 2,
    selectedSessionId: "s",
    sessions: [
      {
        id: "s",
        title: "日常",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turns: [
          {
            id: "t",
            prompt: "照保存计划帮我安排日常",
            source: "recorded",
            at: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            planner: structuredClone(planner),
          },
        ],
      },
    ],
  };
  let stored: ChatCommandStore | undefined;
  const launch = vi.fn(async () => ({
    batchId: "batch",
    requestIds: ["batch:a", "batch:b"],
  }));
  const prepare = vi.fn(async () => ({
    fingerprint: "settings",
    summary: [
      {
        laneName: "账号一",
        games: [{ gameId: "arknights", title: "明日方舟", steps: ["登录"] }],
      },
    ],
    payload: { frozen: true },
  }));
  let intent: ChatIntentReviewService;
  const commandDeps = {
    validateSession: async () =>
      `${chat.selectedSessionId}:${chat.sessions[0].turns.at(-1)?.id}`,
    validateOrigin: async (
      view: Parameters<ChatIntentReviewService["assertCurrent"]>[0],
    ) => intent.assertCurrent(view),
    prepare,
    launch,
    load: async () => stored,
    save: vi.fn(async (value: ChatCommandStore) => {
      stored = structuredClone(value);
    }),
  };
  const commands = new ChatCommandService(commandDeps);
  const deps = {
    planner: async () => structuredClone(planner),
    chat: async () => structuredClone(chat),
    commands,
  };
  intent = new ChatIntentReviewService(deps);
  const target = { sessionId: "s", turnId: "t", requestId: "request" };
  return {
    planner,
    chat,
    target,
    deps,
    commands,
    commandDeps,
    prepare,
    launch,
    intent,
    restart: () => {
      const restored = new ChatCommandService(commandDeps);
      intent = new ChatIntentReviewService({ ...deps, commands: restored });
      return intent;
    },
  };
}

describe("current model intent uses the original saved daily review", () => {
  it.each(["SAME_DAY", "SAME_DAY_EXECUTION"])(
    "keeps a definite %s host refusal in the model turn without retrying or starting games",
    async (code) => {
      const f = fixture();
      f.prepare.mockRejectedValueOnce(
        new AgentToolError(code, "same game day"),
      );
      const view = await f.intent.review(f.target);
      expect(view).toMatchObject({
        status: "blocked",
        origin: { turnId: "t", plannerRequestId: "request" },
        summary: [],
      });
      expect(view.message).toContain(code);
      expect(view.message).toContain("该游戏日已有执行记录");
      expect((await f.restart().review(f.target)).reviewId).toBe(view.reviewId);
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.launch).not.toHaveBeenCalled();
      await expect(
        f.commands.review({ sessionId: "s", text: "运行保存的日常" }),
      ).resolves.toMatchObject({ status: "review" });
    },
  );
  it("rejects a planner invalidated during chat reconciliation even when history stays completed", async () => {
    const f = fixture();
    f.deps.chat = async () => {
      f.planner.status = "failed";
      f.planner.result = undefined;
      return structuredClone(f.chat);
    };
    await expect(f.intent.review(f.target)).rejects.toMatchObject({
      code: "CHAT_INTENT_STALE",
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("persists one exact preview across repeated notifications and restart without starting games", async () => {
    const f = fixture();
    const review = await f.intent.review(f.target);
    expect(review).toMatchObject({
      text: "运行保存的日常",
      origin: { turnId: "t", plannerRequestId: "request" },
    });
    expect((await f.intent.review(f.target)).reviewId).toBe(review.reviewId);
    expect((await f.restart().review(f.target)).reviewId).toBe(review.reviewId);
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("maps the dual game intent exactly and confirms through the original host only", async () => {
    const f = fixture();
    f.planner.result!.status = "saved-both-games";
    f.chat.sessions[0].turns[0].planner = structuredClone(f.planner);
    const review = await f.intent.review(f.target);
    expect(review.text).toBe("运行双游戏日常");
    expect(f.launch).not.toHaveBeenCalled();
    expect(
      (
        await f.commands.confirm({
          sessionId: "s",
          reviewId: review.reviewId,
          revision: 1,
        })
      ).status,
    ).toBe("submitted");
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "historical",
    "fixture",
    "question",
    "new-turn",
    "new-session",
    "revision",
    "cancelled",
  ])("rejects %s intent without preparation or launch", async (reason) => {
    const f = fixture();
    if (reason === "historical") f.planner.requestId = "new-request";
    if (reason === "fixture") {
      f.planner.source = "fixture";
      f.planner.result!.source = "fixture";
    }
    if (reason === "question") f.planner.result!.status = "question";
    if (reason === "new-turn")
      f.chat.sessions[0].turns.push({
        ...f.chat.sessions[0].turns[0],
        id: "new",
      });
    if (reason === "new-session") f.chat.selectedSessionId = "other";
    if (reason === "revision") f.chat.sessions[0].turns[0].planner.revision--;
    if (reason === "cancelled") f.planner.status = "cancelled";
    await expect(f.intent.review(f.target)).rejects.toMatchObject({
      code: "CHAT_INTENT_STALE",
    });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
  it("checks the target again after asynchronous preparation and before confirmation", async () => {
    const f = fixture();
    f.prepare.mockImplementationOnce(async () => {
      f.chat.selectedSessionId = "other";
      return {
        fingerprint: "settings",
        summary: [],
        payload: { frozen: true },
      };
    });
    await expect(f.intent.review(f.target)).rejects.toMatchObject({
      code: "CHAT_INTENT_STALE",
    });
    expect(await f.commands.snapshot()).toEqual([]);
    const g = fixture();
    const review = await g.intent.review(g.target);
    g.planner.status = "cancelled";
    await expect(
      g.commands.confirm({
        sessionId: "s",
        reviewId: review.reviewId,
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: "CHAT_INTENT_STALE" });
    expect(g.launch).not.toHaveBeenCalled();
  });
  it("will not regenerate an expired preview or accept renderer text/plan overrides", async () => {
    const f = fixture();
    const review = await f.intent.review(f.target);
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.expiresAt) + 1);
    try {
      expect((await f.intent.review(f.target)).reviewId).toBe(review.reviewId);
      await expect(
        f.commands.confirm({
          sessionId: "s",
          reviewId: review.reviewId,
          revision: 1,
        }),
      ).rejects.toMatchObject({ code: "COMMAND_EXPIRED" });
      await expect(
        f.intent.review({ ...f.target, text: "run", plan: {} } as never),
      ).rejects.toThrow();
      expect(f.prepare).toHaveBeenCalledTimes(1);
      expect(f.launch).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("fails closed on persistence failure", async () => {
    const f = fixture();
    f.commandDeps.save.mockRejectedValueOnce(Error("disk"));
    await expect(f.intent.review(f.target)).rejects.toMatchObject({
      code: "COMMAND_STORE_UNAVAILABLE",
    });
    await expect(f.intent.review(f.target)).rejects.toMatchObject({
      code: "COMMAND_STORE_UNAVAILABLE",
    });
    expect(f.launch).not.toHaveBeenCalled();
  });
});
