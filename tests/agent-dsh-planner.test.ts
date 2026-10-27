import { expect, it, vi } from "vitest";
import { planWithDsh } from "../packages/agent/dsh-planner";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import type { AgentRuntimeToolBinding } from "../packages/protocol/agent-runtime";
import { AgentToolError } from "../packages/protocol/agent";
import type { PlannerStreamEvent } from "../packages/protocol/agent-planner";
import type { GoalRun } from "../packages/protocol/agent-goal";
import { createGameGoalTools } from "../packages/agent/game-tools";
import type { CompiledDraft } from "../packages/protocol/agent";

const at = "2026-10-05T06:00:00.000Z";

it.each([false, true])(
  "turns a host local-confirmation refusal into the exact saved intent with unrelated compile=%s",
  async (compileFirst) => {
    const snapshot = createFixtureSnapshot();
    snapshot.source = "configured";
    const result = await planWithDsh(createAgentTools(snapshot), {
      connection: {
        baseUrl: "https://offline.invalid",
        model: "test",
        apiKey: "test",
      },
      prompt: "运行保存的日常",
      at,
      binding: {
        specs: [
          { name: "run_saved_daily", description: "test", inputSchema: {} },
        ],
        goalIds: () => [],
        compiled: () => {},
        call: async () => {
          throw new AgentToolError(
            "LOCAL_CONFIRMATION_REQUIRED",
            "请核对清单并确认",
          );
        },
      },
      run: async (options) => {
        if (compileFirst) {
          const ctx = (callId: string) => ({
            callId,
            signal: new AbortController().signal,
          });
          const catalog: any = await options.callTool(
              "list_capabilities",
              {},
              ctx("catalog"),
            ),
            environment: any = await options.callTool(
              "get_environment",
              {},
              ctx("env"),
            );
          await options.callTool(
            "compile_plan",
            {
              catalogRevision: catalog.revision,
              environmentRevision: environment.revision,
              at,
              lanes: [
                {
                  laneId: "lane-a",
                  games: [{ gameId: "arknights", skillIds: ["login"] }],
                },
              ],
            },
            ctx("compile"),
          );
        }
        await options.callTool(
          "run_saved_daily",
          { scope: compileFirst ? "both" : "saved" },
          {
            callId: "request-confirmation",
            signal: new AbortController().signal,
          },
        );
        return {
          finalText: "已经启动游戏",
          model: "test",
          sessionId: "offline",
          events: [],
        };
      },
    });
    expect(result.status).toBe(
      compileFirst ? "saved-both-games" : "saved-daily",
    );
    expect(result.draft).toBeUndefined();
    expect(result.execution).toBe("not-started");
    expect(result.canExecute).toBe(false);
    expect(result.modelText).toMatch(/确认/);
    expect(result.modelText).not.toContain("已经启动");
  },
);

