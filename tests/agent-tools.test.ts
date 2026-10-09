import { expect, it } from "vitest";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";

const make = () => createAgentTools(createFixtureSnapshot());
it.each(["empty", "partial", "unassociated", "not-read"])(
  "keeps whole-day completion unknown for %s history",
  (kind) => {
    const snapshot = createFixtureSnapshot();
    snapshot.source = kind === "not-read" ? "configured" : "recorded";
    snapshot.historyAvailable = kind !== "not-read";
    if (kind === "empty" || kind === "not-read") {
      snapshot.requests = [];
      snapshot.tasks = [];
    }
    if (kind === "unassociated")
      snapshot.history = {
        unassociatedRequests: 12,
        incompleteRequests: [],
        scope: "bounded-ledger",
        identity: "not-verified",
      };
    expect(
      createAgentTools(snapshot).call("get_environment").historyAssessment,
    ).toEqual({
      scope: kind === "not-read" ? "not-read" : "bounded-ledger",
      dailyCompletion: "unknown",
      missingRecordMeans: "unknown",
      canInferNotRun: false,
      canAuthorizeReplay: false,
    });
  },
);
it("exposes the configured default skills when no custom routine is saved", () => {
  const snapshot = createFixtureSnapshot();
  snapshot.source = "configured";
  delete snapshot.lanes!.lanes[0].arknights.routine;
  snapshot.profiles!.profiles[0].recruit = true;
  const env = createAgentTools(snapshot).call("get_environment");
  expect(env.lanes[0].games.arknights).toMatchObject({
    routine: null,
    routineMode: "defaults",
    defaultSkillIds: [
      "login",
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ],
  });
  snapshot.profiles!.profiles[0].recruit = false;
  snapshot.lanes!.lanes[0].arknights.routine = {
    version: 1,
    steps: [{ skillId: "login", enabled: true }],
  };
  const changed = createAgentTools(snapshot).call("get_environment");
  expect(changed.lanes[0].games.arknights).toMatchObject({
    routineMode: "custom",
    routine: { steps: [{ skillId: "login", enabled: true }] },
  });
  expect(changed.lanes[0].games.arknights.defaultSkillIds).not.toContain(
    "recruit",
  );
});
function draft(tools = make()) {
  return {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at: "2026-09-28T08:00:00+08:00",
    lanes: ["lane-a", "lane-b"].map((laneId) => ({
      laneId,
      games: [
        { gameId: "arknights", parameters: { stage: "LS-6", mail: true } },
        { gameId: "onmyoji" },
      ],
    })),
  };
}

it("lists actual skills, truthful certification and the supported planning surface", () => {
  const catalog = make().call("list_capabilities");
  expect(catalog.complete).toBe(true);
  expect(catalog.games.map((g) => g.id)).toEqual(["onmyoji", "arknights"]);
  const ark = catalog.games.find((g) => g.id === "arknights")!;
  expect(ark.skills.some((s) => s.id === "mail")).toBe(false);
  expect(ark.skills.find((s) => s.id === "fight")).toMatchObject({
    draftSupported: true,
    verification: "registered-not-certified",
  });
  expect(ark.skills.find((s) => s.id === "copilot")?.draftSupported).toBe(
    false,
  );
});

it("compiles both lanes using existing routines, mail and native zero-refill policy without mutation", () => {
  const snapshot = createFixtureSnapshot();
  const original = structuredClone(snapshot);
  const tools = createAgentTools(snapshot);
  const input = draft(tools);
  const before = structuredClone(input);
  const result = tools.call("compile_plan", input);
  expect(result.status).toBe("valid");
  expect(result.canExecute).toBe(false);
  expect(result.lanes).toHaveLength(2);
  for (const lane of result.lanes) {
    expect(lane.games.map((g) => g.plan.gameId)).toEqual([
      "arknights",
      "onmyoji",
    ]);
    expect(lane.games[0].parameters).toMatchObject({
      stage: "LS-6",
      mail: true,
      medicine: 0,
      stone: 0,
      expiringMedicine: 0,
    });
    expect(lane.games[0].plan.skillIds).toContain("award");
    expect(lane.games[1].plan.skillIds.at(-1)).toBe("hana-claim");
  }
  expect(result.planHash).toMatch(/^[a-f0-9]{64}$/);
  expect(tools.call("compile_plan", input).planHash).toBe(result.planHash);
  expect(snapshot).toEqual(original);
  expect(input).toEqual(before);
});

it.each([
  { medicine: 1 },
  { stone: 1 },
  { expiringMedicine: 1 },
  { stage: "LS-6", shell: "adb shell input tap 1 1" },
  { mail: "true" },
  { stage: "" },
])("rejects unsupported or unsafe game parameters %j", (parameters) => {
  const tools = make();
  const input = draft(tools);
  input.lanes[0].games[0].parameters = parameters as never;
  expect(() => tools.call("compile_plan", input)).toThrow();
});

