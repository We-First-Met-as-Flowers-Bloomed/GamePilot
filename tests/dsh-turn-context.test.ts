import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDshTurnContext,
  DSH_GOAL_CONTEXT_MAX_BYTES,
} from "../apps/desktop/main/dsh-turn-context";
import type { GoalRun, GoalScope } from "../packages/protocol/agent-goal";
import { gameMessageAuthority } from "../packages/agent/game-message-authority";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { planWithDsh } from "../packages/agent/dsh-planner";
import { createGameGoalTools } from "../packages/agent/game-tools";

const at = "2026-10-09T12:00:00.000Z";
const principal = {
  sessionId: "chat-original",
  turnId: "turn-current",
  prompt: "只检查原目标的状态，不启动任务",
};
const scopes: GoalScope[] = [
  {
    laneId: "account-a",
    gameId: "onmyoji",
    skillIds: ["login", "mail"],
    resources: { premium: 0 },
  },
];
function goal(overrides: Partial<GoalRun> = {}): GoalRun {
  return {
    version: 1,
    id: "goal-original",
    revision: 3,
    sessionId: principal.sessionId,
    turnId: "turn-old",
    prompt: "现在运行账号一阴阳师登录和邮件，不消费付费资源",
    selection: { kind: "saved-daily", laneIds: ["account-a"] },
    grant: {
      id: "grant-old",
      source: "user-message",
      sessionId: principal.sessionId,
      turnId: "turn-old",
      issuedAt: at,
      expiresAt: at,
      maxRetries: 0,
      scopes,
    },
    createdAt: at,
    updatedAt: at,
    status: "unknown",
    message: "设备已停止，业务结果未知",
    submission: {
      batchId: "batch-original",
      requestIds: ["request-original"],
      attempt: 1,
      acceptedAt: at,
      state: "unknown",
    },
    receipt: {
      batchId: "batch-original",
      requestIds: ["request-original"],
    },
    attempts: [],
    retryCount: 0,
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
    ...overrides,
  };
}
const input = (goals: GoalRun[] = []) => ({
  prompt: "有界历史。当前用户：" + principal.prompt,
  principal,
  requestId: "planner-request-current",
  goals,
});
function facts(prompt: string) {
  return JSON.parse(
    prompt.slice(
      prompt.indexOf("\n宿主本会话目标事实：") +
        "\n宿主本会话目标事实：".length,
    ),
  );
}

it("isolates two App turns while retaining a stable SDK-compatible key within one turn", () => {
  const first = createDshTurnContext(input());
  const same = createDshTurnContext({
    ...input(),
    requestId: "another-request",
  });
  const next = createDshTurnContext({
    ...input(),
    principal: { ...principal, turnId: "turn-next" },
  });
  expect(first.sessionId).toMatch(/^[a-zA-Z0-9_-]{1,120}$/);
  expect(first.sessionId).toBe(same.sessionId);
  expect(first.sessionId).not.toBe(next.sessionId);
  expect(first.sessionId).not.toBe(`chat-${principal.sessionId}`);
  expect(first.resume).toBe(true);
});

it("does not collide at concatenation boundaries or across chat sessions", () => {
  const key = (sessionId: string, turnId: string) =>
    createDshTurnContext({
      ...input(),
      principal: { ...principal, sessionId, turnId },
    }).sessionId;
  expect(key("a-b", "c")).not.toBe(key("a", "b-c"));
  expect(key("chat-a", "turn-1")).not.toBe(key("chat-b", "turn-1"));
});

it("retains standalone planner behavior and ignores foreign goals without a principal", () => {
  expect(
    createDshTurnContext({
      prompt: "检查状态",
      requestId: "request-1",
      goals: [goal()],
    }),
  ).toEqual({
    prompt: "检查状态",
    currentMessage: "检查状态",
    sessionId: "planner-request-1",
    resume: false,
  });
});

