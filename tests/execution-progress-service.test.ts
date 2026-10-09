import { expect, it, vi } from "vitest";
import { ExecutionProgressService } from "../apps/desktop/main/execution-progress";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type { TaskRecord } from "../packages/protocol/task-record";

function fixture() {
  const root: ExecutionRecord = {
    version: 1,
    id: "old-request",
    source: "daily",
    laneId: "a",
    batchId: "b",
    resources: ["mumu:a"],
    fingerprint: "fp",
    status: "succeeded",
    startedAt: "2026-10-03T03:00:00Z",
    finishedAt: "2026-10-03T03:01:00Z",
    message: "done",
    snapshot: {},
  };
  const plan = {
    gameId: "arknights",
    mode: "live" as const,
    skillIds: ["login", "award"],
  };
  const task: TaskRecord = {
    version: 1,
    runId: "task",
    executionId: root.id,
    laneId: "a",
    batchId: "b",
    instance: 0,
    gameId: "arknights",
    plan,
    status: "succeeded",
    message: "done",
    startedAt: root.startedAt,
    updatedAt: root.finishedAt!,
    finishedAt: root.finishedAt,
    steps: plan.skillIds.map((skillId) => ({
      skillId,
      status: "succeeded" as const,
      message: "done",
      diagnostics: [],
    })),
  };
  const detail: ExecutionDetail = {
    request: root,
    games: [{ plan, record: task }],
    warnings: [],
  };
  const records = [
    root,
    ...Array.from({ length: 110 }, (_, i) => ({
      ...root,
      id: `unrelated-${i}`,
    })),
  ];
  const executions = {
    assertHealthy: vi.fn(),
    get: vi.fn((id: string) => {
      const r = records.find((r) => r.id === id);
      if (!r) throw Error("missing");
      return r;
    }),
    snapshot: vi.fn((limit: number) => records.slice(-limit)),
  };
  const ledger = { assertHealthy: vi.fn(), forExecution: vi.fn(() => [task]) };
  const details = { get: vi.fn(() => detail) };
  return {
    root,
    task,
    detail,
    executions,
    ledger,
    details,
    service: new ExecutionProgressService(executions, ledger, details),
  };
}

it("reads old evidence beyond the recent UI window without reading unrelated task details", () => {
  const s = fixture();
  expect(s.service.get(s.root.id).wholePlanComplete).toBe(true);
  expect(s.executions.snapshot).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
  expect(s.details.get).toHaveBeenCalledTimes(1);
  expect(s.details.get).toHaveBeenCalledWith(s.root.id);
  expect(s.ledger.forExecution).toHaveBeenCalledTimes(1);
});
it("flags unmatched existing ledgers without mutating reusable detail projections", () => {
  const s = fixture();
  s.detail.games[0].record = undefined;
  expect(s.service.get(s.root.id).outcome).toBe("unconfirmed");
  expect(s.detail.warnings).toEqual([]);
});
it("does not convert detail read errors into successful coverage", () => {
  const s = fixture();
  s.details.get.mockImplementation(() => {
    throw Error("corrupt");
  });
  expect(s.service.get(s.root.id).wholePlanComplete).toBe(false);
});
it("validates IDs and storage health before reading any detailed evidence", () => {
  const s = fixture();
  expect(() => s.service.get("../unsafe")).toThrow();
  expect(s.details.get).not.toHaveBeenCalled();
  s.ledger.assertHealthy.mockImplementation(() => {
    throw Error("corrupt storage");
  });
  expect(() => s.service.get(s.root.id)).toThrow("corrupt storage");
  expect(s.details.get).not.toHaveBeenCalled();
});
