import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StartupReconciliationStore } from "../apps/desktop/main/startup-reconciliation-store";
import {
  recordStartupReconciliations,
  verifiedStartupFacts,
} from "../apps/desktop/main/startup-reconciliation";
import { defaultArknightsConfig } from "../games/arknights/config";
import { arknightsConfigForPlan } from "../games/arknights/daily-plan";
import {
  createStartupReconciliationFact,
  matchesStartupReconciliation,
  startupReconciliationCandidate,
  verifyStartupReconciliationFact,
} from "../games/arknights/startup-reconciliation";
import { validStartupReconciliationFact } from "../packages/protocol/startup-reconciliation";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { projectExecutionDetail } from "../games/execution-detail";
import {
  previewDailyContinuation,
  continuationPlans,
} from "../games/continuation";
import {
  assertContinuationHistory,
  completedContinuationRequestIds,
} from "../games/continuation-history";
import { mergeExecutionProgress } from "../games/execution-progress";
import { ExecutionProgressService } from "../apps/desktop/main/execution-progress";
import { ContinuationService } from "../apps/desktop/main/continuation-service";
import type { ExecutionCoordinator } from "../apps/desktop/main/execution-coordinator";
import type { RunLedger } from "../apps/desktop/main/run-ledger";
import type { ExecutionDetailService } from "../apps/desktop/main/execution-detail";

const oldStart = "2026-10-07T05:25:00.000Z";
const oldEnd = "2026-10-07T05:26:00.000Z";
const exitAt = "2026-10-07T11:00:00.000Z";
const newStart = "2026-10-07T11:00:01.000Z";
const nativeAt = "2026-10-07T11:00:02.000Z";
const uidAt = "2026-10-07T11:00:03.000Z";
const homeAt = "2026-10-07T11:00:04.000Z";
const newEnd = "2026-10-07T11:00:05.000Z";
const now = new Date("2026-10-07T11:00:06.000Z");
const resource = "mumu:d:\\mumu\\mumumanager.exe#0";
function fixture() {
  const profile = {
    ...defaultArknightsConfig,
    id: "fixture-profile",
    name: "fixture profile",
    expectedUid: "111222333",
    stage: "LS-6",
  };
  const lane = {
    id: "lane-a",
    name: "fixture account",
    managerPath: "D:\\MuMu\\MuMuManager.exe",
    instance: 0,
    enabled: true,
    arknights: { enabled: true, profileId: profile.id },
    onmyoji: { enabled: false },
    closeEmulatorAfterSuccess: false,
  };
  const plan = {
    gameId: "arknights",
    mode: "live" as const,
    skillIds: ["login"],
  };
  const originalRequest: ExecutionRecord = {
    version: 1,
    id: "old:lane-a",
    batchId: "old",
    laneId: "lane-a",
    source: "daily",
    resources: [resource],
    fingerprint: "a".repeat(64),
    status: "cancelled",
    startedAt: oldStart,
    finishedAt: oldEnd,
    message: "cancelled",
    snapshot: { lane, profile, arknightsPlan: plan },
  };
  const originalTasks: TaskRecord[] = [
    {
      version: 1,
      executionId: originalRequest.id,
      runId: "old-run",
      batchId: "old",
      laneId: lane.id,
      instance: lane.instance,
      profileId: profile.id,
      gameId: "arknights",
      plan,
      status: "cancelled",
      startedAt: oldStart,
      updatedAt: oldEnd,
      finishedAt: oldEnd,
      message: "cancelled",
      steps: [
        {
          skillId: "login",
          status: "cancelled",
          startedAt: oldStart,
          finishedAt: oldEnd,
          message: "unknown original native completion",
          diagnostics: [],
          result: {
            arknights: {
              version: 1,
              taskType: "StartUp",
              submission: "submitted",
              completion: "unknown",
              observedAt: oldEnd,
              taskId: 1,
            },
          },
        },
      ],
    },
  ];
  const freshRequest: ExecutionRecord = {
    ...structuredClone(originalRequest),
    id: "new:lane-a",
    batchId: "new",
    fingerprint: "b".repeat(64),
    status: "succeeded",
    startedAt: newStart,
    finishedAt: newEnd,
  };
  const freshTasks: TaskRecord[] = [
    {
      ...structuredClone(originalTasks[0]),
      executionId: freshRequest.id,
      runId: "new-run",
      batchId: "new",
      status: "succeeded",
      startedAt: newStart,
      updatedAt: newEnd,
      finishedAt: newEnd,
      steps: [
        {
          skillId: "login",
          status: "succeeded",
          startedAt: newStart,
          finishedAt: newEnd,
          message: "host login verification",
          diagnostics: [],
          result: {
            goalSatisfied: true,
            evidenceTimestamp: homeAt,
            evidenceReference: "new:lane-a:login-identity-and-home",
            arknights: {
              version: 1,
              taskType: "StartUp",
              submission: "submitted",
              completion: "native-confirmed",
              observedAt: nativeAt,
              taskId: 2,
              login: {
                expectedUid: profile.expectedUid,
                observedUid: profile.expectedUid,
                observedAt: uidAt,
                method: "profile",
                homeObservedAt: homeAt,
                home: true,
              },
            },
          },
        },
      ],
    },
  ];
  return {
    id: "startup-reconcile-fixture",
    originalRequest,
    originalTasks,
    freshRequest,
    freshTasks,
    executorExit: {
      verified: true as const,
      requestId: originalRequest.id,
      resource,
      observedAt: exitAt,
      evidenceReference: "runtime:original-worker-and-bridge-exited",
    },
    evidenceReference: "new:lane-a:login-identity-and-home",
    now,
  };
}

