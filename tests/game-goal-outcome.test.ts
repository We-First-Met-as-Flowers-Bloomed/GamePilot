import { expect, it } from "vitest";
import {
  evaluateGoalOutcome,
  goalOutcomeCriteriaForPrompt,
} from "../games/goal-outcome";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { defaultArknightsConfig } from "../games/arknights/config";
import { projectExecutionDetail } from "../games/execution-detail";
import { mergeExecutionProgress } from "../games/execution-progress";
import { validateTaskRecord } from "../packages/protocol/task-record";
import { GoalService } from "../apps/desktop/main/agent-goals";
import type { GoalScope, GoalStore } from "../packages/protocol/agent-goal";

const at = "2026-10-05T04:00:00.000Z";
it("derives stricter requested outcome predicates only from the current unquoted objective", () => {
  expect(
    goalOutcomeCriteriaForPrompt("运行明日方舟日常，用尽当前理智"),
  ).toMatchObject({ fight: "consume-current-sanity" });
  expect(
    goalOutcomeCriteriaForPrompt("运行保存日常，消耗现有理智"),
  ).toMatchObject({ fight: "consume-current-sanity" });
  expect(
    goalOutcomeCriteriaForPrompt("只给第二个账号运行阴阳师登录并核验角色身份"),
  ).toMatchObject({ login: "verify-account" });
  expect(goalOutcomeCriteriaForPrompt("双账号登录核验")).toMatchObject({
    login: "verify-account",
  });
  expect(
    goalOutcomeCriteriaForPrompt(
      "之前说“用尽理智，核验账号”。现在运行保存的日常。",
    ),
  ).toEqual({});
  expect(goalOutcomeCriteriaForPrompt("确认运行账号二保存的日常")).toEqual({});
});
function records(gameId = "onmyoji", skillId = "guild-kirin") {
  const plan = { gameId, skillIds: [skillId], mode: "live" as const };
  const request: ExecutionRecord = {
    version: 1,
    id: "request-1",
    source: "single",
    resources: ["device:1"],
    snapshot: {
      plan,
      lane: {
        id: "lane-b",
        name: "account two",
        instance: 1,
        managerPath: "D:/MuMu/MuMuManager.exe",
        arknights: { profileId: "p" },
      },
      profile: {
        ...defaultArknightsConfig,
        id: "p",
        name: "p",
        expectedUid: "123456789",
      },
    },
    fingerprint: "frozen",
    status: "succeeded",
    startedAt: at,
    finishedAt: at,
    message: "flow finished",
    laneId: "lane-b",
  };
  const task: TaskRecord = {
    version: 1,
    runId: "run-1",
    executionId: request.id,
    laneId: "lane-b",
    instance: 1,
    profileId: "p",
    gameId,
    plan,
    status: "succeeded",
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    message: "flow finished",
    steps: [
      {
        skillId,
        status: "skipped",
        message: "麒麟已完成",
        diagnostics: [],
        evidence: "adapter-result",
        result: { status: "skipped", summary: "麒麟已完成" },
      },
    ],
  };
  return { request, task };
}

function nativeLoginRecords(laneId = "lane-b", instance = 1) {
  const { request, task } = records("arknights", "login");
  const uid = instance === 0 ? "123456780" : "123456789";
  const profileId = `profile-${laneId}`;
  (request.snapshot.profile as { id: string; expectedUid: string }).id =
    profileId;
  (
    request.snapshot.profile as { id: string; expectedUid: string }
  ).expectedUid = uid;
  (
    request.snapshot.lane as { arknights: { profileId: string } }
  ).arknights.profileId = profileId;
  request.id = `request-${laneId}`;
  request.laneId = laneId;
  (request.snapshot.lane as { id: string; instance: number }).id = laneId;
  (request.snapshot.lane as { id: string; instance: number }).instance =
    instance;
  request.finishedAt = "2026-10-05T04:00:04.000Z";
  task.executionId = request.id;
  task.runId = `run-${laneId}`;
  task.laneId = laneId;
  task.instance = instance;
  task.profileId = profileId;
  task.finishedAt = task.updatedAt = request.finishedAt;
  task.steps[0] = {
    skillId: "login",
    status: "succeeded",
    startedAt: at,
    finishedAt: request.finishedAt,
    message: "matched native completion and profile UID verification",
    evidence: "adapter-result",
    diagnostics: [],
    result: {
      status: "succeeded",
      arknights: {
        version: 1,
        taskType: "StartUp",
        taskId: 17,
        submission: "submitted",
        completion: "native-confirmed",
        observedAt: "2026-10-05T04:00:01.000Z",
        login: {
          expectedUid: uid,
          observedUid: uid,
          observedAt: "2026-10-05T04:00:02.000Z",
          home: true,
          method: "profile",
          homeObservedAt: "2026-10-05T04:00:03.000Z",
        },
      },
    },
  };
  return { request, task };
}

