import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../packages/acceptance/files";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { readConfiguredSnapshot } from "../packages/agent/configured";
import { createAgentTools } from "../packages/agent/tools";
import type { PlannerViewState } from "../packages/protocol/agent-planner";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import { prepareAgentExecution } from "../apps/desktop/main/agent-execution-policy";
import { completedContinuationRequestIds } from "../games/continuation-history";
import {
  fightTasksFor,
  taskFor,
  type ArknightsConfig,
} from "../games/arknights/config";
import { compileGameDraft } from "../games/agent";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
const at = "2026-09-27T04:00:00.000Z";
const now = new Date("2026-09-27T04:01:00.000Z");
async function setup(
  skillIds = ["login", "fight", "award"],
  parameters: Record<string, unknown> = {},
  gameId = "arknights",
  identity?: { roleId: string; serverName: string },
  profileSettings: Partial<ArknightsConfig> = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "gp-agent-confirm-"));
  dirs.push(dir);
  const raw = createFixtureSnapshot();
  const lanes = raw.lanes!;
  const profiles = raw.profiles!;
  const oldIds = profiles.profiles.map((p) => p.id);
  profiles.profiles.forEach((p, i) => {
    Object.assign(p, structuredClone(profileSettings));
    p.id = `private-account-${i}`;
    p.name = `账号 ${i}`;
  });
  profiles.activeProfileId = profiles.profiles[0].id;
  lanes.lanes.forEach((l, i) => {
    l.id = `private-device-${i}`;
    l.name = `设备 ${i}`;
    l.managerPath = "D:/MuMu/MuMuManager.exe";
    l.arknights.profileId =
      profiles.profiles[oldIds.indexOf(l.arknights.profileId)].id;
    l.closeEmulatorAfterSuccess = true;
    if (identity) {
      l.identityRequired = true;
      l.onmyoji.identity = structuredClone(identity);
    }
  });
  await writeFile(join(dir, "device-lanes.json"), JSON.stringify(lanes));
  await writeFile(join(dir, "arknights.json"), JSON.stringify(profiles));
  const configured = await readConfiguredSnapshot(dir);
  const tools = createAgentTools(configured.snapshot);
  const draft = tools.call("compile_plan", {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at,
    lanes: configured.snapshot.lanes!.lanes.map((l) => ({
      laneId: l.id,
      games: [{ gameId, skillIds, parameters }],
    })),
  });
  expect(draft.status).toBe("valid");
  const state: PlannerViewState = {
    revision: 1,
    status: "completed",
    requestId: "planning-1",
    startedAt: at,
    source: "configured",
    result: {
      status: "draft",
      source: "configured",
      execution: "not-started",
      canExecute: false,
      draft,
      trace: [],
      modelText: "草稿",
      model: "test",
      codexVersion: "test",
      elapsedMs: 1,
    },
  };
  const context = {
    configured,
    lanes,
    profiles,
    requests: [] as ExecutionRecord[],
    tasks: [] as TaskRecord[],
  };
  return { state, context, draft };
}

it("freezes the reviewed zero-supply AI configuration instead of hidden saved expiring medicine or queues", async () => {
  const { state, context } = await setup(
    ["login", "fight"],
    {},
    "arknights",
    undefined,
    {
      taskOptions: {
        fight: { medicineExpireDays: 7, stages: ["LS-6", "1-7"] },
        mall: { creditFight: true },
      },
      extendedOptions: {
        operProgress: {
          allowMaterialConsumption: true,
          plans: [{ name: "芬", skillLevel: 2 }],
        },
      },
      copilotOptions: { useSanityPotion: true },
    },
  );
  const frozen = prepareAgentExecution(state, context, now);
  for (const snapshot of frozen) {
    const { id: _id, name: _name, ...config } = snapshot.profile!;
    const tasks = fightTasksFor(config);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].params).toMatchObject({
      medicine: 0,
      stone: 0,
      medicine_expire_days: 0,
      expiring_medicine: 0,
    });
    expect(taskFor("friends", config).params.credit_fight).toBe(false);
    expect(snapshot.profile?.extendedOptions).toBeUndefined();
    expect(snapshot.profile?.copilotOptions).toBeUndefined();
    expect(snapshot.arknightsPlan?.skillIds).toEqual(["login", "fight"]);
  }
  expect(
    context.profiles.profiles[0].taskOptions?.fight?.medicineExpireDays,
  ).toBe(7);
  expect(
    context.profiles.profiles[0].extendedOptions?.operProgress
      ?.allowMaterialConsumption,
  ).toBe(true);
});

