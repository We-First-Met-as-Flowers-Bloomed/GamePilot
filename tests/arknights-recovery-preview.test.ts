import { expect, it } from "vitest";
import { assessExecution } from "../packages/protocol/recovery";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { TaskRecord } from "../packages/protocol/task-record";
import type { ExecutionRecord } from "../packages/protocol/execution";
const at = "2026-09-25T08:00:00.000Z",
  end = "2026-09-25T08:01:00.000Z";
const plan = {
  gameId: "arknights",
  skillIds: ["login", "fight", "award"],
  mode: "live" as const,
};
const evidence = (taskType: string, complete = false) => ({
  version: 1 as const,
  taskType,
  submission: complete ? ("submitted" as const) : ("not-submitted" as const),
  completion: complete
    ? ("native-confirmed" as const)
    : ("not-started" as const),
  observedAt: at,
  ...(complete ? { taskId: 1 } : {}),
  ...(taskType === "StartUp"
    ? {
        login: {
          home: true as const,
          expectedUid: "123456789",
          observedUid: "123456789",
          observedAt: at,
        },
      }
    : {}),
});
const request: ExecutionRecord = {
  version: 1,
  id: "r",
  source: "single",
  resources: ["*"],
  fingerprint: "x",
  snapshot: {
    appVersion: "test",
    plan,
    arknights: {
      ...defaultArknightsConfig,
      stage: "LS-6",
      expectedUid: "123456789",
    },
  },
  status: "failed",
  startedAt: at,
  finishedAt: end,
  message: "failed",
};
function task(): TaskRecord {
  return {
    version: 1,
    executionId: "r",
    runId: "run",
    gameId: "arknights",
    plan,
    status: "failed",
    startedAt: at,
    updatedAt: end,
    finishedAt: end,
    message: "failed",
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        startedAt: at,
        finishedAt: end,
        evidence: "adapter-result",
        result: { arknights: evidence("StartUp", true) },
        message: "home",
        diagnostics: [],
      },
      {
        skillId: "fight",
        status: "failed",
        startedAt: at,
        finishedAt: end,
        result: { arknights: evidence("Fight") },
        message: "not submitted",
        diagnostics: [],
      },
      {
        skillId: "award",
        status: "not-run",
        message: "not run",
        diagnostics: [],
      },
    ],
  };
}
const review = (r = request, t = task(), version = "test") =>
  assessExecution(r, [t], version, new Date(end));
it("proposes only the unsubmitted suffix, preserving completed prefix without executing anything", () => {
  expect(review()).toMatchObject({
    canResume: false,
    resumePreview: {
      state: "needs-inspection",
      retained: ["login"],
      candidates: ["fight", "award"],
      blocked: [],
    },
  });
});
it("blocks ambiguous submitted work and legacy callback-free completion", () => {
  const t = task();
  t.steps[1].result!.arknights = {
    ...evidence("Fight"),
    submission: "submitted",
    completion: "unknown",
  };
  expect(review(request, t).resumePreview?.state).toBe("blocked");
  delete t.steps[0].result;
  expect(review(request, t).resumePreview?.blocked).toContain("login");
});
it("blocks stale game days, new app versions, unbound identities and multi-game chains", () => {
  expect(
    assessExecution(request, [task()], "test", new Date("2026-09-26T08:01:00Z"))
      .resumePreview?.state,
  ).toBe("blocked");
  expect(review(request, task(), "new").resumePreview?.state).toBe("blocked");
  expect(
    review({
      ...request,
      snapshot: { ...request.snapshot, arknights: defaultArknightsConfig },
    }).resumePreview?.state,
  ).toBe("blocked");
  expect(
    review({
      ...request,
      source: "daily",
      snapshot: {
        ...request.snapshot,
        onmyojiPlan: { ...plan, gameId: "onmyoji" },
      },
    }).resumePreview?.state,
  ).toBe("blocked");
});
it("blocks missing exact linkage, false not-run records, noncontiguous results and worker death", () => {
  const t = task();
  t.steps[2].startedAt = at;
  expect(review(request, t).resumePreview?.state).toBe("blocked");
  const mismatch = task();
  mismatch.executionId = "other";
  expect(review(request, mismatch).resumePreview?.state).toBe("blocked");
  const unknown = task();
  unknown.status = "unknown";
  expect(
    review({ ...request, status: "unknown" }, unknown).resumePreview?.state,
  ).toBe("blocked");
  const order = task();
  order.steps[2] = {
    ...order.steps[2],
    status: "succeeded",
    startedAt: at,
    finishedAt: end,
    result: { arknights: evidence("Award", true) },
  };
  expect(review(request, order).resumePreview?.state).toBe("blocked");
});
it("rejects fabricated task-type/timestamp evidence and never treats a whole successful run as resumable", () => {
  const wrong = task();
  wrong.steps[1].result!.arknights = evidence("Recruit");
  expect(review(request, wrong).resumePreview?.state).toBe("blocked");
  const future = task();
  future.steps[1].result!.arknights!.observedAt = "2099-01-01T00:00:00Z";
  expect(review(request, future).resumePreview?.state).toBe("blocked");
  expect(review({ ...request, status: "succeeded" }).resumePreview?.state).toBe(
    "blocked",
  );
});
