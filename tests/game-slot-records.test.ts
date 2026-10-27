import { describe, expect, it } from "vitest";
import type { DeviceLane, Plan, RunEvent } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { defaultArknightsProfiles } from "../games/arknights/config";
import { gameSlotRecords } from "../apps/desktop/renderer/game-slot-records";

const now = new Date("2026-10-25T04:30:00+08:00");
const at = "2026-10-24T12:00:00.000Z";
const profile = {
  ...defaultArknightsProfiles.profiles[0],
  expectedUid: "12345678",
};
const frozenProfile = { ...profile, recruit: false };
const loginRoutine = {
  version: 1 as const,
  steps: [{ skillId: "login", enabled: true }],
};
const lane: DeviceLane = {
  id: "lane-a",
  name: "账号一",
  managerPath: "D:/MuMu/manager.exe",
  instance: 0,
  enabled: true,
  closeEmulatorAfterSuccess: false,
  arknights: { enabled: true, profileId: profile.id, routine: loginRoutine },
  onmyoji: {
    enabled: true,
    routine: loginRoutine,
    identity: { roleId: "role-a", serverName: "一区" },
  },
};
const plan = (gameId: string): Plan => ({
  gameId,
  mode: "live",
  skillIds: ["login"],
});
function request(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    version: 1,
    id: "request-a",
    laneId: lane.id,
    batchId: "batch-a",
    source: "daily",
    resources: [],
    fingerprint: "test",
    status: "succeeded",
    startedAt: at,
    finishedAt: at,
    message: "请求已结束",
    snapshot: {
      lane: structuredClone(lane),
      profile: frozenProfile,
      arknightsPlan: plan("arknights"),
      onmyojiPlan: plan("onmyoji"),
    },
    ...overrides,
  };
}
function task(gameId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    executionId: "request-a",
    runId: `${gameId}-run`,
    laneId: lane.id,
    batchId: "batch-a",
    instance: 0,
    profileId: gameId === "arknights" ? profile.id : undefined,
    gameId,
    plan: plan(gameId),
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    status: "succeeded",
    message: "结构化步骤结束",
    steps: [
      {
        skillId: "login",
        status: "succeeded",
        message: "完成",
        diagnostics: [],
      },
    ],
    ...overrides,
  };
}
function select(
  gameId: "arknights" | "onmyoji",
  requests = [request()],
  tasks: TaskRecord[] = [],
  options: Partial<Parameters<typeof gameSlotRecords>[0]> = {},
) {
  return gameSlotRecords({
    lane,
    gameId,
    requests,
    tasks,
    now,
    profile,
    ...options,
  });
}