it.each(["environment-only", "pre-read", "old-goal", "budget-used"])(
  "fills a today's two-account daily query from host records after %s",
  async (mode) => {
    const snapshot = createFixtureSnapshot();
    snapshot.source = "recorded";
    snapshot.historyAvailable = true;
    snapshot.capturedAt = at;
    snapshot.requests = [];
    snapshot.tasks = [];
    const ark = [
      "login",
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ];
    const yys = [
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "realm-raid",
      "hana-claim",
    ];
    for (const [index, lane] of snapshot.lanes!.lanes.entries()) {
      lane.onmyoji.enabled = true;
      lane.onmyoji.routine = {
        version: 1,
        steps: yys.map((skillId) => ({ skillId, enabled: true })),
      };
      const requestId = `daily-${index}`;
      const plans = [
        { gameId: "arknights", skillIds: ark, mode: "live" as const },
        { gameId: "onmyoji", skillIds: yys, mode: "live" as const },
      ];
      snapshot.requests.push({
        version: 1,
        id: requestId,
        batchId: requestId,
        laneId: lane.id,
        fingerprint: "fixture",
        source: "daily",
        resources: [],
        status: index ? "unknown" : "succeeded",
        startedAt: "2026-10-05T04:00:00.000Z",
        finishedAt: "2026-10-05T05:00:00.000Z",
        message: "",
        snapshot: {
          lane: structuredClone(lane),
          arknightsPlan: plans[0],
          onmyojiPlan: plans[1],
        },
      });
      for (const plan of plans)
        snapshot.tasks.push({
          version: 1,
          executionId: requestId,
          batchId: requestId,
          laneId: lane.id,
          instance: lane.instance,
          runId: `${requestId}-${plan.gameId}`,
          gameId: plan.gameId,
          plan,
          status: index && plan.gameId === "onmyoji" ? "unknown" : "succeeded",
          startedAt: "2026-10-05T04:00:00.000Z",
          updatedAt: "2026-10-05T05:00:00.000Z",
          finishedAt: "2026-10-05T05:00:00.000Z",
          message: "",
          steps: plan.skillIds.map((skillId) => ({
            skillId,
            status:
              plan.gameId === "arknights"
                ? "succeeded"
                : index
                  ? skillId === "login"
                    ? "unknown"
                    : "not-run"
                  : skillId === "daily-gift"
                    ? "skipped"
                    : "succeeded",
            evidence: "adapter-return",
            message: "",
            diagnostics: [],
          })),
        });
    }
    const effects = vi.fn();
    const result = await planWithDsh(createAgentTools(snapshot), {
      connection: {
        baseUrl: "https://offline.invalid",
        model: "test",
        apiKey: "test",
      },
      prompt:
        "今天两个账号的明日方舟日常完成了吗？阴阳师有什么没做完？只查看结果，不启动任务。",
      at,
      binding: {
        specs: ["run_saved_daily", "read_goal"].map((name) => ({
          name,
          description: name,
          inputSchema: {},
        })),
        call: async (name) => {
          if (name === "read_goal")
            return {
              version: 1,
              id: "old-login-goal",
              createdAt: "2026-10-04T04:00:00Z",
              updatedAt: "2026-10-04T05:00:00Z",
              status: "completed",
              attempts: [],
              requests: [],
              grant: { scopes: [] },
              selection: { kind: "custom" },
              flowComplete: true,
              goalSatisfied: true,
            };
          return effects();
        },
        compiled() {},
        goalIds: () => [],
      },
      run: async (options) => {
        await options.callTool(
          "get_environment",
          {},
          { callId: "env-only", signal: new AbortController().signal },
        );
        if (mode === "pre-read")
          await options.callTool(
            "get_run",
            { requestId: "daily-0" },
            { callId: "pre-read", signal: new AbortController().signal },
          );
        if (mode === "old-goal")
          await options.callTool(
            "read_goal",
            { goalId: "old-login-goal" },
            { callId: "old-goal", signal: new AbortController().signal },
          );
        if (mode === "budget-used")
          for (let index = 0; index < 11; index++)
            await options.callTool(
              "get_environment",
              {},
              {
                callId: `repeat-${index}`,
                signal: new AbortController().signal,
              },
            );
        return {
          finalText: "所有日常已经全部完成",
          model: "test",
          sessionId: "s",
          events: [],
        };
      },
    });
    for (const account of ["账号一", "账号二"])
      for (const game of ["明日方舟", "阴阳师"])
        expect(result.modelText).toContain(`${account} · ${game}`);
    if (mode === "budget-used") {
      expect(result.trace).toHaveLength(12);
      expect(result.modelText).toContain("部分记录未能读取");
      expect(result.modelText).not.toContain("任务流程已完成");
    } else {
      expect(result.modelText.match(/任务流程已完成/g)).toHaveLength(2);
      expect(result.modelText).toContain("每日礼包");
      expect(result.modelText).toContain("未执行");
    }
    expect(result.modelText).not.toContain("请指定原任务或账号");
    expect(result.modelText).not.toContain("所有日常已经全部完成");
    expect(result.modelText).not.toContain("这份交办记录创建于");
    expect(
      result.trace.filter((entry) => entry.tool === "get_run"),
    ).toHaveLength(mode === "budget-used" ? 0 : 2);
    expect(result.execution).toBe("not-started");
    expect(effects).not.toHaveBeenCalled();
  },
);