it("compiles AI resource declarations from its safe projection even when passed the full saved profile", async () => {
  const { context } = await setup();
  const profile = context.profiles.profiles[0];
  profile.taskOptions = {
    fight: { medicine: 5, stone: 2, medicineExpireDays: 7 },
  };
  const compiled = compileGameDraft(
    { gameId: "arknights", skillIds: ["fight"] },
    context.lanes.lanes[0],
    profile,
    at,
  );
  expect(compiled.parameters).toMatchObject({
    medicine: 0,
    stone: 0,
    expiringMedicine: 0,
  });
  expect(profile.taskOptions.fight?.medicine).toBe(5);
});

it("freezes custom drafts on their game-specific physical devices", async () => {
  const { state, context } = await setup();
  context.lanes.lanes.forEach((lane, i) => {
    lane.deviceInstances = { arknights: i + 2, onmyoji: i + 4 };
  });
  const frozen = prepareAgentExecution(state, context, now);
  expect(frozen.map((item) => item.lane.instance)).toEqual([2, 3]);
  expect(frozen.every((item) => item.lane.deviceInstances === undefined)).toBe(
    true,
  );
});

it("admits a copied Onmyoji channel with its bound identity and rejects later identity changes", async () => {
  const identity = { roleId: "role-own-123", serverName: "测试区" };
  const { state, context } = await setup(
    ["login", "mail"],
    {},
    "onmyoji",
    identity,
  );
  const frozen = prepareAgentExecution(state, context, now);
  expect(frozen[0].lane.onmyoji.identity).toEqual(identity);
  context.lanes.lanes[0].onmyoji.identity!.roleId = "role-different";
  expect(() => prepareAgentExecution(state, context, now)).toThrow(
    /身份绑定已变化/,
  );
});

it("rejects physical collisions introduced by custom draft overrides", async () => {
  const { state, context } = await setup();
  context.lanes.lanes.forEach((lane) => {
    lane.deviceInstances = { arknights: 2 };
  });
  expect(() => prepareAgentExecution(state, context, now)).toThrow(
    /同一个模拟器/,
  );
});

it("freezes only account two Onmyoji mail without requiring a selected Arknights identity", async () => {
  const { state, context, draft } = await setup(
    ["login", "mail"],
    {},
    "onmyoji",
  );
  draft.lanes = [draft.lanes[1]];
  rehash(draft);
  context.lanes.lanes[1].arknights.enabled = false;
  context.profiles.profiles[1].expectedUid = "";
  const frozen = prepareAgentExecution(state, context, now);
  expect(frozen).toHaveLength(1);
  expect(frozen[0]).toMatchObject({
    lane: {
      id: context.lanes.lanes[1].id,
      instance: context.lanes.lanes[1].instance,
      arknights: { enabled: false },
      onmyoji: {
        enabled: true,
        routine: {
          steps: [
            { skillId: "login", enabled: true },
            { skillId: "mail", enabled: true },
          ],
        },
      },
    },
    onmyojiPlan: { gameId: "onmyoji", skillIds: ["login", "mail"] },
  });
  expect(frozen[0].arknightsPlan).toBeUndefined();
});

it("freezes a known closed custom Kirin selection as an explicit exclusion", async () => {
  const { state, context } = await setup(
    ["login", "guild-kirin"],
    {},
    "onmyoji",
  );
  const frozen = prepareAgentExecution(state, context, now);
  expect(frozen[0].onmyojiPlan?.skillIds).toEqual(["login"]);
  expect(frozen[0].exclusions).toEqual([
    {
      gameId: "onmyoji",
      skillIds: ["guild-kirin"],
      skipReason: "not-open",
      evidenceTimestamp: at,
      evidenceReference: "onmyoji:compiled-calendar-exclusion",
    },
  ]);
});
function rehash(
  draft: NonNullable<NonNullable<PlannerViewState["result"]>["draft"]>,
) {
  const { catalogRevision, environmentRevision, at, lanes } = draft;
  draft.planHash = createHash("sha256")
    .update(canonical({ catalogRevision, environmentRevision, at, lanes }))
    .digest("hex");
}
function history(
  context: Awaited<ReturnType<typeof setup>>["context"],
  status: ExecutionRecord["status"] = "succeeded",
): ExecutionRecord {
  const lane = context.lanes.lanes[0];
  return {
    version: 1,
    id: "prior",
    source: "daily",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    laneId: lane.id,
    snapshot: {
      lane: structuredClone(lane),
      arknightsPlan: {
        gameId: "arknights",
        skillIds: ["login", "fight"],
        mode: "live",
      },
    },
    fingerprint: "test",
    status,
    startedAt: at,
    finishedAt: at,
    message: "",
  };
}

