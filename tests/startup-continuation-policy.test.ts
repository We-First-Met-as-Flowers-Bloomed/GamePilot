import { expect, it } from "vitest";
import type { DeviceLane, Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { defaultArknightsConfig } from "../games/arknights/config";
import { arknightsConfigForPlan } from "../games/arknights/daily-plan";
import { startupFailureProof } from "../games/startup-continuation";
import {
  previewDailyContinuation,
  continuationPlans,
} from "../games/continuation";
import { projectExecutionDetail } from "../games/execution-detail";
import { mergeExecutionProgress } from "../games/execution-progress";
import {
  assertContinuationHistory,
  completedContinuationRequestIds,
} from "../games/continuation-history";
import { evaluateGoalOutcome } from "../games/goal-outcome";
import { goalContinuationScopes } from "../games/goal-continuation";
import { createStartupReconciliationFact } from "../games/arknights/startup-reconciliation";

const now = new Date("2026-10-08T11:10:00.000Z");
function fixture(skills = ["login"]) {
  const lane: DeviceLane = {
    id: "lane-b",
    name: "test",
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 1,
    enabled: true,
    arknights: { enabled: true, profileId: "p" },
    onmyoji: { enabled: false },
    closeEmulatorAfterSuccess: false,
  };
  const plan: Plan = { gameId: "arknights", mode: "live", skillIds: skills };
  const profile = {
    id: "p",
    name: "test",
    ...arknightsConfigForPlan(
      {
        ...defaultArknightsConfig,
        expectedUid: "111111111",
      },
      plan,
    ),
  };
  const parent: ExecutionRecord = {
    version: 1,
    id: "original:lane-b",
    batchId: "original",
    laneId: lane.id,
    source: "single",
    resources: ["mumu:d:\\mumu\\mumumanager.exe#1"],
    fingerprint: "a".repeat(64),
    status: "failed",
    startedAt: "2026-10-08T11:02:00.000Z",
    finishedAt: "2026-10-08T11:06:00.000Z",
    message: "startup failed",
    snapshot: { lane, profile, arknightsPlan: plan },
    startupFault: {
      version: 1,
      source: "startup",
      code: "mumu-boot-timeout",
      observedAt: "2026-10-08T11:06:00.000Z",
    },
  };
  const requests = [parent];
  const tasks: TaskRecord[] = [];
  const proof = () => startupFailureProof(parent, requests, tasks, now);
  const preview = () =>
    previewDailyContinuation(
      projectExecutionDetail(
        parent,
        tasks.filter((t) => t.executionId === parent.id),
      ),
      parent,
      now,
      [],
      proof(),
    );
  return { parent, requests, tasks, proof, preview };
}
function taskFor(request: ExecutionRecord, plan: Plan): TaskRecord {
  const lane = request.snapshot.lane as DeviceLane;
  return {
    version: 1,
    executionId: request.id,
    runId: `task-${request.id}-${plan.gameId}`,
    laneId: request.laneId,
    batchId: request.batchId,
    instance: lane.instance,
    ...(plan.gameId === "arknights"
      ? { profileId: lane.arknights.profileId }
      : {}),
    gameId: plan.gameId,
    plan: structuredClone(plan),
    status: "succeeded",
    startedAt: request.startedAt,
    finishedAt: request.finishedAt,
    updatedAt: request.finishedAt!,
    message: "done",
    steps: plan.skillIds.map((skillId) => ({
      skillId,
      status: "succeeded",
      startedAt: request.startedAt,
      finishedAt: request.finishedAt,
      message: "done",
      diagnostics: [],
    })),
  };
}
function addChild(s: ReturnType<typeof fixture>) {
  const preview = s.preview();
  const plans = continuationPlans(
    preview,
    {
      parentId: s.parent.id,
      fingerprint: s.parent.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: false,
    },
    [],
    s.proof(),
  );
  const child: ExecutionRecord = {
    ...structuredClone(s.parent),
    id: "child:lane-b",
    batchId: "child",
    source: "daily",
    fingerprint: "b".repeat(64),
    status: "succeeded",
    startedAt: now.toISOString(),
    finishedAt: "2026-10-08T11:12:00.000Z",
    startupFault: undefined,
    snapshot: {
      ...structuredClone(s.parent.snapshot),
      continuation: {
        parentId: s.parent.id,
        parentFingerprint: s.parent.fingerprint,
        retained: [],
        excluded: [],
        acknowledgedPartial: false,
      },
    },
  };
  s.requests.push(child);
  for (const plan of plans) s.tasks.push(taskFor(child, plan));
  return child;
}
function progress(s: ReturnType<typeof fixture>, includeRaw = true) {
  const details = new Map(
    s.requests.map((r) => [
      r.id,
      projectExecutionDetail(
        r,
        s.tasks.filter((t) => t.executionId === r.id),
      ),
    ]),
  );
  return mergeExecutionProgress(
    s.parent.id,
    s.requests,
    details,
    [],
    includeRaw ? s.tasks : undefined,
  );
}

it.each([
  "mumu-state-unavailable",
  "mumu-launch-failed",
  "mumu-boot-timeout",
] as const)(
  "proves the exact typed %s failure without changing records",
  (code) => {
    const s = fixture();
    s.parent.startupFault!.code = code;
    const before = structuredClone(s.requests);
    expect(s.proof()).toEqual({
      parentId: s.parent.id,
      fingerprint: s.parent.fingerprint,
      observedAt: now.toISOString(),
    });
    expect(s.preview()).toMatchObject({
      canContinue: true,
      needsAcknowledgement: false,
      defaults: [{ gameId: "arknights", skillIds: ["login"] }],
    });
    expect(
      goalContinuationScopes(s.preview(), "lane-b", s.proof())[0].skillIds,
    ).toEqual(["login"]);
    expect(s.requests).toEqual(before);
  },
);

it("requires the host proof even when the projected original has zero task records", () => {
  const s = fixture();
  expect(
    previewDailyContinuation(
      projectExecutionDetail(s.parent, []),
      s.parent,
      now,
    ).canContinue,
  ).toBe(false);
  const mismatched = { ...s.proof()!, fingerprint: "c".repeat(64) };
  expect(
    previewDailyContinuation(
      projectExecutionDetail(s.parent, []),
      s.parent,
      now,
      [],
      mismatched,
    ).canContinue,
  ).toBe(false);
});

it("keeps dual-game business defaults separate from the fresh login gates", () => {
  const s = fixture(["login", "award"]);
  (s.parent.snapshot.lane as DeviceLane).onmyoji.enabled = true;
  s.parent.snapshot.onmyojiPlan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login", "mail"],
  };
  const preview = s.preview();
  expect(preview.canContinue).toBe(true);
  expect(preview.steps.every((step) => step.status === "pending")).toBe(true);
  expect(preview.defaults).toEqual([
    { gameId: "arknights", skillIds: ["award"] },
    { gameId: "onmyoji", skillIds: ["mail"] },
  ]);
  expect(
    goalContinuationScopes(preview, "lane-b", s.proof()).map((s) => s.skillIds),
  ).toEqual([
    ["login", "award"],
    ["login", "mail"],
  ]);
});

