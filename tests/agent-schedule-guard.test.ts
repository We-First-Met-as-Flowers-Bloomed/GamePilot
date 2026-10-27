import { expect, it, vi } from "vitest";
import { assertAgentScheduleClear } from "../apps/desktop/main/agent-schedule-guard";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { DeviceLane, Plan } from "../packages/protocol";
import type { TaskRecord } from "../packages/protocol/task-record";
import { startupRecoveryFixture } from "./startup-recovery-fixture";
import { completedContinuationRequestIds } from "../games/continuation-history";
const lane = createFixtureSnapshot().lanes!.lanes[0];
const now = new Date("2026-09-27T04:00:00Z");
it("allows completed morning AI work before the evening window but keeps unresolved work blocked", () => {
  const evening = new Date("2026-09-27T12:00:00Z");
  expect(() =>
    assertAgentScheduleClear(lane, [record()], evening, evening),
  ).not.toThrow();
  expect(() =>
    assertAgentScheduleClear(
      lane,
      [{ ...record(), status: "unknown" }],
      evening,
      evening,
    ),
  ).toThrow();
  expect(() =>
    assertAgentScheduleClear(
      lane,
      [{ ...record(), finishedAt: evening.toISOString() }],
      evening,
      evening,
    ),
  ).toThrow();
});
function record(): ExecutionRecord {
  return {
    version: 1,
    id: "agent-batch:a",
    fingerprint: "fixture",
    source: "single",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    laneId: lane.id,
    snapshot: {
      lane,
      agent: { requestId: "planner", planHash: "hash" },
      arknightsPlan: {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login", "award"],
      },
    },
    status: "succeeded",
    startedAt: "2026-09-27T03:00:00Z",
    finishedAt: "2026-09-27T03:20:00Z",
    message: "done",
  };
}
it("holds same-day automatic daily after custom actions without marking completion", () => {
  expect(() => assertAgentScheduleClear(lane, [record()], now)).toThrow(
    /本次 AI/,
  );
});
it("keeps future days and login-only checks eligible", () => {
  expect(() =>
    assertAgentScheduleClear(
      lane,
      [record()],
      new Date("2026-09-28T04:00:00Z"),
    ),
  ).not.toThrow();
  const login = record();
  (login.snapshot.arknightsPlan as { skillIds: string[] }).skillIds = ["login"];
  expect(() => assertAgentScheduleClear(lane, [login], now)).not.toThrow();
});
it("blocks unresolved interrupted batches across restart and game days", () => {
  const unknown = record();
  unknown.status = "unknown";
  expect(() =>
    assertAgentScheduleClear(lane, [unknown], new Date("2026-09-28T04:00:00Z")),
  ).toThrow();
});
it.each(["unknown", "cancelled"] as const)(
  "blocks an ordinary non-Agent %s daily before scheduler catch-up",
  (status) => {
    const ordinary = record();
    delete ordinary.snapshot.agent;
    ordinary.source = "daily";
    ordinary.status = status;
    expect(() => assertAgentScheduleClear(lane, [ordinary], now)).toThrow();
  },
);
it("does not alter regular daily behavior or an unrelated physical lane", () => {
  const normal = record();
  delete normal.snapshot.agent;
  expect(() => assertAgentScheduleClear(lane, [normal], now)).not.toThrow();
  const other = record();
  other.laneId = "other";
  const saved = {
    ...lane,
    id: "other",
    managerPath: "D:/Another/MuMuManager.exe",
    instance: 9,
  };
  other.snapshot.lane = saved;
  other.resources = [mumuResource(saved.managerPath, saved.instance)];
  expect(() => assertAgentScheduleClear(lane, [other], now)).not.toThrow();
});
it("saved daily completion uses the regular scheduler, while its unresolved admission stays blocked", () => {
  const saved = record();
  saved.source = "daily";
  saved.snapshot.agent = { requestId: "review", kind: "saved-daily" };
  delete saved.snapshot.arknightsPlan;
  saved.snapshot.onmyojiPlan = {
    gameId: "onmyoji",
    mode: "live",
    skillIds: ["login", "mail"],
  };
  expect(() => assertAgentScheduleClear(lane, [saved], now)).not.toThrow();
  saved.status = "unknown";
  expect(() => assertAgentScheduleClear(lane, [saved], now)).toThrow(
    /尚需核对/,
  );
});