async function completedRecovery() {
  const t = await setup(["login", "award"]);
  const lane = t.context.lanes.lanes[0],
    profile = { ...t.context.profiles.profiles[0], recruit: false };
  const plan = {
    gameId: "arknights",
    skillIds: ["login", "award"],
    mode: "live" as const,
  };
  const parent: ExecutionRecord = {
    ...history(t.context, "unknown"),
    id: "old:lane-a",
    batchId: "old",
    startedAt: "2026-09-26T04:00:00Z",
    finishedAt: "2026-09-26T04:01:00Z",
    snapshot: { lane: structuredClone(lane), profile, arknightsPlan: plan },
  };
  const child: ExecutionRecord = {
    ...structuredClone(parent),
    id: "child:lane-a",
    batchId: "child",
    status: "succeeded",
    fingerprint: "child-fingerprint",
    startedAt: "2026-09-26T04:02:00Z",
    finishedAt: "2026-09-26T04:03:00Z",
    snapshot: {
      ...structuredClone(parent.snapshot),
      continuation: {
        parentId: parent.id,
        parentFingerprint: parent.fingerprint,
        retained: [],
        excluded: [],
        acknowledgedPartial: true,
      },
    },
  };
  const task = (request: ExecutionRecord, completed: boolean): TaskRecord => ({
    version: 1,
    runId: `run-${request.id}`,
    executionId: request.id,
    batchId: request.batchId,
    laneId: lane.id,
    instance: lane.instance,
    profileId: profile.id,
    gameId: "arknights",
    plan,
    startedAt: request.startedAt,
    updatedAt: request.finishedAt!,
    finishedAt: request.finishedAt,
    status: completed ? "succeeded" : "failed",
    message: "record",
    steps: plan.skillIds.map((skillId, index) => ({
      skillId,
      status: completed ? "succeeded" : index === 0 ? "failed" : "not-run",
      diagnostics: [],
      message: "fact",
    })),
  });
  t.context.requests.push(parent, child);
  t.context.tasks.push(task(parent, false), task(child, true));
  return { ...t, parent, child };
}

it("admits next-day work after complete strict continuation coverage while preserving the original unknown record", async () => {
  const t = await completedRecovery(),
    before = structuredClone(t.context.requests);
  expect(
    completedContinuationRequestIds(t.context.requests, t.context.tasks).has(
      t.parent.id,
    ),
  ).toBe(true);
  expect(() => prepareAgentExecution(t.state, t.context, now)).not.toThrow();
  expect(t.context.requests).toEqual(before);
  expect(t.parent.status).toBe("unknown");
  expect(t.parent.resolution).toBeUndefined();
});

it("keeps missing or native-unconfirmed descendant evidence behind the unresolved history gate", async () => {
  const t = await completedRecovery();
  const last = t.context.tasks[1];
  last.steps[1].result = {
    arknights: {
      version: 1,
      taskType: "Award",
      submission: "submitted",
      completion: "unknown",
      observedAt: last.finishedAt!,
    },
  };
  expect(
    completedContinuationRequestIds(t.context.requests, t.context.tasks).size,
  ).toBe(0);
  expect(() => prepareAgentExecution(t.state, t.context, now)).toThrow(
    /未处置/,
  );
  t.context.tasks.pop();
  expect(() => prepareAgentExecution(t.state, t.context, now)).toThrow(
    /未处置/,
  );
});

