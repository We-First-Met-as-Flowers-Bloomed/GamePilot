import { expect, it, vi } from "vitest";
import { GoalService } from "../apps/desktop/main/agent-goals";
import {
  IncidentAgentService,
  type PreparedIncident,
} from "../apps/desktop/main/incident-agent";
import type {
  GoalObservation,
  GoalStore,
  GoalRecoveryReference,
  GoalRun,
} from "../packages/protocol/agent-goal";

it("defers Goal-managed navigation until the Goal's new accepted attempt is durable", async () => {
  const at = "2026-10-05T04:00:00.000Z",
    owner = { sessionId: "session-a", turnId: "turn-a" };
  const scope = {
    laneId: "lane-a",
    gameId: "arknights",
    skillIds: ["login", "award"],
    resources: { medicine: 0, stone: 0 },
  };
  let stored: GoalStore | undefined;
  const order: string[] = [];
  let observation: GoalObservation = {
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
    summary: "waiting",
  };
  const prepared = {
    fingerprint: "frozen",
    summary: [],
    payload: {},
    frozenPlan: { kind: "saved-daily" as const, hash: "original" },
    scopes: [scope],
  };
  const goals = new GoalService({
    now: () => new Date(at),
    save: async (store) => {
      stored = structuredClone(store);
      if (
        store.goals[0]?.submission?.attempt === 1 &&
        store.goals[0]?.submission?.state === "accepted"
      )
        order.push("accepted");
    },
    prepare: async () => prepared,
    submit: async (goal) => {
      if (goal.submission!.attempt === 1) {
        expect(stored?.goals[0].submission?.attempt).toBe(1);
        expect(stored?.goals[0].submission?.state).toBe("accepted");
        order.push("navigate");
      }
      return {
        batchId: goal.submission!.batchId,
        requestIds: goal.submission!.requestIds,
      };
    },
    observe: async () => observation,
    stop: async () => observation,
    recover: async (_goal, reference) => ({
      ...prepared,
      frozenPlan: {
        kind: "continuation",
        hash: "remaining",
        parentRequestId: reference.requestId,
      },
    }),
  });
  const goal = await goals.submit(
    (
      await goals.create({
        ...owner,
        prompt: "原计划继续，最多恢复两次",
        selection: { kind: "saved-daily" },
        grant: {
          id: "grant-a",
          source: "user-message",
          ...owner,
          issuedAt: at,
          expiresAt: "2026-10-05T05:00:00.000Z",
          maxRetries: 2,
          scopes: [scope],
        },
      })
    ).id,
    owner,
  );
  const reference: GoalRecoveryReference = {
    ...scope,
    requestId: goal.submission!.requestIds[0],
    reference: "known-page-return",
    safety: {
      kind: "bounded-navigation",
      fingerprint: "proof",
      observedAt: at,
      nativeSubmission: "known",
      accountProof: "login-gate-before-effects",
    },
  };
  observation = {
    requests: [
      {
        requestId: reference.requestId,
        laneId: scope.laneId,
        gameId: scope.gameId,
        status: "unknown",
        flowComplete: false,
        goalSatisfied: false,
        skills: [],
      },
    ],
    flowComplete: false,
    goalSatisfied: false,
    summary: "原生操作已核对；需要返回已知主页",
    recovery: reference,
  };
  await goals.refresh(goal.id);
  const legacyNavigate = vi.fn(async () => {
    throw Error("navigation must be deferred");
  });
  const p = {
    fingerprint: "incident-fp",
    automaticAllowed: false,
    screens: [],
    bundle: { incident: {}, screens: [] },
    recovery: {
      kind: "return-arknights-home",
      gameId: "arknights",
      runId: "original-run",
      fromPage: "friends-list",
    },
    preview: {
      parentId: reference.requestId,
      fingerprint: "parent-fp",
      canContinue: true,
      reasons: [],
      defaults: [{ gameId: "arknights", skillIds: ["award"] }],
      steps: [],
      needsAcknowledgement: true,
    },
  } as unknown as PreparedIncident;
  const incidents = new IncidentAgentService({
    prepare: async () => p,
    currentFingerprint: async () => p.fingerprint,
    available: () => true,
    diagnose: async () => ({
      model: "offline-stub",
      diagnosis: {
        summary: "可登记受限主页返回",
        basis: ["known-page"],
        action: "retry-remaining",
      },
    }),
    recover: legacyNavigate,
    hostManagedRecovery: () =>
      goals.get(goal.id, owner).status === "recovering",
    resume: async () => {
      order.push("goal-resume");
      const resumed = await goals.recover(goal.id, owner);
      return { requestId: resumed.receipt!.requestIds[0] };
    },
    save: async () => {},
  });
  await incidents.enqueue(reference.requestId);
  await incidents.tick();
  await incidents.idle();
  expect(legacyNavigate).not.toHaveBeenCalled();
  expect(order).toEqual(["goal-resume", "accepted", "navigate"]);
  expect(incidents.snapshot().sessions[0].status).toBe("resumed");
});