it("reports a rejected daily resume from the host instead of generic model non-dispatch", async () => {
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://offline.invalid",
      model: "test",
      apiKey: "offline-unused",
    },
    at,
    prompt: "更新好了，继续刚才的日常",
    binding: {
      specs: [{ name: "resume_daily", description: "resume", inputSchema: {} }],
      call: async () => {
        throw new AgentToolError(
          "DAILY_CONTINUATION_BLOCKED",
          "需先重新核验账号",
        );
      },
      compiled() {},
      goalIds: () => [],
    },
    run: async (runner) => {
      await runner.callTool(
        "resume_daily",
        {},
        { callId: "resume", signal: new AbortController().signal },
      );
      return {
        finalText: "已经跑起来了",
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(result.modelText).toContain("需先重新核验账号");
  expect(result.modelText).not.toContain("已经跑起来了");
  expect(result.execution).toBe("not-started");
});

type OfflineRunOptions = Parameters<
  NonNullable<Parameters<typeof planWithDsh>[1]["run"]>
>[0];
function continuationSetup() {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "recorded";
  const tools = createAgentTools(snapshot);
  const principal = Object.freeze({
    sessionId: "chat-original",
    turnId: "turn-original",
    prompt: "现在运行两个账号明日方舟登录任务，仅login，不购物",
  });
  const controller = new AbortController();
  const runPlan = vi.fn(async (_draft: CompiledDraft) => ({
    id: "goal-original",
  }));
  const readGoal = vi.fn(async (): Promise<unknown> => ({
    id: "goal-old",
    status: "completed",
  }));
  const binding = createGameGoalTools({
    principal,
    source: "recorded",
    host: {
      assertCurrent: async () => {},
      runPlan,
      runSaved: async () => {
        throw Error("custom login must not run saved daily");
      },
      read: readGoal,
      wait: readGoal,
      cancel: async () => ({ id: "goal-original" }),
      resume: async () => ({ id: "goal-original" }),
      preferences: async () => ({}),
    },
  });
  const options = {
    connection: {
      baseUrl: "https://offline.invalid",
      model: "test",
      apiKey: "offline-unused",
    },
    at,
    prompt: "历史文字只作上下文。当前用户需求：" + principal.prompt,
    currentMessage: principal.prompt,
    sessionId: principal.sessionId,
    signal: controller.signal,
    binding,
  };
  const finished = (finalText = "环境已查询，尚未提交游戏动作。") => ({
    finalText,
    model: "test",
    sessionId: principal.sessionId,
    events: [],
  });
  const compile = async (runner: OfflineRunOptions) => {
    const signal = runner.signal!;
    const environment = (await runner.callTool(
      "get_environment",
      {},
      { callId: "environment", signal },
    )) as any;
    const catalog = (await runner.callTool(
      "list_capabilities",
      {},
      { callId: "catalog", signal },
    )) as any;
    return (await runner.callTool(
      "compile_plan",
      {
        catalogRevision: catalog.revision,
        environmentRevision: environment.revision,
        at,
        lanes: environment.lanes.map((lane: { id: string }) => ({
          laneId: lane.id,
          games: [{ gameId: "arknights", skillIds: ["login"] }],
        })),
      },
      { callId: "compile", signal },
    )) as CompiledDraft;
  };
  const compileUnused = (runner: OfflineRunOptions) =>
    compile({
      ...runner,
      callTool: (name, args, context) =>
        runner.callTool(
          name,
          name === "compile_plan"
            ? {
                ...args,
                lanes: (
                  args.lanes as {
                    laneId: string;
                    games: Record<string, unknown>[];
                  }[]
                ).map((lane) => ({
                  ...lane,
                  games: lane.games.map((game) => ({
                    ...game,
                    parameters: { mail: true },
                  })),
                })),
              }
            : args,
          name === "compile_plan"
            ? { ...context, callId: "unused-compile" }
            : context,
        ),
    });
  return {
    tools,
    principal,
    controller,
    runPlan,
    readGoal,
    binding,
    options,
    finished,
    compile,
    compileUnused,
  };
}

it.each(["query", "compile"])(
  "continues once after %s while retaining the original current-turn binding",
  async (first) => {
    const x = continuationSetup();
    let calls = 0;
    let draft: CompiledDraft | undefined;
    const result = await planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        expect(runner.signal?.aborted).toBe(false);
        if (calls === 1) expect(runner.signal).toBe(x.controller.signal);
        expect(runner.at).toBe(at);
        expect(runner.sessionId).toBe(x.principal.sessionId);
        if (calls === 1) {
          await runner.callTool(
            "get_environment",
            {},
            { callId: "environment", signal: runner.signal! },
          );
          if (first === "compile") draft = await x.compile(runner);
          return x.finished(
            draft
              ? JSON.stringify({
                  kind: "draft",
                  text: "计划已准备",
                  planHash: draft.planHash,
                })
              : undefined,
          );
        }
        expect(runner.resume).toBe(true);
        expect(runner.prompt).toContain(x.principal.prompt);
        draft ??= await x.compile(runner);
        await runner.callTool(
          "run_plan",
          { planHash: draft.planHash },
          { callId: "run", signal: runner.signal! },
        );
        return x.finished("已提交，等待实际结果。");
      },
    });
    expect(calls).toBe(2);
    expect(x.runPlan).toHaveBeenCalledOnce();
    expect(x.runPlan.mock.calls[0][0].planHash).toBe(draft!.planHash);
    expect(result).toMatchObject({
      execution: "managed-by-goal",
      goalIds: ["goal-original"],
    });
    expect(
      result.trace.filter((call) => call.tool === "compile_plan"),
    ).toHaveLength(1);
  },
);

it("stops after one continuation without inventing an execution receipt", async () => {
  const x = continuationSetup();
  let calls = 0;
  const result = await planWithDsh(x.tools, {
    ...x.options,
    run: async () => {
      calls++;
      return x.finished();
    },
  });
  expect(calls).toBe(2);
  expect(x.runPlan).not.toHaveBeenCalled();
  expect(result.execution).toBe("not-started");
  expect(result.modelText).toContain("尚未受理");
});

