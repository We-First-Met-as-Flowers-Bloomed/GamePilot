import { expect, it, vi } from "vitest";
import { createDailyContinuationPreparation } from "../apps/desktop/main/agent-daily-continuation";
import { startupRecoveryFixture } from "./startup-recovery-fixture";
import { createStartupReconciliationFact } from "../games/arknights/startup-reconciliation";
import { ContinuationService } from "../apps/desktop/main/continuation-service";
import type { GoalRun } from "../packages/protocol/agent-goal";
import type { DeviceLane } from "../packages/protocol";
import { GoalService } from "../apps/desktop/main/agent-goals";
import { createGoalRuntime } from "../apps/desktop/main/agent-goal-runtime";
import type { GoalStore } from "../packages/protocol/agent-goal";

function setup() {
  const x = startupRecoveryFixture(["login", "infrastructure", "award"]);
  x.parent.status = "unknown";
  delete x.parent.startupFault;
  const failed = x.succeeded(x.parent);
  failed.status = "failed";
  failed.steps = failed.plan.skillIds.map((skillId, index) =>
    index === 0
      ? {
          skillId,
          status: "failed",
          startedAt: x.parent.startedAt,
          finishedAt: x.parent.finishedAt,
          diagnostics: [],
          message: "客户端更新",
          result: {
            arknights: {
              version: 1,
              taskType: "StartUp",
              submission: "submitted",
              completion: "unknown",
              observedAt: x.parent.finishedAt!,
              taskId: 1,
            },
          },
        }
      : { skillId, status: "not-run", diagnostics: [], message: "未开始" },
  );
  x.tasks.push(failed);
  const fresh = structuredClone(x.parent);
  fresh.id = "fresh:lane-b";
  fresh.batchId = "fresh";
  fresh.fingerprint = "c".repeat(64);
  fresh.startedAt = "2026-10-08T11:06:02.000Z";
  fresh.finishedAt = "2026-10-08T11:06:08.000Z";
  fresh.status = "succeeded";
  fresh.snapshot.arknightsPlan = {
    gameId: "arknights",
    mode: "live",
    skillIds: ["login"],
  };
  const login = x.succeeded(fresh);
  login.steps[0].result!.arknights = {
    version: 1,
    taskType: "StartUp",
    submission: "submitted",
    completion: "native-confirmed",
    taskId: 2,
    observedAt: "2026-10-08T11:06:03.000Z",
    login: {
      expectedUid: x.currentProfile.expectedUid,
      observedUid: x.currentProfile.expectedUid,
      observedAt: "2026-10-08T11:06:04.000Z",
      homeObservedAt: "2026-10-08T11:06:05.000Z",
      method: "profile",
      home: true,
    },
  };
  const fact = createStartupReconciliationFact({
    id: "fact",
    originalRequest: x.parent,
    originalTasks: [failed],
    freshRequest: fresh,
    freshTasks: [login],
    executorExit: {
      verified: true,
      requestId: x.parent.id,
      resource: x.parent.resources[0],
      observedAt: "2026-10-08T11:06:01.000Z",
      evidenceReference: "worker-exit",
    },
    evidenceReference: "login-evidence",
    now: new Date("2026-10-08T11:06:10.000Z"),
  });
  x.records.push(fresh);
  x.tasks.push(login);
  const facts = [fact],
    goals: GoalRun[] = [];
  const service = new ContinuationService({
    executions: x.executions as any,
    ledger: x.ledger as any,
    details: x.details as any,
    lanes: async () => ({ version: 1, lanes: [x.currentLane] }),
    profiles: async () => ({
      version: 1,
      activeProfileId: x.currentProfile.id,
      profiles: [x.currentProfile],
    }),
    startupFacts: () => facts,
    now: x.now,
    appVersion: "0.15.11",
  });
  const assertOwner = vi.fn((_session: string, _request: string) => {});
  const prepare = createDailyContinuationPreparation({
    read: async () => ({
      requests: x.records,
      tasks: x.tasks,
      startupFacts: facts,
      lanes: [
        { ...(x.sibling.snapshot.lane as DeviceLane), name: "账号一" },
        x.currentLane,
      ],
      profiles: {
        version: 1,
        activeProfileId: x.currentProfile.id,
        profiles: [x.currentProfile],
      },
      goals,
    }),
    preview: (id) => service.preview(id),
    assertOwner,
    now: x.now,
  });
  const principal = {
    sessionId: "chat",
    turnId: "turn",
    prompt: "更新好了，继续刚才的日常",
  };
  return {
    ...x,
    prepare,
    principal,
    facts,
    goals,
    assertOwner,
    service,
    failed,
    fresh,
    login,
  };
}