it("retains the same-day business replay gate even for complete recovered coverage", async () => {
  const t = await completedRecovery();
  for (const request of t.context.requests) {
    request.startedAt = request.startedAt.replace("2026-09-26", "2026-09-27");
    request.finishedAt = request.finishedAt!.replace(
      "2026-09-26",
      "2026-09-27",
    );
  }
  for (const task of t.context.tasks) {
    task.startedAt = task.startedAt.replace("2026-09-26", "2026-09-27");
    task.finishedAt = task.finishedAt!.replace("2026-09-26", "2026-09-27");
    task.updatedAt = task.finishedAt;
  }
  expect(() =>
    prepareAgentExecution(t.state, t.context, new Date("2026-09-27T04:04:00Z")),
  ).toThrow(/本游戏日/);
});

it("maps sanitized aliases to private devices and profiles, freezing only the reviewed skills without mutating inputs", async () => {
  const { state, context, draft } = await setup(["login", "fight", "award"], {
    stage: "CE-6",
    mail: true,
  });
  const before = structuredClone({ state, context });
  const result = prepareAgentExecution(state, context, now);
  expect(result).toHaveLength(2);
  result.forEach((s, i) => {
    expect(s.lane.id).toBe(context.lanes.lanes[i].id);
    expect(s.lane.name).toBe(context.lanes.lanes[i].name);
    expect(s.profile).toMatchObject({
      id: context.profiles.profiles[i].id,
      expectedUid: context.profiles.profiles[i].expectedUid,
      stage: "CE-6",
      mail: true,
      recruit: false,
    });
    expect(s.lane.arknights.routine?.steps).toEqual(
      draft.lanes[i].games[0].plan.skillIds.map((skillId) => ({
        skillId,
        enabled: true,
      })),
    );
    expect(s.lane.onmyoji.enabled).toBe(false);
    expect(s.lane.closeEmulatorAfterSuccess).toBe(false);
    expect(s.onmyojiPlan).toBeUndefined();
    expect(s.startedAt).toBe(now.toISOString());
  });
  result[0].lane.name = "changed";
  result[0].profile!.expectedUid = "999999";
  expect({ state, context }).toEqual(before);
});

it.each([
  "running",
  "fixture",
  "blocked",
  "hash",
  "capability",
  "environment",
  "parameters",
  "rehearsal",
  "login",
  "unknown-skill",
  "game",
  "duplicate",
])("rejects an untrusted or altered draft: %s", async (change) => {
  const { state, context, draft } = await setup();
  if (change === "running") state.status = "running";
  if (change === "fixture") state.result!.source = "fixture";
  if (change === "blocked") draft.status = "blocked";
  if (change === "hash") draft.planHash = "0".repeat(64);
  if (change === "capability") draft.catalogRevision = "old";
  if (change === "environment") draft.environmentRevision = "old";
  if (change === "parameters")
    draft.lanes[0].games[0].parameters.maxRunMinutes = 1;
  if (change === "rehearsal") draft.lanes[0].games[0].plan.mode = "rehearsal";
  if (change === "login") draft.lanes[0].games[0].plan.skillIds.shift();
  if (change === "unknown-skill")
    draft.lanes[0].games[0].plan.skillIds.push("copilot");
  if (change === "game") draft.lanes[0].games[0].plan.gameId = "onmyoji";
  if (change === "duplicate") draft.lanes.push(structuredClone(draft.lanes[0]));
  if (!["hash"].includes(change)) rehash(draft);
  expect(() => prepareAgentExecution(state, context, now)).toThrow();
});

it.each([
  "uid",
  "unpinned",
  "disabled",
  "game-disabled",
  "instance",
  "binding",
  "profile-index",
])("rejects unsafe private configuration: %s", async (change) => {
  const { state, context } = await setup();
  const lane = context.lanes.lanes[0];
  if (change === "uid") context.profiles.profiles[0].expectedUid = "";
  if (change === "unpinned") lane.managerPath = "";
  if (change === "disabled") lane.enabled = false;
  if (change === "game-disabled") lane.arknights.enabled = false;
  if (change === "instance") lane.instance += 10;
  if (change === "binding")
    lane.arknights.profileId = context.profiles.profiles[1].id;
  if (change === "profile-index") context.profiles.profiles.reverse();
  expect(() => prepareAgentExecution(state, context, now)).toThrow();
});

