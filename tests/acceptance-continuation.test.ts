import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonical } from "../packages/acceptance/files";
import { inspectDaily, summarizeDaily } from "../packages/acceptance/report";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { Plan } from "../packages/protocol";
import type { TaskRecord, StepStatus } from "../packages/protocol/task-record";
import { defaultArknightsConfig } from "../games/arknights/config";

function seal(r: ExecutionRecord) {
  const { startedAt: _, ...snapshot } = r.snapshot;
  r.fingerprint = createHash("sha256")
    .update(
      canonical({
        id: r.id,
        source: r.source,
        resources: [...new Set(r.resources)].sort(),
        snapshot,
        ...(r.laneId ? { laneId: r.laneId } : {}),
        ...(r.batchId ? { batchId: r.batchId } : {}),
      }),
    )
    .digest("hex");
}
function fixture() {
  const plans: Plan[] = [
    {
      gameId: "arknights",
      mode: "live",
      skillIds: ["login", "fight", "friends", "award"],
    },
    { gameId: "onmyoji", mode: "live", skillIds: ["login", "check-in"] },
  ];
  const expected = { date: "2026-10-03", laneId: "a", instance: 0, plans };
  const root: ExecutionRecord = {
    version: 1,
    id: "root",
    source: "daily",
    laneId: "a",
    batchId: "r",
    resources: ["mumu:a"],
    fingerprint: "",
    status: "failed",
    startedAt: "2026-10-03T00:00:00Z",
    finishedAt: "2026-10-03T00:01:00Z",
    message: "failed",
    snapshot: {
      appVersion: "0.14.26",
      lane: {
        id: "a",
        instance: 0,
        managerPath: "D:\\MuMu\\MuMuManager.exe",
        arknights: { profileId: "p" },
      },
      profile: {
        ...defaultArknightsConfig,
        recruit: false,
        id: "p",
        name: "test",
        expectedUid: "753108577",
        clientType: "Official",
      },
      arknightsPlan: plans[0],
      onmyojiPlan: plans[1],
    },
  };
  seal(root);
  const child: ExecutionRecord = {
    ...structuredClone(root),
    id: "child",
    batchId: "c",
    status: "succeeded",
    startedAt: "2026-10-03T00:02:00Z",
    finishedAt: "2026-10-03T00:04:00Z",
  };
  child.snapshot.appVersion = "0.14.27";
  child.snapshot.arknightsPlan = {
    ...plans[0],
    skillIds: ["login", "friends", "award"],
  };
  child.snapshot.continuation = {
    parentId: "root",
    parentFingerprint: root.fingerprint,
    retained: [{ gameId: "arknights", skillIds: ["fight"] }],
    excluded: [],
    acknowledgedPartial: true,
  };
  seal(child);
  function task(
    r: ExecutionRecord,
    gameId: string,
    statuses: StepStatus[],
    from = r.startedAt,
    to = r.finishedAt!,
  ): TaskRecord {
    const plan = r.snapshot[gameId + "Plan"] as Plan;
    return {
      version: 1,
      runId: r.id + gameId,
      executionId: r.id,
      laneId: r.laneId,
      batchId: r.batchId,
      instance: 0,
      ...(gameId === "arknights" ? { profileId: "p" } : {}),
      gameId,
      plan: structuredClone(plan),
      status:
        r.status === "succeeded"
          ? "succeeded"
          : r.status === "running"
            ? "running"
            : "failed",
      startedAt: from,
      updatedAt: to,
      ...(r.finishedAt ? { finishedAt: to } : {}),
      message: "facts",
      steps: plan.skillIds.map((skillId, i) => ({
        skillId,
        status: statuses[i],
        message: "fact",
        diagnostics: [],
      })),
    };
  }
  const requests = [root, child];
  const tasks = [
    task(root, "arknights", ["succeeded", "succeeded", "failed", "not-run"]),
    task(
      child,
      "arknights",
      ["succeeded", "succeeded", "succeeded"],
      child.startedAt,
      "2026-10-03T00:03:00Z",
    ),
    task(child, "onmyoji", ["succeeded", "succeeded"], "2026-10-03T00:03:00Z"),
  ];
  const now = new Date("2026-10-03T01:00:00Z");
  return {
    root,
    child,
    requests,
    tasks,
    expected,
    task,
    now,
    run: () => inspectDaily(expected, requests, tasks, now),
  };
}

