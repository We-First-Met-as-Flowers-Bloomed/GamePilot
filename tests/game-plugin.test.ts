import { expect, it } from "vitest";
import {
  createTrustedGameRegistry,
  type GamePlugin,
  type GameWorkerAdapter,
} from "../games/plugin";
import { gamePlugins } from "../games/registry";
import { validateGameOrder } from "../games/agent";
import { executeRegisteredLanePlan } from "../apps/desktop/main/lane-plan";

it("orders three trusted plugins and executes their registered lane actions", async () => {
  const builtins = gamePlugins.list();
  const third: GamePlugin = {
    ...gamePlugins.get("onmyoji"),
    descriptor: {
      ...gamePlugins.get("onmyoji").descriptor,
      id: "third-fixture",
    },
    order: 30,
    lane: {
      ...gamePlugins.get("onmyoji").lane!,
      actionKey: "third",
      enabled: () => true,
    },
  };
  const registry = createTrustedGameRegistry([...builtins, third]);
  expect(() =>
    validateGameOrder(
      [
        { gameId: "arknights" },
        { gameId: "onmyoji" },
        { gameId: "third-fixture" },
      ],
      registry,
    ),
  ).not.toThrow();
  expect(() =>
    validateGameOrder(
      [{ gameId: "third-fixture" }, { gameId: "arknights" }],
      registry,
    ),
  ).toThrow("顺序");
  const calls: string[] = [];
  const lane = {
    arknights: { enabled: true },
    onmyoji: { enabled: true },
  } as never;
  const actions = Object.fromEntries(
    ["prepare", "arknights", "closeArknights", "onmyoji", "third"].map(
      (key) => [
        key,
        async () => {
          calls.push(key);
        },
      ],
    ),
  );
  const result = await executeRegisteredLanePlan(lane, registry, actions);
  expect(calls).toEqual([
    "prepare",
    "arknights",
    "closeArknights",
    "onmyoji",
    "third",
  ]);
  expect(result.third).toBe("succeeded");
  expect(() =>
    createTrustedGameRegistry([
      ...builtins,
      { ...third, order: builtins[0].order },
    ]),
  ).toThrow("顺序");
});

it("runs a trusted synthetic registration through compile, adapter, outcome, day and recovery without platform dispatch edits", async () => {
  const descriptor = {
    id: "test-only",
    name: "Synthetic",
    subtitle: "fixture only",
    skills: [
      { id: "probe", title: "probe", description: "fixture", ready: false },
    ],
  };
  const base = gamePlugins.get("onmyoji");
  const plugin: GamePlugin = {
    ...base,
    descriptor,
    adapterId: "synthetic",
    dailySkills: ["probe"],
    compile: () => ({
      plan: { gameId: descriptor.id, skillIds: ["probe"], mode: "rehearsal" },
      parameters: {},
      excluded: [],
      notes: ["synthetic, not certified"],
    }),
    capabilities: () => ({
      ...base.capabilities(),
      id: descriptor.id,
      name: descriptor.name,
    }),
    gameDay: () => "fixture-day",
    outcome: (step) => ({
      skillId: step.skillId,
      status: step.status,
      goalSatisfied: null,
      summary: "rehearsal",
    }),
    recovery: {
      classify: () => "unknown",
      replayBlockers: () => [],
      retainedStep: () => false,
      allowRetry: () => false,
      propose: () => undefined,
    },
  };
  const registry = createTrustedGameRegistry([plugin]);
  const adapter: GameWorkerAdapter = {
    validate: () => {},
    run: async () => ({ status: "succeeded", summary: "fixture observation" }),
  };
  expect(registry.descriptors().map((game) => game.id)).toEqual(["test-only"]);
  expect(registry.capabilities()[0].verification.status).toBe(
    "registered-not-certified",
  );
  const plan = registry
    .get("test-only")
    .compile(
      { gameId: "test-only" },
      {} as never,
      undefined,
      "2026-10-05T04:00:00Z",
    ).plan;
  expect(
    await registry.run(
      plan,
      "probe",
      { adapters: { synthetic: adapter } },
      new AbortController().signal,
      () => {},
    ),
  ).toMatchObject({ summary: "fixture observation" });
  expect(registry.get("test-only").gameDay(new Date())).toBe("fixture-day");
  expect(
    registry.get("test-only").recovery.allowRetry({} as never, "unknown", 0),
  ).toBe(false);
  expect(() => registry.get("untrusted-file")).toThrow(/未注册/);
  expect(() =>
    registry.validate(
      { ...plan, mode: "live" },
      { adapters: { synthetic: adapter } },
    ),
  ).toThrow(/尚未/);
});

it("selects built-in worker adapters by trusted descriptor rather than game-name conditionals", async () => {
  const called: string[] = [];
  const adapter = (name: string): GameWorkerAdapter => ({
    validate: () => {},
    run: async () => {
      called.push(name);
      return { status: "succeeded" };
    },
  });
  const context = {
    adapters: {
      maacore: adapter("maacore"),
      maaframework: adapter("maaframework"),
    },
  };
  for (const game of gamePlugins.descriptors())
    await gamePlugins.run(
      { gameId: game.id, skillIds: ["login"], mode: "live" },
      "login",
      context,
      new AbortController().signal,
      () => {},
    );
  expect(called).toEqual(["maaframework", "maacore"]);
});
