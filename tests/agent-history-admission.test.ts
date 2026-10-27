import { expect, it } from "vitest";
import type { DeviceLane, Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import {
  guardHistory,
  guardSavedDailyHistory,
  type AgentExecutionContext,
} from "../apps/desktop/main/agent-execution-policy";
import type { LaneExecutionSnapshot } from "../apps/desktop/main/lane-snapshot";
import { defaultArknightsConfig } from "../games/arknights/config";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";

const at = "2026-10-08T02:00:00.000Z";
const end = "2026-10-08T02:01:00.000Z";
const now = new Date("2026-10-08T04:00:00.000Z");
const ark: Plan = {
  gameId: "arknights",
  mode: "live",
  skillIds: ["login", "award"],
};
const yys: Plan = {
  gameId: "onmyoji",
  mode: "live",
  skillIds: ["login", "check-in"],
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
  const request: ExecutionRecord = {
    version: 1,
    id: "old:lane-a",
    source: "daily",
    laneId: lane.id,
    batchId: "old",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    fingerprint: "old",
    status: "unknown",
    startedAt: at,
    finishedAt: end,
    message: "old result",
    snapshot: { lane, profile, onmyojiPlan: structuredClone(yys) },
  };
  const makeTask = (plan: Plan): TaskRecord => ({
    version: 1,
    executionId: request.id,
    runId: `old-${plan.gameId}`,
    laneId: lane.id,
    batchId: request.batchId,
    instance: lane.instance,
    ...(plan.gameId === "arknights" ? { profileId: profile.id } : {}),
    gameId: plan.gameId,
    plan: structuredClone(plan),
    status: "failed",
    startedAt: at,
    updatedAt: end,
    finishedAt: end,
    message: "old result",
    steps: plan.skillIds.map((skillId, i) => ({
      skillId,
      status: i === 0 ? "succeeded" : "failed",
      startedAt: at,
      finishedAt: end,
      message: "recorded",
      diagnostics: [],
    })),
  });
  const task = makeTask(yys);
  const target: LaneExecutionSnapshot = {
    lane,
    profile,
    startedAt: now.toISOString(),
    arknightsPlan: structuredClone(ark),
  };
  const context = {
    requests: [request],
    tasks: [task],
  } as AgentExecutionContext;
  return { request, task, target, context, makeTask };
}

/**
 * 2026-10-15（账号级 Actor · P1a）：等调度层改成「每个槽位 × 游戏一个请求」之后，
 * 一个游戏的未处置记录**不该**再挡住另一个游戏——但只有在"请求自己冻结的计划
 * 证明与本游戏无关 + 任务证据完整自洽"时才允许放行。
 */
it("does not let a proven-unrelated request block this game", () => {
  const s = fixture();
  s.request.snapshot = {
    lane: s.request.snapshot.lane,
    profile: s.request.snapshot.profile,
    arknightsPlan: structuredClone(ark),
  } as typeof s.request.snapshot;
  s.context.tasks = [s.makeTask(structuredClone(ark))];
  // 该请求只冻结了方舟计划：阴阳师准入不受它影响。
  expect(() => guardHistory(s.target, s.context, now, yys)).not.toThrow();
});

it("still blocks the same request when its evidence is missing", () => {
  const s = fixture();
  s.request.snapshot = {
    lane: s.request.snapshot.lane,
    profile: s.request.snapshot.profile,
    arknightsPlan: structuredClone(ark),
  } as typeof s.request.snapshot;
  s.context.tasks = []; // 没有任务证据 → 不构成"可证明无关"
  expect(() => guardHistory(s.target, s.context, now, yys)).toThrow(/未处置/);
});

it("admits independent business after a reliably terminal plain failure in another game without rewriting history", () => {  const s = fixture(),
    before = structuredClone(s.context);
  expect(() => guardHistory(s.target, s.context, now)).not.toThrow();
  expect(s.context).toEqual(before);
});

it("admits disjoint same-game skills only when the prior login is settled", () => {
  const s = fixture();
  const plan: Plan = { ...yys, skillIds: ["login", "mail"] };
  s.target.arknightsPlan = undefined;
  s.target.onmyojiPlan = plan;
  expect(() => guardHistory(s.target, s.context, now, plan)).not.toThrow();
  s.task.steps[0].status = "failed";
  expect(() => guardHistory(s.target, s.context, now, plan)).toThrow(/未处置/);
});

it("admits a disjoint mixed request without its linked task being blocked again as an orphan", () => {
  const s = fixture();
  const login = { ...ark, skillIds: ["login"] };
  s.request.snapshot.arknightsPlan = login;
  const task = s.makeTask(login);
  task.status = "succeeded";
  s.context.tasks.push(task);
  expect(() => guardHistory(s.target, s.context, now)).not.toThrow();
});

it.each([
  "active-request",
  "active-task",
  "active-step",
  "missing-end",
  "task-missing-end",
  "future-end",
  "missing-plan",
  "invalid-plan",
  "missing-task",
  "duplicate-task",
  "orphan",
  "wrong-lane",
  "wrong-batch",
  "wrong-instance",
  "different-task-plan",
  "outside-request",
  "unexpected-task",
  "yys-submitted",
  "yys-contradictory",
  "native-unknown",
  "native-contradictory",
  "native-unsubmitted-success",
  "not-run-with-result",
  "successful-task-with-failed-step",
  "successful-request-with-failed-task",
] as const)(
  "retains the unresolved gate for disjoint but unsafe evidence: %s",
  (kind) => {
    const s = fixture();
    if (kind === "active-request") s.request.status = "running";
    if (kind === "active-task") s.task.status = "running";
    if (kind === "active-step") s.task.steps[1].status = "running";
    if (kind === "not-run-with-result") {
      s.task.steps[1].status = "not-run";
      s.task.steps[1].result = { status: "succeeded" };
    }
    if (kind === "successful-task-with-failed-step")
      s.task.status = "succeeded";
    if (kind === "successful-request-with-failed-task")
      s.request.status = "succeeded";
    if (kind === "missing-end") delete s.request.finishedAt;
    if (kind === "task-missing-end") delete s.task.finishedAt;
    if (kind === "future-end") s.request.finishedAt = "2026-10-09T02:00:00Z";
    if (kind === "missing-plan") delete s.request.snapshot.onmyojiPlan;
    if (kind === "invalid-plan")
      (s.request.snapshot.onmyojiPlan as Plan).skillIds.push("unregistered");
    if (kind === "missing-task") s.context.tasks = [];
    if (kind === "duplicate-task")
      s.context.tasks.push({ ...structuredClone(s.task), runId: "duplicate" });
    if (kind === "orphan") s.task.executionId = "missing-request";
    if (kind === "wrong-lane") s.task.laneId = "lane-b";
    if (kind === "wrong-batch") s.task.batchId = "other";
    if (kind === "wrong-instance") s.task.instance = 1;
    if (kind === "different-task-plan")
      s.task.plan.skillIds = ["login", "mail"];
    if (kind === "outside-request") s.task.startedAt = "2026-10-08T01:59:59Z";
    if (kind === "unexpected-task")
      s.context.tasks.push(s.makeTask({ ...ark, skillIds: ["login"] }));
    if (kind === "yys-submitted" || kind === "yys-contradictory")
      s.task.steps[1].result = {
        onmyoji: {
          version: 1,
          skillId: "check-in",
          phase: "submitted",
          observedAt: kind === "yys-submitted" ? end : "2026-10-08T03:00:00Z",
          effects: [],
        },
      };
    if (
      kind === "native-unknown" ||
      kind === "native-contradictory" ||
      kind === "native-unsubmitted-success"
    ) {
      const plan = { ...ark, skillIds: ["login", "friends"] };
      delete s.request.snapshot.onmyojiPlan;
      s.request.snapshot.arknightsPlan = plan;
      const task = s.makeTask(plan);
      task.steps[1].result = {
        arknights: {
          version: 1,
          taskType: "Mall",
          submission: "submitted",
          taskId: 1,
          completion: kind === "native-unknown" ? "unknown" : "not-started",
          observedAt: end,
        },
      };
      if (kind === "native-unsubmitted-success") {
        task.steps[1].status = "succeeded";
        task.steps[1].result.arknights = {
          version: 1,
          taskType: "Mall",
          submission: "not-submitted",
          completion: "not-started",
          observedAt: end,
        };
      }
      s.context.tasks = [task];
    }
    expect(() => guardHistory(s.target, s.context, now)).toThrow(/未处置/);
  },
);

it.each(["primary", "secondary"] as const)(
  "shares disjoint admission and unresolved native protection with saved daily %s",
  (slot) => {
    const s = fixture();
    expect(() =>
      guardSavedDailyHistory(s.target, s.context, now, slot),
    ).not.toThrow();
    s.task.steps[1].result = {
      onmyoji: {
        version: 1,
        skillId: "check-in",
        phase: "submitted",
        observedAt: end,
        effects: [],
      },
    };
    expect(() =>
      guardSavedDailyHistory(s.target, s.context, now, slot),
    ).toThrow(/未处置/);
  },
);

it("checks every selected saved game rather than accepting the first disjoint game", () => {
  const s = fixture();
  s.target.onmyojiPlan = structuredClone(yys);
  expect(() =>
    guardSavedDailyHistory(s.target, s.context, now, "primary"),
  ).toThrow(/未处置/);
});

it("preserves primary replay blocking and the existing settled-success exception for the secondary Arknights period", () => {
  const s = fixture();
  s.context.tasks = [];
  s.request.status = "succeeded";
  delete s.request.snapshot.onmyojiPlan;
  s.request.snapshot.arknightsPlan = structuredClone(ark);
  // Local dates match the host's established 20:00 daily period boundary.
  s.request.startedAt = new Date(2026, 9, 8, 10, 0).toISOString();
  s.request.finishedAt = new Date(2026, 9, 8, 10, 1).toISOString();
  const evening = new Date(2026, 9, 8, 21, 0);
  expect(() =>
    guardSavedDailyHistory(s.target, s.context, evening, "primary"),
  ).toThrow(/本游戏日/);
  expect(() =>
    guardSavedDailyHistory(s.target, s.context, evening, "secondary"),
  ).not.toThrow();
  s.request.startedAt = new Date(2026, 9, 8, 20, 0).toISOString();
  s.request.finishedAt = new Date(2026, 9, 8, 20, 1).toISOString();
  expect(() =>
    guardSavedDailyHistory(s.target, s.context, evening, "secondary"),
  ).toThrow(/本游戏日/);
});

it.each([99, 0, null])(
  "does not exempt unknown snapshot %s from secondary history admission",
  (schemaVersion) => {
    const s = fixture();
    s.context.tasks = [];
    s.request.status = "succeeded";
    s.request.snapshot.schemaVersion = schemaVersion;
    delete s.request.snapshot.onmyojiPlan;
    s.request.snapshot.arknightsPlan = structuredClone(ark);
    s.request.startedAt = new Date(2026, 9, 8, 10, 0).toISOString();
    s.request.finishedAt = new Date(2026, 9, 8, 10, 1).toISOString();
    expect(() =>
      guardSavedDailyHistory(
        s.target,
        s.context,
        new Date(2026, 9, 8, 21, 0),
        "secondary",
      ),
    ).toThrow(/版本不受支持/);
  },
);

it("keeps same-day confirmed effects blocked and never uses independent success to close older uncertainty", () => {
  const s = fixture();
  const plan = structuredClone(ark);
  s.request.snapshot.arknightsPlan = plan;
  const task = s.makeTask(plan);
  task.status = "succeeded";
  task.steps.forEach((step) => (step.status = "succeeded"));
  s.context.tasks.push(task);
  expect(() => guardHistory(s.target, s.context, now)).toThrow();
  s.request.status = "succeeded";
  s.task.status = "succeeded";
  s.task.steps.forEach((step) => (step.status = "succeeded"));
  expect(() => guardHistory(s.target, s.context, now)).toThrow(/本游戏日/);
  s.request.status = "unknown";
  s.context.requests.push({
    ...structuredClone(s.request),
    id: "new-success",
    status: "succeeded",
  });
  expect(() => guardHistory(s.target, s.context, now)).toThrow(/未处置/);
  expect(s.request.status).toBe("unknown");
  expect(s.request.resolution).toBeUndefined();
});

function resolvedLoginOnlyFailure() {
  const s = fixture();
  const old: Plan = {
    ...yys,
    skillIds: [
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "realm-raid",
      "hana-claim",
    ],
  };
  s.request.snapshot.onmyojiPlan = old;
  s.request.resolution = {
    action: "abandoned",
    at: end,
    note: "Stopped the earlier attempt; business did not start",
  };
  s.task = s.makeTask(old);
  s.task.status = "unknown";
  s.task.fault = {
    version: 1,
    source: "watchdog",
    code: "worker-run-timeout",
    runId: s.task.runId,
    skillId: "login",
    observedAt: end,
    capture: { status: "not-attempted" },
  };
  s.task.steps = old.skillIds.map((skillId, i) =>
    i === 0
      ? {
          skillId,
          status: "unknown",
          startedAt: at,
          finishedAt: end,
          message: "login interrupted",
          diagnostics: ["worker timeout"],
        }
      : { skillId, status: "not-run", message: "not started", diagnostics: [] },
  );
  s.context.tasks = [s.task];
  s.target.arknightsPlan = undefined;
  s.target.onmyojiPlan = { ...yys, skillIds: ["login", "mail", "hana-claim"] };
  return s;
}

it.each(["unknown", "failed", "cancelled"] as const)(
  "admits a newly authorized login and YYS business after resolved %s login-only interruption without rewriting it",
  (status) => {
    const s = resolvedLoginOnlyFailure();
    s.request.status = status;
    s.task.status = status;
    const before = structuredClone(s.context);
    expect(() =>
      guardHistory(s.target, s.context, now, s.target.onmyojiPlan),
    ).not.toThrow();
    expect(s.context).toEqual(before);
    expect(s.target.onmyojiPlan!.skillIds[0]).toBe("login");
  },
);

it.each(["primary", "secondary"] as const)(
  "uses the same strict unstarted YYS exception for saved daily %s",
  (slot) => {
    const s = resolvedLoginOnlyFailure();
    expect(() =>
      guardSavedDailyHistory(s.target, s.context, now, slot),
    ).not.toThrow();
  },
);

it.each([
  "unresolved",
  "active-request",
  "active-task",
  "successful-request",
  "successful-task",
  "missing-end",
  "future-resolution",
  "early-resolution",
  "bad-resolution",
  "empty-note",
  "missing-task",
  "duplicate-task",
  "orphan",
  "wrong-lane",
  "wrong-batch",
  "wrong-instance",
  "missing-plan",
  "bad-plan",
  "different-plan",
  "task-outside-request",
  "task-end-mismatch",
  "business-running",
  "business-unknown",
  "business-succeeded",
  "business-skipped",
  "business-start",
  "business-end",
  "business-result",
  "business-evidence",
  "business-diagnostic",
  "target-other-manager",
  "target-other-instance",
  "target-other-lane",
  "wildcard-resource",
  "extra-resource",
  "missing-manager",
  "new-plan-without-login",
  "extra-game",
  "missing-fault",
  "unlocated-fault",
  "business-fault",
  "worker-exited",
  "early-fault",
  "login-not-first",
  "business-outside-selection",
  "additional-orphan",
  "another-active-request",
  "login-business-result",
  "login-evidence",
] as const)(
  "rejects the unstarted business exemption when evidence is unsafe: %s",
  (kind) => {
    const s = resolvedLoginOnlyFailure();
    const step = s.task.steps[2];
    if (kind === "unresolved") delete s.request.resolution;
    if (kind === "active-request") s.request.status = "running";
    if (kind === "active-task") s.task.status = "running";
    if (kind === "successful-request") s.request.status = "succeeded";
    if (kind === "successful-task") s.task.status = "succeeded";
    if (kind === "missing-end") delete s.request.finishedAt;
    if (kind === "future-resolution")
      s.request.resolution!.at = "2026-10-09T00:00:00Z";
    if (kind === "early-resolution") s.request.resolution!.at = at;
    if (kind === "bad-resolution") s.request.resolution!.at = "invalid";
    if (kind === "empty-note") s.request.resolution!.note = "";
    if (kind === "missing-task") s.context.tasks = [];
    if (kind === "duplicate-task")
      s.context.tasks.push({ ...structuredClone(s.task), runId: "duplicate" });
    if (kind === "orphan") s.task.executionId = "absent";
    if (kind === "wrong-lane") s.task.laneId = "other";
    if (kind === "wrong-batch") s.task.batchId = "other";
    if (kind === "wrong-instance") s.task.instance = 1;
    if (kind === "missing-plan") delete s.request.snapshot.onmyojiPlan;
    if (kind === "bad-plan")
      (s.request.snapshot.onmyojiPlan as Plan).skillIds.push("bad-skill");
    if (kind === "different-plan") s.task.plan.skillIds = ["login", "mail"];
    if (kind === "task-outside-request")
      s.task.startedAt = "2026-10-08T01:59:59Z";
    if (kind === "task-end-mismatch") s.task.finishedAt = at;
    if (kind === "business-running") step.status = "running";
    if (kind === "business-unknown") step.status = "unknown";
    if (kind === "business-succeeded") step.status = "succeeded";
    if (kind === "business-skipped") step.status = "skipped";
    if (kind === "business-start") step.startedAt = at;
    if (kind === "business-end") step.finishedAt = end;
    if (kind === "business-result")
      step.result = {
        onmyoji: {
          version: 1,
          skillId: "mail",
          phase: "submitted",
          observedAt: end,
          effects: [],
        },
      };
    if (kind === "business-evidence") step.evidence = "live" as never;
    if (kind === "business-diagnostic")
      step.diagnostics = ["action may have started"];
    s.target.lane = structuredClone(s.target.lane);
    if (kind === "target-other-manager")
      s.target.lane.managerPath = "D:/Other/MuMuManager.exe";
    if (kind === "target-other-instance") s.target.lane.instance = 1;
    if (kind === "target-other-lane") s.target.lane.id = "renamed";
    if (kind === "wildcard-resource") s.request.resources = ["*"];
    if (kind === "extra-resource") s.request.resources.push("mumu:other#0");
    if (kind === "missing-manager")
      delete (s.request.snapshot.lane as Partial<DeviceLane>).managerPath;
    if (kind === "new-plan-without-login")
      s.target.onmyojiPlan!.skillIds = ["mail", "hana-claim"];
    if (kind === "extra-game")
      s.request.snapshot.arknightsPlan = structuredClone(ark);
    if (kind === "missing-fault") delete s.task.fault;
    if (kind === "unlocated-fault") delete s.task.fault!.skillId;
    if (kind === "business-fault") s.task.fault!.skillId = "mail";
    if (kind === "worker-exited") s.task.fault!.code = "worker-exited";
    if (kind === "early-fault")
      s.task.fault!.observedAt = "2026-10-08T01:59:59Z";
    if (kind === "login-not-first")
      (s.request.snapshot.onmyojiPlan as Plan).skillIds = ["mail", "login"];
    if (kind === "business-outside-selection")
      s.task.steps[1].status = "succeeded";
    if (kind === "additional-orphan")
      s.context.tasks.push({
        ...structuredClone(s.task),
        runId: "orphan",
        executionId: "absent",
      });
    if (kind === "another-active-request")
      s.context.requests.push({
        ...structuredClone(s.request),
        id: "active",
        status: "running",
      });
    if (kind === "login-business-result")
      s.task.steps[0].result = {
        onmyoji: {
          version: 1,
          skillId: "mail",
          phase: "submitted",
          observedAt: end,
          effects: [],
        },
      };
    if (kind === "login-evidence") s.task.steps[0].evidence = "live" as never;
    expect(() =>
      guardHistory(s.target, s.context, now, s.target.onmyojiPlan),
    ).toThrow();
  },
);
