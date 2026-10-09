import { describe, expect, it, vi } from "vitest";
import { GoalService } from "../apps/desktop/main/agent-goals";
import type {
  GoalExecutionGrant,
  GoalObservation,
  GoalRun,
  GoalScope,
  GoalSelection,
  GoalStore,
} from "../packages/protocol/agent-goal";

const at = "2026-10-05T08:00:00.000Z";
const recoverySafety = {
  kind: "native-not-submitted" as const,
  fingerprint: "proof-a",
  observedAt: at,
  accountProof: "verified-current" as const,
  nativeSubmission: "not-submitted" as const,
};
const owner = { sessionId: "session-a", turnId: "turn-a" };
const scope: GoalScope = {
  laneId: "lane-a",
  gameId: "arknights",
  skillIds: ["login", "award"],
  resources: { medicine: 0, stone: 0 },
};
function grant(scopes = [scope]): GoalExecutionGrant {
  return {
    id: "grant-a",
    source: "user-message",
    ...owner,
    issuedAt: at,
    expiresAt: "2026-10-05T09:00:00.000Z",
    maxRetries: 2,
    scopes,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup(initial?: GoalStore) {
  let stored = initial ? structuredClone(initial) : undefined;
  let observation: GoalObservation = {
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
    summary: "运行中",
  };
  const calls: string[] = [];
  const prepared = {
    fingerprint: "fingerprint-a",
    summary: [],
    payload: { frozen: true },
    frozenPlan: { kind: "saved-daily" as const, hash: "a".repeat(64) },
    scopes: [scope],
  };
  const prepare = vi.fn(
    async (_goal: GoalRun, _selection: GoalSelection) => prepared,
  );
  const submit = vi.fn(
    async (goal: GoalRun, _prepared?: unknown, _signal?: AbortSignal) => {
      calls.push("submit");
      expect(stored?.goals.find((g) => g.id === goal.id)?.submission).toEqual(
        goal.submission,
      );
      return {
        batchId: goal.submission!.batchId,
        requestIds: goal.submission!.requestIds,
      };
    },
  );
  const observe = vi.fn(async () => observation);
  const stop = vi.fn(async (goal: GoalRun): Promise<GoalObservation> => ({
    requests: goal.submission!.requestIds.map((requestId) => ({
      requestId,
      laneId: "lane-a",
      status: "cancelled",
      flowComplete: true,
      goalSatisfied: null,
      skills: [],
    })),
    flowComplete: true,
    goalSatisfied: null,
    summary: "已核实停止",
    stopVerification: {
      verified: true,
      requestIds: goal.attempts.flatMap(
        (attempt) => attempt.submission.requestIds,
      ),
      observedAt: at,
      evidenceReference: "runtime:verified-worker-stop",
    },
  }));
  const recover = vi.fn(
    async (
      _goal: GoalRun,
      recovery: import("../packages/protocol/agent-goal").GoalRecoveryReference,
    ) => ({
      ...prepared,
      scopes: [{ ...scope, skillIds: ["award"] }],
      frozenPlan: {
        kind: "continuation" as const,
        hash: "b".repeat(64),
        parentRequestId: recovery.requestId,
      },
    }),
  );
  const save = vi.fn(async (v: GoalStore) => {
    calls.push("save");
    stored = structuredClone(v);
  });
  const deps = {
    load: async () => stored,
    save,
    prepare,
    submit,
    observe,
    stop,
    recover,
    now: () => new Date(at),
  };
  const service = new GoalService(deps);
  const create = (overrides: Record<string, unknown> = {}) =>
    service.create({
      ...owner,
      prompt: "按保存计划跑账号一，不吃药",
      selection: { kind: "saved-daily" },
      grant: grant(),
      ...overrides,
    });
  return {
    service,
    create,
    prepare,
    submit,
    observe,
    stop,
    recover,
    save,
    calls,
    stored: () => stored,
    setObservation: (o: GoalObservation) => {
      observation = o;
    },
    prepared,
    deps,
  };
}
function outcome(
  goal: GoalRun,
  satisfied: boolean | null,
  status: "succeeded" | "failed" | "unknown" = "succeeded",
): GoalObservation {
  return {
    requests: goal.submission!.requestIds.map((requestId) => ({
      requestId,
      laneId: "lane-a",
      status,
      flowComplete: true,
      goalSatisfied: satisfied,
      skills: goal.originalReview!.scopes.flatMap((scope) =>
        scope.skillIds.map((skillId) => ({
          skillId,
          gameId: scope.gameId,
          status,
          goalSatisfied: satisfied,
          summary: "实际步骤",
          evidenceTimestamp: at,
          evidenceReference: `request:${requestId}:${skillId}`,
        })),
      ),
    })),
    flowComplete: true,
    goalSatisfied: satisfied,
    summary: "实际结果",
  };
}

describe("persistent autonomous game goals", () => {
  it("deduplicates a session turn and persists acceptance before the host effect", async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.create(), t.create()]);
    expect(a.id).toBe(b.id);
    await Promise.all([
      t.service.submit(a.id, owner),
      t.service.submit(b.id, owner),
    ]);
    expect(t.submit).toHaveBeenCalledOnce();
    const g = t.service.get(a.id, owner);
    expect(g.originalReview?.frozenPlan.hash).toBe("a".repeat(64));
    expect(g.receipt?.requestIds).toEqual(g.submission?.requestIds);
    expect(t.calls.indexOf("submit")).toBeGreaterThan(0);
  });
  it("cancels pending preparation immediately and never launches after it returns", async () => {
    const t = setup();
    const pending = deferred<typeof t.prepared>();
    t.prepare.mockImplementation(() => pending.promise);
    const goal = await t.create();
    const submission = t.service.submit(goal.id, owner);
    await vi.waitFor(() => expect(t.prepare).toHaveBeenCalledOnce());
    expect((await t.service.cancel(goal.id, owner)).status).toBe("cancelled");
    pending.resolve(t.prepared);
    expect((await submission).status).toBe("cancelled");
    expect(t.submit).not.toHaveBeenCalled();
  });
  it("does not dispatch when the model turn aborts during deferred preparation", async () => {
    const t = setup();
    const prepared = deferred<typeof t.prepared>();
    t.prepare.mockImplementation(() => prepared.promise);
    const goal = await t.create();
    const model = new AbortController();
    const submission = t.service.submit(goal.id, owner, model.signal);
    await vi.waitFor(() => expect(t.prepare).toHaveBeenCalledOnce());
    model.abort();
    prepared.resolve(t.prepared);
    expect((await submission).status).toBe("cancelled");
    expect(t.service.get(goal.id, owner).submission).toBeUndefined();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.stop).not.toHaveBeenCalled();
    expect(t.stored()?.goals[0].status).toBe("cancelled");
  });
  it("keeps a durably accepted goal independent of later model cancellation", async () => {
    const t = setup();
    const goal = await t.create();
    const model = new AbortController();
    t.service.subscribe((view) => {
      if (view.goals[0].submission?.state === "accepted") model.abort();
    });
    const submitted = await t.service.submit(goal.id, owner, model.signal);
    expect(model.signal.aborted).toBe(true);
    expect(submitted.status).toBe("waiting");
    expect(submitted.receipt?.requestIds).toEqual(
      submitted.submission?.requestIds,
    );
    expect(t.submit).toHaveBeenCalledWith(
      expect.anything(),
      t.prepared,
      expect.any(AbortSignal),
    );
    expect(t.submit.mock.calls[0][2]!.aborted).toBe(false);
    expect(t.stop).not.toHaveBeenCalled();
  });
  it("preserves a reservation without dispatch when cancellation wins during its durable save", async () => {
    const t = setup();
    const goal = await t.create();
    const saved = deferred<void>();
    const persist = t.save.getMockImplementation()!;
    t.save.mockImplementationOnce(async (store) => {
      await saved.promise;
      await persist(store);
    });
    const model = new AbortController();
    const submission = t.service.submit(goal.id, owner, model.signal);
    await vi.waitFor(() =>
      expect(t.save.mock.lastCall?.[0].goals[0].submission?.state).toBe(
        "accepted",
      ),
    );
    model.abort();
    saved.resolve();
    const cancelled = await submission;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.submission?.state).toBe("accepted");
    expect(cancelled.receipt).toBeUndefined();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.stop).not.toHaveBeenCalled();
    const restarted = setup(t.stored());
    await restarted.service.reconcile();
    expect(restarted.service.get(goal.id, owner).status).toBe("cancelled");
    expect(restarted.submit).not.toHaveBeenCalled();
    expect(restarted.stop).not.toHaveBeenCalled();
  });
  it("stops an accepted request even when the host admission response arrives after cancellation", async () => {
    const t = setup();
    const response = deferred<{ batchId: string; requestIds: string[] }>();
    t.submit.mockImplementation(() => response.promise);
    const goal = await t.create();
    const starting = t.service.submit(goal.id, owner);
    await vi.waitFor(() => expect(t.submit).toHaveBeenCalledOnce());
    const cancelled = t.service.cancel(goal.id, owner);
    const reservation = t.service.get(goal.id, owner).submission!;
    response.resolve({
      batchId: reservation.batchId,
      requestIds: reservation.requestIds,
    });
    await Promise.all([starting, cancelled]);
    expect(t.stop).toHaveBeenCalled();
    expect(t.service.get(goal.id, owner).status).toBe("cancelled");
  });
  it("refuses another session and another original turn before calling the host", async () => {
    const t = setup();
    const g = await t.create();
    await expect(
      t.service.submit(g.id, { sessionId: "session-b", turnId: "turn-a" }),
    ).rejects.toThrow();
    await expect(
      t.service.submit(g.id, { ...owner, turnId: "old-turn" }),
    ).rejects.toThrow();
    expect(() => t.service.get(g.id, { sessionId: "session-b" })).toThrow();
    expect(t.prepare).not.toHaveBeenCalled();
  });
  it("requires resource and skill scope before admission including explicit resource zero", async () => {
    const t = setup();
    t.prepare.mockResolvedValue({
      ...t.prepared,
      scopes: [{ ...scope, resources: { medicine: 1, stone: 0 } }],
    });
    const g = await t.create();
    expect((await t.service.submit(g.id, owner)).status).toBe("needs-user");
    expect(t.submit).not.toHaveBeenCalled();
  });
  it("retains a durable unknown admission and never resubmits after restart", async () => {
    const t = setup();
    t.submit.mockRejectedValue(new Error("lost admission response"));
    const g = await t.create();
    expect((await t.service.submit(g.id, owner)).status).toBe("unknown");
    const restarted = setup(t.stored());
    await restarted.service.ready();
    await restarted.service.reconcile();
    await restarted.service.submit(g.id, owner);
    expect(restarted.observe).toHaveBeenCalled();
    expect(restarted.submit).not.toHaveBeenCalled();
    expect(restarted.service.get(g.id, owner).status).toBe("unknown");
  });
  it("does not relaunch a preparing record left by a crash", async () => {
    const t = setup();
    const g = await t.create();
    const restarted = setup(t.stored());
    await restarted.service.reconcile();
    expect((await restarted.service.submit(g.id, owner)).status).toBe(
      "unknown",
    );
    expect(restarted.prepare).not.toHaveBeenCalled();
    expect(restarted.submit).not.toHaveBeenCalled();
  });
  it("cannot claim a goal complete when only the flow or skipped requests ended", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation(outcome(g, null));
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner).status).toBe("unknown");
    t.setObservation(outcome(g, true));
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner).status).toBe("completed");
  });
  it("keeps a sibling lane running when another lane requires user action", async () => {
    const t = setup();
    const other = { ...scope, laneId: "lane-b" };
    t.prepare.mockResolvedValue({ ...t.prepared, scopes: [scope, other] });
    const g = await t.service.submit(
      (await t.create({ grant: grant([scope, other]) })).id,
      owner,
    );
    t.setObservation({
      requests: [
        {
          requestId: g.submission!.requestIds[0],
          laneId: "lane-a",
          status: "failed",
          flowComplete: true,
          goalSatisfied: false,
          skills: [],
        },
        {
          requestId: g.submission!.requestIds[1],
          laneId: "lane-b",
          status: "running",
          flowComplete: false,
          goalSatisfied: null,
          skills: [],
        },
      ],
      flowComplete: false,
      goalSatisfied: false,
      summary: "账号一失败；账号二继续",
    });
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner).status).toBe("waiting");
    expect(t.stop).not.toHaveBeenCalled();
  });
  it("allows only registered failed-request recovery within original scopes and at most two retries", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    for (let n = 0; n < 3; n++) {
      const current = t.service.get(g.id, owner);
      t.setObservation({
        ...outcome(current, false, "failed"),
        recovery: {
          requestId: current.submission!.requestIds[0],
          laneId: "lane-a",
          gameId: "arknights",
          skillIds: ["award"],
          resources: { medicine: 0, stone: 0 },
          reference: `continuation-${n}`,
          safety: recoverySafety,
        },
      });
      await t.service.refresh(g.id);
      await t.service.recover(g.id, owner);
    }
    expect(t.recover).toHaveBeenCalledTimes(2);
    expect(t.submit).toHaveBeenCalledTimes(3);
    expect(t.service.get(g.id, owner).retryCount).toBe(2);
    expect(t.service.get(g.id, owner).status).toBe("needs-user");
  });
  it("fails closed with unknown state when durable acceptance cannot be saved", async () => {
    const t = setup();
    const g = await t.create();
    t.save.mockRejectedValue(new Error("disk full secret bearer token"));
    await expect(t.service.submit(g.id, owner)).rejects.toThrow("可靠保存");
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.service.get(g.id, owner).status).toBe("unknown");
    expect(JSON.stringify(t.service.snapshot())).not.toContain("bearer token");
  });
  it("flush waits for every already queued goal write before reporting persisted state", async () => {
    const t = setup(),
      first = deferred<void>(),
      second = deferred<void>();
    const persist = t.save.getMockImplementation()!;
    t.save
      .mockImplementationOnce(async (store) => {
        await first.promise;
        await persist(store);
      })
      .mockImplementationOnce(async (store) => {
        await second.promise;
        await persist(store);
      });
    const a = t.service.setPreferences({
      resourceLimits: { medicine: 0 },
      excludedSkills: [],
    });
    await vi.waitFor(() => expect(t.save).toHaveBeenCalledOnce());
    const b = t.service.setPreferences({
      resourceLimits: { medicine: 0, stone: 0 },
      excludedSkills: [],
    });
    // Let the second operation pass ready() and join the serialized write queue.
    await Promise.resolve();
    await Promise.resolve();
    let flushed = false;
    try {
      const flushing = t.service.flush().then(() => {
        flushed = true;
      });
      await Promise.resolve();
      expect(flushed).toBe(false);
      first.resolve();
      await a;
      await vi.waitFor(() => expect(t.save).toHaveBeenCalledTimes(2));
      expect(flushed).toBe(false);
      expect(t.stored()?.preferences?.resourceLimits).toEqual({ medicine: 0 });
      second.resolve();
      await Promise.all([b, flushing]);
      expect(flushed).toBe(true);
      expect(t.stored()?.preferences?.resourceLimits).toEqual({
        medicine: 0,
        stone: 0,
      });
    } finally {
      first.resolve();
      second.resolve();
      await Promise.allSettled([a, b]);
    }
  });
  it("flush rejects a pending durable save failure instead of claiming the result is saved", async () => {
    const t = setup(),
      writing = deferred<void>();
    await t.create();
    t.save.mockImplementationOnce(async () => {
      await writing.promise;
      throw Error("disk full private path");
    });
    const failedWrite = t.service
      .setPreferences({ resourceLimits: { medicine: 0 }, excludedSkills: [] })
      .catch((error) => error);
    await vi.waitFor(() => expect(t.save).toHaveBeenCalledTimes(2));
    try {
      const flushing = t.service.flush();
      const rejected = expect(flushing).rejects.toThrow("可靠保存");
      writing.resolve();
      await rejected;
      expect(await failedWrite).toBeInstanceOf(Error);
      expect(t.service.snapshot().error).toMatch(/可靠保存/);
      expect(JSON.stringify(t.service.snapshot())).not.toContain(
        "private path",
      );
    } finally {
      writing.resolve();
      await failedWrite;
    }
  });
  it("bounds waiting and sends a terminal callback to the same original conversation", async () => {
    const t = setup();
    const terminal = vi.fn();
    t.service.subscribeTerminal(terminal);
    const g = await t.service.submit((await t.create()).id, owner);
    expect((await t.service.wait(g.id, owner, { timeoutMs: 1 })).status).toBe(
      "waiting",
    );
    const waiting = t.service.wait(g.id, owner, {
      timeoutMs: 1000,
      afterRevision: g.revision,
    });
    t.setObservation(outcome(g, true));
    await t.service.refresh(g.id);
    expect((await waiting).status).toBe("completed");
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0][0].sessionId).toBe(owner.sessionId);
    expect(terminal.mock.calls[0][0].turnId).toBe(owner.turnId);
    await t.service.refresh(g.id);
    expect(terminal).toHaveBeenCalledOnce();
  });
  it("consumes final-result delivery durably before any model result reply", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation(outcome(g, true));
    await t.service.refresh(g.id);
    expect(await t.service.beginResultNotification(g.id, owner)).toBe(true);
    expect(await t.service.beginResultNotification(g.id, owner)).toBe(false);
    const restarted = setup(t.stored());
    await restarted.service.ready();
    expect(await restarted.service.beginResultNotification(g.id, owner)).toBe(
      false,
    );
    await restarted.service.setReply(g.id, owner, {
      text: "已根据实际结果核对完成",
    });
    expect(restarted.stored()?.goals[0].publicReply?.text).toContain(
      "实际结果",
    );
    expect(restarted.stored()?.goals[0].resultNotification?.state).toBe(
      "delivered",
    );
  });
  it("cannot finish a recovery while an original sibling lane has no observed result", async () => {
    const t = setup();
    const other = { ...scope, laneId: "lane-b" };
    t.prepare.mockResolvedValue({ ...t.prepared, scopes: [scope, other] });
    const g = await t.service.submit(
      (await t.create({ grant: grant([scope, other]) })).id,
      owner,
    );
    t.setObservation({
      requests: [
        {
          requestId: g.submission!.requestIds[0],
          laneId: "lane-a",
          status: "failed",
          flowComplete: true,
          goalSatisfied: false,
          skills: [],
        },
      ],
      flowComplete: true,
      goalSatisfied: false,
      summary: "账号一失败",
      recovery: {
        requestId: g.submission!.requestIds[0],
        laneId: "lane-a",
        gameId: "arknights",
        skillIds: ["award"],
        resources: { medicine: 0, stone: 0 },
        reference: "resume-a",
        safety: recoverySafety,
      },
    });
    await t.service.refresh(g.id);
    const continued = await t.service.recover(g.id, owner);
    t.setObservation(outcome(continued, true));
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner).status).toBe("unknown");
  });
  it("requires observed terminal status for every original request before confirming stop", async () => {
    const t = setup();
    const other = { ...scope, laneId: "lane-b" };
    t.prepare.mockResolvedValue({ ...t.prepared, scopes: [scope, other] });
    const g = await t.service.submit(
      (await t.create({ grant: grant([scope, other]) })).id,
      owner,
    );
    t.stop.mockResolvedValue({
      requests: [
        {
          requestId: g.submission!.requestIds[0],
          laneId: "lane-a",
          status: "cancelled",
          flowComplete: true,
          goalSatisfied: null,
          skills: [],
        },
      ],
      flowComplete: true,
      goalSatisfied: null,
      summary: "只确认账号一停止",
    });
    expect((await t.service.cancel(g.id, owner)).status).toBe("unknown");
  });
  it("refuses recovery of native-unknown requests and broader continuation scope", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const recovery = {
      requestId: g.submission!.requestIds[0],
      ...scope,
      reference: "resume-a",
      safety: recoverySafety,
    };
    t.setObservation({
      ...outcome(g, null, "unknown"),
      recovery: {
        ...recovery,
        safety: {
          ...recoverySafety,
          nativeSubmission: "unknown" as "not-submitted",
        },
      },
    });
    await t.service.refresh(g.id);
    await t.service.recover(g.id, owner);
    expect(t.recover).not.toHaveBeenCalled();
    t.setObservation({
      ...outcome(g, false, "failed"),
      recovery: { ...recovery, skillIds: ["award"] },
    });
    await t.service.refresh(g.id);
    t.recover.mockResolvedValue({
      ...t.prepared,
      frozenPlan: {
        kind: "continuation",
        hash: "b".repeat(64),
        parentRequestId: recovery.requestId,
      },
    });
    await t.service.recover(g.id, owner);
    expect(t.submit).toHaveBeenCalledOnce();
  });
  it("rejects expired grants and never exposes stored secrets in public goal fields", async () => {
    const t = setup();
    const g = await t.create({
      prompt: "运行；api_key=sk-sensitive-auth-12345678",
    });
    expect(JSON.stringify(t.stored())).not.toContain("sk-sensitive-auth");
    const expired = setup();
    const old = await expired.create({
      grant: {
        ...grant(),
        expiresAt: at,
        issuedAt: "2026-10-05T07:00:00.000Z",
      },
    });
    expect((await expired.service.submit(old.id, owner)).status).toBe(
      "needs-user",
    );
    expect(expired.submit).not.toHaveBeenCalled();
    expect(g.prompt).toContain("已隐藏");
  });
  it("admits independent goals concurrently while one lane waits for preparation", async () => {
    const t = setup();
    const pending = deferred<typeof t.prepared>();
    t.prepare.mockImplementation((g) =>
      g.turnId === "turn-a" ? pending.promise : Promise.resolve(t.prepared),
    );
    const a = await t.create();
    const ownerB = { sessionId: "session-b", turnId: "turn-b" };
    const b = await t.create({ ...ownerB, grant: { ...grant(), ...ownerB } });
    const first = t.service.submit(a.id, owner);
    expect((await t.service.submit(b.id, ownerB)).status).toBe("waiting");
    expect(t.submit).toHaveBeenCalledOnce();
    pending.resolve(t.prepared);
    await first;
    expect(t.submit).toHaveBeenCalledTimes(2);
  });
  it("preserves unknown after a lost durable receipt and refuses another submission", async () => {
    const t = setup();
    const g = await t.create();
    t.submit.mockImplementation(async (goal) => {
      t.save.mockRejectedValue(new Error("receipt write failed"));
      return {
        batchId: goal.submission!.batchId,
        requestIds: goal.submission!.requestIds,
      };
    });
    await expect(t.service.submit(g.id, owner)).rejects.toThrow("可靠保存");
    expect(t.service.get(g.id, owner).status).toBe("unknown");
    const restarted = setup(t.stored());
    await restarted.service.ready();
    await restarted.service.submit(g.id, owner);
    expect(restarted.submit).not.toHaveBeenCalled();
    expect(restarted.service.get(g.id, owner).submission?.state).toBe(
      "accepted",
    );
  });
  it("refuses a result for another goal without corrupting accepted request facts", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation({
      requests: [
        {
          requestId: "unrelated-request",
          status: "succeeded",
          flowComplete: true,
          goalSatisfied: true,
          skills: [],
        },
      ],
      flowComplete: true,
      goalSatisfied: true,
      summary: "another goal",
    });
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner).status).toBe("unknown");
    expect(t.service.get(g.id, owner).requests).toEqual([]);
  });
  it("refuses malformed persisted grants and duplicate session-turn entries", async () => {
    const t = setup();
    await t.create();
    const initial = structuredClone(t.stored()!);
    initial.goals[0].grant.maxRetries = 3 as 2;
    const restarted = setup(initial);
    await expect(restarted.service.ready()).rejects.toThrow("可靠保存");
    expect(restarted.submit).not.toHaveBeenCalled();
  });
  it("cannot finish without evidence covering the original game and skill scope", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const missing = outcome(g, true);
    missing.requests[0].skills = [];
    t.setObservation(missing);
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner).status).toBe("unknown");
  });
  it("recovers an actual unknown lease failure only when fresh host evidence proves native not submitted", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const failed = outcome(g, false, "unknown");
    failed.flowComplete = false;
    failed.requests[0].flowComplete = false;
    failed.recovery = {
      ...scope,
      skillIds: ["award"],
      requestId: g.submission!.requestIds[0],
      reference: "registered-native-unsubmitted",
      safety: recoverySafety,
    };
    t.setObservation(failed);
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner).status).toBe("recovering");
    expect((await t.service.recover(g.id, owner)).status).toBe("waiting");
    expect(t.recover).toHaveBeenCalledOnce();
    expect(t.submit).toHaveBeenCalledTimes(2);
  });
  it("refuses stale or mismatched identity recovery proof before host continuation preparation", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation({
      ...outcome(g, false, "failed"),
      recovery: {
        ...scope,
        requestId: g.submission!.requestIds[0],
        reference: "registered",
        safety: { ...recoverySafety, observedAt: "2026-10-05T07:00:00.000Z" },
      },
    });
    await t.service.refresh(g.id);
    expect((await t.service.recover(g.id, owner)).status).toBe("needs-user");
    expect(t.recover).not.toHaveBeenCalled();
  });
  it("persists resource-zero preferences across restart and applies them as a stricter admission cap", async () => {
    const t = setup();
    await t.service.setPreferences({
      resourceLimits: { medicine: 0, stone: 0 },
      excludedSkills: [],
    });
    const restarted = setup(t.stored());
    await restarted.service.ready();
    expect(restarted.service.preferences().resourceLimits.medicine).toBe(0);
    restarted.prepare.mockResolvedValue({
      ...restarted.prepared,
      scopes: [{ ...scope, resources: { medicine: 1, stone: 0 } }],
    });
    const g = await restarted.create({
      grant: grant([{ ...scope, resources: { medicine: 1, stone: 0 } }]),
    });
    expect((await restarted.service.submit(g.id, owner)).status).toBe(
      "needs-user",
    );
    expect(restarted.submit).not.toHaveBeenCalled();
  });
  it("stores excluded skills as preferences without turning them into old-chat authorization", async () => {
    const t = setup();
    await t.service.setPreferences({
      resourceLimits: {},
      excludedSkills: [{ gameId: "arknights", skillIds: ["award"] }],
    });
    const g = await t.create();
    expect((await t.service.submit(g.id, owner)).status).toBe("needs-user");
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.stored()?.goals[0].grant.id).toBe("grant-a");
  });
  it("preserves a newer terminal notification when an older model reply arrives late", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation(outcome(g, null));
    await t.service.refresh(g.id);
    const oldRevision = t.service.get(g.id, owner).resultNotification!.revision;
    await t.service.beginResultNotification(g.id, owner, oldRevision);
    t.setObservation(outcome(g, true));
    await t.service.refresh(g.id);
    await t.service.setReply(g.id, owner, {
      text: "旧模型答复：结果未知",
      notificationRevision: oldRevision,
    });
    const completed = t.service.get(g.id, owner);
    expect(completed.status).toBe("completed");
    expect(completed.resultNotification?.state).toBe("pending");
    expect(completed.publicReply).toBeUndefined();
    expect(
      await t.service.beginResultNotification(g.id, owner, oldRevision),
    ).toBe(false);
  });
  it("cannot persist model-invented completion over an unknown host outcome", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation(outcome(g, null, "unknown"));
    await t.service.refresh(g.id);
    const revision = t.service.get(g.id, owner).resultNotification!.revision;
    await t.service.beginResultNotification(g.id, owner, revision);
    await t.service.setReply(g.id, owner, {
      text: "两个账号所有游戏日常已全部完成",
      notificationRevision: revision,
    });
    const reply = t.stored()!.goals[0].publicReply!.text;
    expect(reply).toContain("结果未完整确认");
    expect(reply).not.toContain("全部完成");
    expect(t.stored()!.goals[0].status).toBe("unknown");
  });
  it("rejects malformed effect facts and preserves legitimate effects without marking a failed skill complete", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const observed = outcome(g, false, "failed");
    observed.requests[0].skills[1].effectEvidence = [
      {
        kind: "hana-claim",
        observedAt: at,
        evidenceReference: "",
        summary: "完成",
      },
    ];
    t.setObservation(observed);
    await t.service.refresh(g.id);
    expect(t.stored()!.goals[0].requests).toHaveLength(0);
    observed.requests[0].skills[1].effectEvidence[0].evidenceReference =
      "proof:a";
    t.setObservation(observed);
    await t.service.refresh(g.id);
    const saved = t.stored()!.goals[0];
    expect(saved.requests[0].skills[1].effectEvidence).toHaveLength(1);
    expect(saved.requests[0].skills[1].goalSatisfied).toBe(false);
    expect(saved.status).toBe("needs-user");
  });
  it("requires the original login gate before effects when current UID cannot yet be observed", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const recovery = {
      ...scope,
      requestId: g.submission!.requestIds[0],
      reference: "login-gate",
      safety: {
        ...recoverySafety,
        accountProof: "login-gate-before-effects" as const,
      },
    };
    t.setObservation({
      ...outcome(g, false, "unknown"),
      flowComplete: false,
      recovery,
    });
    await t.service.refresh(g.id);
    // Preparing only award would bypass the original worker's current-UID check.
    await t.service.recover(g.id, owner);
    expect(t.submit).toHaveBeenCalledOnce();
    t.recover.mockResolvedValue({
      ...t.prepared,
      frozenPlan: {
        kind: "continuation",
        hash: "b".repeat(64),
        parentRequestId: recovery.requestId,
      },
    });
    await t.service.refresh(g.id);
    expect((await t.service.recover(g.id, owner)).status).toBe("waiting");
    expect(t.submit).toHaveBeenCalledTimes(2);
  });
  it("does not rewind a newer observed completion with an older concurrent executor read", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const stale = deferred<GoalObservation>();
    t.observe.mockImplementationOnce(() => stale.promise);
    const first = t.service.refresh(g.id);
    await vi.waitFor(() => expect(t.observe).toHaveBeenCalledOnce());
    t.setObservation(outcome(g, true));
    await t.service.refresh(g.id);
    stale.resolve({
      requests: g.submission!.requestIds.map((requestId) => ({
        requestId,
        laneId: "lane-a",
        status: "running",
        flowComplete: false,
        goalSatisfied: null,
        skills: [],
      })),
      flowComplete: false,
      goalSatisfied: null,
      summary: "旧的运行中观察",
    });
    await first;
    expect(t.service.get(g.id, owner).status).toBe("completed");
  });
  it("continues both original games on the same lane after an unsubmitted login failure", async () => {
    const t = setup();
    const onmyoji: GoalScope = {
      laneId: "lane-a",
      gameId: "onmyoji",
      skillIds: ["login", "mail"],
      resources: {},
    };
    t.prepare.mockResolvedValue({ ...t.prepared, scopes: [scope, onmyoji] });
    const g = await t.service.submit(
      (await t.create({ grant: grant([scope, onmyoji]) })).id,
      owner,
    );
    const recovery = {
      ...scope,
      requestId: g.submission!.requestIds[0],
      reference: "two-game-original-remainder",
      remainingScopes: [scope, onmyoji],
      safety: {
        ...recoverySafety,
        accountProof: "login-gate-before-effects" as const,
      },
    };
    t.setObservation({
      ...outcome(g, false, "unknown"),
      flowComplete: false,
      recovery,
    });
    await t.service.refresh(g.id);
    t.recover.mockResolvedValue({
      ...t.prepared,
      scopes: [scope, onmyoji],
      frozenPlan: {
        kind: "continuation",
        hash: "both-hash",
        parentRequestId: recovery.requestId,
      },
    });
    expect((await t.service.recover(g.id, owner)).status).toBe("waiting");
    expect(t.submit).toHaveBeenCalledTimes(2);
  });
  it("refuses a multi-game remainder that silently switches to another lane", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation({
      ...outcome(g, false, "unknown"),
      recovery: {
        ...scope,
        requestId: g.submission!.requestIds[0],
        reference: "changed-lane",
        remainingScopes: [scope, { ...scope, laneId: "lane-b" }],
        safety: recoverySafety,
      },
    });
    await t.service.refresh(g.id);
    await t.service.recover(g.id, owner);
    expect(t.recover).not.toHaveBeenCalled();
    expect(t.submit).toHaveBeenCalledOnce();
  });
  it("records verified worker stop separately from the original unknown native outcome", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.stop.mockResolvedValue({
      ...outcome(g, null, "unknown"),
      stopVerification: {
        verified: true,
        requestIds: g.submission!.requestIds,
        observedAt: at,
        evidenceReference: "runtime:worker-exit",
      },
    });
    const cancelled = await t.service.cancel(g.id, owner);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.requests[0].status).toBe("unknown");
    expect(cancelled.goalSatisfied).toBeNull();
    expect(cancelled.stopVerification?.evidenceReference).toBe(
      "runtime:worker-exit",
    );
    expect(setup(t.stored()).service.snapshot().goals).toEqual([]);
    const restarted = setup(t.stored());
    await restarted.service.ready();
    expect(restarted.service.get(g.id, owner).requests[0].status).toBe(
      "unknown",
    );
    expect(restarted.service.get(g.id, owner).status).toBe("cancelled");
  });
  it.each(["cancelled", "failed", "succeeded"] as const)(
    "does not infer worker exit from %s receipts, including after restart",
    async (status) => {
      const t = setup();
      const g = await t.service.submit((await t.create()).id, owner);
      const observation: GoalObservation = {
        ...outcome(g, null),
        requests: outcome(g, null).requests.map((request) => ({
          ...request,
          status,
        })),
        summary: "已核实停止",
      };
      t.stop.mockResolvedValue(observation);
      const pending = await t.service.cancel(g.id, owner);
      expect(pending.status).toBe("unknown");
      expect(pending.waitingReason).toBe("stop-not-verified");
      expect(pending.message).toMatch(/停止.*尚无法确认/);
      expect(pending.requests).toEqual(observation.requests);
      expect(pending.stopVerification).toBeUndefined();
      expect(pending.goalSatisfied).toBeNull();
      const restored = setup(t.stored());
      restored.stop.mockResolvedValue(observation);
      await restored.service.reconcile();
      expect(restored.service.get(g.id, owner)).toMatchObject({
        status: "unknown",
        waitingReason: "stop-not-verified",
        requests: observation.requests,
      });
      expect(restored.submit).not.toHaveBeenCalled();
      restored.stop.mockResolvedValue({
        ...observation,
        stopVerification: {
          verified: true,
          requestIds: g.submission!.requestIds,
          observedAt: at,
          evidenceReference: "runtime:actual-worker-exit",
        },
      });
      const confirmed = await restored.service.cancel(g.id, owner);
      expect(confirmed.status).toBe("cancelled");
      expect(confirmed.requests).toEqual(observation.requests);
      expect(confirmed.stopVerification?.evidenceReference).toBe(
        "runtime:actual-worker-exit",
      );
    },
  );
  it("does not report a worker stopped when only observing a cancelled request", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const observation: GoalObservation = {
      ...outcome(g, null),
      requests: outcome(g, null).requests.map((request) => ({
        ...request,
        status: "cancelled",
      })),
      summary: "请求已停止",
    };
    t.setObservation(observation);
    await t.service.refresh(g.id);
    expect(t.service.get(g.id, owner)).toMatchObject({
      status: "unknown",
      waitingReason: "stop-not-verified",
      requests: observation.requests,
    });
    expect(t.service.get(g.id, owner).message).toMatch(/停止.*尚未核实/);
  });
  it("preserves an already verified completed goal when cancellation is requested later", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    t.setObservation(outcome(g, true));
    await t.service.refresh(g.id);
    const completed = t.service.get(g.id, owner);
    expect(completed.status).toBe("completed");
    expect(await t.service.cancel(g.id, owner)).toEqual(completed);
    expect(t.stop).not.toHaveBeenCalled();
  });
  it("rejects stale control stop proof and proof that omits an accepted sibling request", async () => {
    const t = setup(),
      other = { ...scope, laneId: "lane-b" };
    t.prepare.mockResolvedValue({ ...t.prepared, scopes: [scope, other] });
    const g = await t.service.submit(
      (await t.create({ grant: grant([scope, other]) })).id,
      owner,
    );
    t.stop.mockResolvedValue({
      ...outcome(g, null, "unknown"),
      stopVerification: {
        verified: true,
        requestIds: [g.submission!.requestIds[0]],
        observedAt: at,
        evidenceReference: "runtime:first-exit",
      },
    });
    expect((await t.service.cancel(g.id, owner)).status).toBe("unknown");
    t.stop.mockResolvedValue({
      ...outcome(g, null, "unknown"),
      stopVerification: {
        verified: true,
        requestIds: g.submission!.requestIds,
        observedAt: "2026-10-05T07:00:00.000Z",
        evidenceReference: "runtime:old-exit",
      },
    });
    expect((await t.service.cancel(g.id, owner)).status).toBe("unknown");
  });
  it("permits registered bounded navigation under a fresh login gate without claiming current UID was seen", async () => {
    const t = setup();
    const g = await t.service.submit((await t.create()).id, owner);
    const recovery = {
      ...scope,
      requestId: g.submission!.requestIds[0],
      reference: "bounded-known-return",
      safety: {
        ...recoverySafety,
        kind: "bounded-navigation" as const,
        nativeSubmission: "known" as const,
        accountProof: "login-gate-before-effects" as const,
      },
    };
    t.setObservation({
      ...outcome(g, false, "unknown"),
      flowComplete: false,
      recovery,
    });
    await t.service.refresh(g.id);
    t.recover.mockResolvedValue({
      ...t.prepared,
      frozenPlan: {
        kind: "continuation",
        hash: "known-home-return",
        parentRequestId: recovery.requestId,
      },
    });
    expect((await t.service.recover(g.id, owner)).status).toBe("waiting");
    expect(t.submit).toHaveBeenCalledTimes(2);
    expect(
      t.service.get(g.id, owner).attempts[1].review.scopes[0].skillIds[0],
    ).toBe("login");
  });
});