function businessPrefixFixture(serial = true) {
  const data = fixture();
  const plan = {
    gameId: "arknights",
    mode: "live" as const,
    skillIds: [
      "login",
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ],
  };
  data.originalRequest.status = "unknown";
  data.originalRequest.snapshot.arknightsPlan = structuredClone(plan);
  const task = data.originalTasks[0];
  task.plan = structuredClone(plan);
  task.status = "failed";
  task.steps[0].status = "failed";
  task.steps.push(
    ...plan.skillIds.slice(1).map((skillId) => ({
      skillId,
      status: "not-run" as const,
      message: "本轮未执行",
      diagnostics: [],
    })),
  );
  if (serial) {
    data.originalRequest.snapshot.onmyojiPlan = {
      gameId: "onmyoji",
      mode: "live",
      skillIds: [
        "login",
        "check-in",
        "mail",
        "daily-gift",
        "realm-raid",
        "hana-claim",
      ],
    };
    (
      data.originalRequest.snapshot.lane as { onmyoji: { enabled: boolean } }
    ).onmyoji.enabled = true;
  }
  return data;
}

describe("pure StartUp reconciliation candidates", () => {
  it("selects one submitted unknown login without mutating the old facts or exposing UID", () => {
    const data = fixture();
    const before = structuredClone(data);
    const candidate = startupReconciliationCandidate(
      data.originalRequest,
      data.originalTasks,
    );
    expect(candidate).toMatchObject({
      originalRequestId: "old:lane-a",
      originalRunId: "old-run",
      skillId: "login",
      gameDay: "2026-10-07",
      binding: {
        resource,
        laneId: "lane-a",
        profileId: "fixture-profile",
        clientType: "Official",
      },
    });
    expect(JSON.stringify(candidate)).not.toContain("111222333");
    expect(data).toEqual(before);
  });

  it("allows a reliably stopped serial lane with no subsequent YYS task", () => {
    const data = fixture();
    data.originalRequest.snapshot.onmyojiPlan = {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["login", "mail"],
    };
    (
      data.originalRequest.snapshot.lane as { onmyoji: { enabled: boolean } }
    ).onmyoji.enabled = true;
    expect(
      startupReconciliationCandidate(data.originalRequest, data.originalTasks),
    ).toBeDefined();
  });

  it.each(["friends", "award", "fight"])(
    "refuses an old plan containing %s even if its task is missing",
    (skillId) => {
      const data = fixture();
      (
        data.originalRequest.snapshot.arknightsPlan as { skillIds: string[] }
      ).skillIds.push(skillId);
      expect(
        startupReconciliationCandidate(
          data.originalRequest,
          data.originalTasks,
        ),
      ).toBeUndefined();
    },
  );

  it.each(["Mall", "Award", "Fight"])(
    "refuses an unknown %s task disguised as login",
    (taskType) => {
      const data = fixture();
      data.originalTasks[0].steps[0].result!.arknights!.taskType = taskType;
      expect(
        startupReconciliationCandidate(
          data.originalRequest,
          data.originalTasks,
        ),
      ).toBeUndefined();
    },
  );

  it("refuses a later YYS task with unknown gift effects", () => {
    const data = fixture();
    data.originalRequest.snapshot.onmyojiPlan = {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["daily-gift"],
    };
    data.originalTasks.push({
      ...structuredClone(data.originalTasks[0]),
      gameId: "onmyoji",
      runId: "yys-run",
    });
    expect(
      startupReconciliationCandidate(data.originalRequest, data.originalTasks),
    ).toBeUndefined();
  });

  it.each([
    "missing",
    "duplicate",
    "wrong-instance",
    "wrong-profile",
    "running",
    "unknown-serial",
    "wrong-resource",
  ])("refuses %s association evidence", (mode) => {
    const data = fixture();
    if (mode === "missing") data.originalTasks = [];
    if (mode === "duplicate")
      data.originalTasks.push(structuredClone(data.originalTasks[0]));
    if (mode === "wrong-instance") data.originalTasks[0].instance = 1;
    if (mode === "wrong-profile")
      data.originalTasks[0].profileId = "other-profile";
    if (mode === "running") data.originalRequest.status = "running";
    if (mode === "wrong-resource") data.originalRequest.resources = ["*"];
    if (mode === "unknown-serial") {
      data.originalTasks[0].status = "unknown";
      data.originalRequest.snapshot.onmyojiPlan = {
        gameId: "onmyoji",
        mode: "live",
        skillIds: ["login", "mail"],
      };
    }
    expect(
      startupReconciliationCandidate(data.originalRequest, data.originalTasks),
    ).toBeUndefined();
  });

  it.each([
    "enabled-yys-without-plan",
    "disabled-yys-with-plan",
    "unknown-yys-skill",
    "missing-task-end",
    "unsupported-source",
  ])("refuses %s rather than guessing serial non-start", (mode) => {
    const data = fixture();
    if (mode === "enabled-yys-without-plan")
      (
        data.originalRequest.snapshot.lane as { onmyoji: { enabled: boolean } }
      ).onmyoji.enabled = true;
    if (mode === "disabled-yys-with-plan" || mode === "unknown-yys-skill") {
      data.originalRequest.snapshot.onmyojiPlan = {
        gameId: "onmyoji",
        mode: "live",
        skillIds: [mode === "unknown-yys-skill" ? "unknown-effect" : "mail"],
      };
    }
    if (mode === "unknown-yys-skill")
      (
        data.originalRequest.snapshot.lane as { onmyoji: { enabled: boolean } }
      ).onmyoji.enabled = true;
    if (mode === "missing-task-end") delete data.originalTasks[0].finishedAt;
    if (mode === "unsupported-source")
      data.originalRequest.source = "other" as "daily";
    expect(
      startupReconciliationCandidate(data.originalRequest, data.originalTasks),
    ).toBeUndefined();
  });
});

