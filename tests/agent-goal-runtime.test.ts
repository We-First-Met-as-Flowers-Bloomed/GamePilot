import { expect, it, vi } from "vitest";
import {
  GoalService,
  type PreparedGoal,
} from "../apps/desktop/main/agent-goals";
import { createGoalRuntime } from "../apps/desktop/main/agent-goal-runtime";
import type { GoalStore } from "../packages/protocol/agent-goal";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { prepareAgentGame } from "../games/agent-execution";
import type { LaneExecutionSnapshot } from "../apps/desktop/main/lane-snapshot";
const at = new Date("2026-10-05T06:00:00.000Z");
function setup(prompt = "运行保存的日常", clock = at, locallyConfirmed = true) {
  let store: GoalStore | undefined;
  const prepared: PreparedGoal = {
    fingerprint: "frozen",
    summary: [],
    payload: {},
    scopes: [],
    frozenPlan: { kind: "saved-daily", hash: "frozen" },
  };
  const setPlan = (
    gameId = "arknights",
    skillIds = ["login", "infrastructure", "friends", "award"],
    parameters: Record<string, unknown> = {},
  ) => {
    const fixture = createFixtureSnapshot(),
      lane = fixture.lanes!.lanes[0],
      profile = fixture.profiles!.profiles[0];
    const tools = createAgentTools(fixture);
    const draft = tools.call("compile_plan", {
      catalogRevision: tools.call("list_capabilities").revision,
      environmentRevision: tools.call("get_environment").revision,
      at: clock.toISOString(),
      lanes: [{ laneId: lane.id, games: [{ gameId, skillIds, parameters }] }],
    });
    expect(draft.status).toBe("valid");
    const frozen = prepareAgentGame(
      draft.lanes[0].games[0],
      lane,
      profile,
      clock.toISOString(),
    );
    const snapshot: LaneExecutionSnapshot = {
      lane,
      startedAt: clock.toISOString(),
      ...(gameId === "arknights"
        ? { arknightsPlan: frozen.plan, profile: frozen.profile }
        : { onmyojiPlan: frozen.plan }),
    };
    const excluded = draft.lanes[0].games[0].excluded;
    if (excluded.length)
      snapshot.exclusions = [
        {
          gameId,
          skillIds: excluded,
          skipReason: "not-open",
          evidenceTimestamp: clock.toISOString(),
          evidenceReference: `${gameId}:compiled-calendar-exclusion`,
        },
      ];
    prepared.scopes = [
      {
        laneId: lane.id,
        gameId,
        skillIds: [...frozen.plan.skillIds],
        resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
      },
    ];
    prepared.payload = { snapshots: [snapshot] };
    prepared.fingerprint = draft.planHash!;
    prepared.frozenPlan = {
      kind: "custom",
      hash: draft.planHash!,
      plannerRequestId: "planner-a",
    };
    return { draft, snapshot };
  };
  setPlan();
  prepared.frozenPlan.kind = "saved-daily";
  const submit = vi.fn(async (goal) => {
    expect(store?.goals[0].submission?.batchId).toBe(goal.submission.batchId);
    return goal.submission;
  });
  const goals = new GoalService({
    now: () => clock,
    save: async (value) => {
      store = structuredClone(value);
    },
    prepare: (goal) => runtime.prepare(goal),
    submit,
    observe: async () => ({
      requests: [],
      flowComplete: false,
      goalSatisfied: null,
      summary: "waiting",
    }),
    stop: async () => ({
      requests: [],
      flowComplete: false,
      goalSatisfied: null,
      summary: "unknown",
    }),
  });
  const assertCurrent = vi.fn(async () => {});
  const runtime = createGoalRuntime({
    goals,
    now: () => clock,
    assertCurrent,
    ...(locallyConfirmed
      ? {
          authorizeExecution: async () => ({
            confirmationId: "local-review-a",
            fingerprint: prepared.fingerprint,
            scopes: structuredClone(prepared.scopes),
            expiresAt: new Date(clock.getTime() + 600000).toISOString(),
            maxRetries: 2 as const,
          }),
        }
      : {}),
    prepareSaved: async () => structuredClone(prepared),
    prepareDraft: async () => prepared,
    prepareContinuation: async (_principal, reference) => {
      if (
        reference &&
        reference.parentRequestId !== prepared.frozenPlan.parentRequestId
      )
        throw Error("parent changed");
      return prepared;
    },
    preferences: async () => ({ saved: true }),
  });
  const principal = { sessionId: "session-a", turnId: "turn-a", prompt };
  const binding = runtime.bind(principal, "planner-a", "recorded");
  const context = { callId: "call-a", signal: new AbortController().signal };
  return {
    prepared,
    goals,
    runtime,
    submit,
    binding,
    principal,
    context,
    assertCurrent,
    setPlan,
  };
}
it("language recognition and model-supplied principal fields cannot grant a new execution", async () => {
  const x = setup("现在立即运行所有账号的保存日常", at, false);
  await expect(
    x.binding.call("run_saved_daily", { scope: "saved" }, x.context),
  ).rejects.toMatchObject({ code: "LOCAL_CONFIRMATION_REQUIRED" });
  expect(x.submit).not.toHaveBeenCalled();
  expect(x.goals.snapshot().goals).toHaveLength(0);
});
it("creates a continuation Goal from current resume authority and reserves its exact external parent", async () => {
  const x = setup("更新好了，继续刚才的日常");
  x.prepared.frozenPlan = {
    kind: "continuation",
    hash: "a".repeat(64),
    parentRequestId: "scheduled:lane-a",
  };
  x.prepared.fingerprint = "a".repeat(64);
  x.prepared.payload = {
    ...(x.prepared.payload as object),
    continuation: {
      parentId: "scheduled:lane-a",
      fingerprint: "a".repeat(64),
      selections: [
        {
          gameId: "arknights",
          skillIds: ["infrastructure", "friends", "award"],
        },
      ],
      acknowledgePartial: false,
    },
  };
  const result = (await x.binding.call("resume_daily", {}, x.context)) as {
    id: string;
  };
  const goal = x.goals.get(result.id, x.principal);
  expect(goal.selection).toMatchObject({
    kind: "continuation",
    parentRequestId: "scheduled:lane-a",
    parentFingerprint: "a".repeat(64),
  });
  expect(goal.submission).toMatchObject({
    attempt: 0,
    state: "received",
    parentRequestId: "scheduled:lane-a",
  });
  expect(goal.grant.turnId).toBe(x.principal.turnId);
  expect(goal.retryCount).toBe(0);
  expect(x.submit).toHaveBeenCalledTimes(1);
});