function runningSerialDaily() {
  const { request, task } = nativeLoginRecords();
  request.source = "daily";
  request.batchId = task.batchId = "serial";
  request.status = "running";
  delete request.finishedAt;
  request.snapshot.arknightsPlan = {
    gameId: "arknights",
    mode: "live",
    skillIds: ["login", "infrastructure", "award"],
  };
  request.snapshot.onmyojiPlan = {
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
  delete request.snapshot.plan;
  task.plan = structuredClone(
    request.snapshot.arknightsPlan,
  ) as TaskRecord["plan"];
  task.status = "running";
  delete task.finishedAt;
  task.updatedAt = "2026-10-05T04:00:08.000Z";
  task.steps.push(
    {
      skillId: "infrastructure",
      status: "running",
      startedAt: "2026-10-05T04:00:05.000Z",
      message: "正在处理基建",
      diagnostics: [],
    },
    {
      skillId: "award",
      status: "pending",
      message: "等待执行",
      diagnostics: [],
    },
  );
  return { request, task, tasks: [task] };
}

it("shows not-yet-started serial YYS as pending while the matched Arknights step is actually running", () => {
  const x = runningSerialDaily(),
    before = structuredClone(x);
  const result = evaluateGoalOutcome([x.request], x.tasks);
  const future = result.requests[0].skills.filter(
    (skill) => skill.gameId === "onmyoji",
  );
  expect(future).toHaveLength(6);
  expect(
    future.every(
      (skill) =>
        skill.status === "pending" &&
        skill.goalSatisfied === null &&
        skill.summary === "等待明日方舟完成后执行",
    ),
  ).toBe(true);
  expect(result.summary.split("等待明日方舟完成后执行")).toHaveLength(2);
  expect(result.goalSatisfied).toBeNull();
  expect(result.flowComplete).toBe(false);
  expect(x).toEqual(before);
});

it.each([
  "terminal-unknown",
  "terminal-failed",
  "terminal-cancelled",
  "terminal-succeeded",
  "stale-finish",
  "duplicate-current",
  "future-record",
  "future-wrong-link",
  "out-of-order",
  "two-running",
  "no-running",
  "unstarted-effect",
  "unstarted-time",
  "missing-current",
  "current-stopped",
  "current-maintenance",
  "wrong-device",
  "rehearsal",
  "conflicting-plan",
  "continuation-link",
])("does not hide %s behind serial pending status", (invalid) => {
  const x = runningSerialDaily();
  if (invalid.startsWith("terminal-")) {
    x.request.status = invalid.slice(
      "terminal-".length,
    ) as ExecutionRecord["status"];
    x.request.finishedAt = x.task.updatedAt;
  }
  if (invalid === "stale-finish") x.request.finishedAt = x.task.updatedAt;
  if (invalid === "duplicate-current")
    x.tasks.push({ ...structuredClone(x.task), runId: "duplicate" });
  if (invalid.startsWith("future-")) {
    const next = structuredClone(x.task);
    next.runId = "future";
    next.gameId = "onmyoji";
    next.plan = structuredClone(
      x.request.snapshot.onmyojiPlan,
    ) as TaskRecord["plan"];
    next.steps = next.plan.skillIds.map((skillId) => ({
      skillId,
      status: "pending",
      message: "waiting",
      diagnostics: [],
    }));
    if (invalid === "future-wrong-link") next.executionId = "contradictory";
    x.tasks.push(next);
  }
  if (invalid === "out-of-order") x.task.steps[1].startedAt = x.task.startedAt;
  if (invalid === "two-running") {
    x.task.steps[2].status = "running";
    x.task.steps[2].startedAt = x.task.updatedAt;
  }
  if (invalid === "no-running") {
    x.task.steps[1].status = "pending";
    delete x.task.steps[1].startedAt;
  }
  if (invalid === "unstarted-effect")
    x.task.steps[2].result = {
      goalSatisfied: true,
      evidenceTimestamp: x.task.updatedAt,
      evidenceReference: "contradictory",
    };
  if (invalid === "unstarted-time")
    x.task.steps[2].startedAt = x.task.updatedAt;
  if (invalid === "missing-current") x.tasks.length = 0;
  if (invalid === "current-stopped") x.task.status = "stopping";
  if (invalid === "current-maintenance") x.task.maintenance = true;
  if (invalid === "wrong-device") x.task.instance = 0;
  if (invalid === "rehearsal") {
    x.task.plan.mode = "rehearsal";
    (x.request.snapshot.arknightsPlan as TaskRecord["plan"]).mode = "rehearsal";
  }
  if (invalid === "conflicting-plan")
    x.request.snapshot.plan = structuredClone(x.task.plan);
  if (invalid === "continuation-link")
    x.request.snapshot.continuation = {
      parentId: "unverified-parent",
      parentFingerprint: "missing",
      acknowledgedPartial: false,
      retained: [],
      excluded: [],
    };
  const result = evaluateGoalOutcome([x.request], x.tasks);
  const future = result.requests[0].skills.filter(
    (skill) => skill.gameId === "onmyoji",
  );
  expect(
    future.every(
      (skill) => skill.status !== "pending" || invalid === "future-record",
    ),
  ).toBe(true);
  expect(result.summary).not.toContain("等待明日方舟完成后执行");
  expect(result.goalSatisfied).not.toBe(true);
  expect(result.flowComplete).toBe(false);
});

it("projects matched UID proof time and original request/run/step/native reference without rewriting the record", () => {
  const { request, task } = nativeLoginRecords(),
    before = structuredClone({ request, task });
  expect(
    evaluateGoalOutcome([request], [task], { login: "verify-account" }),
  ).toMatchObject({
    status: "verified",
    goalSatisfied: true,
    requests: [
      {
        skills: [
          {
            skillId: "login",
            goalSatisfied: true,
            evidenceTimestamp: "2026-10-05T04:00:03.000Z",
            evidenceReference: `request:${request.id}:run:${task.runId}:step:login:native:StartUp:17`,
          },
        ],
      },
    ],
  });
  expect({ request, task }).toEqual(before);
});

it.each([
  "missing-native",
  "unmatched-record",
  "future-native",
  "future-uid",
  "future-home",
  "rehearsal",
])("keeps %s login proof unknown", (invalid) => {
  const { request, task } = nativeLoginRecords();
  if (invalid === "missing-native") delete task.steps[0].result!.arknights;
  if (invalid === "unmatched-record") task.executionId = "another-request";
  if (invalid === "future-native")
    task.steps[0].result!.arknights!.observedAt = "2026-10-05T04:00:05.000Z";
  if (invalid === "future-uid")
    task.steps[0].result!.arknights!.login!.observedAt =
      "2026-10-05T04:00:05.000Z";
  if (invalid === "future-home")
    task.steps[0].result!.arknights!.login!.homeObservedAt =
      "2026-10-05T04:00:05.000Z";
  if (invalid === "rehearsal") {
    task.plan.mode = "rehearsal";
    (request.snapshot.plan as { mode: string }).mode = "rehearsal";
  }
  const outcome = evaluateGoalOutcome([request], [task], {
    login: "verify-account",
  });
  expect(outcome.status).toBe("unknown");
  expect(outcome.goalSatisfied).toBeNull();
});

it.each([
  "valid",
  "missing-native",
  "unmatched-record",
  "future-native",
  "future-uid",
  "future-home",
  "wrong-uid",
  "rehearsal",
])("a real GoalService requires both native UID facts: %s", async (proof) => {
  const owner = { sessionId: "session-native", turnId: "turn-native" };
  const pairs = [
    nativeLoginRecords("lane-a", 0),
    nativeLoginRecords("lane-b", 1),
  ];
  const scopes: GoalScope[] = pairs.map(({ request }) => ({
    laneId: request.laneId!,
    gameId: "arknights",
    skillIds: ["login"],
    resources: {},
  }));
  let persisted: GoalStore | undefined;
  let clock = new Date(at);
  const service = new GoalService({
    now: () => clock,
    save: async (store) => {
      persisted = structuredClone(store);
    },
    prepare: async () => ({
      fingerprint: "frozen-native-login",
      summary: [],
      scopes,
      payload: {},
      frozenPlan: {
        kind: "custom",
        hash: "native-login-plan",
        plannerRequestId: "planner-native",
      },
    }),
    submit: async (goal) => {
      for (const { request, task } of pairs) {
        request.id = `${goal.submission!.batchId}:${request.laneId}`;
        request.batchId = task.batchId = goal.submission!.batchId;
        task.executionId = request.id;
      }
      return goal.submission!;
    },
    observe: async () =>
      evaluateGoalOutcome(
        pairs.map((pair) => pair.request),
        pairs.map((pair) => pair.task),
        { login: "verify-account" },
      ),
    stop: async () => ({
      requests: [],
      flowComplete: false,
      goalSatisfied: null,
      summary: "not stopped",
    }),
  });
  const goal = await service.create({
    ...owner,
    prompt: "现在只运行双账号明日方舟登录与UID核验",
    selection: {
      kind: "custom",
      planHash: "native-login-plan",
      plannerRequestId: "planner-native",
    },
    grant: {
      id: "grant-native",
      ...owner,
      source: "user-message",
      issuedAt: at,
      expiresAt: "2026-10-05T05:00:00.000Z",
      maxRetries: 0,
      scopes,
    },
  });
  await service.submit(goal.id, owner);
  clock = new Date("2026-10-05T04:00:05.000Z");
  const { request, task } = pairs[1];
  if (proof === "missing-native") delete task.steps[0].result!.arknights;
  if (proof === "unmatched-record") task.executionId = "another-request";
  if (proof === "future-native")
    task.steps[0].result!.arknights!.observedAt = "2026-10-05T04:00:06.000Z";
  if (proof === "future-uid")
    task.steps[0].result!.arknights!.login!.observedAt =
      "2026-10-05T04:00:06.000Z";
  if (proof === "future-home")
    task.steps[0].result!.arknights!.login!.homeObservedAt =
      "2026-10-05T04:00:06.000Z";
  if (proof === "wrong-uid")
    task.steps[0].result!.arknights!.login!.observedUid = "987654321";
  if (proof === "rehearsal") {
    task.plan.mode = "rehearsal";
    (request.snapshot.plan as { mode: string }).mode = "rehearsal";
  }
  await service.refresh(goal.id);
  const expected = proof === "valid" ? "completed" : "unknown";
  expect(service.get(goal.id, owner)).toMatchObject({
    status: expected,
    goalSatisfied: proof === "valid" ? true : null,
  });
  expect(persisted!.goals[0].status).toBe(expected);
  expect(service.get(goal.id, owner).requests).toHaveLength(2);
});

it("preserves legacy flow completion without guessing Kirin satisfaction from a summary", () => {
  const { request, task } = records();
  const before = structuredClone({ request, task });
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "unknown",
    flowComplete: true,
    goalSatisfied: null,
  });
  expect({ request, task }).toEqual(before);
});