describe("game account slot evidence", () => {
  it("reads the original game's request and tasks after a channel ID migration without rewriting them", () => {
    const previous = {
      ...lane,
      instance: 2,
      arknights: { ...lane.arknights, enabled: false },
    };
    const migrated = {
      ...previous,
      id: "lane-a-onmyoji",
      legacyBinding: { laneId: "lane-a", instance: 2, scope: "old" },
    };
    const original = request({
      snapshot: {
        lane: previous,
        onmyojiPlan: plan("onmyoji"),
        gameSlot: { laneId: "lane-a", gameId: "onmyoji" },
      },
    });
    const record = task("onmyoji", { instance: 2 });
    const before = JSON.stringify([original, record]);
    const result = select("onmyoji", [original], [record], { lane: migrated });
    expect(result.requestId).toBe(original.id);
    expect(result.records).toEqual([record]);
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify([original, record])).toBe(before);
  });
  it("does not copy a mixed parent success into a game without task evidence", () => {
    const result = select("onmyoji", [request()], [task("arknights")]);
    expect(result.records).toEqual([]);
    expect(result.status).not.toBe("succeeded");
    expect(result.label).toContain("未验证");
  });
  it("keeps one game's unknown steps out of another game's successful record", () => {
    const ark = task("arknights", {
      status: "unknown",
      steps: [
        {
          skillId: "login",
          status: "unknown",
          message: "未确认",
          diagnostics: [],
        },
      ],
    });
    const yys = task("onmyoji");
    const receipts = [request({ status: "unknown" })];
    expect(select("onmyoji", receipts, [ark, yys])).toMatchObject({
      status: "succeeded",
      uncertain: false,
      records: [yys],
    });
    expect(select("arknights", receipts, [ark, yys])).toMatchObject({
      status: "unknown",
      uncertain: true,
      records: [ark],
    });
  });
  it("keeps a queued scoped request visible before its first task record", () => {
    const receipt = request({
      status: "running",
      finishedAt: undefined,
      snapshot: {
        lane,
        profile,
        arknightsPlan: plan("arknights"),
        gameSlot: { laneId: lane.id, gameId: "arknights" },
      },
    });
    expect(select("arknights", [receipt])).toMatchObject({
      active: true,
      status: "running",
      latestRequest: receipt,
      requestId: receipt.id,
    });
    expect(select("onmyoji", [receipt])).toMatchObject({
      active: false,
      status: null,
      latestRequest: undefined,
    });
  });
  it("finishes the first game while the mixed request continues in the other game", () => {
    const yys = task("onmyoji", {
      status: "running",
      finishedAt: undefined,
      steps: [
        {
          skillId: "login",
          status: "running",
          message: "运行",
          diagnostics: [],
        },
      ],
    });
    const receipts = [request({ status: "running", finishedAt: undefined })];
    expect(
      select("arknights", receipts, [task("arknights"), yys]),
    ).toMatchObject({ active: false, status: "succeeded" });
    expect(select("onmyoji", receipts, [task("arknights"), yys])).toMatchObject(
      {
        active: true,
        status: "running",
        currentStep: { gameId: "onmyoji", skillId: "login" },
      },
    );
  });
  it("never leaves a game running when its host request has already terminated", () => {
    const running = task("arknights", {
      status: "running",
      finishedAt: undefined,
    });
    expect(
      select("arknights", [request({ status: "unknown" })], [running]),
    ).toMatchObject({ active: false, status: "unknown", uncertain: true });
  });
  it("does not hide unknown or missing steps behind a succeeded task status", () => {
    const partial = task("onmyoji", {
      steps: [
        {
          skillId: "login",
          status: "pending",
          message: "等待",
          diagnostics: [],
        },
      ],
    });
    expect(select("onmyoji", [request()], [partial])).toMatchObject({
      status: "unknown",
      uncertain: true,
    });
  });
  it("rejects task evidence belonging to another lane, execution, batch or physical instance", () => {
    const records = [
      task("arknights", { laneId: "lane-b" }),
      task("arknights", { executionId: "request-b" }),
      task("arknights", { batchId: "batch-b" }),
      task("arknights", { instance: 2 }),
    ];
    expect(select("arknights", [request()], records).records).toEqual([]);
  });
  it("rejects ambiguous legacy correlation instead of choosing a same-batch account result", () => {
    const legacy = task("arknights", { executionId: undefined });
    expect(
      select("arknights", [request(), request({ id: "second" })], [legacy])
        .records,
    ).toEqual([]);
    expect(
      select(
        "arknights",
        [request(), request({ laneId: "lane-b" })],
        [task("arknights")],
      ).latestRequest,
    ).toBeUndefined();
  });
  it("rejects an opposite-game task attached to an explicitly single-game receipt", () => {
    const receipt = request({
      snapshot: {
        lane,
        profile: frozenProfile,
        arknightsPlan: plan("arknights"),
      },
    });
    expect(select("onmyoji", [receipt], [task("onmyoji")])).toMatchObject({
      latestRequest: undefined,
      records: [],
      status: null,
    });
  });
  it("does not choose one successful task from multiple game records for the same request", () => {
    const duplicate = task("arknights", { runId: "second-ark-run" });
    expect(
      select("arknights", [request()], [task("arknights"), duplicate]),
    ).toMatchObject({ status: "unknown", uncertain: true });
  });
  it("uses each game's reset boundary even when both games are enabled", () => {
    const receipts = [request({ startedAt: "2026-10-24T20:30:00.000Z" })];
    expect(select("arknights", receipts).currentGameDay).toBe("2026-10-25");
    expect(select("onmyoji", receipts).currentGameDay).toBe("2026-10-24");
    expect(select("arknights", receipts).gameDay).toBe("2026-10-25");
    expect(select("onmyoji", receipts).gameDay).toBe("2026-10-24");
  });
  it("compares the selected game binding without invalidating it when the other game changes", () => {
    const changed = { ...lane, onmyoji: { ...lane.onmyoji, enabled: false } };
    expect(
      select("arknights", [request()], [task("arknights")], { lane: changed })
        .currentPlanMatches,
    ).toBe(true);
  });
  it.each([
    { profile: { ...profile, expectedUid: "87654321" } },
    { profile: { ...profile, clientType: "Bilibili" as const } },
    { profile: undefined },
    { lane: { ...lane, deviceInstances: { arknights: 3 } } },
    {
      lane: {
        ...lane,
        arknights: {
          ...lane.arknights,
          routine: {
            version: 1 as const,
            steps: [{ skillId: "award", enabled: true }],
          },
        },
      },
    },
  ])(
    "does not certify the current plan after an account, instance or routine change: %j",
    (options) => {
      expect(
        select("arknights", [request()], [task("arknights")], options)
          .currentPlanMatches,
      ).toBe(false);
    },
  );
  it("does not certify an unbound or changed Onmyoji role from an Arknights profile", () => {
    const changed = {
      ...lane,
      onmyoji: {
        ...lane.onmyoji,
        identity: { roleId: "another-role", serverName: "一区" },
      },
    };
    expect(
      select("onmyoji", [request()], [task("onmyoji")], { lane: changed })
        .currentPlanMatches,
    ).toBe(false);
    expect(
      select("onmyoji", [request()], [task("onmyoji")], {
        lane: { ...lane, onmyoji: { enabled: true } },
      }).currentPlanMatches,
    ).toBe(false);
  });
  it("resolves the game-specific device override against the frozen instance", () => {
    const mapped = { ...lane, deviceInstances: { arknights: 2 } };
    const frozenLane = {
      ...lane,
      instance: 2,
      onmyoji: { ...lane.onmyoji, enabled: false },
    };
    const receipts = [
      request({
        snapshot: {
          lane: frozenLane,
          profile: frozenProfile,
          arknightsPlan: plan("arknights"),
        },
      }),
    ];
    expect(
      select("arknights", receipts, [task("arknights", { instance: 2 })], {
        lane: mapped,
      }),
    ).toMatchObject({ instance: 2, currentPlanMatches: true });
  });
  it("keeps continuation and maintenance sources separate from full daily results", () => {
    expect(
      select(
        "onmyoji",
        [
          request({
            snapshot: {
              ...request().snapshot,
              continuation: { parentId: "original" },
            },
          }),
        ],
        [task("onmyoji")],
      ).scope,
    ).toBe("continuation");
    expect(
      select("onmyoji", [request({ source: "maintenance" })], [task("onmyoji")])
        .scope,
    ).toBe("maintenance");
  });
  it("does not certify a different task selection as the current full saved daily plan", () => {
    const receipt = request({
      snapshot: {
        ...request().snapshot,
        arknightsPlan: { ...plan("arknights"), skillIds: ["login", "award"] },
      },
    });
    expect(select("arknights", [receipt]).currentPlanMatches).toBe(false);
  });
  it("shows older per-game records without treating them as today's completed plan", () => {
    const result = select("arknights", [request()], [task("arknights")]);
    expect(result.gameDay).toBe("2026-10-24");
    expect(result.currentGameDay).toBe("2026-10-25");
    expect(result.label).not.toContain("今日日常已完成");
    expect(result.requestId).toBe("request-a");
  });
  it("does not use log messages or another game's events to invent completion", () => {
    const events: RunEvent[] = [
      {
        runId: "log",
        laneId: lane.id,
        gameId: "arknights",
        batchId: "batch-a",
        type: "log",
        at,
        message: "两个游戏已全部完成",
      },
    ];
    expect(select("onmyoji", [request()], [], { events }).status).not.toBe(
      "succeeded",
    );
  });
});