it("adopts only a reconciled startup-stopped daily without changing its original unknown result", async () => {
  const x = setup(),
    before = structuredClone(x.parent);
  const prepared = await x.prepare(x.principal);
  expect(prepared.frozenPlan).toEqual({
    kind: "continuation",
    hash: x.parent.fingerprint,
    parentRequestId: x.parent.id,
  });
  expect(prepared.scopes).toEqual([
    {
      laneId: "lane-b",
      gameId: "arknights",
      skillIds: ["login", "infrastructure", "award"],
      resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
    },
  ]);
  expect(prepared.payload).toMatchObject({
    continuation: { parentId: x.parent.id, acknowledgePartial: false },
  });
  expect(x.parent).toEqual(before);
});

it.each(["更新好了", "先看看能否继续日常", "不要继续日常"])(
  "does not turn %s into an execution grant",
  async (prompt) => {
    const x = setup();
    await expect(x.prepare({ ...x.principal, prompt })).rejects.toMatchObject({
      code: "MESSAGE_NOT_AUTHORIZED",
    });
  },
);

it("requires a verified fresh-login reconciliation fact", async () => {
  const x = setup();
  x.facts.length = 0;
  await expect(x.prepare(x.principal)).rejects.toMatchObject({
    code: "DAILY_CONTINUATION_BLOCKED",
  });
});

