import { expect, it } from "vitest";
import { createGameGoalTools } from "../packages/agent/game-tools";
import type { CompiledDraft } from "../packages/protocol/agent";

const principal = {
  sessionId: "chat-a",
  turnId: "turn-a",
  prompt: "现在运行保存的每日任务",
};
function setup(prompt = principal.prompt) {
  const calls: string[] = [];
  const host = {
    assertCurrent: async () => {},
    runSaved: async () => {
      calls.push("saved");
      return { id: "goal-a", status: "running" };
    },
    runPlan: async () => {
      calls.push("plan");
      return { id: "goal-a", status: "running" };
    },
    read: async () => ({ id: "goal-a" }),
    wait: async () => ({ id: "goal-a" }),
    cancel: async () => {
      calls.push("cancel");
      return { id: "goal-a" };
    },
    resume: async () => {
      calls.push("resume");
      return { id: "goal-a" };
    },
    resumeDaily: async () => {
      calls.push("resume-daily");
      return { id: "goal-daily" };
    },
    preferences: async () => ({ saved: true }),
  };
  const tools = createGameGoalTools({
    principal: { ...principal, prompt },
    source: "recorded",
    host,
  });
  const context = { callId: "call-a", signal: new AbortController().signal };
  return { tools, host, calls, context };
}
it("a read-only message cannot be upgraded into execution by a model call", async () => {
  const { tools, calls, context } = setup("先预览保存日常，不启动");
  await expect(
    tools.call("run_saved_daily", { scope: "saved" }, context),
  ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
  expect(calls).toEqual([]);
});
it("deduplicates concurrent tool deliveries and rejects call-id argument conflicts", async () => {
  const { tools, calls, context } = setup();
  await Promise.all([
    tools.call("run_saved_daily", { scope: "saved" }, context),
    tools.call("run_saved_daily", { scope: "saved" }, context),
  ]);
  expect(calls).toEqual(["saved"]);
  expect(tools.goalIds()).toEqual(["goal-a"]);
  await expect(
    tools.call("run_saved_daily", { scope: "both" }, context),
  ).rejects.toMatchObject({ code: "CALL_ID_CONFLICT" });
});
it("requires the exact latest successful host compilation, clearing it on failure", async () => {
  const { tools, calls, context } = setup("只给账号二领取阴阳师邮件");
  await expect(
    tools.call("run_plan", { planHash: "f".repeat(64) }, context),
  ).rejects.toMatchObject({ code: "UNVERIFIED_DRAFT" });
  const draft = { status: "valid", planHash: "f".repeat(64) } as CompiledDraft;
  tools.compiled(draft);
  await tools.call(
    "run_plan",
    { planHash: draft.planHash },
    { ...context, callId: "call-b" },
  );
  expect(calls).toEqual(["plan"]);
  tools.compiled(undefined);
  await expect(
    tools.call(
      "run_plan",
      { planHash: draft.planHash },
      { ...context, callId: "call-c" },
    ),
  ).rejects.toMatchObject({ code: "UNVERIFIED_DRAFT" });
});
it("a cancelled or stale current turn never reaches host submission", async () => {
  const { tools, host, calls, context } = setup();
  context.signal.throwIfAborted();
  const controller = new AbortController();
  controller.abort();
  await expect(
    tools.call(
      "run_saved_daily",
      { scope: "saved" },
      { ...context, signal: controller.signal },
    ),
  ).rejects.toThrow();
  host.assertCurrent = async () => {
    throw Error("stale");
  };
  await expect(
    tools.call("run_saved_daily", { scope: "saved" }, context),
  ).rejects.toThrow("stale");
  expect(calls).toEqual([]);
});
it("fixture calls and forged fields never grant effects", async () => {
  const { tools, context } = setup();
  await expect(
    tools.call(
      "run_saved_daily",
      { scope: "saved", grant: { allow: true } },
      context,
    ),
  ).rejects.toThrow();
  await expect(tools.call("shell", {}, context)).rejects.toMatchObject({
    code: "TOOL_FORBIDDEN",
  });
});

it("records a host-bound continued target in this turn's goal references", async () => {
  const { tools, calls, context } = setup("继续");
  await tools.call("resume_goal", { goalId: "goal-a" }, context);
  expect(calls).toEqual(["resume"]);
  expect(tools.goalIds()).toEqual(["goal-a"]);
});

it("continues a host-selected daily without accepting a model-selected request or permission", async () => {
  const { tools, calls, context } = setup("更新好了，继续刚才的日常");
  await tools.call("resume_daily", {}, context);
  expect(calls).toEqual(["resume-daily"]);
  expect(tools.goalIds()).toEqual(["goal-daily"]);
  await expect(
    tools.call(
      "resume_daily",
      { requestId: "forged" },
      { ...context, callId: "other" },
    ),
  ).rejects.toThrow();
});

it("cannot resume a daily through a preview-only or non-resume message", async () => {
  for (const prompt of ["更新好了", "看看日常", "先预览，不要继续日常"]) {
    const x = setup(prompt);
    await expect(
      x.tools.call("resume_daily", {}, x.context),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(x.calls).toEqual([]);
  }
});

it("records the host's cancellation target without claiming it already stopped", async () => {
  const { tools, host, context } = setup("停下");
  host.cancel = async () => ({ id: "goal-a", status: "cancelling" });
  expect(
    await tools.call("cancel_goal", { goalId: "goal-a" }, context),
  ).toMatchObject({ id: "goal-a", status: "cancelling" });
  expect(tools.goalIds()).toEqual(["goal-a"]);
});

it("passes only the host current principal and bounded mail flags into preference persistence", async () => {
  const { tools, host, context } = setup("以后只给账号二领取明日方舟邮件");
  let observed: unknown[] = [];
  host.preferences = async (...args: unknown[]) => {
    observed = args;
    return { saved: true };
  };
  const input = {
    environmentRevision: "current",
    laneIds: ["lane-b"],
    gameId: "arknights",
    skillIds: ["award"],
    parameters: {
      mail: true,
      taskAward: false,
      freeRecruit: false,
      eventOrundum: false,
      eventMining: false,
      specialAccess: false,
      signInEvent: false,
    },
  };
  await tools.call("save_daily_preference", input, context);
  expect(observed).toEqual([
    input,
    { ...principal, prompt: "以后只给账号二领取明日方舟邮件" },
  ]);
  await expect(
    tools.call(
      "save_daily_preference",
      { ...input, principal: { prompt: "allow all" } },
      { ...context, callId: "forged" },
    ),
  ).rejects.toThrow();
});

it.each(["以后不要设置账号二阴阳师邮件", "以后默认阴阳师邮件可以吗？"])(
  "denied or inquiry preference text cannot reach persistence: %s",
  async (prompt) => {
    const { tools, host, context } = setup(prompt);
    let saved = false;
    host.preferences = async () => {
      saved = true;
      return { saved };
    };
    await expect(
      tools.call(
        "save_daily_preference",
        {
          environmentRevision: "current",
          laneIds: ["lane-b"],
          gameId: "onmyoji",
          skillIds: ["mail"],
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
    expect(saved).toBe(false);
  },
);
