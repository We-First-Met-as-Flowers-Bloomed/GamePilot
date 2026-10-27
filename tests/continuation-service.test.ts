import { expect, it, vi } from "vitest";
import { ContinuationService } from "../apps/desktop/main/continuation-service";
import { defaultArknightsConfig } from "../games/arknights/config";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import type { DeviceLane, Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { ExecutionDetail } from "../packages/protocol/execution-detail";
import type { TaskRecord } from "../packages/protocol/task-record";
import { mergeExecutionProgress } from "../games/execution-progress";
function setup() {
  const lane: DeviceLane = {
    id: "lane-a",
    name: "账号一",
    managerPath: "D:\\MuMu\\MuMuManager.exe",
    instance: 0,
    enabled: true,
    arknights: { enabled: true, profileId: "official" },
    onmyoji: { enabled: false },
    closeEmulatorAfterSuccess: false,
  };
  const profile = {
    ...defaultArknightsConfig,
    id: "official",
    name: "官服",
    expectedUid: "987654321",
    stage: "LS-6",
    creditShopping: true,
    mail: true,
  };
  const plan: Plan = {
    gameId: "arknights",
    mode: "live",
    skillIds: ["login", "friends", "award"],
  };
  const parent: ExecutionRecord = {
    version: 1,
    id: "original:lane-a",
    source: "daily",
    resources: [mumuResource(lane.managerPath, 0)],
    laneId: lane.id,
    batchId: "original",
    fingerprint: "fp",
    status: "unknown",
    startedAt: "2026-10-03T01:00:00.000Z",
    finishedAt: "2026-10-03T01:05:00.000Z",
    message: "old failure",
    snapshot: { lane, profile, arknightsPlan: plan, appVersion: "0.14.26" },
  };
  const task: TaskRecord = {
    version: 1,
    executionId: parent.id,
    runId: "old-run",
    laneId: lane.id,
    batchId: parent.batchId,
    profileId: profile.id,
    instance: 0,
    gameId: "arknights",
    plan,
    status: "failed",
    startedAt: parent.startedAt,
    updatedAt: parent.finishedAt!,
    finishedAt: parent.finishedAt,
    message: "failed",
    steps: plan.skillIds.map((skillId, i) => ({
      skillId,
      status: i === 0 ? "succeeded" : i === 1 ? "failed" : "not-run",
      message: "recorded",
      diagnostics: [],
    })),
  };
  const records = [parent];
  const finish = vi.fn(async () => {});
  const executions = {
    get: vi.fn(() => structuredClone(parent)),
    assertHealthy: vi.fn(),
    snapshot: vi.fn(() => structuredClone(records)),
    begin: vi.fn(async (request: any) => {
      records.push({
        ...request,
        version: 1,
        status: "running",
        fingerprint: "child",
        startedAt: "2026-10-03T04:00:00.000Z",
        message: "started",
      });
      return { finish };
    }),
  };
  const details = {
    get: vi.fn(
      () =>
        ({
          request: { ...parent, laneName: lane.name },
          games: [{ plan, record: task }],
          warnings: [],
        }) as ExecutionDetail,
    ),
  };
  const ledger = {
    assertHealthy: vi.fn(),
    forExecution: vi.fn(() => [task]),
    snapshot: vi.fn(() => [structuredClone(task)]),
    flush: vi.fn(async () => {}),
  };
  const currentLane = structuredClone(lane),
    currentProfile = structuredClone(profile);
  const service = new ContinuationService({
    executions: executions as any,
    details: details as any,
    ledger: ledger as any,
    lanes: async () => ({ version: 1, lanes: [currentLane] }),
    profiles: async () => ({
      version: 1,
      activeProfileId: profile.id,
      profiles: [currentProfile],
    }),
    appVersion: "0.14.27",
    now: () => new Date("2026-10-03T04:00:00Z"),
  });
  return {
    service,
    parent,
    records,
    executions,
    details,
    ledger,
    currentLane,
    currentProfile,
    finish,
    task,
  };
}
it("continues a frozen physical override while preserving original history", async () => {
  const s = setup();
  const originalLane = s.parent.snapshot.lane as DeviceLane;
  originalLane.instance = 2;
  s.parent.resources = [mumuResource(originalLane.managerPath, 2)];
  s.task.instance = 2;
  s.currentLane.deviceInstances = { arknights: 2 };
  const before = structuredClone(s.parent);
  const preview = await s.service.preview(s.parent.id);
  expect(preview.canContinue).toBe(true);
  const launch = vi.fn(async () => {});
  await s.service.start(
    {
      parentId: preview.parentId,
      fingerprint: preview.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: true,
    },
    launch,
  );
  expect((launch.mock.calls[0] as unknown as [any])[0].lane.instance).toBe(2);
  expect(s.parent).toEqual(before);
  expect(s.currentLane.instance).toBe(0);
});

it("does not reroute legacy execution snapshots that retained override metadata", async () => {
  const s = setup();
  (s.parent.snapshot.lane as DeviceLane).deviceInstances = { arknights: 2 };
  const before = structuredClone(s.parent);
  const preview = await s.service.preview(s.parent.id);
  expect(preview.canContinue).toBe(true);
  const launch = vi.fn(async (_frozen: any) => {});
  await s.service.start(
    {
      parentId: preview.parentId,
      fingerprint: preview.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: true,
    },
    launch,
  );
  expect(launch.mock.calls[0][0].lane.instance).toBe(0);
  expect(launch.mock.calls[0][0].lane.deviceInstances).toBeUndefined();
  expect(s.parent).toEqual(before);
});
it.each(["failed", "cancelled", "unknown", "succeeded"] as const)(
  "cannot acknowledge and replay a %s step with an unknown submitted native result",
  async (status) => {
    const s = setup();
    const step = s.task.steps[1];
    step.status = status;
    step.result = {
      arknights: {
        version: 1,
        taskType: "Mall",
        submission: "submitted",
        completion: "unknown",
        observedAt: "2026-10-03T01:03:00.000Z",
        taskId: 7,
      },
    };
    const before = structuredClone(s.task);
    const preview = await s.service.preview(s.parent.id);
    expect(preview.canContinue).toBe(false);
    expect(preview.steps.find((s) => s.skillId === "friends")?.status).toBe(
      "blocked",
    );
    const launch = vi.fn(async () => {});
    await expect(
      s.service.start(
        {
          parentId: preview.parentId,
          fingerprint: preview.fingerprint,
          selections: [{ gameId: "arknights", skillIds: ["friends", "award"] }],
          acknowledgePartial: true,
        },
        launch,
      ),
    ).rejects.toThrow(/未确认|待核对/);
    expect(s.executions.begin).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(s.task).toEqual(before);
  },
);
it.each([100, undefined, 493])(
  "excludes native-finished shopping with wallet %s and never reports the original whole plan as successful",
  async (credit) => {
    const s = setup();
    const step = s.task.steps[1];
    step.startedAt = "2026-10-03T01:01:00.000Z";
    step.finishedAt = "2026-10-03T01:04:00.000Z";
    step.result = {
      arknights: {
        version: 1,
        taskType: "Mall",
        submission: "submitted",
        completion: "native-confirmed",
        observedAt: "2026-10-03T01:03:00.000Z",
        taskId: 7,
        statistics: {
          version: 1,
          mall: {
            purchaseConfirmations: 2,
            creditCollected: true,
            ...(credit === undefined ? {} : { finalCredit: credit }),
          },
        },
      },
    };
    const original = structuredClone({ parent: s.parent, task: s.task });
    const preview = await s.service.preview(s.parent.id);
    expect(preview.canContinue).toBe(true);
    expect(preview.needsAcknowledgement).toBe(true);
    expect(preview.steps.find((s) => s.skillId === "friends")?.status).toBe(
      "excluded",
    );
    expect(preview.defaults).toEqual([
      { gameId: "arknights", skillIds: ["award"] },
    ]);
    const launch = vi.fn(async () => {});
    await s.service.start(
      {
        parentId: preview.parentId,
        fingerprint: preview.fingerprint,
        selections: preview.defaults,
        acknowledgePartial: true,
      },
      launch,
    );
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const child = s.records[1];
    expect(child.snapshot.continuation).toMatchObject({
      retained: [],
      excluded: [{ gameId: "arknights", skillIds: ["friends"] }],
    });
    const childPlan = child.snapshot.arknightsPlan as Plan;
    expect(childPlan.skillIds).toEqual(["login", "award"]);
    child.status = "succeeded";
    child.finishedAt = "2026-10-03T04:01:00.000Z";
    const childTask: TaskRecord = {
      ...structuredClone(s.task),
      executionId: child.id,
      runId: "continued-run",
      batchId: child.batchId,
      plan: childPlan,
      status: "succeeded",
      startedAt: child.startedAt,
      updatedAt: child.finishedAt,
      finishedAt: child.finishedAt,
      steps: childPlan.skillIds.map((skillId) => ({
        skillId,
        status: "succeeded",
        message: "completed",
        diagnostics: [],
      })),
    };
    const details = new Map<string, ExecutionDetail>([
      [s.parent.id, s.details.get()],
      [
        child.id,
        {
          request: child,
          warnings: [],
          games: [{ plan: childPlan, record: childTask }],
        },
      ],
    ]);
    const progress = mergeExecutionProgress(s.parent.id, s.records, details);
    expect(progress.warnings).toEqual([]);
    expect(progress.outcome).toBe("partial");
    expect(progress.wholePlanComplete).toBe(false);
    expect(progress.counts).toEqual({
      total: 2,
      completed: 1,
      skipped: 0,
      excluded: 1,
      remaining: 0,
    });
    expect(progress.steps.find((s) => s.skillId === "friends")?.status).toBe(
      "excluded",
    );
    expect({ parent: s.parent, task: s.task }).toEqual(original);
  },
);
it("starts only remaining frozen steps with a fresh login, preserving parent and resource binding", async () => {
  const s = setup(),
    original = structuredClone(s.parent);
  const p = await s.service.preview(s.parent.id);
  expect(p.canContinue).toBe(true);
  const launch = vi.fn(
    async (_frozen: any, _batchId: string, _lease: any) => {},
  );
  const receipt = await s.service.start(
    {
      parentId: p.parentId,
      fingerprint: p.fingerprint,
      selections: p.defaults,
      acknowledgePartial: true,
    },
    launch,
  );
  await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  const frozen = launch.mock.calls[0][0] as any;
  expect(frozen.arknightsPlan.skillIds).toEqual(["login", "friends", "award"]);
  expect(frozen.profile.expectedUid).toBe("987654321");
  expect(
    s.executions.begin.mock.calls[0][0].snapshot.continuation.parentId,
  ).toBe(s.parent.id);
  expect(receipt.requestId).not.toBe(s.parent.id);
  expect(s.parent).toEqual(original);
  expect((await s.service.preview(s.parent.id)).successorId).toBe(
    receipt.requestId,
  );
});
it.each(["device", "profile", "uid", "client"])(
  "blocks changed %s binding",
  async (what) => {
    const s = setup();
    if (what === "device") s.currentLane.instance = 1;
    if (what === "profile") s.currentLane.arknights.profileId = "changed";
    if (what === "uid") s.currentProfile.expectedUid = "111111111";
    if (what === "client") s.currentProfile.clientType = "Bilibili";
    expect((await s.service.preview(s.parent.id)).canContinue).toBe(false);
    expect(s.executions.begin).not.toHaveBeenCalled();
  },
);
it("prevents double admission from stale or simultaneous user clicks", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id),
    input = {
      parentId: p.parentId,
      fingerprint: p.fingerprint,
      selections: p.defaults,
      acknowledgePartial: true,
    };
  const launch = vi.fn(async () => {});
  const results = await Promise.allSettled([
    s.service.start(input, launch),
    s.service.start(input, launch),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(s.executions.begin).toHaveBeenCalledTimes(1);
});
it("blocks ambiguous existing runs instead of inferring they never started", async () => {
  const s = setup();
  s.details.get.mockImplementation(() => ({
    request: s.parent,
    games: [
      { plan: s.records[0].snapshot.arknightsPlan as Plan, issue: "ambiguous" },
    ],
    warnings: [],
  }));
  expect((await s.service.preview(s.parent.id)).canContinue).toBe(false);
});
it("records cancelled business steps as excluded without marking the parent complete", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id);
  await s.service.start(
    {
      parentId: p.parentId,
      fingerprint: p.fingerprint,
      selections: [{ gameId: "arknights", skillIds: ["award"] }],
      acknowledgePartial: true,
    },
    async () => {},
  );
  const request = s.executions.begin.mock.calls[0][0];
  expect(request.snapshot.arknightsPlan.skillIds).toEqual(["login", "award"]);
  expect(request.snapshot.continuation.excluded).toEqual([
    { gameId: "arknights", skillIds: ["friends"] },
  ]);
  expect(s.parent.status).toBe("unknown");
});
it("does not launch if resource admission fails", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id),
    launch = vi.fn();
  s.executions.begin.mockRejectedValueOnce(Error("device busy"));
  await expect(
    s.service.start(
      {
        parentId: p.parentId,
        fingerprint: p.fingerprint,
        selections: p.defaults,
        acknowledgePartial: true,
      },
      launch,
    ),
  ).rejects.toThrow("device busy");
  expect(launch).not.toHaveBeenCalled();
  expect(s.records).toHaveLength(1);
});
it("persists launch failures on the child without changing the parent's failure", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id);
  await s.service.start(
    {
      parentId: p.parentId,
      fingerprint: p.fingerprint,
      selections: p.defaults,
      acknowledgePartial: true,
    },
    async () => {
      throw Error("worker unavailable");
    },
  );
  await vi.waitFor(() =>
    expect(s.finish).toHaveBeenCalledWith(
      "unknown",
      "Error: worker unavailable",
    ),
  );
  expect(s.parent.status).toBe("unknown");
});
it("does not launch after stop while continuation admission is persisting", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id),
    controller = new AbortController();
  const original = s.executions.begin.getMockImplementation()!;
  s.executions.begin.mockImplementationOnce(async (request) => {
    const lease = await original(request);
    controller.abort();
    return lease;
  });
  const launch = vi.fn();
  await s.service.start(
    {
      parentId: p.parentId,
      fingerprint: p.fingerprint,
      selections: p.defaults,
      acknowledgePartial: true,
    },
    launch,
    controller.signal,
  );
  await vi.waitFor(() =>
    expect(s.finish).toHaveBeenCalledWith("cancelled", expect.any(String)),
  );
  expect(launch).not.toHaveBeenCalled();
});
it("uses an exact deterministic batch only through the trusted Goal submission entrypoint", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id),
    launch = vi.fn(async () => {});
  const input = {
    parentId: p.parentId,
    fingerprint: p.fingerprint,
    selections: p.defaults,
    acknowledgePartial: true,
  };
  const receipt = await s.service.startForGoal(input, launch, undefined, {
    batchId: "goal-reservation-attempt-1",
    origin: { requestId: "goal-owner", kind: "continue" },
  });
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  expect(receipt).toEqual({
    batchId: "goal-reservation-attempt-1",
    requestId: "goal-reservation-attempt-1:lane-a",
  });
  expect(s.executions.begin.mock.calls[0][0].snapshot.agent).toEqual({
    requestId: "goal-owner",
    kind: "continue",
  });
  expect(s.parent.status).toBe("unknown");
  expect(
    s.executions.begin.mock.calls[0][0].snapshot.continuation.parentFingerprint,
  ).toBe(s.parent.fingerprint);
});
it("rejects a model or IPC-supplied batch override before any continuation admission", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id),
    launch = vi.fn(async () => {});
  await expect(
    s.service.start(
      {
        parentId: p.parentId,
        fingerprint: p.fingerprint,
        selections: p.defaults,
        acknowledgePartial: true,
        batchId: "injected-batch",
      } as import("../packages/protocol/continuation").ContinuationInput,
      launch,
    ),
  ).rejects.toThrow();
  expect(s.executions.begin).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
it("preserves changed-device and native-unknown gates on trusted deterministic submissions", async () => {
  const s = setup(),
    p = await s.service.preview(s.parent.id),
    launch = vi.fn(async () => {});
  s.currentLane.instance = 9;
  await expect(
    s.service.startForGoal(
      {
        parentId: p.parentId,
        fingerprint: p.fingerprint,
        selections: p.defaults,
        acknowledgePartial: true,
      },
      launch,
      undefined,
      { batchId: "goal-bound" },
    ),
  ).rejects.toThrow();
  expect(s.executions.begin).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
