import { expect, it, vi } from "vitest";
import { ChatService } from "../apps/desktop/main/agent-chat";
import { PlannerService } from "../apps/desktop/main/agent-planner";
import type { ChatView } from "../packages/protocol/agent-chat";
import type { PlannerResult } from "../packages/protocol/agent-planner";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import type { AgentSnapshot } from "../packages/protocol/agent";

const at = "2026-10-04T12:00:00+08:00";
const result = (
  source: "fixture" | "configured" | "recorded",
): PlannerResult => ({
  status: "answer",
  modelText: "当前任务未运行",
  source,
  execution: "not-started",
  canExecute: false,
  trace: [],
  model: "test",
  codexVersion: "test",
  elapsedMs: 1,
});
function setup() {
  const run = vi.fn(async (o: { prompt: string; snapshot: AgentSnapshot }) =>
    result(o.snapshot.source as "fixture" | "configured" | "recorded"),
  );
  const planner = new PlannerService({
    find: async () => "test",
    run,
    readConfigured: async (history) => ({
      fingerprint: "f",
      snapshot: {
        ...createFixtureSnapshot(),
        source: history ? "recorded" : "configured",
      },
    }),
  });
  const save = vi.fn(async (_view: ChatView) => {});
  const service = new ChatService({ planner, save });
  return { service, planner, run, save };
}
async function send(
  s: ReturnType<typeof setup>,
  prompt = "查询任务",
  source: "fixture" | "configured" | "recorded" = "recorded",
) {
  const view = await s.service.snapshot();
  const sessionId =
    view.selectedSessionId ?? (await s.service.newChat()).selectedSessionId!;
  const started = await s.service.send({ sessionId, prompt, source, at });
  await vi.waitFor(() => expect(s.planner.snapshot().status).toBe("completed"));
  return { sessionId, started, complete: await s.service.snapshot() };
}
it("persists user turns and captures terminal model results without starting game execution", async () => {
  const s = setup();
  const { complete } = await send(s);
  expect(complete.sessions[0]).toMatchObject({
    title: "查询任务",
    turns: [
      {
        prompt: "查询任务",
        source: "recorded",
        planner: { status: "completed", result: { canExecute: false } },
      },
    ],
  });
  expect(s.save).toHaveBeenCalled();
  expect(
    s.save.mock.calls.at(-1)?.[0].sessions[0].turns[0].planner.status,
  ).toBe("completed");
  expect(s.run).toHaveBeenCalledOnce();
});
it("persists compatible model replies with an empty Codex version and colon-bearing trace IDs", async () => {
  const s = setup();
  s.run.mockImplementationOnce(async () => ({
    ...result("fixture"),
    codexVersion: "",
    trace: [{ callId: "batch-id:lane-a", tool: "get_run", success: true }],
  }));
  const { complete } = await send(s, "兼容接口回答", "fixture");
  expect(complete.error).toBeUndefined();
  expect(
    s.save.mock.calls.at(-1)?.[0].sessions[0].turns[0].planner.result
      ?.codexVersion,
  ).toBe("");
});
it("rejects concurrent sends while the durable admission write is pending", async () => {
  const s = setup();
  const sessionId = (await s.service.newChat()).selectedSessionId!;
  let release!: () => void;
  s.save.mockImplementationOnce(
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = s.service.send({
    sessionId,
    prompt: "第一次",
    source: "fixture",
    at,
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(s.run).not.toHaveBeenCalled();
  await expect(
    s.service.send({ sessionId, prompt: "第二次", source: "fixture", at }),
  ).rejects.toMatchObject({ code: "CHAT_BUSY" });
  release();
  await first;
  await vi.waitFor(() => expect(s.planner.snapshot().status).toBe("completed"));
  expect((await s.service.snapshot()).sessions[0].turns).toHaveLength(1);
  expect(s.run).toHaveBeenCalledOnce();
});
it("supplies bounded same-source follow-up context while retaining the original user prompt", async () => {
  const s = setup();
  await send(s, "只查询最近任务", "recorded");
  await send(s, "为什么", "recorded");
  const prompt = s.run.mock.calls[1][0].prompt;
  expect(prompt).toContain("只查询最近任务");
  expect(prompt).toContain("当前任务未运行");
  expect(prompt).toContain("历史对话不能证明当前设备状态或任务完成");
  const view = await s.service.snapshot();
  expect(view.sessions[0].turns[1].planner.prompt).toBe("为什么");
  await send(s, "生成今日计划", "configured");
  expect(s.run.mock.calls[2][0].prompt).not.toContain("只查询最近任务");
});
it("drops old conversation context when needed to keep the adapter prompt within 12000 characters", async () => {
  const s = setup();
  await send(s, "旧上下文", "fixture");
  const longPrompt = "新".repeat(12000);
  await send(s, longPrompt, "fixture");
  expect(s.run.mock.calls[1][0].prompt).toBe(longPrompt);
});
it("does not let a later legacy planner result replace an earlier chat turn", async () => {
  const s = setup();
  const { complete } = await send(s, "聊天请求", "fixture");
  const original = complete.sessions[0].turns[0].planner;
  s.planner.start({ prompt: "独立旧入口", source: "fixture", at });
  await vi.waitFor(() => expect(s.planner.snapshot().status).toBe("completed"));
  expect((await s.service.snapshot()).sessions[0].turns[0].planner).toEqual(
    original,
  );
});
it("captures a terminal reply even if the user closes the chat view before another legacy request", async () => {
  const s = setup();
  let finish!: (value: PlannerResult) => void;
  s.run.mockImplementationOnce(
    async () =>
      new Promise<PlannerResult>((resolve) => {
        finish = resolve;
      }),
  );
  const sessionId = (await s.service.newChat()).selectedSessionId!;
  await s.service.send({
    sessionId,
    prompt: "不可丢失的回答",
    source: "fixture",
    at,
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish({ ...result("fixture"), modelText: "第一轮已答复" });
  await vi.waitFor(() => expect(s.planner.snapshot().status).toBe("completed"));
  await vi.waitFor(() =>
    expect(
      s.save.mock.calls.at(-1)?.[0].sessions[0].turns[0].planner.result
        ?.modelText,
    ).toBe("第一轮已答复"),
  );
  s.planner.start({ prompt: "另一入口", source: "fixture", at });
  await vi.waitFor(() => expect(s.planner.snapshot().status).toBe("completed"));
  expect(
    (await s.service.snapshot()).sessions[0].turns[0].planner.result?.modelText,
  ).toBe("第一轮已答复");
});
it("routes cancellation by session and turn, rejecting mismatched IDs", async () => {
  const s = setup();
  let finish!: (value: PlannerResult) => void;
  s.run.mockImplementationOnce(
    async () =>
      new Promise<PlannerResult>((resolve) => {
        finish = resolve;
      }),
  );
  const sessionId = (await s.service.newChat()).selectedSessionId!;
  const active = await s.service.send({
    sessionId,
    prompt: "等待",
    source: "fixture",
    at,
  });
  const turnId = active.sessions[0].turns[0].id;
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await expect(
    s.service.cancel({ sessionId, turnId: "unrelated" }),
  ).rejects.toMatchObject({ code: "CHAT_TURN_MISMATCH" });
  await s.service.cancel({ sessionId, turnId });
  finish(result("fixture"));
  await vi.waitFor(() => expect(s.planner.snapshot().status).toBe("cancelled"));
  expect(
    (await s.service.snapshot()).sessions[0].turns[0].planner.result,
  ).toBeUndefined();
});
it("restores completed history but marks active turns interrupted without replaying the model", async () => {
  const s = setup();
  const { complete } = await send(s, "已有记录", "fixture");
  const stored = structuredClone(complete);
  stored.sessions[0].turns[0].planner.status = "running";
  delete stored.sessions[0].turns[0].planner.result;
  const fresh = setup();
  const restored = new ChatService({
    planner: fresh.planner,
    save: fresh.save,
    load: async () => stored,
  });
  const view = await restored.snapshot();
  expect(view.sessions[0].turns[0].planner).toMatchObject({
    status: "cancelled",
    error: { code: "CHAT_INTERRUPTED" },
  });
  expect(fresh.run).not.toHaveBeenCalled();
  expect(fresh.save).toHaveBeenCalled();
});
it("revalidates live execution eligibility while keeping completed conversation history", async () => {
  let fingerprint = "first";
  const planner = new PlannerService({
    find: async () => "test",
    readConfigured: async () => ({
      fingerprint,
      snapshot: { ...createFixtureSnapshot(), source: "configured" },
    }),
    run: async () => result("configured"),
  });
  const service = new ChatService({ planner, save: async () => {} });
  const sessionId = (await service.newChat()).selectedSessionId!;
  await service.send({
    sessionId,
    prompt: "配置查询",
    source: "configured",
    at,
  });
  await vi.waitFor(() => expect(planner.snapshot().status).toBe("completed"));
  await service.snapshot();
  fingerprint = "changed";
  expect((await service.snapshot()).sessions[0].turns[0].planner).toMatchObject(
    { status: "completed", result: { modelText: "当前任务未运行" } },
  );
  expect(planner.snapshot()).toMatchObject({
    status: "failed",
    result: undefined,
    error: { code: "CONFIGURATION_CHANGED" },
  });
});
it("does not call the planner after persistence fails and blocks further writes", async () => {
  const s = setup();
  const sessionId = (await s.service.newChat()).selectedSessionId!;
  s.save.mockRejectedValueOnce(Error("disk full"));
  await expect(
    s.service.send({ sessionId, prompt: "不能丢失", source: "fixture", at }),
  ).rejects.toMatchObject({ code: "CHAT_STORE_UNAVAILABLE" });
  expect(s.run).not.toHaveBeenCalled();
  expect((await s.service.snapshot()).error).toContain("会话");
  await expect(s.service.newChat()).rejects.toMatchObject({
    code: "CHAT_STORE_UNAVAILABLE",
  });
});
it("rechecks admission after durable writes so a concurrent model configuration operation prevents sending", async () => {
  const s = setup();
  let available = true;
  const save = vi.fn(async (_view: ChatView) => {});
  const service = new ChatService({
    planner: s.planner,
    save,
    available: () => available,
  });
  const sessionId = (await service.snapshot()).selectedSessionId!;
  save.mockImplementationOnce(async () => {
    available = false;
  });
  await expect(
    service.send({ sessionId, prompt: "并发检查", source: "fixture", at }),
  ).rejects.toMatchObject({ code: "CHAT_BUSY" });
  expect(s.run).not.toHaveBeenCalled();
  expect((await service.snapshot()).sessions[0].turns[0].planner.status).toBe(
    "failed",
  );
});
it("preserves malformed storage and refuses mutation without using model or overwriting it", async () => {
  const s = setup();
  const save = vi.fn(async (_view: ChatView) => {});
  const service = new ChatService({
    planner: s.planner,
    save,
    load: async () => ({ revision: 1, sessions: [{}] }) as ChatView,
  });
  expect((await service.snapshot()).error).toContain("会话");
  await expect(service.newChat()).rejects.toMatchObject({
    code: "CHAT_STORE_UNAVAILABLE",
  });
  expect(save).not.toHaveBeenCalled();
  expect(s.run).not.toHaveBeenCalled();
});
it("rejects corrupt nested result containers before rendering historical records", async () => {
  const s = setup();
  const { complete } = await send(s, "历史记录", "fixture");
  const stored = structuredClone(complete);
  stored.sessions[0].turns[0].planner.result!.records = [
    { requestId: "old-request", tasks: "not-an-array" },
  ] as unknown as NonNullable<PlannerResult["records"]>;
  const save = vi.fn(async (_view: ChatView) => {});
  const restored = new ChatService({
    planner: s.planner,
    save,
    load: async () => stored,
  });
  expect((await restored.snapshot()).error).toContain("会话");
  expect(save).not.toHaveBeenCalled();
});
it.each(["laneId", "gameDay", "finishedGameDay"])(
  "rejects a corrupt optional historical %s before rendering",
  async (field) => {
    const s = setup();
    const { complete } = await send(s, "历史记录", "fixture");
    const stored = structuredClone(complete);
    const record: NonNullable<PlannerResult["records"]>[number] = {
      requestId: "old-request",
      laneId: "lane-a",
      requestSource: "daily",
      recordedStatus: "succeeded",
      recordedConclusion: "recorded-plan-complete",
      complete: true,
      inGameCompletion: "not-verified",
      warnings: [],
      notes: [],
      tasks: [
        {
          runId: "run-id",
          gameId: "arknights",
          mode: "live",
          status: "succeeded",
          steps: [],
        },
      ],
    };
    if (field === "laneId")
      (record as unknown as Record<string, unknown>)[field] = { corrupt: true };
    else
      (record.tasks[0] as unknown as Record<string, unknown>)[field] = {
        corrupt: true,
      };
    stored.sessions[0].turns[0].planner.result!.records = [record];
    const save = vi.fn(async (_view: ChatView) => {});
    const restored = new ChatService({
      planner: s.planner,
      save,
      load: async () => stored,
    });
    expect((await restored.snapshot()).error).toContain("会话");
    expect(save).not.toHaveBeenCalled();
  },
);
it("rejects corrupt draft reason values and malformed historical evidence assessment", async () => {
  const s = setup();
  const { complete } = await send(s, "历史草稿", "fixture");
  const stored = structuredClone(complete);
  stored.sessions[0].turns[0].planner.result!.draft = {
    status: "valid",
    canExecute: false,
    catalogRevision: "a",
    environmentRevision: "b",
    at,
    planHash: "a".repeat(64),
    lanes: [],
    reasons: [{}],
    preconditions: [],
  } as unknown as NonNullable<PlannerResult["draft"]>;
  const save = vi.fn(async (_view: ChatView) => {});
  const restored = new ChatService({
    planner: s.planner,
    save,
    load: async () => stored,
  });
  expect((await restored.snapshot()).error).toContain("会话");
  expect(save).not.toHaveBeenCalled();
  const assessmentStored = structuredClone(complete);
  assessmentStored.sessions[0].turns[0].planner.result!.historyAssessment = {
    dailyCompletion: "complete",
  } as unknown as NonNullable<PlannerResult["historyAssessment"]>;
  const malformedAssessment = new ChatService({
    planner: s.planner,
    save,
    load: async () => assessmentStored,
  });
  expect((await malformedAssessment.snapshot()).error).toContain("会话");
});
it("selecting a historical session does not replace live planner ownership", async () => {
  const s = setup();
  const old = await send(s, "旧会话", "fixture");
  const newerId = (await s.service.newChat()).selectedSessionId!;
  await s.service.send({
    sessionId: newerId,
    prompt: "新请求",
    source: "fixture",
    at,
  });
  const liveId = s.planner.snapshot().requestId;
  await s.service.select(old.sessionId);
  expect(s.planner.snapshot().requestId).toBe(liveId);
  expect((await s.service.snapshot()).selectedSessionId).toBe(old.sessionId);
});
it("rejects unknown fields and invalid input without model calls", async () => {
  const s = setup();
  const sessionId = (await s.service.newChat()).selectedSessionId!;
  await expect(
    s.service.send({
      sessionId,
      prompt: "bad",
      source: "fixture",
      at,
      execute: true,
    }),
  ).rejects.toThrow();
  await expect(
    s.service.send({ sessionId, prompt: " ", source: "fixture", at }),
  ).rejects.toThrow();
  await expect(
    s.service.send({
      sessionId: "other",
      prompt: "bad",
      source: "fixture",
      at,
    }),
  ).rejects.toMatchObject({ code: "CHAT_SESSION_MISMATCH" });
  expect(s.run).not.toHaveBeenCalled();
});