it.each(["started", "draft", "future", "cross-day"])(
  "requires fresh timestamps in the same game day: %s",
  async (change) => {
    const { state, context, draft } = await setup();
    let clock = now;
    if (change === "started") state.startedAt = "2026-09-27T03:30:00.000Z";
    if (change === "draft") draft.at = "2026-09-27T03:30:00.000Z";
    if (change === "future") state.startedAt = "2026-09-27T04:03:00.000Z";
    if (change === "cross-day") {
      state.startedAt = draft.at = "2026-09-26T19:59:00.000Z";
      clock = new Date("2026-09-26T20:01:00.000Z");
    }
    rehash(draft);
    expect(() => prepareAgentExecution(state, context, clock)).toThrow();
  },
);

it.each(["running", "unknown", "failed", "cancelled"] as const)(
  "blocks unresolved %s physical resources even with another lane ID and old game day",
  async (status) => {
    const { state, context } = await setup(["login"]);
    const prior = history(context, status);
    prior.laneId = "former-device-name";
    prior.startedAt = "2026-09-20T04:00:00.000Z";
    context.requests.push(prior);
    expect(() => prepareAgentExecution(state, context, now)).toThrow();
  },
);

it("permits only a fresh login inspection with host executor-exit evidence, preserving uncertain history", async () => {
  const { state, context } = await setup(["login"]);
  const prior = history(context, "unknown");
  context.requests.push(prior);
  const before = JSON.stringify(context.requests);
  const startupInspection = {
    verified: true as const,
    observedAt: now.toISOString(),
    evidenceReference: `native-executor-exit:sha256:${"a".repeat(64)}`,
    resources: context.lanes.lanes.map((l) =>
      mumuResource(l.managerPath, l.instance),
    ),
  };
  expect(
    prepareAgentExecution(state, { ...context, startupInspection }, now),
  ).toHaveLength(2);
  expect(JSON.stringify(context.requests)).toBe(before);
});

it.each([
  "active-request",
  "active-orphan",
  "stale",
  "future",
  "wrong-resource",
  "wildcard",
  "bad-proof",
  "business",
  "onmyoji",
])("executor-exit proof never bypasses %s", async (change) => {
  const { state, context } = await setup(
    change === "business" ? ["login", "award"] : ["login"],
    {},
    change === "onmyoji" ? "onmyoji" : "arknights",
  );
  context.requests.push(
    history(context, change === "active-request" ? "running" : "unknown"),
  );
  const startupInspection = {
    verified: true as const,
    observedAt: now.toISOString(),
    evidenceReference: `native-executor-exit:sha256:${"a".repeat(64)}`,
    resources: context.lanes.lanes.map((l) =>
      mumuResource(l.managerPath, l.instance),
    ),
  };
  if (change === "active-orphan") {
    const task = createFixtureSnapshot().tasks[0];
    task.status = "running";
    task.laneId = context.lanes.lanes[0].id;
    task.executionId = "orphan";
    context.tasks.push(task);
  }
  if (change === "stale")
    startupInspection.observedAt = new Date(
      now.getTime() - 15_001,
    ).toISOString();
  if (change === "future")
    startupInspection.observedAt = new Date(now.getTime() + 1).toISOString();
  if (change === "wrong-resource")
    startupInspection.resources = ["mumu:D:/other.exe#0"];
  if (change === "wildcard") startupInspection.resources = ["*"];
  if (change === "bad-proof") startupInspection.evidenceReference = "true";
  expect(() =>
    prepareAgentExecution(state, { ...context, startupInspection }, now),
  ).toThrow();
});

it.each(["resource", "wildcard", "lane", "missing-plan", "resolved-failure"])(
  "blocks same-day repeated non-login work via %s",
  async (match) => {
    const { state, context } = await setup();
    const prior = history(context);
    if (match === "resource") prior.laneId = "old-lane";
    if (match === "wildcard") {
      prior.laneId = "old-lane";
      prior.resources = ["*"];
    }
    if (match === "lane") prior.resources = ["another-resource"];
    if (match === "missing-plan") prior.snapshot = {};
    if (match === "resolved-failure") {
      prior.status = "failed";
      prior.resolution = { action: "abandoned", at, note: "reviewed" };
    }
    context.requests.push(prior);
    expect(() => prepareAgentExecution(state, context, now)).toThrow();
  },
);