it("continues after a later valid host compile corrects UNUSED_PARAMETER", async () => {
  const x = continuationSetup();
  let calls = 0;
  let draft: CompiledDraft;
  const result = await planWithDsh(x.tools, {
    ...x.options,
    run: async (runner) => {
      calls++;
      if (calls === 1) {
        expect(await x.compileUnused(runner)).toMatchObject({
          error: { code: "UNUSED_PARAMETER" },
        });
        draft = await x.compile(runner);
        expect(draft.status).toBe("valid");
        return x.finished(
          JSON.stringify({
            kind: "draft",
            text: "参数已纠正并编译",
            planHash: draft.planHash,
          }),
        );
      }
      await runner.callTool(
        "run_plan",
        { planHash: draft.planHash },
        { callId: "run-corrected", signal: runner.signal! },
      );
      return x.finished("已提交纠正后的本轮计划");
    },
  });
  expect(calls).toBe(2);
  expect(x.runPlan).toHaveBeenCalledOnce();
  expect(x.runPlan.mock.calls[0][0].planHash).toBe(draft!.planHash);
  expect(result.execution).toBe("managed-by-goal");
  expect(
    result.trace.filter((call) => call.tool === "compile_plan"),
  ).toMatchObject([
    { success: false, code: "UNUSED_PARAMETER" },
    { success: true, planHash: draft!.planHash },
  ]);
});

it.each([
  "last-failed",
  "last-blocked",
  "cached-old-success",
  "other-read-error",
])("does not waive %s after a compile correction", async (outcome) => {
  const x = continuationSetup();
  let calls = 0;
  await planWithDsh(x.tools, {
    ...x.options,
    run: async (runner) => {
      calls++;
      if (outcome === "other-read-error") {
        await runner.callTool(
          "read_skill",
          {},
          { callId: "bad-read", signal: runner.signal! },
        );
        await x.compileUnused(runner);
        await x.compile(runner);
      } else {
        await x.compile(runner);
        await x.compileUnused(runner);
        if (outcome === "cached-old-success") await x.compile(runner);
        if (outcome === "last-blocked") {
          const blocked = await x.compile({
            ...runner,
            callTool: (name, args, context) =>
              runner.callTool(
                name,
                name === "compile_plan"
                  ? { ...args, environmentRevision: "changed" }
                  : args,
                name === "compile_plan"
                  ? { ...context, callId: "blocked-compile" }
                  : context,
              ),
          });
          expect(blocked.status).toBe("blocked");
        }
      }
      return x.finished();
    },
  });
  expect(calls).toBe(1);
  expect(x.runPlan).not.toHaveBeenCalled();
});

it.each(["read_goal", "wait_goal"])(
  "continues the current execution after %s successfully reads an old terminal goal",
  async (tool) => {
    const x = continuationSetup();
    let calls = 0;
    const result = await planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        if (calls === 1) {
          await runner.callTool(
            tool,
            { goalId: "goal-old" },
            {
              callId: "old-goal",
              signal: runner.signal!,
            },
          );
          return x.finished("旧目标已经结束，本轮还未提交。");
        }
        const draft = await x.compile(runner);
        await runner.callTool(
          "run_plan",
          { planHash: draft.planHash },
          {
            callId: "new-run",
            signal: runner.signal!,
          },
        );
        return x.finished("本轮目标已经受理，等待实际结果。");
      },
    });
    expect(calls).toBe(2);
    expect(x.readGoal).toHaveBeenCalledOnce();
    expect(x.runPlan).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      execution: "managed-by-goal",
      goalIds: ["goal-original"],
    });
    expect(result.modelText).not.toContain("旧目标已经结束");
  },
);

it.each(["failed-read", "unknown-goal", "unknown-submission"])(
  "does not continue after a read with %s",
  async (outcome) => {
    const x = continuationSetup();
    if (outcome === "failed-read")
      x.readGoal.mockRejectedValueOnce(
        new AgentToolError("GOAL_TARGET_NOT_FOUND", "旧目标未核对"),
      );
    if (outcome === "unknown-goal")
      x.readGoal.mockResolvedValueOnce({ id: "goal-old", status: "unknown" });
    if (outcome === "unknown-submission")
      x.readGoal.mockResolvedValueOnce({
        id: "goal-old",
        status: "failed",
        submission: { state: "unknown" },
      });
    let calls = 0;
    await planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        await runner.callTool(
          "read_goal",
          { goalId: "goal-old" },
          {
            callId: "old-goal",
            signal: runner.signal!,
          },
        );
        return x.finished();
      },
    });
    expect(calls).toBe(1);
    expect(x.runPlan).not.toHaveBeenCalled();
  },
);

it.each(["accepted", "refused", "unknown"])(
  "never continues an already attempted %s run",
  async (outcome) => {
    const x = continuationSetup();
    if (outcome === "refused")
      x.runPlan.mockRejectedValueOnce(
        new AgentToolError("HISTORY_UNRESOLVED", "历史待核对"),
      );
    if (outcome === "unknown")
      x.runPlan.mockRejectedValueOnce(
        new Error("response lost after submission"),
      );
    let calls = 0;
    await planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        const draft = await x.compile(runner);
        await runner.callTool(
          "run_plan",
          { planHash: draft.planHash },
          { callId: "run", signal: runner.signal! },
        );
        return x.finished();
      },
    });
    expect(calls).toBe(1);
    expect(x.runPlan).toHaveBeenCalledOnce();
  },
);