function resolvedOnmyojiOnlyRecord(): ExecutionRecord {
  const request = record();
  request.status = "unknown";
  request.snapshot.agent = { requestId: "custom-goal", kind: "custom" };
  request.snapshot.lane = {
    ...structuredClone(lane),
    arknights: { ...lane.arknights, enabled: false },
    onmyoji: { ...lane.onmyoji, enabled: true },
  };
  delete request.snapshot.arknightsPlan;
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
  request.resolution = {
    action: "abandoned",
    at: "2026-09-27T03:30:00Z",
    note: "结束处理，保留原结果",
  };
  return request;
}

it("does not block the evening Ark schedule with explicitly resolved YYS-only work", () => {
  const request = resolvedOnmyojiOnlyRecord();
  const original = structuredClone(request);
  const evening = new Date("2026-09-27T12:00:00Z");
  expect(() =>
    assertAgentScheduleClear(lane, [request], evening, evening),
  ).not.toThrow();
  expect(request).toEqual(original);
  expect(request.status).toBe("unknown");
});

it("keeps unresolved YYS-only work blocked before any cross-game exemption", () => {
  const request = resolvedOnmyojiOnlyRecord();
  delete request.resolution;
  for (const at of ["2026-09-27T12:00:00Z", "2026-09-28T00:00:00Z"])
    expect(() =>
      assertAgentScheduleClear(lane, [request], new Date(at)),
    ).toThrow(/尚需核对/);
});

it.each([
  "missing-plan",
  "null-plan",
  "empty-skills",
  "unknown-skill",
  "duplicate-skills",
  "wrong-game",
  "invalid-mode",
  "rehearsal",
  "ark-plan",
  "null-ark-plan",
  "generic-plan",
  "null-generic-plan",
  "ark-enabled",
  "ark-unspecified",
  "yys-disabled",
  "missing-lane",
])("does not exempt resolved YYS work with %s frozen evidence", (kind) => {
  const request = resolvedOnmyojiOnlyRecord();
  const plan = request.snapshot.onmyojiPlan as Plan;
  const frozen = request.snapshot.lane as DeviceLane;
  switch (kind) {
    case "missing-plan":
      delete request.snapshot.onmyojiPlan;
      break;
    case "null-plan":
      request.snapshot.onmyojiPlan = null;
      break;
    case "empty-skills":
      plan.skillIds = [];
      break;
    case "unknown-skill":
      plan.skillIds = ["login", "unknown"];
      break;
    case "duplicate-skills":
      plan.skillIds = ["login", "login"];
      break;
    case "wrong-game":
      plan.gameId = "arknights";
      plan.skillIds = ["login", "award"];
      break;
    case "invalid-mode":
      request.snapshot.onmyojiPlan = { ...plan, mode: "invalid" };
      break;
    case "rehearsal":
      plan.mode = "rehearsal";
      break;
    case "ark-plan":
      request.snapshot.arknightsPlan = record().snapshot.arknightsPlan;
      break;
    case "null-ark-plan":
      request.snapshot.arknightsPlan = null;
      break;
    case "generic-plan":
      request.snapshot.plan = structuredClone(plan);
      break;
    case "null-generic-plan":
      request.snapshot.plan = null;
      break;
    case "ark-enabled":
      frozen.arknights.enabled = true;
      break;
    case "ark-unspecified":
      request.snapshot.lane = { ...frozen, arknights: undefined };
      break;
    case "yys-disabled":
      frozen.onmyoji.enabled = false;
      break;
    case "missing-lane":
      delete request.snapshot.lane;
      break;
  }
  expect(() => assertAgentScheduleClear(lane, [request], now)).toThrow(
    /避免重复/,
  );
});

it("does not exempt a YYS-only snapshot contradicted by an associated Ark task", () => {
  const request = resolvedOnmyojiOnlyRecord();
  const task: TaskRecord = {
    version: 1,
    runId: "contradictory-run",
    executionId: request.id,
    laneId: request.laneId,
    gameId: "arknights",
    plan: record().snapshot.arknightsPlan as Plan,
    startedAt: request.startedAt,
    updatedAt: request.finishedAt!,
    finishedAt: request.finishedAt,
    status: "unknown",
    message: "unknown",
    steps: [],
  };
  expect(() =>
    assertAgentScheduleClear(lane, [request], now, undefined, {
      tasks: [task],
      startupFacts: [],
    }),
  ).toThrow(/避免重复/);
  task.executionId = "unrelated-request";
  expect(() =>
    assertAgentScheduleClear(lane, [request], now, undefined, {
      tasks: [task],
      startupFacts: [],
    }),
  ).not.toThrow();
});