it.each([false, true])(
  "merges a verified child with complete raw ledger (dual=%s), preserving original failure",
  (dual) => {
    const s = fixture(dual ? ["login", "award"] : ["login"]);
    if (dual) {
      (s.parent.snapshot.lane as DeviceLane).onmyoji.enabled = true;
      s.parent.snapshot.onmyojiPlan = {
        gameId: "onmyoji",
        mode: "live",
        skillIds: ["login", "mail"],
      };
    }
    const original = structuredClone(s.parent);
    addChild(s);
    expect(progress(s)).toMatchObject({
      outcome: "recovered",
      wholePlanComplete: true,
      originalStatus: "failed",
      warnings: [],
    });
    expect(progress(s, false).wholePlanComplete).toBe(false);
    expect(
      completedContinuationRequestIds(s.requests, s.tasks).has(s.parent.id),
    ).toBe(true);
    expect(evaluateGoalOutcome(s.requests, s.tasks).flowComplete).toBe(true);
    expect(s.parent).toEqual(original);
  },
);

it("accepts a reliably associated successful sibling on the other physical instance", () => {
  const s = fixture();
  const sibling = structuredClone(s.parent);
  sibling.id = "original:lane-a";
  sibling.laneId = "lane-a";
  sibling.status = "succeeded";
  sibling.startupFault = undefined;
  sibling.resources = ["mumu:d:\\mumu\\mumumanager.exe#0"];
  Object.assign(sibling.snapshot.lane as DeviceLane, {
    id: "lane-a",
    instance: 0,
  });
  s.requests.push(sibling);
  s.tasks.push(taskFor(sibling, sibling.snapshot.arknightsPlan as Plan));
  expect(s.proof()).toBeDefined();
});