it("never turns an Onmyoji courtyard login into proof of a requested account identity check", () => {
  const { request, task } = records("onmyoji", "login");
  task.steps[0].status = "succeeded";
  task.steps[0].result = {
    goalSatisfied: true,
    evidenceTimestamp: at,
    evidenceReference: "onmyoji:login:two-frames",
    summary: "已观察庭院；角色未独立核验",
  };
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "verified",
    goalSatisfied: true,
  });
  expect(
    evaluateGoalOutcome(
      [request],
      [task],
      goalOutcomeCriteriaForPrompt("运行阴阳师登录并核验账号"),
    ),
  ).toMatchObject({
    status: "unknown",
    flowComplete: true,
    goalSatisfied: null,
  });
  expect(task.steps[0].result.goalSatisfied).toBe(true);
});

it("distinguishes a verified prior completion from a known closed activity", () => {
  const { request, task } = records();
  task.steps[0].result = {
    status: "skipped",
    skipReason: "already-completed",
    goalSatisfied: true,
    evidenceTimestamp: at,
    evidenceReference: "kirin:matching-score",
    summary: "已确认今日参与",
  };
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "verified",
    goalSatisfied: true,
  });
  task.steps[0].result = {
    status: "skipped",
    skipReason: "not-open",
    goalSatisfied: null,
    evidenceTimestamp: at,
    evidenceReference: "kirin:calendar",
    summary: "活动不开放",
  };
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "not-applicable",
    goalSatisfied: null,
  });
});