it("labels a trusted continuation recovered, preserving original failure and versions without accepting rewards", () => {
  const f = fixture(),
    before = structuredClone(f.requests),
    row = f.run();
  expect(row.state).toBe("recovered");
  expect(row.requestIds).toEqual(["root"]);
  expect(row.originalStatus).toBe("failed");
  expect(row.continuationIds).toEqual(["child"]);
  expect(row.progress?.requests.map((r) => r.appVersion)).toEqual([
    "0.14.26",
    "0.14.27",
  ]);
  expect(row.reviewRequired).toBe(true);
  expect(row.notes.join(" ")).toContain("奖励");
  expect(f.requests).toEqual(before);
});
it("labels exclusions partial and unfinished child running", () => {
  const f = fixture();
  (f.child.snapshot.arknightsPlan as Plan).skillIds = ["login", "award"];
  (f.child.snapshot.continuation as any).excluded = [
    { gameId: "arknights", skillIds: ["friends"] },
  ];
  seal(f.child);
  f.tasks[1] = f.task(
    f.child,
    "arknights",
    ["succeeded", "succeeded"],
    f.child.startedAt,
    "2026-10-03T00:03:00Z",
  );
  expect(f.run().state).toBe("partial");
  expect(f.run().progress?.wholePlanComplete).toBe(false);
  const active = fixture();
  active.child.status = "running";
  active.child.finishedAt = undefined;
  active.tasks[2].status = "running";
  active.tasks[2].finishedAt = undefined;
  active.tasks[2].steps[1].status = "running";
  expect(active.run().state).toBe("running");
});
it.each([
  "fingerprint",
  "requestHash",
  "uid",
  "instance",
  "plan",
  "parent",
  "time",
  "future",
  "day",
  "slot",
  "missing",
  "ambiguous",
  "wrongBinding",
  "nativeUid",
  "taskTerminal",
  "cycle",
])("denies false recovery for %s", (what) => {
  const f = fixture();
  if (what === "fingerprint")
    (f.child.snapshot.continuation as any).parentFingerprint = "wrong";
  if (what === "requestHash") f.root.snapshot.appVersion = "tampered";
  if (what === "uid")
    (f.child.snapshot.profile as any).expectedUid = "123456789";
  if (what === "instance") (f.child.snapshot.lane as any).instance = 1;
  if (what === "plan")
    (f.root.snapshot.arknightsPlan as Plan).skillIds = ["login", "award"];
  if (what === "parent")
    (f.child.snapshot.continuation as any).parentId = "missing";
  if (what === "time") f.child.startedAt = "2026-10-02T23:58:00Z";
  if (what === "future") f.child.finishedAt = "2026-10-03T02:00:00Z";
  if (what === "day") f.child.startedAt = "2026-10-04T00:02:00Z";
  if (what === "slot") f.child.snapshot.schedule = { slot: "secondary" };
  if (what === "missing") f.tasks.splice(1, 1);
  if (what === "ambiguous") f.tasks.push(structuredClone(f.tasks[1]));
  if (what === "wrongBinding") f.tasks[0].batchId = "wrong";
  if (what === "taskTerminal") f.tasks[1].status = "failed";
  if (what === "nativeUid")
    f.tasks[1].steps[0].result = {
      arknights: {
        version: 1,
        taskType: "StartUp",
        submission: "submitted",
        completion: "native-confirmed",
        taskId: 1,
        observedAt: "2026-10-03T00:02:30Z",
        login: {
          home: true,
          expectedUid: "123456789",
          observedUid: "123456789",
          observedAt: "2026-10-03T00:02:30Z",
        },
      },
    };
  if (what === "cycle") f.root.snapshot.continuation = { parentId: "child" };
  if (!["requestHash", "plan", "cycle"].includes(what)) seal(f.child);
  expect(["recovered", "partial"]).not.toContain(f.run().state);
});
it("matches the original baseline before accepting any recovery", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.expected.instance = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.expected.plans = [f.expected.plans[0]];
    },
    (f: ReturnType<typeof fixture>) => {
      f.expected.plans[0] = {
        ...f.expected.plans[0],
        skillIds: ["login", "award"],
      };
    },
  ]) {
    const f = fixture();
    change(f);
    expect(f.run().state).not.toBe("recovered");
  }
});
it("does not turn orphan or malformed child metadata into daily originals", () => {
  const f = fixture();
  expect(inspectDaily(f.expected, [f.child], f.tasks, f.now).state).toBe(
    "missing",
  );
  f.child.snapshot.continuation = "malformed";
  expect(inspectDaily(f.expected, [f.child], f.tasks, f.now).state).toBe(
    "missing",
  );
  f.child.snapshot.continuation = null;
  expect(inspectDaily(f.expected, [f.child], f.tasks, f.now).state).toBe(
    "missing",
  );
});
it("keeps historical recovery when the original issue was closed after admission", () => {
  const f = fixture();
  f.root.resolution = {
    action: "abandoned",
    at: "2026-10-03T00:05:00Z",
    note: "reviewed",
  };
  expect(f.run().state).toBe("recovered");
  f.root.resolution.at = "2026-10-03T00:02:00Z";
  expect(f.run().state).not.toBe("recovered");
});
it("summarizes future and missing slots separately from first pass, recovered and partial completion", () => {
  const f = fixture(),
    row = f.run();
  const rows = [
    row,
    {
      ...row,
      state: "flow-ended" as const,
      continuationIds: [],
      interventionRecorded: false,
    },
    { ...row, state: "partial" as const },
    { ...row, state: "pending" as const },
    { ...row, state: "missing" as const },
  ];
  expect(summarizeDaily(rows)).toMatchObject({
    total: 5,
    flowEnded: 1,
    recovered: 1,
    partial: 1,
    pending: 1,
    missing: 1,
    firstPassFlowEnded: 1,
    withRecordedIntervention: 4,
  });
});