it("allows login-only inspection after a successful request and allows disjoint or previous-day skills", async () => {
  const login = await setup(["login"]);
  login.context.requests.push(history(login.context));
  expect(prepareAgentExecution(login.state, login.context, now)).toHaveLength(
    2,
  );
  const disjoint = await setup(["login", "award"]);
  disjoint.context.requests.push(history(disjoint.context));
  expect(
    prepareAgentExecution(disjoint.state, disjoint.context, now),
  ).toHaveLength(2);
  const old = await setup();
  const prior = history(old.context);
  prior.startedAt = prior.finishedAt = "2026-09-25T04:00:00.000Z";
  old.context.requests.push(prior);
  expect(prepareAgentExecution(old.state, old.context, now)).toHaveLength(2);
});

it("checks linked tasks even when the original request plan says login only", async () => {
  const { state, context } = await setup();
  const prior = history(context);
  (prior.snapshot.arknightsPlan as { skillIds: string[] }).skillIds = ["login"];
  context.requests.push(prior);
  const task = createFixtureSnapshot().tasks[0];
  task.executionId = prior.id;
  task.startedAt = task.updatedAt = at;
  task.plan.skillIds = ["login", "fight"];
  context.tasks.push(task);
  expect(() => prepareAgentExecution(state, context, now)).toThrow();
});

it("blocks orphan tasks conservatively by physical instance", async () => {
  const { state, context } = await setup();
  const task = createFixtureSnapshot().tasks[0];
  task.executionId = "lost-request";
  task.laneId = "old-alias";
  task.instance = context.lanes.lanes[0].instance;
  task.startedAt = task.updatedAt = at;
  task.plan.skillIds = ["login", "fight"];
  context.tasks.push(task);
  expect(() => prepareAgentExecution(state, context, now)).toThrow();
});

it.each(["medicine", "stone", "expiringMedicine", "freeRecruit"])(
  "rejects altered complete parameters even with a recomputed hash: %s",
  async (key) => {
    const { state, context, draft } = await setup();
    draft.lanes[0].games[0].parameters[key] =
      key === "freeRecruit" ? !draft.lanes[0].games[0].parameters[key] : 1;
    rehash(draft);
    expect(() => prepareAgentExecution(state, context, now)).toThrow();
  },
);

it("preserves device mapping when the selected draft lanes are reversed", async () => {
  const { state, context, draft } = await setup(["login"]);
  draft.lanes.reverse();
  rehash(draft);
  expect(
    prepareAgentExecution(state, context, now).map((s) => s.lane.id),
  ).toEqual(context.lanes.lanes.map((l) => l.id).reverse());
});

it("supports a recorded source using that source's environment revision", async () => {
  const { state, context, draft } = await setup(["login"]);
  state.source =
    state.result!.source =
    context.configured.snapshot.source =
      "recorded";
  context.configured.snapshot.historyAvailable = true;
  draft.environmentRevision = createAgentTools(
    context.configured.snapshot,
  ).call("get_environment").revision;
  rehash(draft);
  expect(prepareAgentExecution(state, context, now)).toHaveLength(2);
});

it("blocks uncertain task association rather than treating disjoint task skills as trustworthy", async () => {
  const { state, context } = await setup(["login", "award"]);
  const prior = history(context);
  context.requests.push(prior);
  const task = createFixtureSnapshot().tasks[0];
  task.executionId = prior.id;
  task.laneId = "unrelated-lane";
  task.instance = 99;
  task.status = "succeeded";
  task.startedAt = task.updatedAt = at;
  task.plan = {
    gameId: "arknights",
    skillIds: ["login", "fight"],
    mode: "live",
  };
  context.tasks.push(task);
  expect(() => prepareAgentExecution(state, context, now)).toThrow();
});

it("blocks requests whose original device snapshot collides despite stale resource metadata", async () => {
  const { state, context } = await setup();
  const prior = history(context);
  prior.laneId = "old-lane";
  prior.resources = ["stale-resource"];
  context.requests.push(prior);
  expect(() => prepareAgentExecution(state, context, now)).toThrow();
});

it("does not infer an old request finished before today's reset when completion time is missing", async () => {
  const { state, context } = await setup();
  const prior = history(context);
  prior.startedAt = "2026-09-26T19:59:00.000Z";
  delete prior.finishedAt;
  context.requests.push(prior);
  expect(() => prepareAgentExecution(state, context, now)).toThrow();
});