it("retains a custom calendar exclusion as not applicable even when the remaining login flow succeeds", () => {
  const { request, task } = records("onmyoji", "login");
  task.steps[0].status = "succeeded";
  task.steps[0].result = {
    status: "succeeded",
    goalSatisfied: true,
    evidenceTimestamp: at,
    evidenceReference: "onmyoji:login:two-frames",
  };
  request.snapshot.exclusions = [
    {
      gameId: "onmyoji",
      skillIds: ["guild-kirin"],
      skipReason: "not-open",
      evidenceTimestamp: at,
      evidenceReference: "onmyoji:calendar",
    },
  ];
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "not-applicable",
    goalSatisfied: null,
    flowComplete: true,
    requests: [
      {
        skills: [
          { skillId: "login", goalSatisfied: true },
          {
            skillId: "guild-kirin",
            skipReason: "not-open",
            goalSatisfied: null,
          },
        ],
      },
    ],
  });
});

it("reports zero confirmed purchases as unverified shopping, with the actual quantity", () => {
  const { request, task } = records("arknights", "friends");
  request.snapshot.profile = {
    ...(request.snapshot.profile as object),
    creditShopping: true,
  };
  task.steps[0].status = "succeeded";
  task.steps[0].result = {
    status: "succeeded",
    arknights: {
      version: 1,
      taskType: "Mall",
      submission: "submitted",
      completion: "native-confirmed",
      observedAt: at,
      taskId: 1,
      statistics: {
        version: 1,
        mall: { purchaseConfirmations: 0, creditCollected: true },
      },
    },
  };
  const outcome = evaluateGoalOutcome([request], [task]);
  expect(outcome).toMatchObject({
    status: "unknown",
    goalSatisfied: null,
    flowComplete: true,
  });
  expect(outcome.summary).toContain("0");
});