async function recoveredLogin(skills = ["login"]) {
  const s = startupRecoveryFixture(skills);
  if (skills.includes("fight")) {
    s.currentProfile.stage = "1-7";
    for (const request of s.records)
      (request.snapshot.profile as { stage: string }).stage = "1-7";
  }
  for (const request of s.records)
    request.snapshot.agent = { requestId: "original-goal", kind: "custom" };
  const preview = await s.continuation.preview(s.parent.id);
  expect(preview.canContinue).toBe(true);
  const launch = vi.fn(async () => {});
  const receipt = await s.continuation.start(
    {
      parentId: s.parent.id,
      fingerprint: preview.fingerprint,
      selections: preview.defaults,
      acknowledgePartial: true,
    },
    launch,
  );
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  const child = s.records.find((request) => request.id === receipt.requestId)!;
  child.status = "succeeded";
  child.finishedAt = "2026-10-08T12:26:44.000Z";
  s.tasks.push(s.succeeded(child));
  const check = () =>
    assertAgentScheduleClear(
      s.currentLane,
      s.records,
      new Date("2026-10-08T12:45:00.000Z"),
      new Date("2026-10-08T12:00:00.000Z"),
      { tasks: s.tasks, startupFacts: [] },
    );
  return { ...s, child, check };
}

it("admits the evening daily after the failed sibling's complete verified login continuation", async () => {
  const s = await recoveredLogin();
  const original = structuredClone(s.parent);
  expect(s.sibling.status).toBe("succeeded");
  expect(s.check).not.toThrow();
  expect(s.parent).toEqual(original);
  expect(s.parent.status).toBe("failed");
  expect(s.parent.resolution).toBeUndefined();
});
it.each([
  "forged",
  "missing-task",
  "native-unknown",
  "active",
  "branch",
  "late-parent-task",
  "future-completion",
])(
  "does not release an unresolved parent with %s continuation evidence",
  async (kind) => {
    const s = await recoveredLogin();
    if (kind === "forged")
      (
        s.child.snapshot.continuation as { parentFingerprint: string }
      ).parentFingerprint = "forged";
    else if (kind === "missing-task") s.tasks.pop();
    else if (kind === "native-unknown") {
      s.tasks.at(-1)!.steps[0].result = {
        arknights: {
          version: 1,
          taskType: "StartUp",
          taskId: 1,
          submission: "submitted",
          completion: "unknown",
          observedAt: s.child.finishedAt!,
        },
      };
    } else if (kind === "active") {
      s.child.status = "running";
      delete s.child.finishedAt;
    } else if (kind === "future-completion") {
      s.child.finishedAt = "2026-10-08T12:50:00.000Z";
      s.tasks[s.tasks.length - 1] = s.succeeded(s.child);
    } else if (kind === "branch")
      s.records.push({ ...structuredClone(s.child), id: "other:lane-b" });
    else s.tasks.push(s.succeeded(s.parent));
    expect(s.check).toThrow(/尚需核对/);
  },
);
it("preserves user disposition without treating abandonment or unrelated success as completed coverage", async () => {
  const s = await recoveredLogin();
  delete s.child.snapshot.continuation;
  expect(s.check).toThrow(/尚需核对/);
  s.parent.resolution = {
    action: "abandoned",
    at: "2026-10-08T12:30:00Z",
    note: "结束处理，原结果保留",
  };
  expect(completedContinuationRequestIds(s.records, s.tasks)).toEqual(
    new Set(),
  );
  expect(s.check).not.toThrow();
  expect(s.parent.status).toBe("failed");
});
it.each(["fight", "friends"])(
  "retains the daily overlap guard for a completed continuation containing %s",
  async (skill) => {
    const s = await recoveredLogin(["login", skill]);
    expect(s.check).toThrow(/避免重复/);
  },
);
it("keeps an incomplete original business scope blocked even if the selected child succeeded", async () => {
  const s = await recoveredLogin(["login", "award"]);
  (s.child.snapshot.arknightsPlan as Plan).skillIds = ["login"];
  s.tasks.at(-1)!.plan.skillIds = ["login"];
  s.tasks.at(-1)!.steps = s.tasks.at(-1)!.steps.slice(0, 1);
  expect(s.check).toThrow(/尚需核对/);
});