it("persists an exact current-message grant before admission and deduplicates two deliveries", async () => {
  const x = setup();
  const [a, b] = (await Promise.all([
    x.binding.call("run_saved_daily", { scope: "saved" }, x.context),
    x.binding.call("run_saved_daily", { scope: "saved" }, x.context),
  ])) as { id: string }[];
  expect(a.id).toBe(b.id);
  expect(x.submit).toHaveBeenCalledTimes(1);
  const goal = x.goals.get(a.id, x.principal);
  expect(goal.grant.maxRetries).toBe(2);
  expect(goal.grant.scopes[0].resources).toEqual({
    medicine: 0,
    stone: 0,
    expiringMedicine: 0,
  });
});
it("a model cannot broaden a mail-only request into a saved full daily", async () => {
  const x = setup("给账号一领取明日方舟邮件");
  await expect(
    x.binding.call("run_saved_daily", { scope: "saved" }, x.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(x.submit).not.toHaveBeenCalled();
  expect(x.goals.snapshot().goals).toHaveLength(0);
});
it("a model cannot add another game or positive resource limits to the host message", async () => {
  const x = setup("运行明日方舟日常");
  x.prepared.scopes.push({ ...x.prepared.scopes[0], gameId: "onmyoji" });
  await expect(
    x.binding.call("run_saved_daily", { scope: "saved" }, x.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  x.prepared.scopes.pop();
  x.prepared.scopes[0].resources.medicine = 1;
  await expect(
    x.binding.call(
      "run_saved_daily",
      { scope: "saved" },
      { ...x.context, callId: "call-b" },
    ),
  ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  expect(x.submit).not.toHaveBeenCalled();
});
it("lost preparation on restart observes a reserved request without replaying a game", async () => {
  const x = setup();
  const goal = (await x.binding.call(
    "run_saved_daily",
    { scope: "saved" },
    x.context,
  )) as { id: string };
  const restarted = createGoalRuntime({
    goals: x.goals,
    assertCurrent: async () => {},
    prepareSaved: async () => x.prepared,
    prepareDraft: async () => x.prepared,
    preferences: async () => ({}),
  });
  await expect(
    restarted.prepare(x.goals.get(goal.id, x.principal)),
  ).rejects.toMatchObject({ code: "GOAL_PREPARATION_LOST" });
  expect(x.submit).toHaveBeenCalledTimes(1);
});

it("rejects shopping carried by a compiled daily friends request when the user forbids it", async () => {
  const x = setup("现在运行明日方舟每日任务，不购物");
  const { draft } = x.setPlan("arknights", ["login", "friends"], {
    creditShopping: true,
  });
  x.binding.compiled(draft);
  await expect(
    x.binding.call("run_plan", { planHash: draft.planHash }, x.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(x.submit).not.toHaveBeenCalled();
});

it("accepts compiled free credit collection with shopping explicitly disabled", async () => {
  const x = setup("给账号一收取明日方舟信用，不购物");
  const { draft, snapshot } = x.setPlan("arknights", ["login", "friends"], {
    creditShopping: false,
  });
  expect(snapshot.profile?.creditShopping).toBe(false);
  x.binding.compiled(draft);
  await x.binding.call("run_plan", { planHash: draft.planHash }, x.context);
  expect(x.submit).toHaveBeenCalledTimes(1);
});

it.each([
  ["给账号一运行明日方舟基建", "arknights", "infrastructure"],
  ["给账号一领取阴阳师花合战奖励", "onmyoji", "hana-claim"],
  ["给账号一领取阴阳师邮件", "onmyoji", "mail"],
])("accepts the registered skill for %s", async (prompt, gameId, skillId) => {
  const x = setup(prompt);
  const { draft } = x.setPlan(gameId, ["login", skillId]);
  x.binding.compiled(draft);
  await x.binding.call("run_plan", { planHash: draft.planHash }, x.context);
  expect(x.submit).toHaveBeenCalledTimes(1);
});

it("accepts compiled Arknights mail-only award flags and rejects bundled task awards", async () => {
  const x = setup("只给账号一领取明日方舟邮件");
  const { draft, snapshot } = x.setPlan("arknights", ["login", "award"], {
    mail: true,
    taskAward: false,
    freeRecruit: false,
    eventOrundum: false,
    eventMining: false,
    specialAccess: false,
    signInEvent: false,
  });
  expect(snapshot.profile).toMatchObject({ mail: true, taskAward: false });
  x.binding.compiled(draft);
  await x.binding.call("run_plan", { planHash: draft.planHash }, x.context);
  expect(x.submit).toHaveBeenCalledTimes(1);
  const y = setup("只给账号一领取明日方舟邮件");
  const full = y.setPlan("arknights", ["login", "award"], {
    mail: true,
    taskAward: true,
  });
  y.binding.compiled(full.draft);
  await expect(
    y.binding.call("run_plan", { planHash: full.draft.planHash }, y.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(y.submit).not.toHaveBeenCalled();
});

it.each([
  "freeRecruit",
  "eventOrundum",
  "eventMining",
  "specialAccess",
  "signInEvent",
])("rejects unrequested %s in frozen mail-only settings", async (flag) => {
  const x = setup("只给账号一领取明日方舟邮件");
  const { draft, snapshot } = x.setPlan("arknights", ["login", "award"], {
    mail: true,
    taskAward: false,
  });
  (snapshot.profile as unknown as Record<string, unknown>)[flag] = true;
  x.binding.compiled(draft);
  await expect(
    x.binding.call("run_plan", { planHash: draft.planHash }, x.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(x.submit).not.toHaveBeenCalled();
});

it("rejects unrequested collective tasks in a compiled Onmyoji mail selection", async () => {
  const x = setup("只给账号一领取阴阳师邮件");
  const { draft } = x.setPlan("onmyoji", ["login", "mail", "guild-quest"]);
  x.binding.compiled(draft);
  await expect(
    x.binding.call("run_plan", { planHash: draft.planHash }, x.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(x.submit).not.toHaveBeenCalled();
});

it("cannot newly enable collective resource spending through a custom daily request", async () => {
  const x = setup("运行阴阳师每日任务");
  const { draft } = x.setPlan("onmyoji", ["login", "mail", "guild-quest"]);
  x.binding.compiled(draft);
  await expect(
    x.binding.call("run_plan", { planHash: draft.planHash }, x.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(x.submit).not.toHaveBeenCalled();
});

it("preserves an already configured legacy collective task in a saved routine", async () => {
  const x = setup("运行阴阳师保存的日常");
  x.setPlan("onmyoji", ["login", "mail", "guild-quest"]);
  x.prepared.frozenPlan = { kind: "saved-daily", hash: x.prepared.fingerprint };
  await x.binding.call("run_saved_daily", { scope: "saved" }, x.context);
  expect(x.submit).toHaveBeenCalledTimes(1);
});

it("rejects a mail-only frozen plan whose mail action was disabled", async () => {
  const x = setup("只给账号一领取明日方舟邮件");
  const { draft } = x.setPlan("arknights", ["login", "award"], {
    mail: false,
    taskAward: false,
  });
  x.binding.compiled(draft);
  await expect(
    x.binding.call("run_plan", { planHash: draft.planHash }, x.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(x.submit).not.toHaveBeenCalled();
});

it.each(["只给第二个账号领取阴阳师邮件日常", "仅给暮雨运行阴阳师邮件日常"])(
  "does not expand a bounded mail objective just because %s also says daily",
  async (prompt) => {
    const x = setup(prompt);
    const { draft } = x.setPlan("onmyoji", ["login", "mail", "hana-claim"]);
    x.binding.compiled(draft);
    await expect(
      x.binding.call("run_plan", { planHash: draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
    expect(x.submit).not.toHaveBeenCalled();
  },
);

it.each([
  ["只给账号一领取明日方舟邮件", "arknights"],
  ["只给账号一领取阴阳师邮件", "onmyoji"],
  ["只运行明日方舟基建", "arknights"],
  ["只领取阴阳师花合战奖励", "onmyoji"],
])(
  "requires the requested single objective instead of accepting login-only for %s",
  async (prompt, gameId) => {
    const x = setup(prompt),
      { draft } = x.setPlan(gameId, ["login"]);
    x.binding.compiled(draft);
    await expect(
      x.binding.call("run_plan", { planHash: draft.planHash }, x.context),
    ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
    expect(x.submit).not.toHaveBeenCalled();
  },
);

it("preserves a genuine compiler not-open exclusion rather than claiming a requested Kirin task ran", async () => {
  const x = setup("只给账号一运行阴阳师麒麟", new Date("2026-10-04T06:00:00Z")),
    { draft, snapshot } = x.setPlan("onmyoji", ["login", "guild-kirin"]);
  expect(draft.lanes[0].games[0].excluded).toEqual(["guild-kirin"]);
  expect(snapshot.onmyojiPlan?.skillIds).toEqual(["login"]);
  x.binding.compiled(draft);
  await x.binding.call("run_plan", { planHash: draft.planHash }, x.context);
  expect(x.submit).toHaveBeenCalledTimes(1);
});

it.each([
  ["只给账号一领取阴阳师邮件，跳过花合战", "onmyoji", "mail", "hana-claim"],
  ["只给账号一领取阴阳师邮件，不要签到", "onmyoji", "mail", "check-in"],
  ["运行阴阳师日常，花合战不要做", "onmyoji", "mail", "hana-claim"],
  ["运行阴阳师日常并领取花合战，但跳过花合战", "onmyoji", "mail", "hana-claim"],
  [
    "只给账号一领取明日方舟邮件，不要基建",
    "arknights",
    "award",
    "infrastructure",
  ],
])(
  "accepts only positive tasks and rejects the denied task in %s",
  async (prompt, gameId, wanted, denied) => {
    const parameters =
      gameId === "arknights" ? { mail: true, taskAward: false } : {};
    const x = setup(prompt),
      good = x.setPlan(gameId, ["login", wanted], parameters);
    x.binding.compiled(good.draft);
    await x.binding.call(
      "run_plan",
      { planHash: good.draft.planHash },
      x.context,
    );
    expect(x.submit).toHaveBeenCalledTimes(1);
    const y = setup(prompt),
      bad = y.setPlan(gameId, ["login", wanted, denied], parameters);
    y.binding.compiled(bad.draft);
    await expect(
      y.binding.call("run_plan", { planHash: bad.draft.planHash }, y.context),
    ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
    expect(y.submit).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "只领取明日方舟邮件，不要任务奖励",
    "taskAward",
    { mail: true, taskAward: false },
  ],
  [
    "只领取明日方舟任务奖励，不要邮件",
    "mail",
    { mail: false, taskAward: true },
  ],
  [
    "运行明日方舟日常，不要任务奖励",
    "taskAward",
    { mail: true, taskAward: false },
  ],
  ["运行明日方舟日常，不要邮件", "mail", { mail: false, taskAward: true }],
])(
  "honors native award flag denial for %s",
  async (prompt, denied, parameters) => {
    const x = setup(prompt),
      good = x.setPlan("arknights", ["login", "award"], parameters);
    x.binding.compiled(good.draft);
    await x.binding.call(
      "run_plan",
      { planHash: good.draft.planHash },
      x.context,
    );
    expect(x.submit).toHaveBeenCalledTimes(1);
    const y = setup(prompt),
      bad = y.setPlan("arknights", ["login", "award"], {
        ...parameters,
        [denied]: true,
      });
    y.binding.compiled(bad.draft);
    await expect(
      y.binding.call("run_plan", { planHash: bad.draft.planHash }, y.context),
    ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
    expect(y.submit).not.toHaveBeenCalled();
  },
);

it("keeps an explicit login request bounded despite the denied other daily tasks", async () => {
  const prompt =
    "现在只给账号一运行明日方舟登录及UID核验任务（仅login）。不运行其他日常、不领取邮件、不购物、不吃药、不用源石、不切换阴阳师";
  const x = setup(prompt),
    good = x.setPlan("arknights", ["login"]);
  x.binding.compiled(good.draft);
  await x.binding.call(
    "run_plan",
    { planHash: good.draft.planHash },
    x.context,
  );
  expect(x.submit).toHaveBeenCalledTimes(1);
  const y = setup(prompt),
    bad = y.setPlan("arknights", ["login", "infrastructure"]);
  y.binding.compiled(bad.draft);
  await expect(
    y.binding.call("run_plan", { planHash: bad.draft.planHash }, y.context),
  ).rejects.toMatchObject({ code: "GOAL_SCOPE_EXCEEDED" });
  expect(y.submit).not.toHaveBeenCalled();
});
