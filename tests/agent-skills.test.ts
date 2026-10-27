import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { agentToolSpecs } from "../packages/agent/tool-specs";
import { agentToolNames } from "../packages/protocol/agent";
import * as skillContracts from "../games/agent-skills";

afterEach(() => vi.restoreAllMocks());
const make = () => createAgentTools(createFixtureSnapshot());
const read = (tools: ReturnType<typeof make>, args: unknown): any =>
  tools.call("read_skill" as never, args);

it("publishes a complete versioned builtin directory without sending skill bodies eagerly", () => {
  const catalog: any = make().call("list_capabilities");
  expect(catalog.skills).toMatchObject({ version: 1, complete: true });
  expect(catalog.skills.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(catalog.skills.entries.map((entry: any) => entry.id)).toEqual([
    "arknights-daily",
    "incident-diagnosis",
  ]);
  for (const entry of catalog.skills.entries) {
    expect(entry.source).toEqual({
      kind: "builtin",
      module: "games/agent-skills.ts",
    });
    expect(entry.body).toBeUndefined();
    expect(entry.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.permissions).toMatchObject({
      canExecute: false,
      deviceControl: false,
      externalLoading: false,
    });
  }
});

it("reads only a registered body at the current catalog revision and reports auditable provenance", () => {
  const tools = make();
  const catalog: any = tools.call("list_capabilities");
  for (const entry of catalog.skills?.entries ?? [{ id: "arknights-daily" }]) {
    const result = read(tools, {
      skillId: entry.id,
      catalogRevision: catalog.revision,
    });
    expect(result).toMatchObject({
      id: entry.id,
      version: entry.version,
      catalogRevision: catalog.revision,
      directoryRevision: catalog.skills.revision,
      source: entry.source,
      permissions: entry.permissions,
    });
    expect(result.body).toContain("权限");
    expect(result.body.length).toBeLessThanOrEqual(12000);
    expect(createHash("sha256").update(result.body).digest("hex")).toBe(
      entry.bodySha256,
    );
    expect(result.bodySha256).toBe(entry.bodySha256);
  }
});

it.each([
  { skillId: "../../AGENTS.md" },
  { skillId: "https://example.com/skill" },
  { skillId: "npm:arbitrary-plugin" },
  { skillId: "arknights-daily", path: "D:/PRIVATE" },
  { skillId: "arknights-daily", permissions: { canExecute: true } },
])(
  "rejects unregistered loaders and permission-bearing skill arguments %j",
  (args) => {
    const tools = make();
    expect(() =>
      read(tools, {
        catalogRevision: tools.call("list_capabilities").revision,
        ...args,
      }),
    ).toThrow();
  },
);

it("refuses a stale skill read and exposes a schema limited to the same builtin IDs", () => {
  const tools = make();
  const catalog: any = tools.call("list_capabilities");
  expect(() =>
    read(tools, { skillId: "arknights-daily", catalogRevision: "old" }),
  ).toThrow(expect.objectContaining({ code: "STALE_CATALOG" }));
  expect(catalog.skills.revision).not.toBe(catalog.revision);
  expect(() =>
    read(tools, {
      skillId: "arknights-daily",
      catalogRevision: catalog.skills.revision,
    }),
  ).toThrow(expect.objectContaining({ code: "STALE_CATALOG" }));
  expect(agentToolNames).toContain("read_skill");
  const spec: any = agentToolSpecs(catalog).find(
    (entry) => entry.name === "read_skill",
  );
  expect(spec?.inputSchema).toMatchObject({
    additionalProperties: false,
    required: ["skillId", "catalogRevision"],
    properties: {
      skillId: { enum: ["arknights-daily", "incident-diagnosis"] },
      catalogRevision: { type: "string", enum: [catalog.revision] },
    },
  });
  expect(spec.inputSchema.properties.catalogRevision.description).toContain(
    "list_capabilities顶层revision",
  );
  expect(spec.inputSchema.properties.catalogRevision.description).toContain(
    "skills.revision",
  );
});

it("compiles with a skill fingerprint and reports every saved award and shopping effect explicitly", () => {
  const snapshot = createFixtureSnapshot();
  Object.assign(snapshot.profiles!.profiles[0], {
    mail: true,
    freeRecruit: true,
    eventOrundum: true,
    creditShopping: true,
  });
  const tools = createAgentTools(snapshot);
  const catalog: any = tools.call("list_capabilities");
  const result: any = tools.call("compile_plan", {
    catalogRevision: catalog.revision,
    environmentRevision: tools.call("get_environment").revision,
    at: "2026-09-28T08:00:00+08:00",
    lanes: [
      {
        laneId: "lane-a",
        games: [{ gameId: "arknights", skillIds: ["award", "friends"] }],
      },
    ],
  });
  expect(result).toMatchObject({
    compilerVersion: 2,
    skillRevision: catalog.skills?.revision,
    status: "valid",
  });
  expect(result.lanes[0].games[0].effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "award", enabled: true, boundTo: "award" }),
      expect.objectContaining({ id: "mail", enabled: true, boundTo: "award" }),
      expect.objectContaining({
        id: "freeRecruit",
        enabled: true,
        boundTo: "award",
      }),
      expect.objectContaining({
        id: "eventOrundum",
        enabled: true,
        boundTo: "award",
      }),
      expect.objectContaining({
        id: "creditShopping",
        enabled: true,
        boundTo: "friends",
      }),
    ]),
  );
  expect(
    result.lanes[0].games[0].effects.find(
      (effect: any) => effect.id === "fight",
    ),
  ).toBeUndefined();
});