it.each([
  "unknown",
  "cancelled",
  "resolved",
  "missing-fault",
  "stopping-fault",
  "missing-end",
  "future-end",
  "bad-time",
  "bad-fingerprint",
  "missing-parent",
  "duplicate-parent",
  "missing-lane",
  "wrong-resource",
  "missing-uid",
  "wrong-client",
  "missing-login",
  "rehearsal",
  "cross-day",
  "new-request",
  "successor",
])("rejects unsafe startup proof: %s", (kind) => {
  const s = fixture();
  if (kind === "unknown") s.parent.status = "unknown";
  if (kind === "cancelled") s.parent.status = "cancelled";
  if (kind === "resolved")
    s.parent.resolution = {
      action: "abandoned",
      at: now.toISOString(),
      note: "closed",
    };
  if (kind === "missing-fault") delete s.parent.startupFault;
  if (kind === "stopping-fault")
    s.parent.startupFault!.code = "mumu-stopping-timeout";
  if (kind === "missing-end") delete s.parent.finishedAt;
  if (kind === "future-end") s.parent.finishedAt = "2026-10-08T12:00:00Z";
  if (kind === "bad-time") s.parent.startedAt = "invalid";
  if (kind === "bad-fingerprint") s.parent.fingerprint = "stale";
  if (kind === "missing-parent") s.requests.pop();
  if (kind === "duplicate-parent") s.requests.push(structuredClone(s.parent));
  if (kind === "missing-lane") delete s.parent.snapshot.lane;
  if (kind === "wrong-resource") s.parent.resources = ["*"];
  if (kind === "missing-uid")
    (s.parent.snapshot.profile as any).expectedUid = "";
  if (kind === "wrong-client")
    (s.parent.snapshot.profile as any).clientType = "another";
  if (kind === "missing-login")
    (s.parent.snapshot.arknightsPlan as Plan).skillIds = ["award"];
  if (kind === "rehearsal")
    (s.parent.snapshot.arknightsPlan as Plan).mode = "rehearsal";
  if (kind === "cross-day") {
    s.parent.startedAt = "2026-10-07T11:02:00Z";
    s.parent.finishedAt = "2026-10-07T11:06:00Z";
    s.parent.startupFault!.observedAt = s.parent.finishedAt;
  }
  if (kind === "new-request" || kind === "successor") {
    const next = structuredClone(s.parent);
    next.id = "next:lane-b";
    next.startedAt = "2026-10-08T11:07:00Z";
    next.finishedAt = "2026-10-08T11:08:00Z";
    if (kind === "successor")
      next.snapshot.continuation = {
        parentId: s.parent.id,
        parentFingerprint: s.parent.fingerprint,
      };
    s.requests.push(next);
  }
  expect(s.proof()).toBeUndefined();
});