describe("startup-only submitted prefix in a frozen business plan", () => {
  it.each([false, true])(
    "accepts a completely recorded unstarted suffix (serial=%s) without changing old facts",
    (serial) => {
      const data = businessPrefixFixture(serial);
      const before = structuredClone(data);
      expect(
        startupReconciliationCandidate(
          data.originalRequest,
          data.originalTasks,
        ),
      ).toMatchObject({
        originalRequestId: data.originalRequest.id,
        originalFingerprint: data.originalRequest.fingerprint,
        originalRunId: data.originalTasks[0].runId,
        skillId: "login",
      });
      expect(data).toEqual(before);
    },
  );

  it.each([
    "pending",
    "running",
    "succeeded",
    "skipped",
    "failed",
    "cancelled",
    "unknown",
  ] as const)("refuses a %s business step", (status) => {
    const data = businessPrefixFixture();
    data.originalTasks[0].steps[1].status = status;
    expect(
      startupReconciliationCandidate(data.originalRequest, data.originalTasks),
    ).toBeUndefined();
  });

  it.each([
    "started",
    "finished",
    "result",
    "evidence",
    "diagnostics",
    "missing-step",
    "reordered",
    "missing-login-start",
    "missing-login-end",
    "unknown-task",
  ])("refuses contradictory or incomplete prefix evidence: %s", (mode) => {
    const data = businessPrefixFixture(false);
    const task = data.originalTasks[0];
    const step = task.steps[1];
    if (mode === "started") step.startedAt = oldEnd;
    if (mode === "finished") step.finishedAt = oldEnd;
    if (mode === "result") step.result = { goalSatisfied: false };
    if (mode === "evidence") step.evidence = "adapter-result";
    if (mode === "diagnostics") step.diagnostics.push("business diagnostic");
    if (mode === "missing-step") task.steps.pop();
    if (mode === "reordered") task.steps.reverse();
    if (mode === "missing-login-start") delete task.steps[0].startedAt;
    if (mode === "missing-login-end") delete task.steps[0].finishedAt;
    if (mode === "unknown-task") task.status = "unknown";
    expect(
      startupReconciliationCandidate(data.originalRequest, data.originalTasks),
    ).toBeUndefined();
  });

  it.each(["missing-execution-id", "wrong-execution-id", "duplicate-run"])(
    "refuses %s in the full raw ledger even outside the projected request",
    (mode) => {
      const data = businessPrefixFixture();
      const other = structuredClone(data.originalTasks[0]);
      other.runId = "ambiguous-run";
      if (mode === "missing-execution-id") delete other.executionId;
      if (mode === "wrong-execution-id") other.executionId = "other:lane-a";
      if (mode === "duplicate-run") {
        other.executionId = "other:lane-a";
        other.batchId = "other";
        other.runId = data.originalTasks[0].runId;
      }
      expect(
        startupReconciliationCandidate(data.originalRequest, [
          ...data.originalTasks,
          other,
        ]),
      ).toBeUndefined();
    },
  );

  it("keeps a legitimate sibling lane outside the original request scope", () => {
    const data = businessPrefixFixture();
    const sibling = {
      ...structuredClone(data.originalTasks[0]),
      executionId: "old:lane-b",
      laneId: "lane-b",
      instance: 1,
    };
    expect(
      startupReconciliationCandidate(data.originalRequest, [
        ...data.originalTasks,
        sibling,
      ]),
    ).toBeDefined();
  });

  it("reconciles only with a fresh pure login and binds every original unstarted step", () => {
    const data = businessPrefixFixture();
    const before = structuredClone(data);
    const fact = createStartupReconciliationFact(data);
    expect(
      verifyStartupReconciliationFact(
        fact,
        data.originalRequest,
        data.originalTasks,
        data.freshRequest,
        data.freshTasks,
      ),
    ).toBe(true);
    expect(data).toEqual(before);
    data.originalTasks[0].steps[1].message = "different persisted fact";
    expect(
      matchesStartupReconciliation(
        fact,
        data.originalRequest,
        data.originalTasks,
      ),
    ).toBe(false);
  });

  it("does not accept a fresh login followed by an unstarted business suffix", () => {
    const data = businessPrefixFixture();
    const plan = {
      gameId: "arknights",
      mode: "live" as const,
      skillIds: ["login", "award"],
    };
    data.freshRequest.snapshot.arknightsPlan = structuredClone(plan);
    data.freshTasks[0].plan = structuredClone(plan);
    data.freshTasks[0].steps.push({
      skillId: "award",
      status: "not-run",
      message: "本轮未执行",
      diagnostics: [],
    });
    expect(() => createStartupReconciliationFact(data)).toThrow();
  });

  it("offers only unstarted business defaults and inserts login again for both games", () => {
    const data = businessPrefixFixture();
    const before = structuredClone(data);
    const detail = projectExecutionDetail(
      data.originalRequest,
      data.originalTasks,
    );
    expect(
      previewDailyContinuation(detail, data.originalRequest, data.now)
        .canContinue,
    ).toBe(false);
    const fact = createStartupReconciliationFact(data);
    const preview = previewDailyContinuation(
      detail,
      data.originalRequest,
      data.now,
      [fact],
    );
    expect(preview.canContinue).toBe(true);
    expect(preview.steps[0]).toMatchObject({
      skillId: "login",
      status: "pending",
    });
    expect(preview.defaults).toEqual([
      {
        gameId: "arknights",
        skillIds: ["recruit", "fight", "infrastructure", "friends", "award"],
      },
      {
        gameId: "onmyoji",
        skillIds: [
          "check-in",
          "mail",
          "daily-gift",
          "realm-raid",
          "hana-claim",
        ],
      },
    ]);
    const input = {
      parentId: data.originalRequest.id,
      fingerprint: preview.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: false,
    };
    expect(continuationPlans(preview, input, [fact])).toEqual([
      data.originalRequest.snapshot.arknightsPlan,
      data.originalRequest.snapshot.onmyojiPlan,
    ]);
    expect(() =>
      continuationPlans(
        preview,
        {
          ...input,
          selections: [{ gameId: "arknights", skillIds: ["login"] }],
        },
        [fact],
      ),
    ).toThrow();
    expect(data).toEqual(before);
  });
});

