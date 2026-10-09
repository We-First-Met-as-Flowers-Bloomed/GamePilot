import { expect, it } from "vitest";
import {
  assertContinuationHistory,
  completedContinuationRequestIds,
} from "../games/continuation-history";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { Plan } from "../packages/protocol";
import type { TaskRecord } from "../packages/protocol/task-record";
import { projectExecutionDetail } from "../games/execution-detail";
import { mergeExecutionProgress } from "../games/execution-progress";

const now = new Date("2026-10-05T08:00:00Z");
const plan: Plan = {
  gameId: "arknights",
  mode: "live",
  skillIds: ["login", "award"],
};
function fixture() {
  const parent: ExecutionRecord = {
    version: 1,
    id: "old:lane-a",
    source: "daily",
    laneId: "lane-a",
    batchId: "old",
    resources: ["mumu:d:\\mumu\\mumumanager.exe#0"],
    fingerprint: "parent",
    status: "unknown",
    startedAt: "2026-10-05T01:00:00Z",
    finishedAt: "2026-10-05T01:01:00Z",
    message: "failed",
    snapshot: {
      lane: {
        id: "lane-a",
        managerPath: "D:/MuMu/MuMuManager.exe",
        instance: 0,
        arknights: { profileId: "p" },
      },
      profile: {
        ...defaultArknightsConfig,
        recruit: false,
        id: "p",
        name: "test",
        expectedUid: "111111111",
      },
      arknightsPlan: plan,
    },
  };
  const independent: ExecutionRecord = {
    ...structuredClone(parent),
    id: "later:lane-a",
    batchId: "later",
    fingerprint: "later",
    status: "succeeded",
    startedAt: "2026-10-05T04:00:00Z",
    finishedAt: "2026-10-05T04:01:00Z",
  };
  const task = (request: ExecutionRecord, completed: boolean): TaskRecord => ({
    version: 1,
    runId: `run-${request.id}`,
    executionId: request.id,
    batchId: request.batchId,
    laneId: request.laneId,
    profileId: "p",
    instance: 0,
    gameId: "arknights",
    plan: structuredClone(plan),
    status: completed ? "succeeded" : "failed",
    startedAt: request.startedAt,
    updatedAt: request.finishedAt!,
    finishedAt: request.finishedAt,
    message: "record",
    steps: [
      {
        skillId: "login",
        status: completed ? "succeeded" : "failed",
        message: "login",
        diagnostics: [],
      },
      {
        skillId: "award",
        status: completed ? "succeeded" : "not-run",
        message: "award",
        diagnostics: [],
      },
    ],
  });
  return {
    parent,
    independent,
    parentTask: task(parent, false),
    laterTask: task(independent, true),
  };
}

it("blocks old pending business after a separate same-day successful run without rewriting either record", () => {
  const t = fixture(),
    records = [t.parent, t.independent],
    tasks = [t.parentTask, t.laterTask];
  const before = structuredClone({ records, tasks });
  expect(() =>
    assertContinuationHistory(t.parent, records, tasks, [plan], now),
  ).toThrow(/已完成|重叠/);
  expect({ records, tasks }).toEqual(before);
});

it("cannot bypass physical-device history by changing a lane alias or path casing", () => {
  const t = fixture();
  t.independent.laneId = "renamed";
  (t.independent.snapshot.lane as any).id = "renamed";
  (t.independent.snapshot.lane as any).managerPath =
    "d:\\MUMU\\MuMuManager.exe";
  t.laterTask.laneId = "renamed";
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
      [plan],
      now,
    ),
  ).toThrow(/已完成|重叠/);
});

it("leaves login-only work and a different game-day or device outside repeated business scope", () => {
  const t = fixture();
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
      [{ ...plan, skillIds: ["login"] }],
      now,
    ),
  ).not.toThrow();
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
      [plan],
      new Date("2026-10-06T08:00:00Z"),
    ),
  ).not.toThrow();
  t.independent.resources = ["mumu:d:\\mumu\\mumumanager.exe#1"];
  (t.independent.snapshot.lane as any).instance = 1;
  t.laterTask.instance = 1;
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
      [plan],
      now,
    ),
  ).not.toThrow();
});

it("does not treat abandoned unknown native effects as proof that business can be replayed", () => {
  const t = fixture();
  t.independent.status = "unknown";
  t.independent.resolution = {
    action: "abandoned",
    at: "2026-10-05T05:00:00Z",
    note: "reviewed, not retried",
  };
  t.laterTask.status = "unknown";
  t.laterTask.steps[1].status = "unknown";
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
      [plan],
      now,
    ),
  ).toThrow(/未知|核对|未确认/);
});

