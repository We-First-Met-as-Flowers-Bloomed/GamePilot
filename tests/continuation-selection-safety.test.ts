import { describe, expect, it, vi } from "vitest";
import type { DeviceLane, Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { defaultArknightsConfig } from "../games/arknights/config";
import { assertContinuationHistory } from "../games/continuation-history";
import { projectExecutionDetail } from "../games/execution-detail";
import { mergeExecutionProgress } from "../games/execution-progress";
import { ContinuationService } from "../apps/desktop/main/continuation-service";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";

const now = new Date("2026-10-07T08:00:00Z");
const remaining = ["guild-kirin", "realm-raid", "hana-claim"];
const ark: Plan = { gameId: "arknights", mode: "live", skillIds: ["login"] };
const yys: Plan = {
  gameId: "onmyoji",
  mode: "live",
  skillIds: ["login", "check-in", "mail", "daily-gift", ...remaining],
};

function fixture() {
  const lane: DeviceLane = {
    id: "lane-a",
    name: "test",
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    enabled: true,
    arknights: { enabled: true, profileId: "p" },
    onmyoji: { enabled: true },
    closeEmulatorAfterSuccess: false,
  };
  const profile = {
    ...defaultArknightsConfig,
    id: "p",
    name: "test",
    expectedUid: "111111111",
  };
  const record = (id: string, hour: number): ExecutionRecord => ({
    version: 1,
    id: `${id}:lane-a`,
    source: "daily",
    laneId: lane.id,
    batchId: id,
    resources: [mumuResource(lane.managerPath, lane.instance)],
    fingerprint: id,
    status: "unknown",
    startedAt: `2026-10-07T0${hour}:00:00.000Z`,
    finishedAt: `2026-10-07T0${hour}:05:00.000Z`,
    message: "recorded failure",
    snapshot: {
      lane: structuredClone(lane),
      profile: structuredClone(profile),
      arknightsPlan: structuredClone(ark),
      onmyojiPlan: structuredClone(yys),
    },
  });
  const task = (request: ExecutionRecord, plan: Plan): TaskRecord => ({
    version: 1,
    executionId: request.id,
    runId: `${request.id}-${plan.gameId}`,
    laneId: request.laneId,
    batchId: request.batchId,
    instance: 0,
    ...(plan.gameId === "arknights" ? { profileId: profile.id } : {}),
    gameId: plan.gameId,
    plan: structuredClone(plan),
    status: plan.gameId === "arknights" ? "succeeded" : "failed",
    startedAt: request.startedAt,
    updatedAt: request.finishedAt!,
    finishedAt: request.finishedAt,
    message: "recorded",
    steps: plan.skillIds.map((skillId, i) => ({
      skillId,
      status:
        plan.gameId === "arknights" || i < 3
          ? "succeeded"
          : i === 3
            ? "failed"
            : "not-run",
      message: "recorded",
      diagnostics: [],
    })),
  });
  const parent = record("parent", 1),
    independent = record("independent", 2);
  const tasks = [
    task(parent, ark),
    task(parent, yys),
    task(independent, ark),
    task(independent, yys),
  ];
  const requests = [parent, independent];
  const get = (id: string) => {
    const found = requests.find((r) => r.id === id);
    if (!found) throw Error("missing request");
    return structuredClone(found);
  };
  const begin = vi.fn(async (input: any) => {
    requests.push({
      ...input,
      version: 1,
      fingerprint: "child",
      status: "running",
      startedAt: now.toISOString(),
      message: "started",
    });
    return { finish: vi.fn(async () => {}) };
  });
  const admission = vi.fn(async (_lane: DeviceLane) => {});
  const ledger = {
    assertHealthy: vi.fn(),
    flush: vi.fn(async () => {}),
    snapshot: () => structuredClone(tasks),
    forExecution: (id: string) =>
      structuredClone(tasks.filter((t) => t.executionId === id)),
  };
  const service = new ContinuationService({
    executions: {
      get,
      snapshot: () => structuredClone(requests),
      assertHealthy() {},
      begin,
    } as any,
    ledger: ledger as any,
    details: {
      get: (id: string) =>
        projectExecutionDetail(
          get(id),
          tasks.filter((t) => t.executionId === id),
        ),
    } as any,
    lanes: async () => ({ version: 1, lanes: [structuredClone(lane)] }),
    profiles: async () => ({
      version: 1,
      activeProfileId: profile.id,
      profiles: [structuredClone(profile)],
    }),
    appVersion: "test",
    now: () => now,
    assertCanStart: admission,
  });
  const serialUnstarted = () => {
    independent.status = "cancelled";
    tasks.splice(3, 1);
    tasks[2].status = "cancelled";
    tasks[2].steps[0].status = "cancelled";
    tasks[2].steps[0].result = {
      arknights: {
        version: 1,
        taskType: "StartUp",
        submission: "not-submitted",
        completion: "not-started",
        observedAt: independent.finishedAt!,
      },
    };
  };
  const selected: Plan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login", ...remaining],
  };
  return {
    parent,
    independent,
    requests,
    tasks,
    service,
    begin,
    admission,
    ledger,
    serialUnstarted,
    selected,
    task,
  };
}