it("refuses a Goal-owned navigation without a registered recovery instead of using the legacy continuation path", async () => {
  const at = "2026-10-05T04:00:00.000Z",
    owner = { sessionId: "session-a", turnId: "turn-a" };
  const scope = {
    laneId: "lane-a",
    gameId: "arknights",
    skillIds: ["login", "award"],
    resources: { medicine: 0, stone: 0 },
  };
  const prepared = {
    fingerprint: "frozen",
    summary: [],
    payload: {},
    frozenPlan: { kind: "saved-daily" as const, hash: "original" },
    scopes: [scope],
  };
  let observation: GoalObservation = {
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
    summary: "waiting",
  };
  const submit = vi.fn(async (goal: GoalRun) => ({
    batchId: goal.submission!.batchId,
    requestIds: goal.submission!.requestIds,
  }));
  const prepareRecovery = vi.fn(async () => prepared);
  const goals = new GoalService({
    now: () => new Date(at),
    save: async () => {},
    prepare: async () => prepared,
    submit,
    observe: async () => observation,
    stop: async () => observation,
    recover: prepareRecovery,
  });
  const goal = await goals.submit(
    (
      await goals.create({
        ...owner,
        prompt: "原目标可在已登记证据内恢复",
        selection: { kind: "saved-daily" },
        grant: {
          id: "grant-a",
          source: "user-message",
          ...owner,
          issuedAt: at,
          expiresAt: "2026-10-05T05:00:00.000Z",
          maxRetries: 2,
          scopes: [scope],
        },
      })
    ).id,
    owner,
  );
  const requestId = goal.submission!.requestIds[0];
  observation = {
    requests: [
      {
        requestId,
        laneId: "lane-a",
        gameId: "arknights",
        status: "unknown",
        flowComplete: false,
        goalSatisfied: null,
        skills: [],
      },
    ],
    flowComplete: false,
    goalSatisfied: null,
    summary: "恢复没有登记；原结果未知",
  };
  await goals.refresh(goal.id);
  const legacyNavigate = vi.fn(async () => ({
    verified: true as const,
    observedAt: new Date().toISOString(),
    evidenceRefs: ["legacy-home"],
  }));
  const p = {
    fingerprint: "incident-fp",
    automaticAllowed: true,
    screens: [],
    bundle: { incident: {}, screens: [] },
    recovery: {
      kind: "return-arknights-home",
      gameId: "arknights",
      runId: "original-run",
      fromPage: "friends-list",
    },
    preview: {
      parentId: requestId,
      fingerprint: "parent-fp",
      canContinue: true,
      reasons: [],
      defaults: [{ gameId: "arknights", skillIds: ["award"] }],
      steps: [],
      needsAcknowledgement: true,
    },
  } as unknown as PreparedIncident;
  const incidents = new IncidentAgentService({
    prepare: async () => p,
    currentFingerprint: async () => p.fingerprint,
    available: () => true,
    hostManagedRecovery: (id) => id === requestId,
    diagnose: async () => ({
      model: "offline-stub",
      diagnosis: {
        summary: "known navigation is only a proposal",
        basis: ["known-page"],
        action: "retry-remaining",
      },
    }),
    recover: legacyNavigate,
    resume: async () => {
      const resumed = await goals.recover(goal.id, owner);
      if (resumed.submission?.attempt !== 1 || !resumed.receipt)
        throw Error("No registered Goal recovery was accepted");
      return { requestId: resumed.receipt.requestIds[0] };
    },
    save: async () => {},
  });
  await incidents.enqueue(requestId);
  await incidents.tick();
  await incidents.idle();
  expect(legacyNavigate).not.toHaveBeenCalled();
  expect(prepareRecovery).not.toHaveBeenCalled();
  expect(submit).toHaveBeenCalledOnce();
  expect(goals.get(goal.id, owner)).toMatchObject({
    status: "needs-user",
    retryCount: 0,
  });
  expect(goals.get(goal.id, owner).attempts).toHaveLength(1);
  expect(goals.get(goal.id, owner).requests[0].status).toBe("unknown");
  expect(incidents.snapshot().sessions[0].status).toBe("failed");
});

it("does not fall back to legacy navigation when a Goal registration is revoked before resume", async () => {
  let checks = 0;
  const navigate = vi.fn(async () => ({
    verified: true as const,
    observedAt: new Date().toISOString(),
    evidenceRefs: ["home"],
  }));
  const resume = vi.fn(async () => ({ requestId: "child" }));
  const prepared = {
    fingerprint: "fp",
    automaticAllowed: false,
    screens: [],
    bundle: { incident: {}, screens: [] },
    recovery: {
      kind: "return-arknights-home",
      gameId: "arknights",
      runId: "run",
      fromPage: "friends-list",
    },
    preview: {
      parentId: "parent",
      fingerprint: "fp",
      canContinue: true,
      reasons: [],
      defaults: [{ gameId: "arknights", skillIds: ["award"] }],
      steps: [],
      needsAcknowledgement: true,
    },
  } as unknown as PreparedIncident;
  const incidents = new IncidentAgentService({
    prepare: async () => prepared,
    currentFingerprint: async () => "fp",
    available: () => true,
    hostManagedRecovery: () => ++checks === 1,
    recover: navigate,
    resume,
    diagnose: async () => ({
      model: "offline-stub",
      diagnosis: {
        summary: "known-page",
        basis: ["known-page"],
        action: "retry-remaining",
      },
    }),
    save: async () => {},
  });
  await incidents.enqueue("parent");
  await incidents.tick();
  await incidents.idle();
  expect(navigate).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(incidents.snapshot().sessions[0].status).toBe("failed");
});