describe("exact startup reconciliation facts", () => {
  it("creates a fact from exit and a separate fresh verified login, retaining the old unknown result", () => {
    const data = fixture();
    const fact = createStartupReconciliationFact(data);
    expect(validStartupReconciliationFact(fact)).toBe(true);
    expect(
      matchesStartupReconciliation(
        fact,
        data.originalRequest,
        data.originalTasks,
      ),
    ).toBe(true);
    expect(fact.freshLogin).toMatchObject({
      requestId: "new:lane-a",
      runId: "new-run",
      observedAt: homeAt,
    });
    expect(data.originalTasks[0].steps[0].result!.arknights!.completion).toBe(
      "unknown",
    );
    expect(data.originalRequest.status).toBe("cancelled");
    expect(JSON.stringify(fact)).not.toContain("111222333");
  });

  it.each([
    "missing-exit",
    "wrong-exit-request",
    "wrong-exit-device",
    "old-exit",
    "stale-login",
    "future-login",
    "same-request",
    "no-native-completion",
    "no-identity",
    "wrong-uid",
    "wrong-client",
    "wrong-profile",
    "business-in-fresh-plan",
    "duplicate-fresh",
    "failed-fresh",
    "missing-home",
    "legacy-home-identity",
  ])("refuses %s evidence instead of accepting booleans or logs", (mode) => {
    const data = fixture();
    if (mode === "missing-exit") data.executorExit.verified = false as true;
    if (mode === "wrong-exit-request")
      data.executorExit.requestId = "other:lane-a";
    if (mode === "wrong-exit-device")
      data.executorExit.resource = "mumu:d:\\mumu\\mumumanager.exe#1";
    if (mode === "old-exit") data.executorExit.observedAt = oldStart;
    if (mode === "stale-login") data.now = new Date("2026-10-07T11:02:00.000Z");
    if (mode === "future-login") data.now = new Date(uidAt);
    if (mode === "same-request") data.freshRequest.id = data.originalRequest.id;
    if (mode === "no-native-completion")
      data.freshTasks[0].steps[0].result!.arknights!.completion = "unknown";
    if (mode === "no-identity")
      delete data.freshTasks[0].steps[0].result!.arknights!.login;
    if (mode === "wrong-uid")
      data.freshTasks[0].steps[0].result!.arknights!.login!.observedUid =
        "999888777";
    if (mode === "wrong-client")
      (
        data.freshRequest.snapshot.profile as { clientType: string }
      ).clientType = "Bilibili";
    if (mode === "wrong-profile")
      (data.freshRequest.snapshot.profile as { id: string }).id = "other";
    if (mode === "business-in-fresh-plan")
      (
        data.freshRequest.snapshot.arknightsPlan as { skillIds: string[] }
      ).skillIds.push("award");
    if (mode === "duplicate-fresh")
      data.freshTasks.push(structuredClone(data.freshTasks[0]));
    if (mode === "failed-fresh") data.freshRequest.status = "failed";
    if (mode === "missing-home")
      delete data.freshTasks[0].steps[0].result!.arknights!.login!
        .homeObservedAt;
    if (mode === "legacy-home-identity") {
      delete data.freshTasks[0].steps[0].result!.arknights!.login!.method;
      delete data.freshTasks[0].steps[0].result!.arknights!.login!
        .homeObservedAt;
    }
    expect(() => createStartupReconciliationFact(data)).toThrow();
  });

  it.each([
    "original-native",
    "fingerprint",
    "binding",
    "run",
    "new-field",
    "invalid-hash",
  ])("does not match a fact after %s changes", (mode) => {
    const data = fixture();
    const fact = createStartupReconciliationFact(data);
    if (mode === "original-native")
      data.originalTasks[0].steps[0].result!.arknights!.taskId = 3;
    if (mode === "fingerprint")
      data.originalRequest.fingerprint = "c".repeat(64);
    if (mode === "binding")
      (
        data.originalRequest.snapshot.profile as { expectedUid: string }
      ).expectedUid = "999888777";
    if (mode === "run") data.originalTasks[0].runId = "other-run";
    if (mode === "new-field")
      Object.assign(fact, { completion: "native-confirmed" });
    if (mode === "invalid-hash") fact.candidate.evidenceHash = "bad";
    expect(
      matchesStartupReconciliation(
        fact,
        data.originalRequest,
        data.originalTasks,
      ),
    ).toBe(false);
  });

  it("never lets a pure-startup fact match an independent failed YYS gift request", () => {
    const data = fixture();
    const fact = createStartupReconciliationFact(data);
    const other = structuredClone(data.originalRequest);
    other.id = "old-gift:lane-a";
    other.snapshot.onmyojiPlan = {
      gameId: "onmyoji",
      mode: "live",
      skillIds: ["daily-gift"],
    };
    expect(matchesStartupReconciliation(fact, other, data.originalTasks)).toBe(
      false,
    );
  });

  it("reloads an old fact only through its exact original and fresh ledger records", () => {
    const data = fixture();
    const fact = createStartupReconciliationFact(data);
    expect(
      verifyStartupReconciliationFact(
        fact,
        data.originalRequest,
        data.originalTasks,
        data.freshRequest,
        data.freshTasks,
      ),
    ).toBe(true);
    data.freshTasks[0].steps[0].result!.arknights!.taskId = 99;
    expect(
      verifyStartupReconciliationFact(
        fact,
        data.originalRequest,
        data.originalTasks,
        data.freshRequest,
        data.freshTasks,
      ),
    ).toBe(false);
  });

  it("rejects a modified fresh request fingerprint after persistence", () => {
    const data = fixture();
    const fact = createStartupReconciliationFact(data);
    data.freshRequest.fingerprint = "c".repeat(64);
    expect(
      verifyStartupReconciliationFact(
        fact,
        data.originalRequest,
        data.originalTasks,
        data.freshRequest,
        data.freshTasks,
      ),
    ).toBe(false);
  });

  it("retains an already verified fact when the original issue is ended afterwards", () => {
    const data = fixture();
    const fact = createStartupReconciliationFact(data);
    data.originalRequest.resolution = {
      action: "abandoned",
      at: "2026-10-07T11:00:20.000Z",
      note: "issue ended later",
    };
    expect(
      startupReconciliationCandidate(data.originalRequest, data.originalTasks),
    ).toBeUndefined();
    expect(
      matchesStartupReconciliation(
        fact,
        data.originalRequest,
        data.originalTasks,
      ),
    ).toBe(true);
    expect(
      verifyStartupReconciliationFact(
        fact,
        data.originalRequest,
        data.originalTasks,
        data.freshRequest,
        data.freshTasks,
      ),
    ).toBe(true);
    expect(() => createStartupReconciliationFact(data)).toThrow();
  });

  it("refuses a fact that postdates the original issue's resolution", () => {
    const data = fixture();
    const fact = createStartupReconciliationFact(data);
    data.originalRequest.resolution = {
      action: "abandoned",
      at: "2026-10-07T11:00:05.000Z",
      note: "already ended",
    };
    expect(
      matchesStartupReconciliation(
        fact,
        data.originalRequest,
        data.originalTasks,
      ),
    ).toBe(false);
    expect(
      verifyStartupReconciliationFact(
        fact,
        data.originalRequest,
        data.originalTasks,
        data.freshRequest,
        data.freshTasks,
      ),
    ).toBe(false);
  });
});

