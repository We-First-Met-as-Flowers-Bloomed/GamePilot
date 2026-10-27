import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AgentGoalPreferencesService } from "../apps/desktop/main/agent-goal-preferences";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { canonical } from "../packages/acceptance/files";
import { plannerProfile } from "../games/agent-configuration";
import type { AgentRuntimePrincipal } from "../packages/protocol/agent-runtime";
import { agentLaneAlias } from "../packages/protocol/lane-alias";
import { createGameGoalTools } from "../packages/agent/game-tools";
const principal = (prompt: string): AgentRuntimePrincipal => ({
  sessionId: "chat-a",
  turnId: "turn-a",
  prompt,
});

function setup(count = 2) {
  const fixture = createFixtureSnapshot();
  let lanes = structuredClone(fixture.lanes!);
  let profiles = structuredClone(fixture.profiles!);
  if (count !== 2) {
    lanes.lanes = Array.from({ length: count }, (_, index) => ({ ...structuredClone(lanes.lanes[0]), instance: index }));
    profiles.profiles = Array.from({ length: count }, () => structuredClone(profiles.profiles[0]));
  }
  lanes.lanes.forEach((lane, index) => {
    lane.id = `private-${index}`;
    lane.name = `private account ${index}`;
    lane.managerPath = "D:/MuMu/MuMuManager.exe";
    lane.arknights.profileId = `private-profile-${index}`;
  });
  profiles.profiles.forEach((profile, index) => {
    profile.id = `private-profile-${index}`;
    profile.name = `private profile ${index}`;
  });
  profiles.activeProfileId = profiles.profiles[0].id;
  const configured = () => ({
    fingerprint: createHash("sha256")
      .update(canonical({ lanes, profiles }))
      .digest("hex"),
    snapshot: {
      ...fixture,
      source: "configured" as const,
      profiles: {
        ...profiles,
        activeProfileId: "profile-1",
        profiles: profiles.profiles.map((profile, index) =>
          plannerProfile(profile, `profile-${index + 1}`),
        ),
      },
      lanes: {
        ...lanes,
        lanes: lanes.lanes.map((lane, index) => ({
          ...structuredClone(lane),
          id: agentLaneAlias(index),
          name: `槽位 ${index + 1}`,
          managerPath: "",
          arknights: {
            ...lane.arknights,
            profileId: `profile-${profiles.profiles.findIndex((profile) => profile.id === lane.arknights.profileId) + 1}`,
          },
        })),
      },
    },
  });
  const readConfigured = vi.fn(async () => structuredClone(configured()));
  const readLanes = vi.fn(async () => structuredClone(lanes));
  const readProfiles = vi.fn(async () => structuredClone(profiles));
  const saveLanes = vi.fn(async (value: typeof lanes) => {
    lanes = structuredClone(value);
  });
  const saveProfiles = vi.fn(async (value: typeof profiles) => {
    profiles = structuredClone(value);
  });
  const assertCurrent = vi.fn(async (_principal: AgentRuntimePrincipal) => {});
  return {
    service: new AgentGoalPreferencesService({
      readConfigured,
      readLanes,
      readProfiles,
      saveLanes,
      saveProfiles,
      assertCurrent,
    }),
    readConfigured,
    readLanes,
    readProfiles,
    saveLanes,
    saveProfiles,
    assertCurrent,
    revision: () =>
      createAgentTools(configured().snapshot).call("get_environment").revision,
    lanes: () => lanes,
    profiles: () => profiles,
  };
}

it.each([27, 64])("saves explicit preferences for %i public channel aliases", async (count) => {
  const t = setup(count);
  const laneIds = Array.from({ length: count }, (_, index) => agentLaneAlias(index));
  const result = await t.service.save({ environmentRevision: t.revision(), laneIds, gameId: "onmyoji", skillIds: ["mail"] });
  expect(result.changedLaneIds).toEqual(laneIds);
  const tools = createGameGoalTools({ principal: principal("以后所有账号阴阳师只领邮件"), source: "configured", host: {} as never });
  const spec: any = tools.specs.find((tool) => tool.name === "save_daily_preference");
  expect(spec.inputSchema.properties.laneIds.maxItems).toBe(64);
});