it("does not select another lane, another session, or a changed parent", async () => {
  const x = setup();
  await expect(
    x.prepare({ ...x.principal, prompt: "继续账号一的日常" }),
  ).rejects.toThrow();
  x.assertOwner.mockImplementation(() => {
    throw Error("另一会话");
  });
  await expect(x.prepare(x.principal)).rejects.toThrow();
  x.assertOwner.mockImplementation(() => {});
  await expect(
    x.prepare(x.principal, {
      parentRequestId: x.parent.id,
      parentFingerprint: "d".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "DAILY_CONTINUATION_CHANGED" });
});

it("rejects altered business evidence and cross-day requests", async () => {
  const x = setup();
  x.failed.steps[1].startedAt = x.parent.startedAt;
  await expect(x.prepare(x.principal)).rejects.toMatchObject({
    code: "DAILY_CONTINUATION_BLOCKED",
  });
  delete x.failed.steps[1].startedAt;
  x.setNow("2026-10-09T11:07:00.000Z");
  await expect(x.prepare(x.principal)).rejects.toThrow();
});

it("reports ambiguous original daily requests instead of guessing the newest", async () => {
  const x = setup();
  const other = structuredClone(x.parent);
  other.id = "other:lane-b";
  other.batchId = "other";
  x.records.push(other);
  await expect(x.prepare(x.principal)).rejects.toMatchObject({
    code: "DAILY_CONTINUATION_AMBIGUOUS",
  });
});

it("refuses task narrowing or expansion during continuation", async () => {
  const x = setup();
  await expect(
    x.prepare({ ...x.principal, prompt: "只继续基建" }),
  ).rejects.toThrow();
  await expect(
    x.prepare({ ...x.principal, prompt: "继续日常，跳过基建" }),
  ).rejects.toThrow();
  await expect(
    x.prepare({ ...x.principal, prompt: "继续阴阳师日常" }),
  ).rejects.toThrow();
  await expect(
    x.prepare({ ...x.principal, prompt: "只继续基建日常" }),
  ).rejects.toThrow();
});

it.each([
  "继续刚才的日常，不需要做基建",
  "继续刚才的日常，基建不需要做",
  "继续刚才的日常，不准做基建",
  "继续账号二的日常，明日方舟不需要继续",
  "继续刚才的日常，基建不需要再做",
  "继续刚才的日常，基建不允许继续",
  "继续刚才的日常，基建不需要",
])("never admits the frozen business contradicted by %s", async (prompt) => {
  const x = setup();
  await expect(x.prepare({ ...x.principal, prompt })).rejects.toThrow();
  expect(x.executions.begin).not.toHaveBeenCalled();
});

it.each(["不必", "无需", "不用", "禁止", "暂不", "先不", "切勿", "勿"])(
  "honors postfix game restriction %s before adopting a daily",
  async (denial) => {
    const x = setup();
    await expect(
      x.prepare({
        ...x.principal,
        prompt: `继续账号二的日常，明日方舟${denial}做`,
      }),
    ).rejects.toThrow();
    expect(x.executions.begin).not.toHaveBeenCalled();
  },
);

it("rejects successor, closed history, changed binding, partial acknowledgment, and another Goal's parent", async () => {
  const x = setup();
  const preview = vi.spyOn(x.service, "preview");
  const normal = await x.service.preview(x.parent.id);
  preview.mockResolvedValueOnce({ ...normal, needsAcknowledgement: true });
  await expect(x.prepare(x.principal)).rejects.toMatchObject({
    code: "DAILY_CONTINUATION_BLOCKED",
  });
  preview.mockRestore();
  x.currentProfile.expectedUid = "987654321";
  await expect(x.prepare(x.principal)).rejects.toThrow();
  x.currentProfile.expectedUid = "123456789";
  x.parent.resolution = {
    at: x.now().toISOString(),
    reason: "closed",
    action: "dismissed",
  } as any;
  await expect(x.prepare(x.principal)).rejects.toThrow();
  delete x.parent.resolution;
  const child = structuredClone(x.parent);
  child.id = "child:lane-b";
  child.snapshot.continuation = { parentId: x.parent.id };
  x.records.push(child);
  await expect(x.prepare(x.principal)).rejects.toThrow();
  x.records.pop();
  x.goals.push({
    sessionId: "another-chat",
    turnId: "another-turn",
    selection: { kind: "saved-daily" },
    attempts: [{ submission: { requestIds: [x.parent.id] } }],
  } as GoalRun);
  await expect(x.prepare(x.principal)).rejects.toThrow();
});

it("persists a current-chat continuation before using the existing executor and never replays after restoration", async () => {
  const x = setup();
  let stored: GoalStore | undefined;
  const launch = vi.fn(async () => {});
  const submit = vi.fn(async (goal, prepared, signal) => {
    expect(stored?.goals[0].submission?.parentRequestId).toBe(x.parent.id);
    const receipt = await x.service.startForGoal(
      prepared.payload.continuation,
      launch,
      signal,
      {
        batchId: goal.submission.batchId,
        origin: { requestId: goal.id, kind: "continue" },
      },
    );
    return { batchId: receipt.batchId, requestIds: [receipt.requestId] };
  });
  const observe = async () => ({
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
    summary: "waiting",
  });
  const goals = new GoalService({
    now: x.now,
    save: async (value) => {
      stored = structuredClone(value);
      x.goals.splice(0, x.goals.length, ...value.goals);
    },
    prepare: (goal) => runtime.prepare(goal),
    submit,
    observe,
    stop: observe,
  });
  const runtime = createGoalRuntime({
    goals,
    now: x.now,
    assertCurrent: async () => {},
    prepareSaved: async () => {
      throw Error("must not start full daily");
    },
    prepareDraft: async () => {
      throw Error("must not start new plan");
    },
    prepareContinuation: x.prepare,
    preferences: async () => ({}),
  });
  const binding = runtime.bind(x.principal, "planner", "recorded"),
    context = { callId: "resume", signal: new AbortController().signal };
  const [one, two] = (await Promise.all([
    binding.call("resume_daily", {}, context),
    binding.call("resume_daily", {}, context),
  ])) as GoalRun[];
  expect(one.id).toBe(two.id);
  expect(one.status).toBe("waiting");
  expect(one.sessionId).toBe("chat");
  expect(submit).toHaveBeenCalledTimes(1);
  expect(x.executions.begin).toHaveBeenCalledTimes(1);
  expect(launch).toHaveBeenCalledTimes(1);
  const child = x.records.at(-1)!;
  expect(child.snapshot.continuation).toMatchObject({
    parentId: x.parent.id,
    parentFingerprint: x.parent.fingerprint,
  });
  expect(x.parent.status).toBe("unknown");
  const restored = new GoalService({
    load: async () => stored,
    save: async () => {},
    prepare: (goal) => runtime.prepare(goal),
    submit,
    observe,
    stop: observe,
    now: x.now,
  });
  await restored.submit(one.id, x.principal);
  expect(submit).toHaveBeenCalledTimes(1);
});
