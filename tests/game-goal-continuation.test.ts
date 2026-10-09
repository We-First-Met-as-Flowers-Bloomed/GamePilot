import { expect, it, vi } from "vitest";
import { goalContinuationScopes } from "../games/goal-continuation";
import { previewDailyContinuation } from "../games/continuation";
import { projectExecutionDetail } from "../games/execution-detail";
import { defaultArknightsConfig } from "../games/arknights/config";
import {
  GoalService,
  type PreparedGoal,
} from "../apps/desktop/main/agent-goals";
import type {
  GoalObservation,
  GoalRecoveryReference,
} from "../packages/protocol/agent-goal";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";

const now = new Date("2026-10-05T08:02:00.000Z");
const scope = {
  laneId: "lane-a",
  gameId: "arknights",
  skillIds: ["login", "award"],
  resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
};
function failure(requestId: string) {
  const plan = {
    gameId: "arknights",
    mode: "live" as const,
    skillIds: scope.skillIds,
  };
  const request: ExecutionRecord = {
    version: 1,
    id: requestId,
    laneId: "lane-a",
    batchId: requestId.split(":")[0],
    source: "daily",
    fingerprint: "original",
    resources: ["device-a"],
    status: "unknown",
    startedAt: "2026-10-05T08:00:00.000Z",
    finishedAt: "2026-10-05T08:01:00.000Z",
    message: "login failed",
    snapshot: {
      arknightsPlan: plan,
      lane: {
        id: "lane-a",
        name: "account one",
        instance: 0,
        arknights: { profileId: "p" },
      },
      profile: {
        ...defaultArknightsConfig,
        id: "p",
        name: "p",
        expectedUid: "111111111",
      },
    },
  };
  const task: TaskRecord = {
    version: 1,
    runId: "run-original",
    executionId: request.id,
    batchId: request.batchId,
    laneId: request.laneId,
    instance: 0,
    profileId: "p",
    gameId: "arknights",
    plan,
    status: "failed",
    startedAt: request.startedAt,
    updatedAt: request.finishedAt!,
    finishedAt: request.finishedAt,
    message: "not submitted",
    steps: [
      {
        skillId: "login",
        status: "failed",
        message: "native startup not submitted",
        diagnostics: [],
        result: {
          arknights: {
            version: 1,
            taskType: "StartUp",
            submission: "not-submitted",
            completion: "not-started",
            observedAt: "2026-10-05T08:00:50.000Z",
          },
        },
      },
      {
        skillId: "award",
        status: "not-run",
        message: "not started",
        diagnostics: [],
      },
    ],
  };
  return {
    request,
    task,
    preview: previewDailyContinuation(
      projectExecutionDetail(request, [task]),
      request,
      now,
    ),
  };
}

it("converts real business-only preview defaults into login-first authorized continuation scopes", () => {
  const { preview } = failure("batch:lane-a");
  expect(preview.canContinue).toBe(true);
  expect(preview.defaults).toEqual([
    { gameId: "arknights", skillIds: ["award"] },
  ]);
  const before = structuredClone(preview);
  expect(goalContinuationScopes(preview, "lane-a")).toEqual([scope]);
  expect(preview).toEqual(before);
});

it("allows GoalService recovery under the fresh login gate using actual preview defaults", async () => {
  const owner = { sessionId: "chat-a", turnId: "turn-a" };
  let observation: GoalObservation = {
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
    summary: "waiting",
  };
  let next: PreparedGoal | undefined;
  const prepared: PreparedGoal = {
    scopes: [scope],
    fingerprint: "frozen",
    frozenPlan: { kind: "saved-daily", hash: "a".repeat(64) },
    summary: [],
    payload: {},
  };
  const submit = vi.fn(async (goal) => ({
    batchId: goal.submission!.batchId,
    requestIds: goal.submission!.requestIds,
  }));
  const service = new GoalService({
    now: () => now,
    save: async () => {},
    prepare: async () => prepared,
    submit,
    observe: async () => observation,
    recover: async () => next!,
    stop: async () => observation,
  });
  let goal = await service.create({
    ...owner,
    prompt: "运行保存日常",
    selection: { kind: "saved-daily" },
    grant: {
      ...owner,
      id: "grant-a",
      source: "user-message",
      issuedAt: now.toISOString(),
      expiresAt: "2026-10-05T09:00:00.000Z",
      scopes: [scope],
      maxRetries: 2,
    },
  });
  goal = await service.submit(goal.id, owner);
  const originalId = goal.submission!.requestIds[0],
    { preview } = failure(originalId);
  const scopes = goalContinuationScopes(preview, "lane-a");
  const recovery: GoalRecoveryReference = {
    requestId: originalId,
    reference: "registered-native-proof",
    ...scopes[0],
    remainingScopes: scopes,
    safety: {
      kind: "native-not-submitted",
      fingerprint: "native-proof",
      observedAt: now.toISOString(),
      nativeSubmission: "not-submitted",
      accountProof: "login-gate-before-effects",
    },
  };
  observation = {
    requests: [
      {
        requestId: originalId,
        laneId: "lane-a",
        status: "unknown",
        skills: [],
        flowComplete: false,
        goalSatisfied: false,
      },
    ],
    flowComplete: false,
    goalSatisfied: false,
    summary: "startup was not submitted",
    recovery,
  };
  next = {
    ...prepared,
    scopes,
    frozenPlan: {
      kind: "continuation",
      hash: preview.fingerprint,
      parentRequestId: originalId,
    },
  };
  await service.refresh(goal.id);
  goal = await service.recover(goal.id, owner);
  expect(goal.status).toBe("waiting");
  expect(goal.attempts[1].review.scopes).toEqual([scope]);
  expect(goal.submission?.parentRequestId).toBe(originalId);
  expect(submit).toHaveBeenCalledTimes(2);
  expect(goal.requests[0].status).toBe("unknown");
});