function continuationFixture() {
  const data = fixture();
  data.originalRequest.snapshot.onmyojiPlan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login", "mail"],
  };
  (
    data.originalRequest.snapshot.lane as { onmyoji: { enabled: boolean } }
  ).onmyoji.enabled = true;
  const fact = createStartupReconciliationFact(data);
  const detail = projectExecutionDetail(
    data.originalRequest,
    data.originalTasks,
  );
  const child: ExecutionRecord = {
    ...structuredClone(data.originalRequest),
    id: "child:lane-a",
    batchId: "child",
    fingerprint: "c".repeat(64),
    status: "succeeded",
    startedAt: "2026-10-07T11:00:08.000Z",
    finishedAt: "2026-10-07T11:00:20.000Z",
    snapshot: {
      ...structuredClone(data.originalRequest.snapshot),
      continuation: {
        parentId: data.originalRequest.id,
        parentFingerprint: data.originalRequest.fingerprint,
        retained: [],
        excluded: [],
        acknowledgedPartial: false,
      },
    },
  };
  child.snapshot.profile = {
    ...(child.snapshot.profile as typeof defaultArknightsConfig),
    ...arknightsConfigForPlan(
      child.snapshot.profile as typeof defaultArknightsConfig,
      child.snapshot.arknightsPlan as TaskRecord["plan"],
    ),
  };
  const ark: TaskRecord = {
    ...structuredClone(data.freshTasks[0]),
    executionId: child.id,
    batchId: child.batchId,
    runId: "child-ark-run",
    startedAt: child.startedAt,
    updatedAt: child.finishedAt!,
    finishedAt: child.finishedAt,
  };
  ark.steps[0].startedAt = child.startedAt;
  ark.steps[0].finishedAt = child.finishedAt;
  ark.steps[0].result!.evidenceTimestamp = "2026-10-07T11:00:12.000Z";
  ark.steps[0].result!.arknights!.observedAt = "2026-10-07T11:00:09.000Z";
  ark.steps[0].result!.arknights!.login!.observedAt =
    "2026-10-07T11:00:10.000Z";
  ark.steps[0].result!.arknights!.login!.homeObservedAt =
    "2026-10-07T11:00:11.000Z";
  const yysPlan = child.snapshot.onmyojiPlan as TaskRecord["plan"];
  const yys: TaskRecord = {
    ...structuredClone(ark),
    gameId: "onmyoji",
    plan: yysPlan,
    profileId: undefined,
    runId: "child-yys-run",
    startedAt: "2026-10-07T11:00:13.000Z",
    steps: yysPlan.skillIds.map((skillId) => ({
      skillId,
      status: "succeeded",
      startedAt: "2026-10-07T11:00:13.000Z",
      finishedAt: child.finishedAt,
      message: "actual flow finished",
      diagnostics: [],
    })),
  };
  const childTasks = [ark, yys];
  const details = new Map([
    [data.originalRequest.id, detail],
    [child.id, projectExecutionDetail(child, childTasks)],
  ]);
  return { ...data, fact, detail, child, childTasks, details };
}