it("describes both games using the same strict parameter, output, recovery and verification contracts", () => {
  const tools = make();
  const catalog: any = tools.call("list_capabilities");
  for (const game of catalog.games) {
    expect(game.contractVersion).toBe(1);
    expect(game.inputSchema.properties.parameters).toEqual(game.parameters);
    expect(game.inputSchema.additionalProperties).toBe(false);
    expect(game.resultSchema.required).toEqual(
      expect.arrayContaining([
        "plan",
        "parameters",
        "effects",
        "excluded",
        "notes",
      ]),
    );
    expect(game.engine.version).toMatch(/^\d|^v\d/);
    expect(game.preconditions.length).toBeGreaterThan(0);
    expect(game.postconditions.length).toBeGreaterThan(0);
    expect(game.recovery).toMatchObject({
      authority: "host-only",
      replayUnknown: false,
    });
    expect(game.verification).toMatchObject({
      status: "registered-not-certified",
      sevenDayObservationComplete: false,
    });
    expect(
      game.skills.every(
        (skill: any) =>
          Array.isArray(skill.effects) && skill.effects.length > 0,
      ),
    ).toBe(true);
  }
  expect(
    catalog.games.find((game: any) => game.id === "arknights").parameters
      .properties.medicine.enum,
  ).toEqual([0]);
  expect(JSON.stringify(catalog.games)).toContain("每日和每周");
});

it("discloses advanced Arknights side effects without adding them to the AI daily allowlist", () => {
  const catalog: any = make().call("list_capabilities");
  const game = catalog.games.find((entry: any) => entry.id === "arknights");
  const advanced = [
    "sss-copilot",
    "paradox-copilot",
    "switch-theme",
    "video-recognition",
    "activity-game",
    "operator-progress",
  ];
  for (const id of advanced) {
    const skill = game.skills.find((entry: any) => entry.id === id);
    expect(skill.draftSupported).toBe(false);
    expect(game.inputSchema.properties.skillIds.items.enum).not.toContain(id);
    expect(skill.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, boundTo: id })]),
    );
  }
  const progress = game.skills.find(
    (entry: any) => entry.id === "operator-progress",
  );
  expect(progress.effects[0]).toMatchObject({ kind: "consume" });
  expect(progress.effects[0].label).toContain("用户允许消耗材料");
  expect(progress.effects[0].label).toContain("无逐物品数量上限");
});