it.each([
  "direct",
  "same-batch",
  "same-batch-no-lane",
  "orphan",
  "contradictory-sibling",
])("rejects a raw task hidden by the detail projection: %s", (kind) => {
  const s = fixture();
  const task = taskFor(s.parent, s.parent.snapshot.arknightsPlan as Plan);
  if (kind !== "direct") task.executionId = "missing";
  if (kind === "same-batch-no-lane") delete task.laneId;
  if (kind === "orphan") {
    delete task.executionId;
    delete task.batchId;
  }
  if (kind === "contradictory-sibling") {
    task.laneId = "lane-a";
    task.instance = 0;
  }
  s.tasks.push(task);
  expect(s.proof()).toBeUndefined();
});

it("reconstructs the original proof at child admission without later unrelated requests invalidating it", () => {
  const s = fixture();
  const child = addChild(s);
  const later = {
    ...structuredClone(child),
    id: "later:lane-b",
    batchId: "later",
    startedAt: "2026-10-08T12:00:00Z",
    finishedAt: "2026-10-08T12:01:00Z",
  };
  delete later.snapshot.continuation;
  s.requests.push(later);
  s.tasks.push(taskFor(later, later.snapshot.arknightsPlan as Plan));
  expect(progress(s).wholePlanComplete).toBe(true);
  s.tasks.push(taskFor(s.parent, s.parent.snapshot.arknightsPlan as Plan));
  expect(progress(s).wholePlanComplete).toBe(false);
});

it("keeps a second unsubmitted startup failure incomplete while preserving its verified ancestor chain", () => {
  const s = fixture(["login", "award"]),
    child = addChild(s);
  s.tasks.length = 0;
  child.status = "failed";
  child.startupFault = {
    version: 1,
    source: "startup",
    code: "mumu-boot-timeout",
    observedAt: child.finishedAt!,
  };
  const later = new Date("2026-10-08T11:13:00.000Z");
  const proof = startupFailureProof(child, s.requests, s.tasks, later);
  expect(proof).toBeDefined();
  const preview = previewDailyContinuation(
    projectExecutionDetail(child, []),
    child,
    later,
    [],
    proof,
  );
  const plans = continuationPlans(
    preview,
    {
      parentId: child.id,
      fingerprint: child.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: false,
    },
    [],
    proof,
  );
  expect(progress(s)).toMatchObject({
    outcome: "incomplete",
    wholePlanComplete: false,
    warnings: [],
  });
  expect(() =>
    assertContinuationHistory(child, s.requests, s.tasks, plans, later),
  ).not.toThrow();
});

it("does not adopt an external child outside the reserved Goal requests", () => {
  const s = fixture();
  addChild(s);
  expect(
    evaluateGoalOutcome([s.parent], s.tasks, {}, s.requests).flowComplete,
  ).toBe(false);
  const orphan = taskFor(s.parent, s.parent.snapshot.arknightsPlan as Plan);
  orphan.executionId = "unowned";
  orphan.batchId = "other";
  s.tasks.push(orphan);
  expect(
    evaluateGoalOutcome(s.requests, s.tasks, {}, s.requests).flowComplete,
  ).toBe(false);
});

it("supports an unsubmitted YYS-only login without inventing an Arknights identity", () => {
  const s = fixture();
  delete s.parent.snapshot.profile;
  delete s.parent.snapshot.arknightsPlan;
  (s.parent.snapshot.lane as DeviceLane).arknights.enabled = false;
  (s.parent.snapshot.lane as DeviceLane).onmyoji.enabled = true;
  s.parent.snapshot.onmyojiPlan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login"],
  };
  expect(s.preview().defaults).toEqual([
    { gameId: "onmyoji", skillIds: ["login"] },
  ]);
  addChild(s);
  expect(progress(s).wholePlanComplete).toBe(true);
});