it("rejects unknown skills, duplicate lanes, wrong game order and unknown top-level keys", () => {
  const tools = make();
  for (const change of [
    (d: ReturnType<typeof draft>) => {
      Object.assign(d.lanes[0].games[0], { skillIds: ["mail"] });
    },
    (d: ReturnType<typeof draft>) => {
      Object.assign(d.lanes[0].games[0], { skillIds: ["copilot"] });
    },
    (d: ReturnType<typeof draft>) => {
      d.lanes[1].laneId = "lane-a";
    },
    (d: ReturnType<typeof draft>) => {
      d.lanes[0].games.reverse();
    },
    (d: ReturnType<typeof draft>) => {
      Object.assign(d, { approved: true });
    },
    (d: ReturnType<typeof draft>) => {
      d.at = "2026-09-28 08:00";
    },
  ]) {
    const input = draft(tools);
    change(input);
    expect(() => tools.call("compile_plan", input)).toThrow();
  }
});

it("applies Kirin weekday and hour rules and moves Hana to the end", () => {
  const tools = make();
  for (const [at, available] of [
    ["2026-09-28T08:00:00+08:00", true],
    ["2026-09-25T08:00:00+08:00", false],
    ["2026-09-28T05:59:00+08:00", false],
    ["2026-09-28T23:00:00+08:00", false],
  ] as const) {
    const input = {
      ...draft(tools),
      at,
      lanes: [
        {
          laneId: "lane-a",
          games: [
            {
              gameId: "onmyoji",
              skillIds: ["hana-claim", "guild-kirin", "mail"],
            },
          ],
        },
      ],
    };
    const result = tools.call("compile_plan", input);
    const ids = result.lanes[0].games[0].plan.skillIds;
    expect(ids[0]).toBe("login");
    expect(ids.at(-1)).toBe("hana-claim");
    expect(ids.includes("guild-kirin")).toBe(available);
    if (!available)
      expect(result.lanes[0].games[0].excluded).toContain("guild-kirin");
  }
});

it("blocks stale revisions and incomplete snapshots without returning a usable partial plan", () => {
  const snapshot = createFixtureSnapshot();
  const tools = createAgentTools(snapshot);
  for (const key of ["catalogRevision", "environmentRevision"] as const) {
    const input = draft(tools);
    input[key] = "old";
    expect(tools.call("compile_plan", input)).toMatchObject({
      status: "blocked",
      canExecute: false,
      lanes: [],
    });
  }
  snapshot.errors.push("记录读取不完整");
  const broken = createAgentTools(snapshot);
  expect(broken.call("get_environment").complete).toBe(false);
  expect(broken.call("compile_plan", draft(broken)).status).toBe("blocked");
  const incomplete = createAgentTools(createFixtureSnapshot(), {
    complete: false,
  });
  expect(incomplete.call("compile_plan", draft(incomplete)).status).toBe(
    "blocked",
  );
});

it("binds hashes to settings and flags missing identity rather than guessing an account", () => {
  const snapshot = createFixtureSnapshot();
  const tools = createAgentTools(snapshot);
  const input = draft(tools);
  const first = tools.call("compile_plan", input);
  snapshot.profiles!.profiles[0].expectedUid = "";
  const changed = createAgentTools(snapshot);
  const next = changed.call("compile_plan", draft(changed));
  expect(next.planHash).not.toBe(first.planHash);
  expect(next.preconditions.join(" ")).toContain("UID");
  snapshot.lanes!.lanes[0].arknights.profileId = "missing";
  const missing = createAgentTools(snapshot);
  expect(missing.call("compile_plan", draft(missing)).status).toBe("blocked");
});

it("reports recorded activity without claiming an emulator is online or presently idle", () => {
  const snapshot = createFixtureSnapshot();
  snapshot.requests[0].status = "running";
  const tools = createAgentTools(snapshot);
  const env = tools.call("get_environment");
  expect(env.source).toBe("fixture");
  expect(env.lanes[0]).toMatchObject({
    online: "not-probed",
    occupancy: "unknown",
  });
  expect(env.lanes[0].recordedRequests[0].status).toBe("running");
  expect(
    env.lanes[0].recordedRequests[0].progress.tasks[0].steps.some(
      (s) => s.status === "unknown",
    ),
  ).toBe(true);
  const serialized = JSON.stringify(env);
  expect(serialized).not.toContain(snapshot.lanes!.lanes[0].managerPath);
  expect(serialized).not.toContain(snapshot.profiles!.profiles[0].expectedUid);
});

it("bounds the environment history while keeping old runs addressable by ID", () => {
  const snapshot = createFixtureSnapshot();
  const original = snapshot.requests[0];
  snapshot.requests = Array.from({ length: 25 }, (_, i) => ({
    ...original,
    id: `test-${i}`,
    startedAt: new Date(
      Date.parse(original.startedAt) + i * 1000,
    ).toISOString(),
  }));
  const tools = createAgentTools(snapshot);
  const lane = tools.call("get_environment").lanes[0];
  expect(lane.recordedRequestCount).toBe(25);
  expect(lane.recordedRequests).toHaveLength(20);
  expect(lane.recordedRequests[0].id).toBe("test-24");
  expect(tools.call("get_run", { requestId: "test-0" }).complete).toBe(false);
});