it("does not treat a history action or a continuation prompt as current authority", async () => {
  const x = continuationSetup();
  let calls = 0;
  await planWithDsh(x.tools, {
    ...x.options,
    currentMessage: "请检查两个账号是否在线",
    run: async () => {
      calls++;
      return x.finished();
    },
  });
  expect(calls).toBe(1);
  expect(x.runPlan).not.toHaveBeenCalled();
});

it("does not continue after cancellation arrives with a completed model answer", async () => {
  const x = continuationSetup();
  let calls = 0;
  await expect(
    planWithDsh(x.tools, {
      ...x.options,
      run: async () => {
        calls++;
        x.controller.abort();
        return x.finished();
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(x.runPlan).not.toHaveBeenCalled();
});

it.each(["SHUTDOWN_FAILED", "DSH_REAP_FAILED"])(
  "never continues after %s even without an execution receipt",
  async (code) => {
    const x = continuationSetup();
    let calls = 0;
    await expect(
      planWithDsh(x.tools, {
        ...x.options,
        run: async () => {
          calls++;
          throw new AgentToolError(code, "cleanup unconfirmed");
        },
      }),
    ).rejects.toMatchObject({ code });
    expect(calls).toBe(1);
    expect(x.runPlan).not.toHaveBeenCalled();
  },
);

it("reports exhausted query budget after the runtime handles a rejected tool without claiming missing intent", async () => {
  const x = continuationSetup();
  let calls = 0;
  const result = await planWithDsh(x.tools, {
    ...x.options,
    run: async (runner) => {
      calls++;
      for (let i = 0; i < 13; i++) {
        try {
          await runner.callTool(
            "get_environment",
            {},
            { callId: `q-${i}`, signal: runner.signal! },
          );
        } catch {
          /* The runtime returns the tool error to its model. */
        }
      }
      return x.finished();
    },
  });
  expect(calls).toBe(1);
  expect(result.modelText).toContain("查询工具预算");
  expect(result.modelText).not.toContain("请明确游戏");
  expect(x.runPlan).not.toHaveBeenCalled();
});

it("retains the original tool budget across the continuation", async () => {
  const x = continuationSetup();
  let calls = 0;
  await expect(
    planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        if (calls === 1) {
          for (let i = 0; i < 12; i++)
            await runner.callTool(
              "get_environment",
              {},
              { callId: `environment-${i}`, signal: runner.signal! },
            );
          return x.finished();
        }
        await runner.callTool(
          "list_capabilities",
          {},
          { callId: "extra", signal: runner.signal! },
        );
        return x.finished();
      },
    }),
  ).rejects.toMatchObject({ code: "TOOL_BUDGET" });
  expect(x.runPlan).not.toHaveBeenCalled();
});

it("shares the model request limit across the continued DSH turn", async () => {
  const x = continuationSetup();
  let calls = 0;
  await expect(
    planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        for (let i = 1; i <= (calls === 1 ? 15 : 2); i++) {
          runner.onEvent?.({ kind: "attempt", attempt: i, status: "started" });
        }
        if (calls === 2) {
          expect(runner.signal?.aborted).toBe(true);
          throw new AgentToolError("CANCELLED", "runtime cancelled by budget");
        }
        return x.finished();
      },
    }),
  ).rejects.toMatchObject({ code: "ROUND_BUDGET" });
  expect(calls).toBe(2);
  expect(x.runPlan).not.toHaveBeenCalled();
});

it("uses only the remaining original deadline for continuation", async () => {
  const x = continuationSetup();
  let elapsed = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
  let calls = 0;
  try {
    await planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        const timeout = (runner as OfflineRunOptions & { timeoutMs?: number })
          .timeoutMs;
        expect(timeout).toBe(calls === 1 ? 120000 : 30000);
        elapsed = 90000;
        return x.finished();
      },
    });
    expect(calls).toBe(2);
  } finally {
    clock.mockRestore();
  }
});

it.each(["question", "blocked"])(
  "does not continue a structured %s response",
  async (kind) => {
    const x = continuationSetup();
    let calls = 0;
    await planWithDsh(x.tools, {
      ...x.options,
      run: async () => {
        calls++;
        return x.finished(
          JSON.stringify({
            kind,
            text: "任务范围需要用户澄清",
            planHash: null,
          }),
        );
      },
    });
    expect(calls).toBe(1);
    expect(x.runPlan).not.toHaveBeenCalled();
  },
);