it.each(["stopping", "interrupted", "future"])(
  "does not treat a %s fault as transient",
  (kind) => {
    const s = fixture();
    s.parent.startupFault!.code = (
      kind === "stopping"
        ? "mumu-stopping-timeout"
        : kind === "interrupted"
          ? "mumu-startup-interrupted"
          : "future-code"
    ) as NonNullable<ExecutionRecord["startupFault"]>["code"];
    expect(s.proof()).toBeUndefined();
  },
);

it.each(["arknights", "onmyoji", "orphan"])(
  "blocks an older unknown submission for a fresh pure login: %s",
  (kind) => {
    const s = fixture();
    const old = {
      ...structuredClone(s.parent),
      id: "old:lane-b",
      batchId: "old",
      status: "failed" as const,
      startedAt: "2026-10-08T10:00:00Z",
      finishedAt: "2026-10-08T10:01:00Z",
      startupFault: undefined,
    };
    const task = taskFor(old, old.snapshot.arknightsPlan as Plan);
    task.status = "unknown";
    task.steps[0].status = "unknown";
    if (kind === "onmyoji")
      task.steps[0].result = {
        onmyoji: {
          version: 1,
          skillId: "login",
          phase: "submitted",
          observedAt: old.finishedAt,
          effects: [],
        } as any,
      };
    else
      task.steps[0].result = {
        arknights: {
          version: 1,
          taskType: "StartUp",
          submission: "submitted",
          completion: "unknown",
          observedAt: old.finishedAt,
          taskId: 1,
        },
      };
    if (kind === "orphan") {
      delete task.executionId;
      delete task.batchId;
    } else s.requests.push(old);
    s.tasks.push(task);
    expect(s.proof()).toBeUndefined();
  },
);

it.each([
  "prior-day",
  "prior-day-abandoned",
  "same-day",
  "same-day-abandoned",
  "prior-day-active",
  "prior-day-missing-end",
  "prior-day-orphan",
  "prior-day-conflict",
  "prior-day-no-uid",
  "prior-day-disabled",
  "same-day-no-uid",
  "same-day-disabled",
])(
  "scopes a terminal, reliably associated old unknown to its game day: %s",
  (kind) => {
    const s = fixture();
    const day = kind.startsWith("same-day") ? "08" : "07";
    const old: ExecutionRecord = {
      ...structuredClone(s.parent),
      id: "historical:lane-b",
      batchId: "historical",
      status: "unknown",
      startupFault: undefined,
      startedAt: `2026-10-${day}T10:00:00.000Z`,
      finishedAt: `2026-10-${day}T10:01:00.000Z`,
      ...(kind.endsWith("abandoned")
        ? {
            resolution: {
              action: "abandoned" as const,
              at: `2026-10-${day}T10:02:00.000Z`,
              note: "原结果保留，不重放",
            },
          }
        : {}),
    };
    const task = taskFor(old, old.snapshot.arknightsPlan as Plan);
    task.status = "failed";
    task.steps[0].status = "failed";
    task.steps[0].result = {
      arknights: {
        version: 1,
        taskType: "StartUp",
        taskId: 1,
        submission: "submitted",
        completion: "unknown",
        observedAt: old.finishedAt!,
      },
    };
    if (kind.endsWith("no-uid"))
      (old.snapshot.profile as Record<string, unknown>).expectedUid = "";
    if (kind.endsWith("disabled"))
      (old.snapshot.lane as DeviceLane).enabled = false;
    if (kind === "prior-day-active") {
      old.status = "running";
      task.status = "running";
    }
    if (kind === "prior-day-missing-end") delete task.finishedAt;
    if (kind === "prior-day-orphan") {
      delete task.executionId;
      delete task.batchId;
    }
    s.requests.push(old);
    s.tasks.push(task);
    if (kind === "prior-day-conflict")
      s.tasks.push({ ...structuredClone(task), message: "conflicting record" });
    const unchanged = structuredClone({ old, task });
    if (
      [
        "prior-day",
        "prior-day-abandoned",
        "prior-day-no-uid",
        "prior-day-disabled",
      ].includes(kind)
    )
      expect(s.proof()).toBeDefined();
    else expect(s.proof()).toBeUndefined();
    expect({ old, task }).toEqual(unchanged);
  },
);