describe("verified startup facts in continuation and progress", () => {
  it("keeps the default block and exposes matched startup as pending rather than retained", () => {
    const data = continuationFixture();
    const before = structuredClone(data.originalTasks);
    expect(
      previewDailyContinuation(data.detail, data.originalRequest, data.now)
        .canContinue,
    ).toBe(false);
    const preview = previewDailyContinuation(
      data.detail,
      data.originalRequest,
      data.now,
      [data.fact],
    );
    expect(preview.canContinue).toBe(true);
    expect(preview.steps[0]).toMatchObject({
      gameId: "arknights",
      skillId: "login",
      status: "pending",
    });
    expect(preview.defaults).toEqual([
      { gameId: "arknights", skillIds: ["login"] },
      { gameId: "onmyoji", skillIds: ["mail"] },
    ]);
    expect(data.originalTasks).toEqual(before);
  });

  it("permits only the precisely reconciled login-only child selection", () => {
    const data = continuationFixture();
    const preview = previewDailyContinuation(
      data.detail,
      data.originalRequest,
      data.now,
      [data.fact],
    );
    const input = {
      parentId: data.originalRequest.id,
      fingerprint: preview.fingerprint,
      selections: [{ gameId: "arknights", skillIds: ["login"] }],
      acknowledgePartial: false,
    };
    expect(continuationPlans(preview, input, [data.fact])).toEqual([
      { gameId: "arknights", mode: "live", skillIds: ["login"] },
    ]);
    expect(() => continuationPlans(preview, input)).toThrow();
  });

  it("restarts verified Ark login before the still-unstarted YYS business", () => {
    const data = continuationFixture();
    const preview = previewDailyContinuation(
      data.detail,
      data.originalRequest,
      data.now,
      [data.fact],
    );
    expect(
      continuationPlans(
        preview,
        {
          parentId: data.originalRequest.id,
          fingerprint: preview.fingerprint,
          selections: preview.defaults,
          acknowledgePartial: false,
        },
        [data.fact],
      ),
    ).toEqual([
      { gameId: "arknights", mode: "live", skillIds: ["login"] },
      { gameId: "onmyoji", mode: "live", skillIds: ["login", "mail"] },
    ]);
  });

  it("does not use another request's fact or a future fact to unlock the preview", () => {
    const data = continuationFixture();
    const wrong = structuredClone(data.fact);
    wrong.candidate.originalRequestId = "other:lane-a";
    expect(
      previewDailyContinuation(data.detail, data.originalRequest, data.now, [
        wrong,
      ]).canContinue,
    ).toBe(false);
    expect(
      previewDailyContinuation(
        data.detail,
        data.originalRequest,
        new Date("2026-10-07T10:59:00Z"),
        [data.fact],
      ).canContinue,
    ).toBe(false);
  });

  it("allows the exact independent startup hazard while retaining global unknown business blocks", () => {
    const data = continuationFixture();
    const target = {
      ...structuredClone(data.originalRequest),
      id: "target:lane-a",
      batchId: "target",
    };
    const plans = [
      { gameId: "onmyoji", mode: "live" as const, skillIds: ["login", "mail"] },
    ];
    expect(() =>
      assertContinuationHistory(
        target,
        [target, data.originalRequest],
        data.originalTasks,
        plans,
        data.now,
      ),
    ).toThrow();
    expect(() =>
      assertContinuationHistory(
        target,
        [target, data.originalRequest],
        data.originalTasks,
        plans,
        data.now,
        [data.fact],
      ),
    ).not.toThrow();
    const unknownMall: TaskRecord = {
      ...structuredClone(data.originalTasks[0]),
      executionId: "mall:lane-a",
      runId: "unknown-mall",
      plan: { gameId: "arknights", mode: "live", skillIds: ["friends"] },
    };
    unknownMall.steps[0].skillId = "friends";
    unknownMall.steps[0].result!.arknights!.taskType = "Mall";
    expect(() =>
      assertContinuationHistory(
        target,
        [target, data.originalRequest],
        [...data.originalTasks, unknownMall],
        plans,
        data.now,
        [data.fact],
      ),
    ).toThrow(/原生|核对|未确认/);
  });

  it("does not use a startup fact to bypass an orphan submitted YYS effect", () => {
    const data = continuationFixture();
    const yys: TaskRecord = {
      ...structuredClone(data.originalTasks[0]),
      executionId: "gift:lane-a",
      gameId: "onmyoji",
      runId: "unknown-gift",
      profileId: undefined,
      plan: { gameId: "onmyoji", mode: "live", skillIds: ["daily-gift"] },
    };
    yys.steps[0] = {
      skillId: "daily-gift",
      status: "not-run",
      message: "contradictory submitted effect",
      diagnostics: [],
      result: {
        onmyoji: {
          version: 1,
          skillId: "daily-gift",
          phase: "submitted",
          observedAt: oldEnd,
          effects: [],
        },
      },
    };
    const plans = [
      {
        gameId: "arknights",
        mode: "live" as const,
        skillIds: ["login", "recruit"],
      },
    ];
    expect(() =>
      assertContinuationHistory(
        data.originalRequest,
        [data.originalRequest],
        [...data.originalTasks, yys],
        plans,
        data.now,
        [data.fact],
      ),
    ).toThrow(/提交|核对|未确认/);
  });

  it("does not mark the original startup complete or continued from the fact alone", () => {
    const data = continuationFixture();
    const progress = mergeExecutionProgress(
      data.originalRequest.id,
      [data.originalRequest],
      new Map([[data.originalRequest.id, data.detail]]),
      [data.fact],
    );
    expect(progress.wholePlanComplete).toBe(false);
    expect(progress.steps[0]).toMatchObject({
      status: "cancelled",
      sourceId: data.originalRequest.id,
      continued: false,
    });
    expect(
      completedContinuationRequestIds(
        [data.originalRequest],
        data.originalTasks,
        [data.fact],
      ).size,
    ).toBe(0);
  });

  it("merges only the actually successful fresh child and leaves the original cancelled", () => {
    const data = continuationFixture();
    const records = [data.originalRequest, data.child];
    expect(
      mergeExecutionProgress(data.originalRequest.id, records, data.details)
        .wholePlanComplete,
    ).toBe(false);
    const progress = mergeExecutionProgress(
      data.originalRequest.id,
      records,
      data.details,
      [data.fact],
    );
    expect(progress.warnings).toEqual([]);
    expect(progress.wholePlanComplete).toBe(true);
    expect(progress.originalStatus).toBe("cancelled");
    expect(progress.steps[0]).toMatchObject({
      status: "succeeded",
      sourceId: data.child.id,
      continued: true,
    });
    expect(
      completedContinuationRequestIds(
        records,
        [...data.originalTasks, ...data.childTasks],
        [data.fact],
      ).has(data.originalRequest.id),
    ).toBe(true);
  });

  it("does not continue the old startup on a failed child or retroactively admit a pre-fact child", () => {
    const data = continuationFixture();
    data.child.status = "failed";
    data.childTasks[0].status = "failed";
    data.childTasks[0].steps[0].status = "failed";
    data.details.set(
      data.child.id,
      projectExecutionDetail(data.child, data.childTasks),
    );
    const progress = mergeExecutionProgress(
      data.originalRequest.id,
      [data.originalRequest, data.child],
      data.details,
      [data.fact],
    );
    expect(progress.wholePlanComplete).toBe(false);
    expect(progress.steps[0].continued).toBe(false);
    data.child.startedAt = "2026-10-07T11:00:05.000Z";
    expect(
      mergeExecutionProgress(
        data.originalRequest.id,
        [data.originalRequest, data.child],
        data.details,
        [data.fact],
      ).warnings.length,
    ).toBeGreaterThan(0);
  });

  it("passes verified facts from the progress service without counting fact-only completion", () => {
    const data = continuationFixture();
    const records = [data.originalRequest, data.child];
    const tasks = [...data.originalTasks, ...data.childTasks];
    const executions = {
      assertHealthy() {},
      get: (id: string) => records.find((r) => r.id === id)!,
      snapshot: () => records,
    };
    const ledger = {
      assertHealthy() {},
      forExecution: (id: string) =>
        tasks.filter((task) => task.executionId === id),
    };
    const details = { get: (id: string) => data.details.get(id)! };
    expect(
      new ExecutionProgressService(executions, ledger, details).get(
        data.originalRequest.id,
      ).wholePlanComplete,
    ).toBe(false);
    expect(
      new ExecutionProgressService(executions, ledger, details, () => [
        data.fact,
      ]).get(data.originalRequest.id).wholePlanComplete,
    ).toBe(true);
  });

  it("the continuation service reads host facts and rechecks their removal before admission", async () => {
    const data = continuationFixture();
    const records = [data.originalRequest, data.freshRequest];
    const tasks = [...data.originalTasks, ...data.freshTasks];
    let facts = [data.fact];
    let accepted = 0;
    const executions = {
      assertHealthy() {},
      get: (id: string) => structuredClone(records.find((r) => r.id === id)!),
      snapshot: () => structuredClone(records),
      async begin() {
        accepted++;
        throw Error("unexpected admission");
      },
    } as unknown as ExecutionCoordinator;
    const ledger = {
      assertHealthy() {},
      async flush() {},
      snapshot: () => structuredClone(tasks),
      forExecution: (id: string) =>
        tasks.filter((task) => task.executionId === id),
    } as unknown as RunLedger;
    const details = {
      get: (id: string) =>
        projectExecutionDetail(executions.get(id), ledger.forExecution(id)),
    } as unknown as ExecutionDetailService;
    const service = new ContinuationService({
      executions,
      ledger,
      details,
      lanes: async () => ({
        version: 1,
        lanes: [data.originalRequest.snapshot.lane as any],
      }),
      profiles: async () => ({
        version: 1,
        activeProfileId: "fixture-profile",
        profiles: [data.originalRequest.snapshot.profile as any],
      }),
      appVersion: "fixture",
      now: () => data.now,
      startupFacts: () => facts,
      assertCanStart: async () => {
        facts = [];
      },
    });
    const preview = await service.preview(data.originalRequest.id);
    expect(preview.canContinue).toBe(true);
    await expect(
      service.start(
        {
          parentId: data.originalRequest.id,
          fingerprint: preview.fingerprint,
          selections: preview.defaults,
          acknowledgePartial: false,
        },
        async () => {},
      ),
    ).rejects.toThrow(/待核对|确认/);
    expect(accepted).toBe(0);
  });
});