it("keeps original intent, exact scope and uncertain receipts as facts without changing current authority", () => {
  const original = goal();
  const saved = structuredClone(original);
  const result = createDshTurnContext(input([original]));
  const context = facts(result.prompt);
  expect(result.currentMessage).toBe(principal.prompt);
  expect(gameMessageAuthority(result.currentMessage).execute).toBe(false);
  expect(gameMessageAuthority(result.currentMessage).resume).toBe(false);
  expect(context.canAuthorizeExecution).toBe(false);
  expect(context.receiptsDoNotProveCompletion).toBe(true);
  expect(context.goals[0]).toMatchObject({
    id: original.id,
    prompt: original.prompt,
    originalScopes: scopes,
    submission: original.submission,
    receipt: original.receipt,
    status: "unknown",
    flowComplete: false,
    goalSatisfied: null,
  });
  expect(context.goals[0]).not.toHaveProperty("grant");
  expect(original).toEqual(saved);
});

it("projects the original accepted scope rather than a later narrowed continuation or grant", () => {
  const review = {
    id: "review-original",
    fingerprint: "fingerprint-original",
    reviewedAt: at,
    expiresAt: at,
    frozenPlan: { kind: "saved-daily" as const, hash: "hash-original" },
    scopes,
    summary: [],
  };
  const original = goal({
    originalReview: review,
    review: { ...review, scopes: [{ ...scopes[0], skillIds: ["mail"] }] },
  });
  expect(
    facts(createDshTurnContext(input([original])).prompt).goals[0]
      .originalScopes,
  ).toEqual(scopes);
});

it("never projects another chat's goal or private receipt", () => {
  const result = createDshTurnContext(
    input([goal({ sessionId: "another-chat", id: "private-goal" })]),
  );
  expect(result.prompt).toBe(input().prompt);
  expect(result.prompt).not.toContain("private-goal");
});

it("bounds UTF-8 goal facts and marks oversized details for read_goal without truncating a restriction", () => {
  const huge = goal({ prompt: "限制".repeat(10000) + "最后限制不得消费" });
  const result = createDshTurnContext(input([huge]));
  const suffix = result.prompt.slice(input().prompt.length);
  expect(Buffer.byteLength(suffix, "utf8")).toBeLessThanOrEqual(
    DSH_GOAL_CONTEXT_MAX_BYTES,
  );
  const projected = facts(result.prompt).goals[0];
  expect(projected).toMatchObject({
    id: huge.id,
    status: "unknown",
    details: "read_goal",
  });
  expect(projected).not.toHaveProperty("prompt");
  expect(projected).not.toHaveProperty("originalScopes");
  expect(facts(result.prompt).requiresReadGoal).toBe(true);
});

it("prioritizes an explicitly referenced target and unresolved goals over old completions", () => {
  const goals = Array.from({ length: 256 }, (_, i) =>
    goal({
      id: `old-${i}`,
      status: "completed",
      message: "较长旧结果".repeat(80),
    }),
  );
  goals.push(goal({ id: "active-goal", status: "running" }));
  const result = createDshTurnContext({
    ...input(goals),
    principal: { ...principal, prompt: "只检查 old-12 的状态" },
  });
  const context = facts(result.prompt);
  expect(context.goals[0].id).toBe("old-12");
  expect(
    context.goals.some((g: { id: string }) => g.id === "active-goal"),
  ).toBe(true);
  expect(context.omittedGoalCount).toBeGreaterThan(0);
  expect(
    Buffer.byteLength(result.prompt.slice(input().prompt.length), "utf8"),
  ).toBeLessThanOrEqual(DSH_GOAL_CONTEXT_MAX_BYTES);
});

it("retains the same inference key for the existing in-turn followup without granting historical execution", async () => {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  const execution = "现在运行两个账号明日方舟登录任务，仅login，不购物";
  const binding = {
    specs: [
      { name: "run_saved_daily", description: "saved daily", inputSchema: {} },
    ],
    call: vi.fn(),
    compiled() {},
    goalIds: () => [],
  };
  const keys: string[] = [];
  const resumes: (boolean | undefined)[] = [];
  const run: NonNullable<Parameters<typeof planWithDsh>[1]["run"]> = async (
    options,
  ) => {
    keys.push(options.sessionId!);
    resumes.push(options.resume);
    return {
      sessionId: options.sessionId!,
      model: "offline",
      finalText: "尚未提交任务。",
      events: [],
    };
  };
  const context = createDshTurnContext({
    ...input([goal()]),
    principal: { ...principal, prompt: execution },
  });
  await planWithDsh(createAgentTools(snapshot), {
    ...context,
    connection: {
      baseUrl: "https://offline.invalid",
      model: "offline",
      apiKey: "unused",
    },
    at,
    binding,
    run,
  });
  expect(keys).toEqual([context.sessionId, context.sessionId]);
  expect(resumes).toEqual([true, true]);
  keys.length = 0;
  await planWithDsh(createAgentTools(snapshot), {
    ...createDshTurnContext(input([goal()])),
    connection: {
      baseUrl: "https://offline.invalid",
      model: "offline",
      apiKey: "unused",
    },
    at,
    binding,
    run,
  });
  expect(keys).toHaveLength(1);
  expect(binding.call).not.toHaveBeenCalled();
});