it.each([
  "valid",
  "today-observation",
  "future-observation",
  "effect-before-step",
  "missing-step-bounds",
])(
  "never uses the old game day to hide inconsistent YYS effect evidence: %s",
  (kind) => {
    const s = fixture();
    const old: ExecutionRecord = {
      ...structuredClone(s.parent),
      id: "old-yys:lane-b",
      batchId: "old-yys",
      status: "unknown",
      startupFault: undefined,
      startedAt: "2026-10-07T10:00:00.000Z",
      finishedAt: "2026-10-07T10:01:00.000Z",
    };
    delete old.snapshot.arknightsPlan;
    delete old.snapshot.profile;
    (old.snapshot.lane as DeviceLane).arknights.enabled = false;
    (old.snapshot.lane as DeviceLane).onmyoji.enabled = true;
    const plan: Plan = {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["login", "mail"],
    };
    old.snapshot.onmyojiPlan = plan;
    const task = taskFor(old, plan);
    task.status = "failed";
    const step = task.steps[1];
    step.status = "failed";
    const observedAt =
      kind === "today-observation"
        ? "2026-10-08T10:01:00.000Z"
        : kind === "future-observation"
          ? "2026-10-09T10:01:00.000Z"
          : old.finishedAt!;
    step.result = {
      onmyoji: {
        version: 1,
        skillId: "mail",
        phase: "submitted",
        observedAt,
        effects:
          kind === "effect-before-step"
            ? [
                {
                  kind: "mail-claim",
                  observedAt: "2026-10-07T09:59:00.000Z",
                  evidenceReference: "onmyoji:mail:effect:1",
                  summary: "recorded",
                },
              ]
            : [],
      },
    };
    if (kind === "missing-step-bounds") {
      delete step.startedAt;
      delete step.finishedAt;
    }
    s.requests.push(old);
    s.tasks.push(task);
    if (kind === "valid") expect(s.proof()).toBeDefined();
    else expect(s.proof()).toBeUndefined();
  },
);

it.each(["invalid-native", "today-native-observation"])(
  "does not exempt old contradictory native evidence: %s",
  (kind) => {
    const s = fixture();
    const old: ExecutionRecord = {
      ...structuredClone(s.parent),
      id: "old-native:lane-b",
      batchId: "old-native",
      status: "unknown",
      startupFault: undefined,
      startedAt: "2026-10-07T10:00:00.000Z",
      finishedAt: "2026-10-07T10:01:00.000Z",
    };
    const task = taskFor(old, old.snapshot.arknightsPlan as Plan);
    task.status = "failed";
    task.steps[0].status = "failed";
    task.steps[0].result = {
      arknights: {
        version: kind === "invalid-native" ? 2 : 1,
        taskType: "StartUp",
        submission: "submitted",
        completion: "unknown",
        taskId: 1,
        observedAt:
          kind === "today-native-observation"
            ? "2026-10-08T10:01:00.000Z"
            : old.finishedAt!,
      } as any,
    };
    s.requests.push(old);
    s.tasks.push(task);
    expect(s.proof()).toBeUndefined();
  },
);

