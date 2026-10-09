import { expect, it, vi } from "vitest";
import { GoalService } from "../apps/desktop/main/agent-goals";
import { createGoalObserver } from "../apps/desktop/main/agent-goal-observer";
import { createGoalStartupRecovery } from "../apps/desktop/main/agent-startup-recovery";
import { startupRecoveryFixture } from "./startup-recovery-fixture";
import type { GoalRun, GoalStore } from "../packages/protocol/agent-goal";
import type { ContinuationInput } from "../packages/protocol/continuation";
import type { Plan } from "../packages/protocol";

const owner = { sessionId: "startup-session", turnId: "startup-turn" };
async function setup(skillIds = ["login"]) {
  const s = startupRecoveryFixture(skillIds);
  let stored: GoalStore | undefined;
  const scopes = ["lane-a", "lane-b"].map((laneId) => ({
    laneId,
    gameId: "arknights",
    skillIds,
    resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
  }));
  const host = createGoalStartupRecovery(s.continuation, s.now);
  const observer = createGoalObserver({
    executions: s.executions,
    ledger: s.ledger,
    findRecovery: (context) =>
      host.find(context.goal, context.candidateRequestIds),
    prepareRecovery: ({ goal }, ref) => host.prepare(goal, ref),
  });
  const launch = vi.fn(async () => {});
  const submit = vi.fn(
    async (goal: GoalRun, prepared: any, signal?: AbortSignal) => {
      if (prepared.payload.continuation) {
        const receipt = await s.continuation.startForGoal(
          prepared.payload.continuation as ContinuationInput,
          launch,
          signal,
          {
            batchId: goal.submission!.batchId,
            origin: { requestId: goal.id, kind: "continue" },
          },
        );
        return { batchId: receipt.batchId, requestIds: [receipt.requestId] };
      }
      const batchId = goal.submission!.batchId;
      for (const record of s.records) {
        record.batchId = batchId;
        record.id = `${batchId}:${record.laneId}`;
      }
      s.tasks[0] = s.succeeded(s.sibling);
      return { batchId, requestIds: goal.submission!.requestIds };
    },
  );
  const deps = {
    save: async (v: GoalStore) => {
      stored = structuredClone(v);
    },
    load: async () => stored,
    prepare: async () => ({
      fingerprint: "initial",
      frozenPlan: { kind: "saved-daily" as const, hash: "initial" },
      scopes,
      summary: [],
      payload: {},
    }),
    submit,
    observe: observer.observe,
    recover: observer.recover,
    stop: async () => ({
      requests: [],
      flowComplete: false,
      goalSatisfied: null,
      summary: "停止",
    }),
    now: s.now,
  };
  const goals = new GoalService(deps);
  const created = await goals.create({
    ...owner,
    prompt: "登录两个账号，临时故障最多重试两次",
    selection: { kind: "saved-daily" },
    grant: {
      id: "startup-grant",
      source: "user-message",
      ...owner,
      issuedAt: "2026-10-08T11:01:00.000Z",
      expiresAt: "2026-10-08T12:00:00.000Z",
      maxRetries: 2,
      scopes,
    },
  });
  const goal = await goals.submit(created.id, owner);
  return {
    ...s,
    goals,
    host,
    goal,
    submit,
    launch,
    deps,
    stored: () => stored,
  };
}

it("automatically retries only the proven unsubmitted sibling and retains the original success", async () => {
  const s = await setup();
  const original = structuredClone(s.records);
  await s.host.settled(s.goals, s.goal.id);
  expect(s.submit).toHaveBeenCalledTimes(2);
  const goal = s.goals.get(s.goal.id, owner);
  expect(goal.retryCount).toBe(1);
  expect(goal.submission!.requestIds).toEqual([
    `${goal.submission!.batchId}:lane-b`,
  ]);
  expect(s.records.slice(0, 2)).toEqual(original);
  const child = s.records.at(-1)!;
  child.status = "succeeded";
  child.finishedAt = "2026-10-08T11:08:00.000Z";
  s.tasks.push(s.succeeded(child));
  s.setNow(child.finishedAt);
  await s.host.settled(s.goals, s.goal.id);
  expect(s.goals.get(s.goal.id, owner).status).toBe("completed");
  expect(s.submit).toHaveBeenCalledTimes(2);
});

