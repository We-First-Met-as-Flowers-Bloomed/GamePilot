import { expect, it, vi } from "vitest";
import { createGoalObserver } from "../apps/desktop/main/agent-goal-observer";
import type {
  GoalRun,
  GoalScope,
  GoalRecoveryReference,
  GoalReview,
} from "../packages/protocol/agent-goal";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { defaultArknightsConfig } from "../games/arknights/config";

const at = "2026-10-05T04:00:00.000Z";
function records(batchId = "goal-batch", laneId = "lane-b") {
  const plan = {
    gameId: "onmyoji",
    mode: "live" as const,
    skillIds: ["login", "mail"],
  };
  const request: ExecutionRecord = {
    version: 1,
    id: `${batchId}:${laneId}`,
    batchId,
    laneId,
    source: "daily",
    resources: ["device:1"],
    fingerprint: batchId,
    status: "succeeded",
    startedAt: at,
    finishedAt: at,
    message: "finished",
    snapshot: {
      plan,
      lane: {
        id: laneId,
        name: "账号二",
        instance: 1,
        managerPath: "D:/MuMu/MuMuManager.exe",
        arknights: { profileId: "p" },
      },
      profile: {
        ...defaultArknightsConfig,
        id: "p",
        name: "p",
        expectedUid: "123456789",
      },
    },
  };
  const task: TaskRecord = {
    version: 1,
    executionId: request.id,
    runId: `${batchId}-run`,
    batchId,
    laneId,
    instance: 1,
    profileId: "p",
    gameId: "onmyoji",
    plan,
    status: "succeeded",
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    message: "finished",
    steps: plan.skillIds.map((skillId) => ({
      skillId,
      status: "succeeded",
      diagnostics: [],
      message: "verified",
      evidence: "adapter-result",
      result: {
        status: "succeeded",
        summary: "已核对",
        goalSatisfied: true,
        evidenceTimestamp: at,
        evidenceReference: `onmyoji:${skillId}:evidence`,
      },
    })),
  };
  return { request, task };
}
function goalFor(request: ExecutionRecord): GoalRun {
  const scope: GoalScope = {
    laneId: request.laneId!,
    gameId: "onmyoji",
    skillIds: ["login", "mail"],
    resources: {},
  };
  const owner = { sessionId: "session-a", turnId: "turn-a" };
  const review: GoalReview = {
    id: "review-a",
    fingerprint: "review-fingerprint",
    reviewedAt: at,
    expiresAt: "2026-10-05T05:00:00.000Z",
    frozenPlan: { kind: "saved-daily", hash: "original-hash" },
    scopes: [scope],
    summary: [],
  };
  const submission = {
    batchId: request.batchId!,
    requestIds: [request.id],
    attempt: 0,
    acceptedAt: at,
    state: "received" as const,
  };
  return {
    version: 1,
    id: "goal-a",
    revision: 3,
    ...owner,
    prompt: "给账号二领邮件",
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
    createdAt: at,
    updatedAt: at,
    status: "waiting",
    message: "waiting",
    originalReview: review,
    review,
    submission,
    attempts: [{ review, submission }],
    retryCount: 0,
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
  };
}
function setup(requests: ExecutionRecord[], tasks: TaskRecord[]) {
  const executions = {
    assertHealthy: vi.fn(),
    snapshot: vi.fn(() => structuredClone(requests)),
  };
  const ledger = {
    assertHealthy: vi.fn(),
    flush: vi.fn(async () => {}),
    forExecution: vi.fn((id: string) =>
      structuredClone(tasks.filter((task) => task.executionId === id)),
    ),
  };
  return { executions, ledger, deps: { executions, ledger } };
}
it("observes a first continuation attempt only through its explicit frozen external daily parent", async () => {
  const parent = records("scheduled");
  parent.request.status = "unknown";
  const child = records("goal-child"),
    goal = goalFor(child.request);
  const fingerprint = "a".repeat(64);
  parent.request.fingerprint = fingerprint;
  child.request.snapshot.continuation = {
    parentId: parent.request.id,
    parentFingerprint: fingerprint,
    retained: [],
    excluded: [],
    acknowledgedPartial: false,
  };
  child.request.snapshot.agent = { requestId: goal.id, kind: "continue" };
  goal.selection = {
    kind: "continuation",
    parentRequestId: parent.request.id,
    parentFingerprint: fingerprint,
    laneIds: [child.request.laneId!],
  };
  goal.attempts[0].review.frozenPlan = {
    kind: "continuation",
    hash: fingerprint,
    parentRequestId: parent.request.id,
  };
  goal.attempts[0].review.fingerprint = fingerprint;
  goal.attempts[0].submission.parentRequestId = parent.request.id;
  const t = setup([parent.request, child.request], [child.task]);
  const observer = createGoalObserver(t.deps);
  const result = await observer.observe(goal);
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({
    requestId: child.request.id,
    status: "succeeded",
    goalSatisfied: true,
  });
  expect(result.flowComplete).toBe(true);
  expect(parent.request.status).toBe("unknown");
  expect(t.ledger.forExecution).not.toHaveBeenCalledWith(parent.request.id);
  parent.request.resolution = {
    action: "abandoned",
    at: "2026-10-05T04:00:05.000Z",
    note: "结束旧故障",
  };
  expect((await observer.observe(goal)).goalSatisfied).toBe(true);
  for (const at of [
    child.request.startedAt,
    "2026-10-05T03:59:59.000Z",
    "invalid",
  ]) {
    parent.request.resolution.at = at;
    expect((await observer.observe(goal)).requests[0].status).toBe("unknown");
  }
  delete parent.request.resolution;
  const childProfile = child.request.snapshot.profile as {
    expectedUid: string;
  };
  childProfile.expectedUid = "999888777";
  expect((await observer.observe(goal)).requests[0].status).toBe("unknown");
  childProfile.expectedUid = "123456789";
  (child.request.snapshot.continuation as { excluded: unknown[] }).excluded = [
    { gameId: "onmyoji", skillIds: ["mail"] },
  ];
  expect((await observer.observe(goal)).requests[0].status).toBe("unknown");
  (child.request.snapshot.continuation as { excluded: unknown[] }).excluded =
    [];
  parent.request.fingerprint = "b".repeat(64);
  expect((await observer.observe(goal)).requests[0].status).toBe("unknown");
});