it("denies execution and resume attempts using historical scopes and receipts under the unchanged host binding", async () => {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  const effects = vi.fn(async () => ({ id: "unexpected-new-goal" }));
  const binding = createGameGoalTools({
    principal,
    source: "recorded",
    host: {
      assertCurrent: async () => {},
      runSaved: effects,
      runPlan: effects,
      resume: effects,
      cancel: effects,
      read: async () => goal(),
      wait: async () => goal(),
      preferences: effects,
    },
  });
  await planWithDsh(createAgentTools(snapshot), {
    ...createDshTurnContext(input([goal()])),
    connection: {
      baseUrl: "https://offline.invalid",
      model: "offline",
      apiKey: "unused",
    },
    at,
    binding,
    run: async (options) => {
      expect(options.prompt).toContain("request-original");
      expect(options.prompt).toContain("不消费付费资源");
      for (const [name, args] of [
        ["run_saved_daily", { scope: "saved" }],
        ["resume_goal", { goalId: "goal-original" }],
      ] as const) {
        expect(
          await options.callTool(name, args, {
            callId: name,
            signal: new AbortController().signal,
          }),
        ).toMatchObject({ error: { code: "MESSAGE_NOT_AUTHORIZED" } });
      }
      return {
        sessionId: options.sessionId!,
        model: "offline",
        finalText: "旧回执不授权本轮运行。",
        events: [],
      };
    },
  });
  expect(effects).not.toHaveBeenCalled();
  expect(binding.goalIds()).toEqual([]);
});

it("wires the actual host callback to per-turn context while preserving the host principal and binding", async () => {
  // Exercise the registration closure without importing Electron or starting App.
  const source = readFileSync(
    new URL("../apps/desktop/main/index.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("runtimeRun: async (");
  const end = source.indexOf(",\n        modelConnection:", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const callback = source.slice(start + "runtimeRun: ".length, end);
  const bind = vi.fn(() => ({ marker: "unchanged-host-binding" }));
  const snapshots = vi.fn(() => ({ goals: [goal()] }));
  const planned = vi.fn(
    async (
      _tools: unknown,
      options: ReturnType<typeof createDshTurnContext> & { binding: unknown },
    ) => options,
  );
  const runtimeRun = new Function(
    "goalRuntime",
    "goals",
    "planWithDsh",
    "createAgentTools",
    "createDshTurnContext",
    "app",
    "join",
    `return (${callback});`,
  )(
    { bind },
    { snapshot: snapshots },
    planned,
    (snapshot: unknown) => snapshot,
    createDshTurnContext,
    {
      isPackaged: false,
      getAppPath: () => "/offline",
      getPath: () => "/offline",
    },
    join,
  );
  const argumentsFor = (turnId: string) => ({
    snapshot: { source: "recorded" },
    principal: { ...principal, turnId },
    requestId: "planner-request",
    prompt: input().prompt,
  });
  const first = await runtimeRun(argumentsFor("turn-one"));
  const second = await runtimeRun(argumentsFor("turn-two"));
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(first.currentMessage).toBe(principal.prompt);
  expect(facts(first.prompt).goals[0].receipt).toEqual(goal().receipt);
  expect(first.binding).toBe(bind.mock.results[0].value);
  expect(bind).toHaveBeenNthCalledWith(
    1,
    argumentsFor("turn-one").principal,
    "planner-request",
    "recorded",
  );
  expect(snapshots).toHaveBeenCalledWith(principal.sessionId);
});