it("does not continue a failed host compilation", async () => {
  const x = continuationSetup();
  let calls = 0;
  await planWithDsh(x.tools, {
    ...x.options,
    run: async (runner) => {
      calls++;
      await runner.callTool(
        "compile_plan",
        { at },
        { callId: "bad-compile", signal: runner.signal! },
      );
      return x.finished();
    },
  });
  expect(calls).toBe(1);
  expect(x.runPlan).not.toHaveBeenCalled();
});

it("keeps the continued runner linked to the original user cancellation", async () => {
  const x = continuationSetup();
  let calls = 0;
  await expect(
    planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        if (calls === 2) {
          x.controller.abort();
          expect(runner.signal?.aborted).toBe(true);
          // A transport-local fresh signal cannot bypass the original cancellation.
          await runner.callTool(
            "run_saved_daily",
            { scope: "saved" },
            { callId: "late-run", signal: new AbortController().signal },
          );
        }
        return x.finished();
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(2);
  expect(x.runPlan).not.toHaveBeenCalled();
});

it("preserves cleanup failure when a continued turn exhausts the model budget", async () => {
  const x = continuationSetup();
  let calls = 0;
  await expect(
    planWithDsh(x.tools, {
      ...x.options,
      run: async (runner) => {
        calls++;
        runner.onEvent?.({
          kind: "attempt",
          attempt: calls === 1 ? 15 : 2,
          status: "started",
        });
        if (calls === 2)
          throw new AgentToolError("DSH_REAP_FAILED", "cleanup unconfirmed");
        return x.finished();
      },
    }),
  ).rejects.toMatchObject({ code: "DSH_REAP_FAILED" });
  expect(calls).toBe(2);
  expect(x.runPlan).not.toHaveBeenCalled();
});

it("keeps read-only compilation proofs and reports an actual goal separately from model prose", async () => {
  const tools = createAgentTools(createFixtureSnapshot());
  let accepted = false;
  const binding: AgentRuntimeToolBinding = {
    specs: [
      {
        name: "run_saved_daily",
        description: "run",
        inputSchema: { type: "object" },
      },
    ],
    call: async () => {
      accepted = true;
      return { id: "goal-a", status: "running" };
    },
    compiled() {},
    goalIds: () => (accepted ? ["goal-a"] : []),
  };
  const result = await planWithDsh(tools, {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "运行日常",
    at,
    binding,
    run: async (options) => {
      await options.callTool(
        "run_saved_daily",
        { scope: "saved" },
        { callId: "call-a", signal: new AbortController().signal },
      );
      return {
        finalText:
          '{"kind":"answer","text":"已受理，等待游戏结果","planHash":null}',
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(result.execution).toBe("managed-by-goal");
  expect(result.goalIds).toEqual(["goal-a"]);
  expect(result.canExecute).toBe(false);
  expect(result.modelText).toContain("等待");
  expect(JSON.stringify(result)).not.toContain("private-test");
});
it("accepts ordinary chat text without turning it into a fabricated draft", async () => {
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "你好",
    at,
    run: async () => ({
      finalText: "你好，可以描述你的游戏需求。",
      model: "test",
      sessionId: "s",
      events: [],
    }),
  });
  expect(result.status).toBe("answer");
  expect(result.execution).toBe("not-started");
  expect(result.draft).toBeUndefined();
});

it("does not publish a model's invented completion when an execution request dispatched no tools", async () => {
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "帮我领取账号二阴阳师邮件",
    at,
    run: async () => ({
      finalText: "账号二邮件已全部领取完成",
      model: "test",
      sessionId: "s",
      events: [],
    }),
  });
  expect(result.execution).toBe("not-started");
  expect(result.modelText).toContain("尚未受理");
  expect(result.modelText).not.toContain("全部领取完成");
});

it("describes an accepted goal as awaiting verified results even when the model says completed", async () => {
  let accepted = false;
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "运行日常",
    at,
    binding: {
      specs: [
        {
          name: "run_saved_daily",
          description: "run",
          inputSchema: { type: "object" },
        },
      ],
      call: async () => {
        accepted = true;
        return { id: "goal-a", status: "waiting" };
      },
      compiled() {},
      goalIds: () => (accepted ? ["goal-a"] : []),
    },
    run: async (options) => {
      await options.callTool(
        "run_saved_daily",
        {},
        { callId: "accept", signal: new AbortController().signal },
      );
      return {
        finalText: "全部日常已经完成",
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(result.modelText).toContain("等待");
  expect(result.modelText).not.toContain("已经完成");
});

it("cannot let a historical completed goal overwrite this turn's newly accepted waiting goal", async () => {
  const scopes = [
    { laneId: "lane-a", gameId: "onmyoji", skillIds: ["mail"], resources: {} },
  ];
  const review = {
    id: "review-a",
    fingerprint: "hash-a",
    reviewedAt: at,
    expiresAt: at,
    frozenPlan: { kind: "custom" as const, hash: "hash-a" },
    scopes,
    summary: [],
  };
  const fresh: GoalRun = {
    version: 1,
    id: "fresh",
    revision: 1,
    sessionId: "s",
    turnId: "t",
    prompt: "运行日常",
    selection: { kind: "custom" },
    grant: {
      id: "grant-a",
      source: "user-message",
      sessionId: "s",
      turnId: "t",
      issuedAt: at,
      expiresAt: at,
      maxRetries: 2,
      scopes,
    },
    createdAt: at,
    updatedAt: at,
    status: "waiting",
    message: "运行中",
    originalReview: review,
    attempts: [
      {
        review,
        submission: {
          batchId: "batch-fresh",
          requestIds: ["batch-fresh:lane-a"],
          attempt: 1,
          acceptedAt: at,
          state: "received",
        },
      },
    ],
    retryCount: 0,
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
  };
  const old = structuredClone(fresh);
  old.id = "old";
  old.status = "completed";
  old.flowComplete = true;
  old.goalSatisfied = true;
  old.requests = [
    {
      requestId: "batch-fresh:lane-a",
      laneId: "lane-a",
      gameId: "onmyoji",
      status: "succeeded",
      flowComplete: true,
      goalSatisfied: true,
      skills: [
        {
          skillId: "mail",
          gameId: "onmyoji",
          status: "succeeded",
          goalSatisfied: true,
          evidenceTimestamp: at,
          evidenceReference: "mail-proof",
          summary: "完成",
        },
      ],
    },
  ];
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "运行日常",
    at,
    binding: {
      specs: ["run_saved_daily", "read_goal"].map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      })),
      call: async (name) => (name === "read_goal" ? old : fresh),
      compiled() {},
      goalIds: () => ["fresh"],
    },
    run: async (options) => {
      for (const name of ["run_saved_daily", "read_goal"])
        await options.callTool(
          name,
          {},
          { callId: name, signal: new AbortController().signal },
        );
      return {
        finalText: "任务完成",
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(result.goalIds).toEqual(["fresh"]);
  expect(result.modelText).toContain("等待");
  expect(result.modelText).not.toContain("1 项任务已核验完成");
});

it("does not stream unverified completion text for a current execution demand", async () => {
  const events: PlannerStreamEvent[] = [];
  await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "历史：查询\n当前：运行日常",
    currentMessage: "运行日常",
    at,
    onEvent: (event) => events.push(event),
    run: async (options) => {
      options.onEvent?.({ kind: "answer-delta", text: "所有任务已完成" });
      return { finalText: "已完成", model: "test", sessionId: "s", events: [] };
    },
  });
  expect(events.some((e) => e.kind === "answer-delta")).toBe(false);
});