it("does not auto-submit when merely observing or restoring an old needs-user goal; explicit recovery still works", async () => {
  const s = await setup();
  await s.goals.refresh(s.goal.id);
  expect(s.submit).toHaveBeenCalledTimes(1);
  const stored = s.stored()!;
  stored.goals[0].status = "needs-user";
  const restartedHost = createGoalStartupRecovery(s.continuation, s.now);
  const restartedObserver = createGoalObserver({
    executions: s.executions,
    ledger: s.ledger,
    findRecovery: (context) =>
      restartedHost.find(context.goal, context.candidateRequestIds),
    prepareRecovery: ({ goal }, ref) => restartedHost.prepare(goal, ref),
  });
  const restarted = new GoalService({
    ...s.deps,
    load: async () => structuredClone(stored),
    observe: restartedObserver.observe,
    recover: restartedObserver.recover,
  });
  await restarted.ready();
  await restarted.reconcile();
  await restarted.refresh(s.goal.id);
  expect(s.submit).toHaveBeenCalledTimes(1);
  await restarted.recover(s.goal.id, owner);
  expect(s.submit).toHaveBeenCalledTimes(2);
  expect(s.records.at(-1)!.laneId).toBe("lane-b");
});

it.each([{ skillIds: ["login"] }, { skillIds: ["login", "award"] }])(
  "serializes duplicate callbacks and uses the same two-retry budget for $skillIds",
  async ({ skillIds }) => {
    const s = await setup(skillIds);
    await Promise.all([
      s.host.settled(s.goals, s.goal.id),
      s.host.settled(s.goals, s.goal.id),
    ]);
    expect(s.submit).toHaveBeenCalledTimes(2);
    for (let n = 0; n < 2; n++) {
      const child = s.records.at(-1)!;
      child.status = "failed";
      child.finishedAt = `2026-10-08T11:${String(8 + n).padStart(2, "0")}:00.000Z`;
      child.startupFault = {
        version: 1,
        source: "startup",
        code: "mumu-boot-timeout",
        observedAt: child.finishedAt,
      };
      s.setNow(child.finishedAt);
      await s.host.settled(s.goals, s.goal.id);
    }
    expect(s.submit).toHaveBeenCalledTimes(3);
    expect(s.goals.get(s.goal.id, owner).retryCount).toBe(2);
    expect(s.goals.get(s.goal.id, owner).status).toBe("needs-user");
  },
);

it.each(["expired", "cancelled"])(
  "does not recover a %s original grant",
  async (state) => {
    const s = await setup();
    if (state === "expired") s.setNow("2026-10-08T12:01:00.000Z");
    else await s.goals.cancel(s.goal.id, owner);
    await s.host.settled(s.goals, s.goal.id);
    expect(s.submit).toHaveBeenCalledTimes(1);
  },
);

it("revalidates the complete task ledger after a startup recovery reference was registered", async () => {
  const s = await setup();
  await s.goals.refresh(s.goal.id);
  expect(s.goals.get(s.goal.id, owner).recovery).toBeDefined();
  s.tasks.push(s.succeeded(s.parent));
  await s.goals.recover(s.goal.id, owner);
  expect(s.submit).toHaveBeenCalledTimes(1);
  expect(s.executions.begin).not.toHaveBeenCalled();
});

it("does not silently accept a smaller remaining scope when earlier independent work requires acknowledgement", async () => {
  const s = await setup(["login", "friends", "award"]);
  const older = {
    ...structuredClone(s.parent),
    id: "earlier:lane-b",
    batchId: "earlier",
    status: "succeeded" as const,
    startupFault: undefined,
    startedAt: "2026-10-08T10:00:00.000Z",
    finishedAt: "2026-10-08T10:01:00.000Z",
  };
  (older.snapshot.arknightsPlan as Plan).skillIds = ["login", "friends"];
  s.records.push(older);
  s.tasks.push(s.succeeded(older));
  await s.host.settled(s.goals, s.goal.id);
  expect(s.goals.get(s.goal.id, owner).status).toBe("needs-user");
  expect(s.submit).toHaveBeenCalledTimes(1);
  expect(s.executions.begin).not.toHaveBeenCalled();
});