it("uses the frozen settings of an existing single-game request when shopping was excluded", () => {
  const { request, task } = records("arknights", "friends");
  request.snapshot.arknights = {
    ...(request.snapshot.profile as object),
    creditShopping: false,
  };
  delete request.snapshot.profile;
  delete request.snapshot.lane;
  delete request.laneId;
  delete task.laneId;
  delete task.instance;
  delete task.profileId;
  task.steps[0].status = "succeeded";
  task.steps[0].result = {
    status: "succeeded",
    arknights: {
      version: 1,
      taskType: "Mall",
      submission: "submitted",
      completion: "native-confirmed",
      observedAt: at,
      taskId: 1,
      statistics: {
        version: 1,
        mall: { purchaseConfirmations: 0, creditCollected: true },
      },
    },
  };
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "verified",
    goalSatisfied: true,
  });
});

it("validates native task execution for recruitment without asserting reward quantities", () => {
  const { request, task } = records("arknights", "recruit");
  task.steps[0].status = "succeeded";
  task.steps[0].result = {
    status: "succeeded",
    arknights: {
      version: 1,
      taskType: "Recruit",
      submission: "submitted",
      completion: "native-confirmed",
      observedAt: at,
      taskId: 1,
    },
  };
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "verified",
    goalSatisfied: true,
  });
});

it("keeps all-sanity consumption unknown unless the remaining sanity proves a known stage cannot run again", () => {
  const { request, task } = records("arknights", "fight");
  request.snapshot.profile = {
    ...(request.snapshot.profile as object),
    stage: "LS-6",
  };
  task.steps[0].status = "succeeded";
  task.steps[0].result = {
    status: "succeeded",
    arknights: {
      version: 1,
      taskType: "Fight",
      submission: "submitted",
      completion: "native-confirmed",
      observedAt: at,
      taskId: 1,
      statistics: {
        version: 1,
        fight: { completedRunsObserved: 1, firstSanity: 80, latestSanity: 44 },
      },
    },
  };
  expect(
    evaluateGoalOutcome([request], [task], { fight: "consume-current-sanity" })
      .goalSatisfied,
  ).toBeNull();
  task.steps[0].result.arknights!.statistics!.fight!.latestSanity = 8;
  expect(
    evaluateGoalOutcome([request], [task], { fight: "consume-current-sanity" })
      .goalSatisfied,
  ).toBe(true);
});