it("keeps a compiled draft unexecuted even if its model description claims completion", async () => {
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "现在给账号一领取阴阳师邮件",
    at,
    run: async (options) => {
      const environment = (await options.callTool(
        "get_environment",
        {},
        { callId: "environment", signal: new AbortController().signal },
      )) as any;
      const catalog = (await options.callTool(
        "list_capabilities",
        {},
        { callId: "catalog", signal: new AbortController().signal },
      )) as any;
      const draft = (await options.callTool(
        "compile_plan",
        {
          catalogRevision: catalog.revision,
          environmentRevision: environment.revision,
          at,
          lanes: [
            {
              laneId: environment.lanes[0].id,
              games: [{ gameId: "onmyoji", skillIds: ["login", "mail"] }],
            },
          ],
        },
        { callId: "compile", signal: new AbortController().signal },
      )) as any;
      expect(draft.status).toBe("valid");
      return {
        finalText: JSON.stringify({
          kind: "draft",
          text: "账号一邮件已经领取完成",
          planHash: draft.planHash,
        }),
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(result.status).toBe("draft");
  expect(result.execution).toBe("not-started");
  expect(result.modelText).toContain("尚未受理");
  expect(result.modelText).not.toContain("已经领取完成");
});
it("does not claim preferences were saved without a host save receipt", async () => {
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "以后默认只领邮件",
    at,
    run: async () => ({
      finalText: JSON.stringify({
        kind: "saved-daily",
        text: "已保存",
        planHash: null,
      }),
      model: "test",
      sessionId: "s",
      events: [],
    }),
  });
  expect(result.status).toBe("answer");
  expect(result.configurationChangedByHost).toBeUndefined();
  expect(result.modelText).toContain("没有保存");
});
it("requires host facts for completion inquiries instead of allowing a zero-tool fabricated answer", async () => {
  const events: PlannerStreamEvent[] = [];
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "账号二阴阳师邮件完成了吗？",
    at,
    onEvent: (event) => events.push(event),
    run: async (options) => {
      options.onEvent?.({ kind: "answer-delta", text: "已经全部完成" });
      return {
        finalText: "账号二邮件已经全部领取完成",
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(result.modelText).toContain("尚未核对");
  expect(result.modelText).not.toContain("全部领取完成");
  expect(events.some((e) => e.kind === "answer-delta")).toBe(false);
});
it.each([
  "账号二阴阳师邮件领了吗？",
  "邮件收了吗？",
  "礼包拿到了吗？",
  "奖励领了没有？",
  "账号二阴阳师邮件领到了吗？",
  "邮件领取成功了吗？",
  "邮件领了么？",
  "查询账号二邮件有没有领取",
  "领了吗？",
  "邮件是否领取",
  "收到了没",
])(
  "requires evidence for natural claim-status questions: %s",
  async (prompt) => {
    const events: PlannerStreamEvent[] = [];
    const result = await planWithDsh(
      createAgentTools(createFixtureSnapshot()),
      {
        connection: {
          baseUrl: "https://example.com",
          model: "test",
          apiKey: "private-test",
        },
        prompt,
        at,
        onEvent: (event) => events.push(event),
        run: async (options) => {
          options.onEvent?.({
            kind: "answer-delta",
            text: "奖励已经全部领取完成",
          });
          return {
            finalText: "奖励已经全部领取完成",
            model: "test",
            sessionId: "s",
            events: [],
          };
        },
      },
    );
    expect(result.modelText).toContain("尚未核对");
    expect(result.modelText).not.toContain("已经全部领取完成");
    expect(events.some((event) => event.kind === "answer-delta")).toBe(false);
  },
);
it.each([
  "如何让我的游戏任务完整完成？",
  "请解释‘账号二阴阳师邮件完成了吗’这个例子",
  "你收到了我的消息吗？",
  "领取是什么意思？",
])(
  "keeps product discussions and quoted examples conversational: %s",
  async (prompt) => {
    const result = await planWithDsh(
      createAgentTools(createFixtureSnapshot()),
      {
        connection: {
          baseUrl: "https://example.com",
          model: "test",
          apiKey: "private-test",
        },
        prompt,
        at,
        run: async () => ({
          finalText: "可以使用注册技能并核对真实结果。",
          model: "test",
          sessionId: "s",
          events: [],
        }),
      },
    );
    expect(result.modelText).toBe("可以使用注册技能并核对真实结果。");
    expect(result.execution).toBe("not-started");
  },
);

it("publishes one failed host receipt even when the runtime acknowledges returned error JSON", async () => {
  const events: PlannerStreamEvent[] = [];
  const binding: AgentRuntimeToolBinding = {
    specs: [
      {
        name: "run_saved_daily",
        description: "run",
        inputSchema: { type: "object" },
      },
    ],
    call: async () => {
      throw new AgentToolError("HISTORY_UNRESOLVED", "旧请求尚未处置");
    },
    compiled() {},
    goalIds: () => [],
  };
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "运行日常",
    at,
    binding,
    onEvent: (event) => events.push(event),
    run: async (options) => {
      options.onEvent?.({
        kind: "tool-started",
        tool: "run_saved_daily",
        callId: "call-error",
      });
      const receipt = await options.callTool(
        "run_saved_daily",
        { scope: "saved", apiKey: "hidden-argument" },
        { callId: "call-error", signal: new AbortController().signal },
      );
      expect(receipt).toEqual({
        error: { code: "HISTORY_UNRESOLVED", message: "旧请求尚未处置" },
      });
      options.onEvent?.({
        kind: "tool-result",
        tool: "run_saved_daily",
        callId: "call-error",
        success: true,
      });
      return {
        finalText: "旧请求尚未处置，游戏未启动。",
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(events.filter((event) => event.kind === "tool-started")).toHaveLength(
    1,
  );
  const receipts = events.filter((event) => event.kind === "tool-result");
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    success: false,
    code: "HISTORY_UNRESOLVED",
  });
  expect(JSON.stringify(events)).not.toContain("hidden-argument");
  expect(result.execution).toBe("not-started");
  expect(result.goalIds).toBeUndefined();
});

it("records a successful protected preference change without treating it as game execution", async () => {
  let changed = false;
  const result = await planWithDsh(createAgentTools(createFixtureSnapshot()), {
    connection: {
      baseUrl: "https://example.com",
      model: "test",
      apiKey: "private-test",
    },
    prompt: "以后默认只领邮件",
    at,
    binding: {
      specs: [
        {
          name: "save_daily_preference",
          description: "save",
          inputSchema: { type: "object" },
        },
      ],
      call: async () => {
        changed = true;
        return { saved: true };
      },
      compiled() {},
      goalIds: () => [],
      changedPreferences: () => changed,
    },
    run: async (options) => {
      await options.callTool(
        "save_daily_preference",
        {},
        { callId: "save-one", signal: new AbortController().signal },
      );
      return {
        finalText: "已保存以后领取邮件的设置，本次未启动游戏。",
        model: "test",
        sessionId: "s",
        events: [],
      };
    },
  });
  expect(result.configurationChangedByHost).toBe(true);
  expect(result.execution).toBe("not-started");
  expect(result.canExecute).toBe(false);
});