it("accepts only the exact earlier verified StartUp reconciliation and passes it through Goal completion", () => {
  const s = fixture();
  const old: ExecutionRecord = {
    ...structuredClone(s.parent),
    id: "old:lane-b",
    batchId: "old",
    status: "cancelled",
    startedAt: "2026-10-08T10:00:00.000Z",
    finishedAt: "2026-10-08T10:01:00.000Z",
    startupFault: undefined,
  };
  const oldTask = taskFor(old, old.snapshot.arknightsPlan as Plan);
  oldTask.status = "cancelled";
  oldTask.steps[0].status = "cancelled";
  oldTask.steps[0].result = {
    arknights: {
      version: 1,
      taskType: "StartUp",
      submission: "submitted",
      completion: "unknown",
      observedAt: old.finishedAt!,
      taskId: 1,
    },
  };
  const fresh: ExecutionRecord = {
    ...structuredClone(old),
    id: "fresh:lane-b",
    batchId: "fresh",
    fingerprint: "c".repeat(64),
    status: "succeeded",
    startedAt: "2026-10-08T10:02:00.000Z",
    finishedAt: "2026-10-08T10:03:00.000Z",
  };
  const freshTask = taskFor(fresh, fresh.snapshot.arknightsPlan as Plan);
  freshTask.steps[0].result = {
    arknights: {
      version: 1,
      taskType: "StartUp",
      submission: "submitted",
      completion: "native-confirmed",
      observedAt: fresh.finishedAt!,
      taskId: 2,
      login: {
        expectedUid: "111111111",
        observedUid: "111111111",
        method: "profile",
        observedAt: fresh.finishedAt!,
        homeObservedAt: fresh.finishedAt!,
        home: true,
      },
    },
  };
  const fact = createStartupReconciliationFact({
    id: "verified-old",
    originalRequest: old,
    originalTasks: [oldTask],
    freshRequest: fresh,
    freshTasks: [freshTask],
    executorExit: {
      verified: true,
      requestId: old.id,
      resource: old.resources[0],
      observedAt: old.finishedAt!,
      evidenceReference: "worker-exited",
    },
    evidenceReference: "fresh-home",
    now: new Date(fresh.finishedAt!),
  });
  const child = addChild(s);
  s.requests.push(old, fresh);
  s.tasks.push(oldTask, freshTask);
  expect(
    startupFailureProof(s.parent, s.requests, s.tasks, now, child.id),
  ).toBeUndefined();
  expect(
    startupFailureProof(s.parent, s.requests, s.tasks, now, child.id, [fact]),
  ).toBeDefined();
  expect(
    evaluateGoalOutcome([s.parent, child], s.tasks, {}, s.requests, [fact])
      .flowComplete,
  ).toBe(true);
  oldTask.steps[0].message += "changed evidence";
  expect(
    startupFailureProof(s.parent, s.requests, s.tasks, now, child.id, [fact]),
  ).toBeUndefined();
});

it.each(["overlap", "contradictory-link"])(
  "rejects a task whose real association defeats its apparent old/other lane: %s",
  (kind) => {
    const s = fixture();
    const task = taskFor(s.parent, s.parent.snapshot.arknightsPlan as Plan);
    task.executionId = "different";
    task.batchId = "different";
    task.startedAt = "2026-10-08T10:59:00Z";
    if (kind === "contradictory-link") {
      const linked = {
        ...structuredClone(s.parent),
        id: task.executionId,
        batchId: task.batchId,
        startedAt: "2026-10-08T12:00:00Z",
        finishedAt: "2026-10-08T12:01:00Z",
      };
      s.requests.push(linked);
      task.laneId = "lane-other";
      task.instance = 5;
      task.startedAt = s.parent.startedAt;
    }
    s.tasks.push(task);
    expect(s.proof()).toBeUndefined();
  },
);

it.each(["same-run", "later-invalid"])(
  "does not let an unreliable child task reuse admission proof: %s",
  (kind) => {
    const s = fixture();
    const child = addChild(s);
    const extra = structuredClone(s.tasks[0]);
    extra.laneId = "lane-other";
    if (kind === "later-invalid") {
      extra.runId = "extra-child-task";
      extra.startedAt = "2026-10-08T11:11:00Z";
    }
    s.tasks.push(extra);
    expect(
      startupFailureProof(s.parent, s.requests, s.tasks, now, child.id),
    ).toBeUndefined();
    expect(progress(s).wholePlanComplete).toBe(false);
  },
);