it("reads exact reserved actual requests and task records without touching unrelated lanes", async () => {
  const { request, task } = records();
  const unrelated = records("other-goal", "lane-a");
  const t = setup([request, unrelated.request], [task, unrelated.task]);
  const goal = goalFor(request),
    before = structuredClone({ request, task, goal });
  const observed = await createGoalObserver(t.deps).observe(goal);
  expect(observed).toMatchObject({
    flowComplete: true,
    goalSatisfied: true,
    requests: [
      { requestId: request.id, status: "succeeded", goalSatisfied: true },
    ],
  });
  expect(t.ledger.forExecution).toHaveBeenCalledWith(request.id);
  expect(t.ledger.forExecution).not.toHaveBeenCalledWith(unrelated.request.id);
  expect({ request, task, goal }).toEqual(before);
});
it("returns an explicit unknown row for a missing durable reservation and never relaunches", async () => {
  const { request } = records();
  const observed = await createGoalObserver(setup([], []).deps).observe(
    goalFor(request),
  );
  expect(observed).toMatchObject({
    flowComplete: false,
    goalSatisfied: null,
    requests: [{ requestId: request.id, status: "unknown" }],
  });
});
it("refuses a reservation reused for another batch, lane or frozen skill scope", async () => {
  const { request, task } = records();
  const goal = goalFor(request);
  request.batchId = "another-batch";
  const observed = await createGoalObserver(
    setup([request], [task]).deps,
  ).observe(goal);
  expect(observed.goalSatisfied).toBeNull();
  expect(observed.requests[0].status).toBe("unknown");
});
it("projects legitimate reserved continuation union while preserving the original failure", async () => {
  const original = records();
  original.request.status = "failed";
  original.task.status = "failed";
  original.task.steps[1].status = "failed";
  const goal = goalFor(original.request),
    child = records("goal-child");
  child.request.startedAt = child.request.finishedAt =
    "2026-10-05T04:01:00.000Z";
  child.task.startedAt =
    child.task.updatedAt =
    child.task.finishedAt =
      child.request.startedAt;
  child.task.steps.forEach((step) => {
    step.result!.evidenceTimestamp = child.request.startedAt;
  });
  child.request.snapshot.continuation = {
    parentId: original.request.id,
    parentFingerprint: original.request.fingerprint,
    retained: [],
    excluded: [],
    acknowledgedPartial: true,
  };
  const review = {
    ...goal.originalReview!,
    id: "review-child",
    frozenPlan: {
      kind: "continuation" as const,
      hash: "child-hash",
      parentRequestId: original.request.id,
    },
  };
  const submission = {
    batchId: child.request.batchId!,
    requestIds: [child.request.id],
    attempt: 1,
    acceptedAt: child.request.startedAt,
    state: "received" as const,
    parentRequestId: original.request.id,
  };
  goal.attempts.push({ review, submission });
  goal.review = review;
  goal.submission = submission;
  goal.retryCount = 1;
  const t = setup(
    [original.request, child.request],
    [original.task, child.task],
  );
  const observed = await createGoalObserver(t.deps).observe(goal);
  expect(observed.goalSatisfied).toBe(true);
  expect(observed.requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestId: original.request.id,
        status: "failed",
      }),
      expect.objectContaining({
        requestId: child.request.id,
        rootRequestId: original.request.id,
        originalStatus: "failed",
        status: "succeeded",
        goalSatisfied: true,
      }),
    ]),
  );
  expect(original.request.status).toBe("failed");
  (
    child.request.snapshot.continuation as { parentFingerprint: string }
  ).parentFingerprint = "forged";
  expect(
    (await createGoalObserver(t.deps).observe(goal)).goalSatisfied,
  ).toBeNull();
});
it("never adopts an unreserved external continuation as this goal's accepted leaf", async () => {
  const original = records(),
    child = records("external-child");
  original.request.status = "failed";
  original.task.status = "failed";
  original.task.steps[1].status = "failed";
  child.request.snapshot.continuation = {
    parentId: original.request.id,
    parentFingerprint: original.request.fingerprint,
    retained: [],
    excluded: [],
    acknowledgedPartial: true,
  };
  const observed = await createGoalObserver(
    setup([original.request, child.request], [original.task, child.task]).deps,
  ).observe(goalFor(original.request));
  expect(observed.requests.map((r) => r.requestId)).toEqual([
    original.request.id,
  ]);
  expect(observed.goalSatisfied).not.toBe(true);
});
it("requires newly registered host proof for recovery and revalidates actual ledger before preparing", async () => {
  const { request, task } = records();
  request.status = "unknown";
  task.status = "failed";
  const goal = goalFor(request);
  const reference: GoalRecoveryReference = {
    ...goal.grant.scopes[0],
    requestId: request.id,
    reference: "registered-host-proof",
    safety: {
      kind: "native-not-submitted",
      fingerprint: "proof",
      observedAt: at,
      nativeSubmission: "not-submitted",
      accountProof: "login-gate-before-effects",
    },
  };
  const prepared = {
    fingerprint: "fresh",
    summary: [],
    payload: {},
    frozenPlan: {
      kind: "continuation" as const,
      hash: "hash",
      parentRequestId: request.id,
    },
    scopes: goal.grant.scopes,
  };
  const findRecovery = vi.fn(async () => reference),
    prepareRecovery = vi.fn(async () => prepared);
  const observer = createGoalObserver({
    ...setup([request], [task]).deps,
    findRecovery,
    prepareRecovery,
  });
  await expect(observer.recover(goal, reference)).rejects.toThrow("登记");
  expect((await observer.observe(goal)).recovery).toEqual(reference);
  expect(await observer.recover(goal, reference)).toEqual(prepared);
  expect(prepareRecovery).toHaveBeenCalledOnce();
  await expect(
    observer.recover(goal, { ...reference, reference: "model-invented" }),
  ).rejects.toThrow();
  const restarted = createGoalObserver({
    ...setup([request], [task]).deps,
    findRecovery,
    prepareRecovery,
  });
  await expect(restarted.recover(goal, reference)).rejects.toThrow("登记");
});
it("cannot register a purported retry when actual native submission remains unknown", async () => {
  const { request, task } = records();
  const plan = {
    gameId: "arknights",
    mode: "live" as const,
    skillIds: ["login", "award"],
  };
  request.status = "unknown";
  request.snapshot.plan = plan;
  task.gameId = "arknights";
  task.plan = plan;
  task.status = "failed";
  task.steps = [
    {
      skillId: "login",
      status: "failed",
      diagnostics: [],
      message: "native unknown",
      result: {
        arknights: {
          version: 1,
          taskType: "StartUp",
          submission: "submitted",
          completion: "unknown",
          observedAt: at,
          taskId: 7,
        },
      },
    },
    {
      skillId: "award",
      status: "not-run",
      diagnostics: [],
      message: "not run",
    },
  ];
  const goal = goalFor(request);
  for (const scope of [goal.grant.scopes[0], goal.originalReview!.scopes[0]]) {
    scope.gameId = "arknights";
    scope.skillIds = ["login", "award"];
  }
  const findRecovery = vi.fn(async (): Promise<GoalRecoveryReference> => ({
    ...goal.grant.scopes[0],
    requestId: request.id,
    reference: "incorrect-host-proof",
    safety: {
      kind: "native-not-submitted",
      fingerprint: "proof",
      observedAt: at,
      nativeSubmission: "not-submitted",
      accountProof: "login-gate-before-effects",
    },
  }));
  const observation = await createGoalObserver({
    ...setup([request], [task]).deps,
    findRecovery,
  }).observe(goal);
  expect(observation.recovery).toBeUndefined();
  expect(findRecovery).not.toHaveBeenCalled();
});
it.each(["submitted", "confirmed"] as const)(
  "projects Onmyoji %s effects without upgrading its failed flow",
  async (phase) => {
    const { request, task } = records();
    request.status = "failed";
    task.status = "failed";
    const step = task.steps[1];
    step.status = "failed";
    step.startedAt = step.finishedAt = at;
    step.result = {
      onmyoji: {
        version: 1,
        skillId: "mail",
        phase,
        observedAt: at,
        effects:
          phase === "confirmed"
            ? [
                {
                  kind: "mail-claim",
                  observedAt: at,
                  evidenceReference: "onmyoji:mail:effect:1",
                  summary: "不可据此宣称全计划完成",
                },
              ]
            : [],
      },
    };
    const findRecovery = vi.fn(async () => undefined);
    const observation = await createGoalObserver({
      ...setup([request], [task]).deps,
      findRecovery,
    }).observe(goalFor(request));
    expect(observation.flowComplete).toBe(false);
    expect(observation.goalSatisfied).toBe(false);
    const projected = observation.requests[0].skills.find(
      (value) => value.skillId === "mail",
    ) as any;
    if (phase === "confirmed")
      expect(projected.effectEvidence).toEqual([
        {
          kind: "mail-claim",
          observedAt: at,
          evidenceReference: "onmyoji:mail:effect:1",
          summary: "邮箱待领取附件状态已核对",
        },
      ]);
    else {
      expect(projected.effectEvidence).toBeUndefined();
      expect(findRecovery).not.toHaveBeenCalled();
    }
    expect(observation.recovery).toBeUndefined();
    expect(task.steps[1].status).toBe("failed");
  },
);
