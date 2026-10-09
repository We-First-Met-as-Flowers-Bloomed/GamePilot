import { expect, it, vi } from "vitest";
import { GoalService } from "../apps/desktop/main/agent-goals";
import { createGoalRuntime } from "../apps/desktop/main/agent-goal-runtime";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import type { GoalRun, GoalObservation } from "../packages/protocol/agent-goal";

async function fixture(count = 1, mixedLogin = false) {
  let clock = new Date("2026-10-05T06:00:00.000Z");
  let siblingComplete = true;
  let siblingSkillEvidence = true;
  const lanes = createFixtureSnapshot().lanes!.lanes;
  lanes[0].id = "private-first";
  lanes[0].name = "晨星";
  lanes[1].id = "private-second";
  lanes[1].name = "暮雨";
  const scope = (index: number) => ({
    laneId: lanes[index].id,
    gameId: "onmyoji",
    skillIds: mixedLogin ? ["login"] : ["login", "mail"],
    resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
  });
  const observe = async (goal: GoalRun): Promise<GoalObservation> => {
    const original = goal.grant.scopes.at(-1)!;
    const requestId = goal.submission!.requestIds.at(-1)!;
    return {
      requests: [
        ...(mixedLogin
          ? [
              {
                requestId: goal.attempts[0].submission.requestIds[0],
                laneId: lanes[0].id,
                gameId: "onmyoji",
                status: siblingComplete
                  ? ("succeeded" as const)
                  : ("unknown" as const),
                flowComplete: siblingComplete,
                goalSatisfied: siblingComplete ? true : null,
                skills: siblingComplete && siblingSkillEvidence
                  ? [
                      {
                        skillId: "login",
                        status: "succeeded",
                        goalSatisfied: true,
                        evidenceTimestamp: clock.toISOString(),
                        evidenceReference: "host-verified-first-login",
                        summary: "账号一登录已确认",
                      },
                    ]
                  : [],
              },
            ]
          : []),
        {
          requestId,
          laneId: original.laneId,
          gameId: original.gameId,
          status: goal.submission!.attempt ? "running" : "failed",
          flowComplete: false,
          goalSatisfied: null,
          skills: [],
        },
      ],
      flowComplete: false,
      goalSatisfied: null,
      summary: "原失败请求具有宿主登记的未提交证明",
      ...(!goal.submission!.attempt
        ? {
            recovery: {
              ...original,
              requestId,
              reference: `registered:${requestId}`,
              safety: {
                kind: "native-not-submitted" as const,
                fingerprint: "proof",
                observedAt: clock.toISOString(),
                nativeSubmission: "not-submitted" as const,
                accountProof: "login-gate-before-effects" as const,
              },
            },
          }
        : {}),
    };
  };
  const submit = vi.fn(async (goal: GoalRun) => ({
    batchId: goal.submission!.batchId,
    requestIds: goal.submission!.requestIds,
  }));
  const stop = vi.fn(async (goal: GoalRun): Promise<GoalObservation> => ({
    requests: goal.attempts.flatMap((attempt) =>
      attempt.submission.requestIds.map((requestId) => ({
        requestId,
        laneId: goal.grant.scopes[0].laneId,
        gameId: "onmyoji",
        status: "cancelled" as const,
        flowComplete: true,
        goalSatisfied: null,
        skills: [],
      })),
    ),
    flowComplete: true,
    goalSatisfied: null,
    summary: "离线宿主确认停止",
    stopVerification: {
      verified: true,
      requestIds: goal.attempts.flatMap(
        (attempt) => attempt.submission.requestIds,
      ),
      observedAt: clock.toISOString(),
      evidenceReference: "offline-host:verified-worker-stop",
    },
  }));
  const goals = new GoalService({
    now: () => clock,
    save: async () => {},
    prepare: async (goal) => ({
      fingerprint: "original",
      frozenPlan: { kind: "saved-daily", hash: "original" },
      scopes: goal.grant.scopes,
      summary: [],
      payload: {},
    }),
    submit,
    observe,
    stop,
    recover: async (_goal, recovery) => ({
      fingerprint: "continuation",
      frozenPlan: {
        kind: "continuation",
        hash: "continuation",
        parentRequestId: recovery.requestId,
      },
      scopes: [recovery],
      summary: [],
      payload: {},
    }),
  });
  const originals: GoalRun[] = [];
  for (let index = 0; index < count; index++) {
    const owner = { sessionId: "session-a", turnId: `original-${index}` };
    const goal = await goals.create({
      ...owner,
      prompt: `给账号${index + 1}领取阴阳师邮件`,
      selection: { kind: "saved-daily" },
      grant: {
        id: `grant-${index}`,
        source: "user-message",
        ...owner,
        issuedAt: clock.toISOString(),
        expiresAt: "2026-10-05T12:00:00.000Z",
        maxRetries: 2,
        scopes: mixedLogin ? [scope(0), scope(1)] : [scope(index)],
      },
    });
    const submitted = await goals.submit(goal.id, owner);
    if (mixedLogin) await goals.refresh(goal.id);
    originals.push(mixedLogin ? goals.get(goal.id, owner) : submitted);
  }
  const runtime = createGoalRuntime({
    goals,
    now: () => clock,
    assertCurrent: async () => {},
    accountLanes: async () => lanes,
    inspect: async (goal) => ({ goalId: goal.id, observed: "offline-fixture" }),
    prepareSaved: async () => {
      throw Error("followup must not prepare a new saved routine");
    },
    prepareDraft: async () => {
      throw Error("followup must not compile or launch a new task");
    },
    preferences: async () => {
      throw Error("followup must not save preferences");
    },
  });
  const bind = (prompt: string) =>
    runtime.bind(
      { sessionId: "session-a", turnId: "current", prompt },
      "planner-current",
      "recorded",
    );
  const call = (prompt: string, name: string, goalId: string) =>
    bind(prompt).call(
      name,
      { goalId, ...(name === "wait_goal" ? { timeoutMs: 0 } : {}) },
      { callId: "current-call", signal: new AbortController().signal },
    );
  return {
    goals,
    lanes,
    originals,
    submit,
    stop,
    bind,
    call,
    clearSiblingEvidence: () => {
      siblingComplete = false;
    },
    clearSiblingSkillEvidence: () => {
      siblingSkillEvidence = false;
    },
    advance: () => {
      clock = new Date("2026-10-05T13:00:00.000Z");
    },
  };
}
it("continues the sole current goal while preserving its original grant and completed-history identity", async () => {
  const x = await fixture();
  const binding = x.bind("继续");
  const continued = (await binding.call(
    "resume_goal",
    { goalId: x.originals[0].id },
    { callId: "continue", signal: new AbortController().signal },
  )) as GoalRun;
  expect(continued.retryCount).toBe(1);
  expect(continued.grant).toEqual(x.originals[0].grant);
  expect(continued.turnId).toBe(x.originals[0].turnId);
  expect(binding.goalIds()).toEqual([continued.id]);
});
it.each([
  "继续刚才的登录目标，只重试尚未开始的账号二，保留账号一已完成的结果。仍按原客户端和保存的 UID 核验，不运行其他任务；请实际续跑并告诉我结果。",
  "继续暮雨的登录目标；保留晨星已完成的进度。",
])(
  "treats a verified completed-account preservation clause as history during resume: %s",
  async (prompt) => {
    const x = await fixture(1, true);
    const original = x.originals[0];
    const continued = (await x.call(
      prompt,
      "resume_goal",
      original.id,
    )) as GoalRun;
    expect(continued.retryCount).toBe(1);
    expect(continued.grant).toEqual(original.grant);
    expect(
      continued.attempts.at(-1)!.review.scopes.map((scope) => scope.laneId),
    ).toEqual([x.lanes[1].id]);
    expect(continued.submission!.requestIds).toEqual([
      `${continued.submission!.batchId}:${x.lanes[1].id}`,
    ]);
    expect(
      continued.requests.find((request) => request.laneId === x.lanes[0].id),
    ).toEqual(
      original.requests.find((request) => request.laneId === x.lanes[0].id),
    );
    expect(x.submit).toHaveBeenCalledTimes(2);
  },
);
it.each([
  "继续账号一和账号二的登录目标",
  "继续账号二的登录目标，保留账号一并重跑账号一已完成的结果",
  "继续账号二的登录目标，保留账号一已完成的结果并重跑账号一",
  "继续账号一的登录目标，保留账号二已完成的结果",
  "继续账号二的登录和邮件任务，保留账号一已完成的结果",
])(
  "does not use preservation words to expand or replace the original remaining scope: %s",
  async (prompt) => {
    const x = await fixture(1, true);
    await expect(
      x.call(prompt, "resume_goal", x.originals[0].id),
    ).rejects.toMatchObject({ code: "GOAL_TARGET_NOT_FOUND" });
    expect(x.submit).toHaveBeenCalledOnce();
  },
);
it("requires the preserved account to belong to the original grant", async () => {
  const x = await fixture(1, true);
  x.lanes.push({ ...x.lanes[0], id: "third-account", name: "第三账号" });
  await expect(
    x.call(
      "继续账号二的登录目标，保留账号三已完成的结果",
      "resume_goal",
      x.originals[0].id,
    ),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_NOT_FOUND" });
  expect(x.submit).toHaveBeenCalledOnce();
});
it("rechecks the preserved completion after refreshing the original goal", async () => {
  const x = await fixture(1, true);
  x.clearSiblingEvidence();
  await expect(
    x.call(
      "继续账号二的登录目标，保留账号一已完成的结果",
      "resume_goal",
      x.originals[0].id,
    ),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_NOT_FOUND" });
  expect(x.submit).toHaveBeenCalledOnce();
  expect(
    x.goals.get(x.originals[0].id, { sessionId: "session-a" }).requests[0]
      .status,
  ).toBe("unknown");
});
it("does not treat a successful request without its skill evidence as preserved completion", async () => {
  const x = await fixture(1, true);
  x.clearSiblingSkillEvidence();
  await x.goals.refresh(x.originals[0].id);
  await expect(
    x.call(
      "继续账号二的登录目标，保留账号一已完成的结果",
      "resume_goal",
      x.originals[0].id,
    ),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_NOT_FOUND" });
  expect(x.submit).toHaveBeenCalledOnce();
});
it("refuses an arbitrary model target when two current goals are ambiguous and lists choices", async () => {
  const x = await fixture(2);
  await expect(
    x.call("继续", "resume_goal", x.originals[0].id),
  ).rejects.toMatchObject({
    code: "GOAL_TARGET_AMBIGUOUS",
    message: expect.stringContaining("暮雨"),
  });
  expect(x.submit).toHaveBeenCalledTimes(2);
});
it("binds a named account to the fresh private lane and refuses another model-selected goal", async () => {
  const x = await fixture(2);
  await expect(
    x.call("继续账号二的阴阳师邮件任务", "resume_goal", x.originals[0].id),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_MISMATCH" });
  expect(x.submit).toHaveBeenCalledTimes(2);
  expect(
    await x.call("继续暮雨的阴阳师邮件任务", "resume_goal", x.originals[1].id),
  ).toMatchObject({ id: x.originals[1].id, retryCount: 1 });
});
it("accepts the exact goal named by the current message while ignoring quoted references", async () => {
  const x = await fixture(2);
  await expect(
    x.call(
      `「继续目标 ${x.originals[0].id}」；继续`,
      "resume_goal",
      x.originals[0].id,
    ),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_AMBIGUOUS" });
  expect(
    await x.call(
      `继续目标 ${x.originals[1].id}`,
      "resume_goal",
      x.originals[1].id,
    ),
  ).toMatchObject({ id: x.originals[1].id, retryCount: 1 });
});
it("binds short stop directives to the sole current target rather than a model-selected historical goal", async () => {
  const x = await fixture();
  expect(await x.call("停下", "cancel_goal", x.originals[0].id)).toMatchObject({
    status: "cancelled",
  });
  expect(x.stop).toHaveBeenCalledOnce();
});
it("cannot change an original goal's account using a followup correction", async () => {
  const x = await fixture();
  await expect(
    x.call("改成账号二继续原任务", "resume_goal", x.originals[0].id),
  ).rejects.toMatchObject({
    code: "GOAL_CORRECTION_REQUIRES_NEW_REQUEST",
    message: expect.stringContaining("重新交办"),
  });
  expect(x.submit).toHaveBeenCalledOnce();
});
it("a fresh continue message does not renew an expired original grant", async () => {
  const x = await fixture();
  x.advance();
  expect(await x.call("继续", "resume_goal", x.originals[0].id)).toMatchObject({
    status: "needs-user",
    retryCount: 0,
  });
  expect(x.submit).toHaveBeenCalledOnce();
});

it("does not shrink an explicit all-account or two-game followup to a sole smaller goal", async () => {
  const x = await fixture();
  await expect(
    x.call("继续两个已启用账号的日常任务", "resume_goal", x.originals[0].id),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_NOT_FOUND" });
  await expect(
    x.call("继续双游戏日常任务", "resume_goal", x.originals[0].id),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_NOT_FOUND" });
  expect(x.submit).toHaveBeenCalledOnce();
});
it("cannot stop another account's goal even when the model selects it", async () => {
  const x = await fixture(2);
  await expect(
    x.call("停下账号二的阴阳师任务", "cancel_goal", x.originals[0].id),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_MISMATCH" });
  expect(x.stop).not.toHaveBeenCalled();
  expect(
    await x.call("停下账号二的阴阳师任务", "cancel_goal", x.originals[1].id),
  ).toMatchObject({ id: x.originals[1].id, status: "cancelled" });
  expect(x.stop).toHaveBeenCalledOnce();
});

it("does not silently ignore a new task added to the original goal by a continue message", async () => {
  const x = await fixture();
  await expect(
    x.call(
      "继续账号一的阴阳师邮件和花合战奖励任务",
      "resume_goal",
      x.originals[0].id,
    ),
  ).rejects.toMatchObject({
    code: "GOAL_TARGET_NOT_FOUND",
    message: expect.stringContaining("重新交办"),
  });
  expect(x.submit).toHaveBeenCalledOnce();
});

it.each(["read_goal", "inspect_goal", "wait_goal"])(
  "refuses another account's goal as the result of an explicit query: %s",
  async (tool) => {
    const x = await fixture(2);
    await expect(
      x.call("账号二阴阳师邮件完成了吗？", tool, x.originals[0].id),
    ).rejects.toMatchObject({ code: "GOAL_QUERY_TARGET_MISMATCH" });
    expect(x.submit).toHaveBeenCalledTimes(2);
    expect(x.stop).not.toHaveBeenCalled();
  },
);
it("does not substitute another game or another explicit goal in a query", async () => {
  const x = await fixture(2);
  await expect(
    x.call("账号一明日方舟完成了吗？", "read_goal", x.originals[0].id),
  ).rejects.toMatchObject({ code: "GOAL_QUERY_TARGET_MISMATCH" });
  await expect(
    x.call(
      `查询目标 ${x.originals[1].id} 的结果`,
      "read_goal",
      x.originals[0].id,
    ),
  ).rejects.toMatchObject({ code: "GOAL_QUERY_TARGET_MISMATCH" });
  expect(
    await x.call(
      `查询目标 ${x.originals[1].id} 的结果`,
      "read_goal",
      x.originals[1].id,
    ),
  ).toMatchObject({ id: x.originals[1].id });
});
it("allows multiple same-session targets in a general readonly query without granting actions", async () => {
  const x = await fixture(2);
  for (const original of x.originals)
    expect(
      await x.call("查询本会话目标的进度", "read_goal", original.id),
    ).toMatchObject({ id: original.id, grant: original.grant });
  expect(x.submit).toHaveBeenCalledTimes(2);
  expect(x.stop).not.toHaveBeenCalled();
});
it("refuses a mixed-account target for a single-account completion question without changing its grant", async () => {
  const x = await fixture(2);
  const owner = { sessionId: "session-a", turnId: "mixed-query-target" };
  const grant = {
    ...x.originals[0].grant,
    ...owner,
    id: "mixed-grant",
    scopes: x.originals.flatMap((goal) => goal.grant.scopes),
  };
  const mixed = await x.goals.create({
    ...owner,
    prompt: "两个账号阴阳师邮件",
    selection: { kind: "saved-daily" },
    grant,
  });
  await expect(
    x.call("账号一邮件完成了吗？", "read_goal", mixed.id),
  ).rejects.toMatchObject({
    code: "GOAL_QUERY_SCOPE_MIXED",
    message: expect.stringContaining("多个账号"),
  });
  expect(x.goals.get(mixed.id, owner).grant).toEqual(grant);
  expect(x.submit).toHaveBeenCalledTimes(2);
});

it("rechecks fresh account bindings when a bounded wait returns", async () => {
  const x = await fixture(2);
  vi.spyOn(x.goals, "wait").mockImplementationOnce(async (goalId, owner) => {
    x.lanes.reverse();
    return x.goals.get(goalId, owner);
  });
  await expect(
    x.call("账号二邮件完成了吗？", "wait_goal", x.originals[1].id),
  ).rejects.toMatchObject({ code: "GOAL_QUERY_TARGET_MISMATCH" });
  expect(x.submit).toHaveBeenCalledTimes(2);
});

it("does not turn an unknown explicit goal identifier into another goal's query or continuation", async () => {
  const x = await fixture();
  await expect(
    x.call(
      "查询目标 goal-does-not-exist 的结果",
      "read_goal",
      x.originals[0].id,
    ),
  ).rejects.toMatchObject({ code: "GOAL_QUERY_TARGET_MISMATCH" });
  await expect(
    x.call("继续目标 goal-does-not-exist", "resume_goal", x.originals[0].id),
  ).rejects.toMatchObject({ code: "GOAL_TARGET_NOT_FOUND" });
  expect(x.submit).toHaveBeenCalledOnce();
});