describe("continuation history for proven unstarted serial games", () => {
  it.each(["failed", "cancelled"] as const)(
    "allows an unstarted later game after a reliably terminal %s prior game",
    (status) => {
      const s = fixture();
      s.serialUnstarted();
      s.tasks[2].status = status;
      s.independent.status = status;
      const before = structuredClone({ requests: s.requests, tasks: s.tasks });
      expect(() =>
        assertContinuationHistory(
          s.parent,
          s.requests,
          s.tasks,
          [s.selected],
          now,
        ),
      ).not.toThrow();
      expect({ requests: s.requests, tasks: s.tasks }).toEqual(before);
    },
  );
  it.each([
    "missing-prior",
    "unknown-prior",
    "unfinished-prior",
    "unknown-native-prior",
    "started-later",
    "ambiguous-later",
    "out-of-bounds-prior",
  ])("keeps uncertain or contradictory serial proof blocked (%s)", (kind) => {
    const s = fixture();
    s.serialUnstarted();
    if (kind === "missing-prior") s.tasks.splice(2, 1);
    if (kind === "unknown-prior") s.tasks[2].status = "unknown";
    if (kind === "unfinished-prior") s.tasks[2].finishedAt = undefined;
    if (kind === "unknown-native-prior")
      s.tasks[2].steps[0].result!.arknights = {
        version: 1,
        taskType: "StartUp",
        submission: "submitted",
        completion: "unknown",
        taskId: 1,
        observedAt: s.independent.finishedAt!,
      };
    if (kind === "out-of-bounds-prior")
      s.tasks[2].startedAt = "2026-10-07T00:00:00.000Z";
    if (kind === "started-later" || kind === "ambiguous-later") {
      const next = s.task(s.independent, yys);
      next.status = "unknown";
      next.steps.forEach((step) => (step.status = "unknown"));
      s.tasks.push(next);
      if (kind === "ambiguous-later")
        s.tasks.push({ ...structuredClone(next), runId: "duplicate" });
    }
    expect(() =>
      assertContinuationHistory(
        s.parent,
        s.requests,
        s.tasks,
        [s.selected],
        now,
      ),
    ).toThrow(/未确认|未知|记录|核对/);
  });
  it("does not apply another device's missing or unknown game to this lane", () => {
    const s = fixture();
    s.serialUnstarted();
    s.tasks[2].status = "unknown";
    s.independent.resources = [mumuResource("D:/MuMu/MuMuManager.exe", 1)];
    (s.independent.snapshot.lane as DeviceLane).instance = 1;
    s.tasks[2].instance = 1;
    expect(() =>
      assertContinuationHistory(
        s.parent,
        s.requests,
        s.tasks,
        [s.selected],
        now,
      ),
    ).not.toThrow();
  });
  it.each(["not-run", "skipped"] as const)(
    "does not use a contradictory %s status to replay independent unknown submitted shopping",
    (status) => {
      const s = fixture();
      const shop: Plan = {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login", "friends", "award"],
      };
      s.parent.snapshot.arknightsPlan = shop;
      s.independent.snapshot.arknightsPlan = shop;
      for (const index of [0, 2]) {
        s.tasks[index].plan = structuredClone(shop);
        s.tasks[index].status = "failed";
        s.tasks[index].steps = shop.skillIds.map((skillId, i) => ({
          skillId,
          status: i === 0 ? "succeeded" : i === 1 ? "failed" : "not-run",
          message: "recorded",
          diagnostics: [],
        }));
      }
      s.tasks[2].steps[1].status = status;
      s.tasks[2].steps[1].result = {
        arknights: {
          version: 1,
          taskType: "Mall",
          submission: "submitted",
          completion: "unknown",
          taskId: 1,
          observedAt: s.independent.finishedAt!,
        },
      };
      expect(() =>
        assertContinuationHistory(s.parent, s.requests, s.tasks, [shop], now),
      ).toThrow(/未知|未确认/);
    },
  );
  it.each(["not-run", "skipped"] as const)(
    "does not replay independent confirmed shopping hidden by a contradictory %s status",
    (status) => {
      const s = fixture();
      const shop: Plan = {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login", "friends", "award"],
      };
      s.parent.snapshot.arknightsPlan = shop;
      s.independent.snapshot.arknightsPlan = shop;
      for (const index of [0, 2]) {
        s.tasks[index].plan = structuredClone(shop);
        s.tasks[index].status = "failed";
        s.tasks[index].steps = shop.skillIds.map((skillId, i) => ({
          skillId,
          status: i === 0 ? "succeeded" : i === 1 ? "failed" : "not-run",
          message: "recorded",
          diagnostics: [],
        }));
      }
      s.tasks[2].steps[1].status = status;
      s.tasks[2].steps[1].result = {
        arknights: {
          version: 1,
          taskType: "Mall",
          submission: "submitted",
          completion: "native-confirmed",
          taskId: 1,
          observedAt: s.independent.finishedAt!,
          statistics: {
            version: 1,
            mall: {
              purchaseConfirmations: 1,
              creditCollected: true,
              finalCredit: 100,
            },
          },
        },
      };
      expect(() =>
        assertContinuationHistory(s.parent, s.requests, s.tasks, [shop], now),
      ).toThrow(/已完成|重叠/);
    },
  );
  it.each(["submitted-not-started", "not-submitted-confirmed"])(
    "does not infer empty business effects from contradictory native metadata (%s)",
    (kind) => {
      const s = fixture();
      // Invalid native metadata invalidates this independently associated game
      // instead of lending its missing steps an unstarted exemption.
      s.serialUnstarted();
      s.tasks[2].steps[0].result!.arknights = {
        version: 1,
        taskType: "StartUp",
        submission:
          kind === "submitted-not-started" ? "submitted" : "not-submitted",
        completion:
          kind === "submitted-not-started" ? "not-started" : "native-confirmed",
        observedAt: s.independent.finishedAt!,
      };
      expect(() =>
        assertContinuationHistory(
          s.parent,
          s.requests,
          s.tasks,
          [s.selected],
          now,
        ),
      ).toThrow(/未确认|记录|核对/);
    },
  );
});