it("projects authorized continuation completion at the actual latest leaf while preserving the original failure", () => {
  const { request, task } = records("onmyoji", "mail");
  const originalPlan = {
    gameId: "onmyoji",
    mode: "live" as const,
    skillIds: ["login", "mail"],
  };
  request.snapshot.plan = originalPlan;
  task.plan = originalPlan;
  request.status = "failed";
  task.status = "failed";
  task.steps[0].status = "failed";
  task.steps.unshift({
    skillId: "login",
    status: "succeeded",
    diagnostics: [],
    message: "checked",
    evidence: "adapter-result",
    result: {
      status: "succeeded",
      goalSatisfied: true,
      evidenceTimestamp: at,
      evidenceReference: "onmyoji:login:checked",
    },
  });
  const child = structuredClone(request);
  child.id = "child";
  child.source = "daily";
  child.status = "succeeded";
  child.fingerprint = "child-frozen";
  child.startedAt = child.finishedAt = "2026-10-05T04:01:00.000Z";
  const childPlan = {
    gameId: "onmyoji",
    mode: "live" as const,
    skillIds: ["login", "mail"],
  };
  child.snapshot.plan = childPlan;
  child.snapshot.continuation = {
    parentId: request.id,
    parentFingerprint: request.fingerprint,
    retained: [],
    excluded: [],
    acknowledgedPartial: true,
  };
  const childTask: TaskRecord = {
    ...structuredClone(task),
    executionId: child.id,
    runId: "child-run",
    plan: childPlan,
    status: "succeeded",
    startedAt: child.startedAt,
    updatedAt: child.finishedAt,
    finishedAt: child.finishedAt,
    steps: childPlan.skillIds.map((skillId) => ({
      skillId,
      status: "succeeded",
      diagnostics: [],
      message: "checked",
      evidence: "adapter-result",
      result: {
        status: "succeeded",
        goalSatisfied: true,
        evidenceTimestamp: child.startedAt,
        evidenceReference: `onmyoji:${skillId}:checked`,
      },
    })),
  };
  const before = structuredClone([request, child, task, childTask]);
  expect(
    mergeExecutionProgress(
      request.id,
      [request, child],
      new Map([
        [request.id, projectExecutionDetail(request, [task])],
        [child.id, projectExecutionDetail(child, [childTask])],
      ]),
    ).warnings,
  ).toEqual([]);
  expect(
    evaluateGoalOutcome([request, child], [task, childTask]),
  ).toMatchObject({
    status: "verified",
    flowComplete: true,
    goalSatisfied: true,
    requests: [
      {
        requestId: child.id,
        rootRequestId: request.id,
        originalStatus: "failed",
        status: "succeeded",
        goalSatisfied: true,
      },
    ],
  });
  expect([request, child, task, childTask]).toEqual(before);
  child.status = "running";
  delete child.finishedAt;
  expect(evaluateGoalOutcome([request, child], [task])).toMatchObject({
    status: "unknown",
    flowComplete: false,
    goalSatisfied: null,
    requests: [{ requestId: child.id, status: "running" }],
  });
  child.status = "succeeded";
  child.finishedAt = "2026-10-05T04:01:00.000Z";
  (
    child.snapshot.continuation as { parentFingerprint: string }
  ).parentFingerprint = "forged";
  expect(
    evaluateGoalOutcome([request, child], [task, childTask]).goalSatisfied,
  ).not.toBe(true);
});

it("requires a matching linked task for every frozen plan", () => {
  const { request, task } = records();
  task.steps[0].result = {
    status: "succeeded",
    goalSatisfied: true,
    evidenceTimestamp: at,
    evidenceReference: "verified",
  };
  task.plan = { ...task.plan, skillIds: ["mail"] };
  expect(evaluateGoalOutcome([request], [task])).toMatchObject({
    status: "unknown",
    goalSatisfied: null,
    flowComplete: false,
  });
});

it("rejects malformed or contradictory structured outcome facts in persisted task records", () => {
  const { task } = records();
  task.steps[0].result = {
    status: "skipped",
    skipReason: "not-open",
    goalSatisfied: true,
    evidenceTimestamp: at,
    evidenceReference: "calendar",
  };
  expect(() => validateTaskRecord(task)).toThrow();
  task.steps[0].result = {
    status: "skipped",
    skipReason: "unknown",
    goalSatisfied: null,
    evidenceTimestamp: "not-a-date",
    evidenceReference: "calendar",
  };
  expect(() => validateTaskRecord(task)).toThrow();
});