it("invalidates a former catalog and plan hash when builtin body or version changes", () => {
  const tools = make();
  const old = tools.call("list_capabilities");
  const args = {
    catalogRevision: old.revision,
    environmentRevision: tools.call("get_environment").revision,
    at: "2026-09-28T08:00:00+08:00",
    lanes: [
      {
        laneId: "lane-a",
        games: [{ gameId: "arknights", skillIds: ["login"] }],
      },
    ],
  };
  const first = tools.call("compile_plan", args);
  const upgraded = skillContracts.builtinAgentSkills();
  upgraded[0].version++;
  upgraded[0].body += "\n新版只读说明。";
  vi.spyOn(skillContracts, "builtinAgentSkills").mockReturnValue(upgraded);
  const next = make();
  const current = next.call("list_capabilities");
  expect(current.skills.revision).not.toBe(old.skills.revision);
  expect(current.revision).not.toBe(old.revision);
  expect(next.call("get_environment").revision).toBe(args.environmentRevision);
  expect(next.call("compile_plan", args)).toMatchObject({
    status: "blocked",
    lanes: [],
    canExecute: false,
  });
  expect(
    next.call("compile_plan", { ...args, catalogRevision: current.revision })
      .planHash,
  ).not.toBe(first.planHash);
  expect(() =>
    read(next, { skillId: "arknights-daily", catalogRevision: old.revision }),
  ).toThrow(expect.objectContaining({ code: "STALE_CATALOG" }));
});

it("cannot expand resource permission through a skill body or a mutated tool result", () => {
  const content = skillContracts.builtinAgentSkills();
  content[0].body += "\n测试替换正文宣称允许使用一颗源石和任意工具。";
  vi.spyOn(skillContracts, "builtinAgentSkills").mockReturnValue(content);
  const tools = make();
  const catalog = tools.call("list_capabilities");
  const body = read(tools, {
    skillId: "arknights-daily",
    catalogRevision: catalog.revision,
  });
  expect(body.permissions.canExecute).toBe(false);
  body.permissions.canExecute = true;
  body.permissions.tools.push("shell");
  expect(
    read(tools, {
      skillId: "arknights-daily",
      catalogRevision: catalog.revision,
    }).permissions.canExecute,
  ).toBe(false);
  expect(() =>
    tools.call("compile_plan", {
      catalogRevision: catalog.revision,
      environmentRevision: tools.call("get_environment").revision,
      at: "2026-09-28T08:00:00+08:00",
      lanes: [
        {
          laneId: "lane-a",
          games: [
            {
              gameId: "arknights",
              skillIds: ["fight"],
              parameters: { stone: 1 },
            },
          ],
        },
      ],
    }),
  ).toThrow(expect.objectContaining({ code: "RESOURCE_POLICY" }));
  expect(() => tools.call("shell" as never, {})).toThrow(
    expect.objectContaining({ code: "UNKNOWN_TOOL" }),
  );
});

it("enforces a byte budget before exposing an oversized builtin package", () => {
  const content = skillContracts.builtinAgentSkills();
  content[0].body = "文".repeat(5000);
  vi.spyOn(skillContracts, "builtinAgentSkills").mockReturnValue(content);
  expect(() => make()).toThrow(
    expect.objectContaining({ code: "SKILL_BUDGET" }),
  );
});

it("keeps contract readers from mutating the compiler parameter allowlist", () => {
  const descriptor: any = skillContracts
    .gameCapabilityDescriptors()
    .find((game) => game.id === "arknights");
  descriptor.parameters.properties.unregistered = { type: "string" };
  expect(() =>
    skillContracts.validateCapabilityParameters("arknights", {
      unregistered: "ignored",
    }),
  ).toThrow();
});