describe("persisted startup reconciliation completion", () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      const inside = relative(resolve(tmpdir()), resolve(directory));
      if (!inside || inside.startsWith("..") || isAbsolute(inside))
        throw Error("unsafe fixture cleanup");
      await rm(directory, { recursive: true, force: true });
    }
  });
  async function setup(data = fixture()) {
    const directory = await mkdtemp(join(tmpdir(), "gp-startup-completion-"));
    directories.push(directory);
    const store = new StartupReconciliationStore(directory);
    await store.load();
    const requests = [data.originalRequest, data.freshRequest];
    const tasks = [...data.originalTasks, ...data.freshTasks];
    const permit = {
      verified: true as const,
      observedAt: data.executorExit.observedAt,
      evidenceReference: data.executorExit.evidenceReference,
      resources: [resource],
    };
    const record = () =>
      recordStartupReconciliations(
        store,
        permit,
        data.freshRequest.id,
        requests,
        tasks,
        data.now,
      );
    return { data, directory, store, requests, tasks, permit, record };
  }

  it("publishes and reloads proof from actual ledgers while preserving the failed original", async () => {
    const s = await setup();
    const before = structuredClone({ requests: s.requests, tasks: s.tasks });
    const written = await s.record();
    expect(written).toHaveLength(1);
    const filenames = await readdir(s.directory);
    expect(filenames).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(s.directory, filenames[0]), "utf8")),
    ).toEqual(written[0]);
    const restored = new StartupReconciliationStore(s.directory);
    await restored.load();
    expect(verifiedStartupFacts(restored, s.requests, s.tasks)).toEqual(
      written,
    );
    expect({ requests: s.requests, tasks: s.tasks }).toEqual(before);
    expect(await s.record()).toEqual([]);
    s.data.freshTasks[0].steps[0].result!.arknights!.login!.observedUid =
      "999888777";
    expect(verifiedStartupFacts(restored, s.requests, s.tasks)).toEqual([]);
    expect(restored.snapshot()).toEqual(written);
  });

  it.each(["old", "fresh"])(
    "reloads a business-prefix proof only while its full %s raw ledger stays unambiguous",
    async (kind) => {
      const s = await setup(businessPrefixFixture());
      const before = structuredClone({ requests: s.requests, tasks: s.tasks });
      const written = await s.record();
      expect(written).toHaveLength(1);
      const restored = new StartupReconciliationStore(s.directory);
      await restored.load();
      expect(verifiedStartupFacts(restored, s.requests, s.tasks)).toEqual(
        written,
      );
      expect({ requests: s.requests, tasks: s.tasks }).toEqual(before);
      const conflicting = structuredClone(
        kind === "old" ? s.data.originalTasks[0] : s.data.freshTasks[0],
      );
      conflicting.runId = "conflicting-unassociated-run";
      delete conflicting.executionId;
      s.tasks.push(conflicting);
      expect(verifiedStartupFacts(restored, s.requests, s.tasks)).toEqual([]);
      expect(await s.record()).toEqual([]);
      expect(restored.snapshot()).toEqual(written);
    },
  );

  it("isolates a candidate whose executor exit happened too early and still records matching old hazards", async () => {
    const s = await setup();
    const invalid = structuredClone(s.data.originalRequest);
    invalid.id = "later:lane-a";
    invalid.batchId = "later";
    invalid.startedAt = newStart;
    invalid.finishedAt = nativeAt;
    const task = structuredClone(s.data.originalTasks[0]);
    Object.assign(task, {
      executionId: invalid.id,
      runId: "later-run",
      batchId: "later",
      startedAt: newStart,
      updatedAt: nativeAt,
      finishedAt: nativeAt,
    });
    task.steps[0].startedAt = newStart;
    task.steps[0].finishedAt = nativeAt;
    task.steps[0].result!.arknights!.observedAt = nativeAt;
    s.requests.unshift(invalid);
    s.tasks.unshift(task);
    expect(startupReconciliationCandidate(invalid, s.tasks)).toBeDefined();
    const facts = await s.record();
    expect(facts.map((f) => f.candidate.originalRequestId)).toEqual([
      s.data.originalRequest.id,
    ]);
  });

  it("refuses an unverified exit permit rather than upgrading its boolean to true", async () => {
    const s = await setup();
    s.permit.verified = false as true;
    expect(await s.record()).toEqual([]);
    expect(s.store.snapshot()).toEqual([]);
  });

  it.each(["old", "fresh"])(
    "does not persist or consume an ambiguous %s request association",
    async (kind) => {
      const s = await setup();
      const facts = await s.record();
      expect(facts).toHaveLength(1);
      s.requests.push(
        structuredClone(
          kind === "old" ? s.data.originalRequest : s.data.freshRequest,
        ),
      );
      expect(verifiedStartupFacts(s.store, s.requests, s.tasks)).toEqual([]);
      expect(await s.record()).toEqual([]);
      expect(s.store.snapshot()).toEqual(facts);
    },
  );

  it("propagates durable-store failure instead of treating it as an inapplicable candidate", async () => {
    const s = await setup();
    vi.spyOn(s.store, "append").mockRejectedValueOnce(
      Error("fixture-durable-write-failed"),
    );
    await expect(s.record()).rejects.toThrow("fixture-durable-write-failed");
    expect(s.store.snapshot()).toEqual([]);
  });

  it.each(["failed-login", "wrong-device", "stale-identity", "business-plan"])(
    "does not publish completion based on %s",
    async (kind) => {
      const s = await setup();
      if (kind === "failed-login") s.data.freshRequest.status = "failed";
      if (kind === "wrong-device")
        s.permit.resources = ["mumu:d:\\mumu\\mumumanager.exe#1"];
      if (kind === "stale-identity")
        s.data.now = new Date("2026-10-07T11:01:00.000Z");
      if (kind === "business-plan")
        (
          s.data.freshRequest.snapshot.arknightsPlan as { skillIds: string[] }
        ).skillIds.push("award");
      expect(await s.record()).toEqual([]);
      expect(s.store.snapshot()).toEqual([]);
    },
  );
});