it("excludes only a strictly validated continuation chain, not a forged parent link", () => {
  const t = fixture();
  t.independent.snapshot.continuation = {
    parentId: t.parent.id,
    parentFingerprint: t.parent.fingerprint,
    retained: [],
    excluded: [],
    acknowledgedPartial: true,
  };
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
      [plan],
      now,
    ),
  ).not.toThrow();
  (t.independent.snapshot.continuation as any).parentFingerprint = "forged";
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
      [plan],
      now,
    ),
  ).toThrow();
});

it("blocks confirmed orphan business on the same instance", () => {
  const t = fixture();
  t.laterTask.executionId = "missing-request";
  expect(() =>
    assertContinuationHistory(
      t.parent,
      [t.parent],
      [t.parentTask, t.laterTask],
      [plan],
      now,
    ),
  ).toThrow(/已完成|重叠/);
});

it("recognizes complete verified recovery coverage without rewriting an unresolved original", () => {
  const t = fixture();
  t.independent.snapshot.continuation = {
    parentId: t.parent.id,
    parentFingerprint: t.parent.fingerprint,
    retained: [],
    excluded: [],
    acknowledgedPartial: true,
  };
  const records = [t.parent, t.independent],
    tasks = [t.parentTask, t.laterTask];
  expect(completedContinuationRequestIds(records, tasks)).toEqual(
    new Set(records.map((record) => record.id)),
  );
  expect(t.parent.status).toBe("unknown");
  expect(t.parent.resolution).toBeUndefined();
  t.laterTask.steps[1].status = "unknown";
  expect(completedContinuationRequestIds(records, tasks)).toEqual(new Set());
});

it("never exempts partial, malformed or branched recovery coverage", () => {
  const t = fixture();
  expect(
    completedContinuationRequestIds(
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
    ),
  ).toEqual(new Set());
  t.independent.snapshot.continuation = {
    parentId: t.parent.id,
    parentFingerprint: "forged",
    retained: [],
    excluded: [],
    acknowledgedPartial: true,
  };
  expect(
    completedContinuationRequestIds(
      [t.parent, t.independent],
      [t.parentTask, t.laterTask],
    ),
  ).toEqual(new Set());
  (t.independent.snapshot.continuation as any).parentFingerprint =
    t.parent.fingerprint;
  expect(
    completedContinuationRequestIds(
      [t.parent, t.independent, { ...t.independent, id: "other-child" }],
      [t.parentTask, t.laterTask],
    ),
  ).toEqual(new Set());
});

it.each(["fight", "friends"])(
  "does not exempt a valid partial recovery with excluded %s effects",
  (skillId) => {
    const t = fixture();
    const originalPlan = { ...plan, skillIds: ["login", skillId, "award"] };
    t.parent.snapshot.arknightsPlan = originalPlan;
    t.parentTask.plan = structuredClone(originalPlan);
    t.parentTask.steps.splice(1, 0, {
      skillId,
      status: "failed",
      diagnostics: [],
      message: "partially failed",
      startedAt: t.parent.startedAt,
      finishedAt: t.parent.finishedAt,
      ...(skillId === "friends"
        ? {
            result: {
              arknights: {
                version: 1,
                taskType: "Mall",
                taskId: 1,
                submission: "submitted",
                completion: "native-confirmed",
                observedAt: t.parent.finishedAt!,
                statistics: {
                  version: 1,
                  mall: {
                    purchaseConfirmations: 1,
                    creditCollected: true,
                    finalCredit: 100,
                  },
                },
              },
            },
          }
        : {}),
    });
    t.independent.snapshot.continuation = {
      parentId: t.parent.id,
      parentFingerprint: t.parent.fingerprint,
      retained: [],
      excluded: [{ gameId: "arknights", skillIds: [skillId] }],
      acknowledgedPartial: true,
    };
    const records = [t.parent, t.independent],
      tasks = [t.parentTask, t.laterTask];
    const progress = mergeExecutionProgress(
      t.parent.id,
      records,
      new Map(
        records.map((record) => [
          record.id,
          projectExecutionDetail(
            record,
            tasks.filter((task) => task.executionId === record.id),
          ),
        ]),
      ),
    );
    expect(progress.warnings).toEqual([]);
    expect(progress.outcome).toBe("partial");
    expect(completedContinuationRequestIds(records, tasks).size).toBe(0);
  },
);
