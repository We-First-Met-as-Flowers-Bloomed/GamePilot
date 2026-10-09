import { expect, it } from "vitest";
import { assessExecution } from "../packages/protocol/recovery";
import { reduceTaskRecords } from "../packages/protocol/task-record";
import type { ExecutionRecord } from "../packages/protocol/execution";
const request: ExecutionRecord = {
  version: 1,
  id: "execution",
  fingerprint: "hash",
  source: "daily",
  resources: ["device-a"],
  laneId: "a",
  batchId: "batch",
  snapshot: {
    appVersion: "test",
    arknightsPlan: {
      gameId: "arknights",
      mode: "live",
      skillIds: ["login", "fight", "award"],
    },
    onmyojiPlan: { gameId: "onmyoji", mode: "live", skillIds: ["login"] },
  },
  status: "unknown",
  startedAt: "2026-09-25T00:00:00Z",
  message: "interrupted",
};
const base = {
  executionId: "execution",
  runId: "run",
  gameId: "arknights",
  laneId: "a",
  batchId: "batch",
  at: request.startedAt,
};
function task() {
  let records = reduceTaskRecords([], {
    ...base,
    type: "status",
    status: "queued",
    message: "queued",
    plan: request.snapshot.arknightsPlan as any,
  });
  records = reduceTaskRecords(records, {
    ...base,
    type: "step",
    skillId: "login",
    stepStatus: "succeeded",
    message: "done",
  });
  records = reduceTaskRecords(records, {
    ...base,
    type: "step",
    skillId: "fight",
    stepStatus: "running",
    message: "started",
  });
  return reduceTaskRecords(records, {
    ...base,
    type: "status",
    status: "failed",
    resultUncertain: true,
    message: "exit",
  });
}
it("associates exact requests and keeps unknown/missing records distinct from not-run", () => {
  const report = assessExecution(request, task(), "test");
  expect(report.games[0]?.steps.map((s) => s.status)).toEqual([
    "succeeded",
    "unknown",
    "not-run",
  ]);
  expect(report.games[1]?.steps[0]?.status).toBe("unrecorded");
  expect(report.canResume).toBe(false);
  expect(report.reasons.join(" ")).toContain("账号");
});
it("does not infer linkage from a similar timestamp, batch or another lane", () => {
  for (const modified of [
    { executionId: undefined },
    { executionId: "other" },
    { laneId: "b" },
    { batchId: "other" },
  ]) {
    const report = assessExecution(
      request,
      task().map((r) => ({ ...r, ...modified })),
      "test",
    );
    expect(report.games[0]?.steps.every((s) => s.status === "unrecorded")).toBe(
      true,
    );
  }
});
it("does not pick one of duplicate or mismatched plans as recovery evidence", () => {
  const records = task();
  expect(
    assessExecution(
      request,
      [...records, { ...records[0]!, runId: "second" }],
      "test",
    ).games[0]?.steps[0]?.status,
  ).toBe("unrecorded");
  const wrong = {
    ...records[0]!,
    plan: { ...records[0]!.plan, mode: "rehearsal" as const },
  };
  expect(
    assessExecution(request, [wrong], "test").games[0]?.steps[0]?.status,
  ).toBe("unrecorded");
  expect(
    assessExecution(request, records, "new-version").reasons.join(" "),
  ).toContain("版本");
});