it("retains unknown results and rejects mismatched task associations without exposing free-text diagnostics", () => {
  const snapshot = createFixtureSnapshot();
  const tools = createAgentTools(snapshot);
  const run = tools.call("get_run", { requestId: snapshot.requests[0].id });
  expect(run.recordedStatus).toBe("unknown");
  expect(run.inGameCompletion).toBe("not-verified");
  expect(run.tasks[0].steps.some((s) => s.status === "unknown")).toBe(true);
  expect(JSON.stringify(run)).not.toContain("PRIVATE");
  snapshot.tasks[0].laneId = "lane-b";
  const bad = createAgentTools(snapshot).call("get_run", {
    requestId: snapshot.requests[0].id,
  });
  expect(bad.tasks).toEqual([]);
  expect(bad.complete).toBe(false);
  expect(() => tools.call("get_run", { requestId: "not-found" })).toThrow();
  expect(() =>
    tools.call("get_environment", { refreshDevice: true }),
  ).toThrow();
});

it("marks missing expected games, changed instance or mismatched plans as incomplete evidence", () => {
  for (const change of [
    (s: ReturnType<typeof createFixtureSnapshot>) => {
      s.requests[0].snapshot.onmyojiPlan = {
        gameId: "onmyoji",
        mode: "live",
        skillIds: ["login"],
      };
    },
    (s: ReturnType<typeof createFixtureSnapshot>) => {
      s.tasks[0].instance = 999;
    },
    (s: ReturnType<typeof createFixtureSnapshot>) => {
      s.requests[0].snapshot.arknightsPlan = {
        gameId: "arknights",
        mode: "live",
        skillIds: ["login"],
      };
    },
  ]) {
    const s = createFixtureSnapshot();
    change(s);
    const result = createAgentTools(s).call("get_run", {
      requestId: s.requests[0].id,
    });
    expect(result.complete).toBe(false);
    expect(result.inGameCompletion).toBe("not-verified");
  }
});

it("does not silently compile ignored mail/stage options and rejects an impossible date", () => {
  const tools = make();
  for (const parameters of [{ mail: false }, { stage: "LS-6" }]) {
    const input = {
      ...draft(tools),
      lanes: [
        {
          laneId: "lane-a",
          games: [{ gameId: "arknights", skillIds: ["login"], parameters }],
        },
      ],
    };
    expect(() => tools.call("compile_plan", input)).toThrow();
  }
  expect(() =>
    tools.call("compile_plan", {
      ...draft(tools),
      at: "2026-02-30T08:00:00+08:00",
    }),
  ).toThrow();
});

it("filters unchecked evidence and step timestamps rather than returning private corrupt fields", () => {
  const snapshot = createFixtureSnapshot();
  snapshot.tasks[0].steps[0].evidence = {
    uid: "111111111",
    path: "D:/PRIVATE/example.png",
  } as never;
  snapshot.tasks[0].steps[0].startedAt = "PRIVATE diagnostic";
  snapshot.tasks[0].steps[0].finishedAt = { path: "PRIVATE" } as never;
  const result = createAgentTools(snapshot).call("get_run", {
    requestId: snapshot.requests[0].id,
  });
  expect(result.complete).toBe(false);
  expect(result.tasks[0].steps[0].evidence).toBeUndefined();
  expect(result.tasks[0].steps[0].startedAt).toBeUndefined();
  expect(result.tasks[0].steps[0].finishedAt).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(JSON.stringify(result)).not.toContain("111111111");
});

it("returns an actionable blocked draft when a selected fight lacks its saved stage", () => {
  const snapshot = createFixtureSnapshot();
  snapshot.profiles!.profiles[0].stage = "";
  const tools = createAgentTools(snapshot);
  const input = {
    ...draft(tools),
    lanes: [
      {
        laneId: "lane-a",
        games: [{ gameId: "arknights", skillIds: ["fight"] }],
      },
    ],
  };
  const result = tools.call("compile_plan", input);
  expect(result).toMatchObject({
    status: "blocked",
    lanes: [],
    canExecute: false,
  });
  expect(result.planHash).toBeUndefined();
  expect(result.reasons.join(" ")).toContain("关卡");
});

it("does not pass Date.parse-compatible comments through any evidence timestamp", () => {
  const snapshot = createFixtureSnapshot();
  const annotated = "2026-09-25 (PRIVATE 111111111 D:/PRIVATE/example.png)";
  expect(Number.isFinite(Date.parse(annotated))).toBe(true);
  snapshot.requests[0].finishedAt = annotated;
  snapshot.tasks[0].updatedAt = annotated;
  snapshot.tasks[0].steps[0].startedAt = annotated;
  snapshot.tasks[0].steps[0].result = {
    arknights: {
      version: 1,
      taskType: "StartUp",
      taskId: 1,
      submission: "submitted",
      completion: "native-confirmed",
      observedAt: annotated,
    },
  };
  const tools = createAgentTools(snapshot);
  const result = tools.call("get_run", { requestId: snapshot.requests[0].id });
  expect(result.complete).toBe(false);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(JSON.stringify(tools.call("get_environment"))).not.toContain(
    "PRIVATE",
  );
});