describe("selection-scoped continuation admission", () => {
  it.each([
    "submitted-unknown",
    "submitted-not-started",
    "not-submitted-confirmed",
  ])(
    "preserves the global native uncertainty gate even when the user selects only a different pending step (%s)",
    async (kind) => {
      const s = fixture();
      const shop: Plan = {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login", "friends", "award"],
      };
      s.parent.snapshot.arknightsPlan = shop;
      s.independent.snapshot.arknightsPlan = shop;
      for (const index of [0, 2]) {
        s.tasks[index].plan = structuredClone(shop);
        s.tasks[index].status = "failed";
        s.tasks[index].steps = shop.skillIds.map((skillId, i) => ({
          skillId,
          status:
            i === 0
              ? "succeeded"
              : index === 0 && i === 1
                ? "failed"
                : "not-run",
          message: "recorded",
          diagnostics: [],
        }));
      }
      const initial = await s.service.preview(s.parent.id);
      expect(initial.canContinue).toBe(true);
      const stale = {
        parentId: s.parent.id,
        fingerprint: initial.fingerprint,
        selections: [{ gameId: "arknights", skillIds: ["award"] }],
        acknowledgePartial: true,
      };
      s.independent.resolution = {
        action: "abandoned",
        at: "2026-10-07T03:00:00Z",
        note: "not completion proof",
      };
      s.tasks[2].steps[1].result = {
        arknights: {
          version: 1,
          taskType: "Mall",
          submission:
            kind === "not-submitted-confirmed" ? "not-submitted" : "submitted",
          completion:
            kind === "submitted-unknown"
              ? "unknown"
              : kind === "submitted-not-started"
                ? "not-started"
                : "native-confirmed",
          observedAt: s.independent.finishedAt!,
          ...(kind === "submitted-unknown" ? { taskId: 1 } : {}),
        },
      };
      const facts = structuredClone({ requests: s.requests, tasks: s.tasks });
      const blocked = await s.service.preview(s.parent.id);
      expect(blocked.canContinue).toBe(false);
      expect(blocked.reasons.join(";")).toMatch(/未确认|原生|元数据/);
      const launch = vi.fn(async () => {});
      await expect(s.service.start(stale, launch)).rejects.toThrow(
        /未确认|原生|元数据/,
      );
      expect(s.begin).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect({ requests: s.requests, tasks: s.tasks }).toEqual(facts);
    },
  );
  it("blocks only the independently uncertain gift and retains the three unstarted skills", async () => {
    const s = fixture(),
      before = structuredClone({ requests: s.requests, tasks: s.tasks });
    const preview = await s.service.preview(s.parent.id);
    expect(preview.canContinue).toBe(true);
    expect(preview.reasons).toEqual([]);
    expect(
      preview.steps.find((step) => step.skillId === "daily-gift"),
    ).toMatchObject({ status: "blocked" });
    expect(preview.defaults).toEqual([
      { gameId: "onmyoji", skillIds: remaining },
    ]);
    expect({ requests: s.requests, tasks: s.tasks }).toEqual(before);
    expect(s.begin).not.toHaveBeenCalled();
  });
  it("records the user's cancelled failed gift and preserves a verifiable partial continuation chain", async () => {
    const s = fixture(),
      original = structuredClone(s.parent),
      launch = vi.fn(async () => {});
    const preview = await s.service.preview(s.parent.id);
    await s.service.start(
      {
        parentId: s.parent.id,
        fingerprint: preview.fingerprint,
        selections: [{ gameId: "onmyoji", skillIds: remaining }],
        acknowledgePartial: true,
      },
      launch,
    );
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    const child = s.requests[2];
    expect(child.snapshot.onmyojiPlan).toEqual(s.selected);
    expect(child.snapshot.arknightsPlan).toBeUndefined();
    expect(child.snapshot.continuation).toMatchObject({
      excluded: [{ gameId: "onmyoji", skillIds: ["daily-gift"] }],
    });
    child.status = "succeeded";
    child.finishedAt = "2026-10-07T08:01:00.000Z";
    const done = s.task(child, s.selected);
    done.status = "succeeded";
    done.steps.forEach((step) => (step.status = "succeeded"));
    s.tasks.push(done);
    const details = new Map(
      s.requests.map((r) => [
        r.id,
        projectExecutionDetail(
          r,
          s.tasks.filter((t) => t.executionId === r.id),
        ),
      ]),
    );
    const progress = mergeExecutionProgress(child.id, s.requests, details);
    expect(progress.warnings).toEqual([]);
    expect(progress.outcome).toBe("partial");
    expect(progress.wholePlanComplete).toBe(false);
    expect(s.parent).toEqual(original);
  });
  it("still rejects an input that includes the blocked failed gift", async () => {
    const s = fixture(),
      preview = await s.service.preview(s.parent.id),
      launch = vi.fn();
    await expect(
      s.service.start(
        {
          parentId: s.parent.id,
          fingerprint: preview.fingerprint,
          selections: [
            { gameId: "onmyoji", skillIds: ["daily-gift", ...remaining] },
          ],
          acknowledgePartial: true,
        },
        launch,
      ),
    ).rejects.toThrow();
    expect(s.begin).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
  it("does not offer continuation when every remaining skill has independent completed effects", async () => {
    const s = fixture();
    s.tasks[3].status = "succeeded";
    s.tasks[3].steps.forEach((step) => (step.status = "succeeded"));
    const preview = await s.service.preview(s.parent.id);
    expect(preview.canContinue).toBe(false);
    expect(preview.defaults).toEqual([]);
    expect(s.begin).not.toHaveBeenCalled();
  });
  it("requires acknowledgement before admitting an explicitly partial selection", async () => {
    const s = fixture(),
      preview = await s.service.preview(s.parent.id),
      launch = vi.fn();
    await expect(
      s.service.start(
        {
          parentId: s.parent.id,
          fingerprint: preview.fingerprint,
          selections: [{ gameId: "onmyoji", skillIds: remaining }],
          acknowledgePartial: false,
        },
        launch,
      ),
    ).rejects.toThrow(/确认|核对/);
    expect(s.begin).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
  it("rechecks the selected remaining work after asynchronous admission changes history", async () => {
    const s = fixture(),
      preview = await s.service.preview(s.parent.id),
      launch = vi.fn();
    s.admission.mockImplementation(async () => {
      s.tasks[3].steps.find((step) => step.skillId === "realm-raid")!.status =
        "succeeded";
    });
    await expect(
      s.service.start(
        {
          parentId: s.parent.id,
          fingerprint: preview.fingerprint,
          selections: [{ gameId: "onmyoji", skillIds: remaining }],
          acknowledgePartial: true,
        },
        launch,
      ),
    ).rejects.toThrow();
    expect(s.begin).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
  it("never treats an unhealthy ledger as permission to skip missing game evidence", async () => {
    const s = fixture();
    s.serialUnstarted();
    s.ledger.assertHealthy.mockImplementation(() => {
      throw Error("ledger unhealthy");
    });
    await expect(s.service.preview(s.parent.id)).rejects.toThrow(
      "ledger unhealthy",
    );
    expect(s.begin).not.toHaveBeenCalled();
  });
});