it("saves a selected public account's Onmyoji routine flags while preserving order, weekdays, identity and other accounts", async () => {
  const t = setup();
  t.lanes().lanes[1].onmyoji.routine = {
    version: 1,
    steps: [
      { skillId: "login", enabled: true },
      { skillId: "guild-kirin", enabled: true, weekdays: [1, 2] },
      { skillId: "mail", enabled: true },
      { skillId: "hana-claim", enabled: true },
    ],
  };
  const before = structuredClone({ lanes: t.lanes(), profiles: t.profiles() });
  const result = await t.service.save({
    environmentRevision: t.revision(),
    laneIds: ["lane-b"],
    gameId: "onmyoji",
    skillIds: ["mail", "guild-kirin"],
  });
  expect(result).toMatchObject({ changedLaneIds: ["lane-b"] });
  expect(t.lanes().lanes[1].onmyoji.routine?.steps).toEqual([
    { skillId: "login", enabled: true },
    { skillId: "guild-kirin", enabled: true, weekdays: [1, 2] },
    { skillId: "mail", enabled: true },
    { skillId: "hana-claim", enabled: false },
  ]);
  expect(t.lanes().lanes[0]).toEqual(before.lanes.lanes[0]);
  expect({
    ...t.lanes().lanes[1],
    onmyoji: before.lanes.lanes[1].onmyoji,
  }).toEqual(before.lanes.lanes[1]);
  expect(t.profiles()).toEqual(before.profiles);
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it("rejects expired environment aliases and a changed private fingerprint before writing", async () => {
  const t = setup();
  await expect(
    t.service.save({
      environmentRevision: "stale",
      laneIds: ["lane-b"],
      gameId: "onmyoji",
      skillIds: ["mail"],
    }),
  ).rejects.toThrow();
  const revision = t.revision();
  const originalRead = t.readConfigured.getMockImplementation()!;
  let calls = 0;
  t.readConfigured.mockImplementation(async () => {
    const value = await originalRead();
    return calls++ === 0 ? value : { ...value, fingerprint: "changed" };
  });
  await expect(
    t.service.save({
      environmentRevision: revision,
      laneIds: ["lane-b"],
      gameId: "onmyoji",
      skillIds: ["mail"],
    }),
  ).rejects.toThrow();
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it("rejects shopping changes that would affect an unselected lane sharing the profile", async () => {
  const t = setup();
  t.lanes().lanes[1].arknights.profileId =
    t.lanes().lanes[0].arknights.profileId;
  await expect(
    t.service.save({
      environmentRevision: t.revision(),
      laneIds: ["lane-a"],
      gameId: "arknights",
      skillIds: ["friends"],
      shopping: false,
    }),
  ).rejects.toThrow(/共享/);
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it("changes only the selected shopping switch with validated routine flags", async () => {
  const t = setup();
  t.profiles().profiles[1].creditShopping = true;
  const before = structuredClone(t.profiles());
  await t.service.save({
    environmentRevision: t.revision(),
    laneIds: ["lane-b"],
    gameId: "arknights",
    skillIds: ["friends"],
    shopping: false,
  });
  expect(t.profiles().profiles[1]).toEqual({
    ...before.profiles[1],
    creditShopping: false,
  });
  expect(t.profiles().profiles[0]).toEqual(before.profiles[0]);
});

it("reports a failed second write as unknown partial persistence and requires a fresh revision", async () => {
  const t = setup();
  t.profiles().profiles[1].creditShopping = true;
  const revision = t.revision();
  t.saveLanes.mockRejectedValueOnce(new Error("disk write failed"));
  await expect(
    t.service.save({
      environmentRevision: revision,
      laneIds: ["lane-b"],
      gameId: "arknights",
      skillIds: ["friends"],
      shopping: false,
    }),
  ).rejects.toThrow(/部分配置/);
  expect(t.profiles().profiles[1].creditShopping).toBe(false);
  await expect(
    t.service.save({
      environmentRevision: revision,
      laneIds: ["lane-b"],
      gameId: "arknights",
      skillIds: ["friends"],
      shopping: false,
    }),
  ).rejects.toThrow(/当前本地环境版本/);
  expect(t.saveProfiles).toHaveBeenCalledOnce();
});

it("reports a lost first-write receipt as unknown rather than claiming no configuration was saved", async () => {
  const t = setup();
  t.profiles().profiles[1].creditShopping = true;
  const originalSave = t.saveProfiles.getMockImplementation()!;
  t.saveProfiles.mockImplementationOnce(async (value) => {
    await originalSave(value);
    throw new Error("lost receipt");
  });
  await expect(
    t.service.save({
      environmentRevision: t.revision(),
      laneIds: ["lane-b"],
      gameId: "arknights",
      skillIds: ["friends"],
      shopping: false,
    }),
  ).rejects.toThrow(/部分配置/);
  expect(t.saveLanes).not.toHaveBeenCalled();
});

it.each(["foster", "copilot", "guild-quest"])(
  "does not newly enable unapproved maintenance, custom engine actions or guild collective spending: %s",
  async (skillId) => {
    const t = setup();
    t.lanes().lanes[1].onmyoji.routine = {
      version: 1,
      steps: [
        { skillId: "login", enabled: true },
        { skillId: "mail", enabled: true },
        { skillId: "guild-quest", enabled: false },
      ],
    };
    await expect(
      t.service.save({
        environmentRevision: t.revision(),
        laneIds: ["lane-b"],
        gameId: "onmyoji",
        skillIds: [skillId],
      }),
    ).rejects.toThrow();
    expect(t.saveLanes).not.toHaveBeenCalled();
  },
);

it("binds future Onmyoji mail preferences to the actual second account and preserves identity", async () => {
  const t = setup(),
    before = structuredClone({ lanes: t.lanes(), profiles: t.profiles() });
  await t.service.save(
    {
      environmentRevision: t.revision(),
      laneIds: ["lane-b"],
      gameId: "onmyoji",
      skillIds: ["mail"],
    },
    principal("以后只给账号二领取阴阳师邮件"),
  );
  expect(
    t
      .lanes()
      .lanes[1].onmyoji.routine?.steps.filter((step) => step.enabled)
      .map((step) => step.skillId),
  ).toEqual(["login", "mail"]);
  expect(t.lanes().lanes[0]).toEqual(before.lanes.lanes[0]);
  expect(t.profiles()).toEqual(before.profiles);
});

it.each([
  { laneIds: ["lane-a"], gameId: "onmyoji", skillIds: ["mail"] },
  { laneIds: ["lane-a", "lane-b"], gameId: "onmyoji", skillIds: ["mail"] },
  { laneIds: ["lane-b"], gameId: "arknights", skillIds: ["friends"] },
  { laneIds: ["lane-b"], gameId: "onmyoji", skillIds: ["mail", "hana-claim"] },
])("rejects model-broadened persistent selection %j", async (selection) => {
  const t = setup();
  await expect(
    t.service.save(
      { environmentRevision: t.revision(), ...selection },
      principal("以后只给账号二领取阴阳师邮件"),
    ),
  ).rejects.toThrow();
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it.each([
  "以后默认只领阴阳师邮件可以吗？",
  "以后可以给账号二默认只领阴阳师邮件吗",
  "不要求你修改以后设置，只查询账号二阴阳师邮件",
  "以后不要设置账号二阴阳师邮件",
  "以后默认账号二阴阳师邮件怎么设置",
])("does not persist from an inquiry or denied change: %s", async (prompt) => {
  const t = setup();
  await expect(
    t.service.save(
      {
        environmentRevision: t.revision(),
        laneIds: ["lane-b"],
        gameId: "onmyoji",
        skillIds: ["mail"],
      },
      principal(prompt),
    ),
  ).rejects.toMatchObject({ code: "MESSAGE_NOT_AUTHORIZED" });
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it("rejects shopping=true when the actual future instruction forbids shopping", async () => {
  const t = setup();
  await expect(
    t.service.save(
      {
        environmentRevision: t.revision(),
        laneIds: ["lane-b"],
        gameId: "arknights",
        skillIds: ["friends"],
        shopping: true,
      },
      principal("以后账号二收取明日方舟信用，不购物"),
    ),
  ).rejects.toThrow();
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it("persists mail-only native flags within the exact requested Arknights account", async () => {
  const t = setup(),
    before = structuredClone(t.profiles());
  await t.service.save(
    {
      environmentRevision: t.revision(),
      laneIds: ["lane-b"],
      gameId: "arknights",
      skillIds: ["award"],
      parameters: {
        mail: true,
        taskAward: false,
        freeRecruit: false,
        eventOrundum: false,
        eventMining: false,
        specialAccess: false,
        signInEvent: false,
      },
    },
    principal("以后只给第二个账号领取明日方舟邮件"),
  );
  expect(t.profiles().profiles[1]).toEqual({
    ...before.profiles[1],
    taskAward: false,
  });
  expect(t.profiles().profiles[0]).toEqual(before.profiles[0]);
  expect(
    t
      .lanes()
      .lanes[1].arknights.routine?.steps.filter((step) => step.enabled)
      .map((step) => step.skillId),
  ).toEqual(["login", "award"]);
});

it("rejects an unresolved mail-only bundle and shared-profile award flag side effects", async () => {
  const t = setup();
  const input = {
    environmentRevision: t.revision(),
    laneIds: ["lane-b"],
    gameId: "arknights",
    skillIds: ["award"],
  };
  await expect(
    t.service.save(input, principal("以后只给账号二领取明日方舟邮件")),
  ).rejects.toThrow();
  t.lanes().lanes[0].arknights.profileId =
    t.lanes().lanes[1].arknights.profileId;
  await expect(
    t.service.save(
      {
        ...input,
        environmentRevision: t.revision(),
        parameters: { mail: true, taskAward: false },
      },
      principal("以后只给账号二领取明日方舟邮件"),
    ),
  ).rejects.toThrow(/共享/);
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it.each([
  { expectedUid: "999999999" },
  { medicine: 1 },
  { mail: "true" },
  { creditShopping: true },
])(
  "rejects parameters outside the bounded reward flags: %j",
  async (parameters) => {
    const t = setup();
    await expect(
      t.service.save(
        {
          environmentRevision: t.revision(),
          laneIds: ["lane-b"],
          gameId: "arknights",
          skillIds: ["award"],
          parameters,
        },
        principal("以后只给账号二领取明日方舟邮件"),
      ),
    ).rejects.toThrow();
    expect(t.saveLanes).not.toHaveBeenCalled();
    expect(t.saveProfiles).not.toHaveBeenCalled();
  },
);

it("rechecks the host turn after configuration reads and rejects a stale turn before persistence", async () => {
  const t = setup();
  t.assertCurrent
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("turn changed"));
  await expect(
    t.service.save(
      {
        environmentRevision: t.revision(),
        laneIds: ["lane-b"],
        gameId: "onmyoji",
        skillIds: ["mail"],
      },
      principal("以后只给账号二领取阴阳师邮件"),
    ),
  ).rejects.toThrow(/turn changed/);
  expect(t.assertCurrent).toHaveBeenCalledTimes(2);
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});

it("a shopping-only preference preserves the original routine and cannot carry an invented task subset", async () => {
  const t = setup();
  t.lanes().lanes[1].arknights.routine = {
    version: 1,
    steps: ["login", "fight", "friends", "award"].map((skillId) => ({
      skillId,
      enabled: true,
    })),
  };
  t.profiles().profiles[1].creditShopping = true;
  const routine = structuredClone(t.lanes().lanes[1].arknights.routine);
  const p = principal("以后账号二不购物");
  await expect(
    t.service.save(
      {
        environmentRevision: t.revision(),
        laneIds: ["lane-b"],
        gameId: "arknights",
        skillIds: ["friends"],
        shopping: false,
      },
      p,
    ),
  ).rejects.toThrow();
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
  await t.service.save(
    {
      environmentRevision: t.revision(),
      laneIds: ["lane-b"],
      gameId: "arknights",
      skillIds: ["fight", "friends", "award"],
      shopping: false,
    },
    p,
  );
  expect(t.lanes().lanes[1].arknights.routine).toEqual(routine);
  expect(t.profiles().profiles[1].creditShopping).toBe(false);
  expect(t.saveLanes).not.toHaveBeenCalled();
});

it("cannot save a task-reward preference with the actual task reward action disabled", async () => {
  const t = setup();
  await expect(
    t.service.save(
      {
        environmentRevision: t.revision(),
        laneIds: ["lane-b"],
        gameId: "arknights",
        skillIds: ["award"],
        parameters: { mail: false, taskAward: false },
      },
      principal("以后只给账号二领取明日方舟任务奖励"),
    ),
  ).rejects.toThrow();
  expect(t.saveLanes).not.toHaveBeenCalled();
  expect(t.saveProfiles).not.toHaveBeenCalled();
});
