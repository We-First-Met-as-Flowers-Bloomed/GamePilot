import { expect, it } from "vitest";
import {
  extendedArknightsRunMinutes,
  extendedArknightsTaskFor,
  resolveArknightsExtendedOptions,
  validateArknightsExtendedOptions,
} from "../games/arknights/extended-options";

it("defaults every long task to a bounded run without inventing native time-budget fields", () => {
  const resolved = resolveArknightsExtendedOptions();
  expect(resolved.roguelike.startsCount).toBe(1);
  expect(resolved.reclamation.numCraftBatches).toBe(1);
  expect(extendedArknightsTaskFor("roguelike")?.params.starts_count).toBe(1);
  expect(extendedArknightsTaskFor("roguelike")?.params).not.toHaveProperty(
    "maxRunMinutes",
  );
  expect(
    extendedArknightsRunMinutes(
      "roguelike",
      { roguelike: { maxRunMinutes: 30 } },
      120,
    ),
  ).toBe(30);
  expect(
    extendedArknightsRunMinutes(
      "reclamation",
      { reclamation: { maxRunMinutes: 120 } },
      20,
    ),
  ).toBe(20);
  expect(extendedArknightsRunMinutes("fight", undefined, 120)).toBe(120);
  expect(extendedArknightsTaskFor("fight")).toBeUndefined();
});

it.each([
  ["Phantom", 0],
  ["Phantom", 1],
  ["Phantom", 4],
  ["Phantom", 6],
  ["Phantom", 7],
  ["Mizuki", 0],
  ["Sami", 5],
  ["Sarkaz", 10001],
  ["JieGarden", 20001],
  ["BlackFlow", 0],
  ["BlackFlow", 1],
  ["BlackFlow", 30001],
  ["BlackFlow", 30003],
] as const)("maps supported v6.20.1 theme/mode %s/%i", (theme, mode) => {
  const options = validateArknightsExtendedOptions({
    roguelike: { theme, mode },
  });
  const task = extendedArknightsTaskFor("roguelike", options)!;
  expect(task.type).toBe("Roguelike");
  expect(task.params).toMatchObject({ theme, mode, starts_count: 1 });
  if (mode === 20001) expect(task.params.find_playTime_target).toBe(1);
  if (mode === 30003)
    expect(task.params).toMatchObject({
      blackflow_start_animals: [],
      blackflow_start_rewards: 0,
    });
  if (mode === 30001)
    expect(task.params.blackflow_strategy).toBe("baby_animal");
});

it.each([
  { roguelike: { theme: "Phantom", mode: 5 } },
  { roguelike: { theme: "BlackFlow", mode: 4 } },
  { roguelike: { theme: "Sami", mode: 10001 } },
  { roguelike: { theme: "Sarkaz", mode: 20001 } },
  { roguelike: { mode: 2 } },
  { roguelike: { mode: 3 } },
  { roguelike: { startsCount: 0 } },
  { roguelike: { startsCount: 2147483647 } },
  { roguelike: { investmentsCount: -1 } },
  { roguelike: { difficulty: -2 } },
  { roguelike: { maxRunMinutes: 0 } },
  { reclamation: { maxRunMinutes: Infinity } },
  { roguelike: { onlyStartWithEliteTwo: true } },
  { roguelike: { theme: "Sami", mode: 4, onlyStartWithEliteTwo: true } },
  { reclamation: { theme: "Fire", mode: 0 } },
  { reclamation: { theme: "Tales", mode: 16 } },
  { reclamation: { theme: "RelaunchAnchor", mode: 0 } },
  { reclamation: { numCraftBatches: 0 } },
  { depot: { pageLimit: 10 } },
  { operatorBox: { includeModules: true } },
  { sssCopilot: { formation: true } },
  { paradoxCopilot: { loopTimes: 2 } },
  { nativeJSON: {} },
  { gacha: { times: 1 } },
  { custom: { taskNames: ["Gacha"] } },
  { switchTheme: { themes: ["夜间", "夜间"] } },
])(
  "rejects unsupported, unbounded or mismatched extended options %j",
  (input) => {
    expect(() => validateArknightsExtendedOptions(input)).toThrow();
  },
);

it("owns nested arrays and maps recruitment slots, investment limits and Sami flags", () => {
  const input = {
    roguelike: {
      theme: "Sami",
      mode: 5,
      startsCount: 3,
      investmentsCount: 25,
      investmentEnabled: false,
      difficulty: 8,
      coreChars: [{ name: "维什戴尔", useSupport: true }],
      useNonfriendSupport: true,
      expectedCollapsalParadigms: ["目空一些"],
    },
  };
  const valid = validateArknightsExtendedOptions(input);
  input.roguelike.coreChars[0].name = "古米";
  const task = extendedArknightsTaskFor("roguelike", valid)!;
  expect(task.params).toMatchObject({
    theme: "Sami",
    mode: 5,
    starts_count: 3,
    investments_count: 25,
    investment_enabled: false,
    difficulty: 8,
    core_char_list: [{ name: "维什戴尔", use_support: true }],
    use_nonfriend_support: true,
    use_foldartal: false,
    check_collapsal_paradigms: true,
    expected_collapsal_paradigms: ["目空一些"],
  });
  expect(task.params).not.toHaveProperty("start_foldartal_list");
});

it("supports bounded BlackFlow start-run animal multiplicity and validates reward masks", () => {
  const task = extendedArknightsTaskFor("roguelike", {
    roguelike: {
      theme: "BlackFlow",
      mode: 30003,
      blackflowStartAnimals: ["swaddled_cat", "swaddled_cat"],
      blackflowStartRewards: 3,
    },
  })!;
  expect(task.params).toMatchObject({
    blackflow_start_animals: ["swaddled_cat", "swaddled_cat"],
    blackflow_start_rewards: 3,
  });
  expect(() =>
    validateArknightsExtendedOptions({
      roguelike: {
        theme: "BlackFlow",
        mode: 30003,
        blackflowStartRewards: 4096,
      },
    }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      roguelike: {
        theme: "BlackFlow",
        mode: 30003,
        blackflowStartAnimals: [
          "swaddled_feathered_serpent",
          "swaddled_feathered_serpent",
        ],
      },
    }),
  ).toThrow();
});

it("maps both active Reclamation themes with their actual native mode encodings", () => {
  for (const mode of [16, 32, 48] as const)
    expect(
      extendedArknightsTaskFor("reclamation", {
        reclamation: { theme: "RelaunchAnchor", mode },
      })?.params,
    ).toMatchObject({ theme: "RelaunchAnchor", mode });
  const task = extendedArknightsTaskFor("reclamation", {
    reclamation: {
      theme: "Tales",
      mode: 1,
      toolsToCraft: ["荧光棒"],
      numCraftBatches: 2,
      incrementMode: 1,
    },
  });
  expect(task?.params).toMatchObject({
    theme: "Tales",
    mode: 1,
    tools_to_craft: ["荧光棒"],
    num_craft_batches: 2,
    increment_mode: 1,
    clear_store: false,
  });
  expect(task?.params).not.toHaveProperty("starts_count");
});

it("maps SSS, single and batched paradox jobs without unsupported formation or repeat settings", () => {
  expect(() => extendedArknightsTaskFor("sss-copilot")).toThrow(/作业/);
  expect(() => extendedArknightsTaskFor("paradox-copilot")).toThrow(/作业/);
  expect(
    extendedArknightsTaskFor("sss-copilot", {
      sssCopilot: { filename: "D:/plans/sss.json", loopTimes: 2 },
    }),
  ).toEqual({
    type: "SSSCopilot",
    params: { enable: true, filename: "D:/plans/sss.json", loop_times: 2 },
  });
  expect(
    extendedArknightsTaskFor("paradox-copilot", {
      paradoxCopilot: { filename: "paradox/one.json" },
    }),
  ).toEqual({
    type: "ParadoxCopilot",
    params: { enable: true, filename: "paradox/one.json" },
  });
  const list = [
    { id: 1, filename: "paradox/one.json" },
    { id: 2, filename: "paradox/two.json" },
  ];
  expect(
    extendedArknightsTaskFor("paradox-copilot", { paradoxCopilot: { list } }),
  ).toEqual({ type: "ParadoxCopilot", params: { enable: true, list } });
  expect(() =>
    validateArknightsExtendedOptions({
      paradoxCopilot: { filename: "one.json", list },
    }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      sssCopilot: { filename: "https://example.test/one.json" },
    }),
  ).toThrow();
});

it("limits Depot and OperBox configuration to the actual native enable switch plus App time budgets", () => {
  expect(
    extendedArknightsTaskFor("depot", {
      depot: { enabled: false, maxRunMinutes: 10 },
    }),
  ).toEqual({ type: "Depot", params: { enable: false } });
  expect(extendedArknightsTaskFor("operator-box")).toEqual({
    type: "OperBox",
    params: { enable: true },
  });
  expect(
    extendedArknightsRunMinutes(
      "operator-box",
      { operatorBox: { maxRunMinutes: 15 } },
      120,
    ),
  ).toBe(15);
  expect(
    extendedArknightsTaskFor("switch-theme", {
      switchTheme: { themes: ["夜间", "银凇"] },
    }),
  ).toEqual({
    type: "SwitchTheme",
    params: { enable: true, themes: ["夜间", "银凇"] },
  });
});

it("maps the official experimental video task from a bounded local recording", () => {
  expect(() => extendedArknightsTaskFor("video-recognition")).toThrow(/录像/);
  expect(
    extendedArknightsTaskFor("video-recognition", {
      videoRecognition: {
        filename: "D:/recordings/battle.mp4",
        maxRunMinutes: 20,
      },
    }),
  ).toEqual({
    type: "VideoRecognition",
    params: { enable: true, filename: "D:/recordings/battle.mp4" },
  });
  expect(
    extendedArknightsRunMinutes(
      "video-recognition",
      { videoRecognition: { maxRunMinutes: 20 } },
      120,
    ),
  ).toBe(20);
  expect(extendedArknightsRunMinutes("__proto__", undefined, 120)).toBe(120);
});

it("preserves only the documented maximum-difficulty sentinel while keeping starts bounded", () => {
  expect(
    extendedArknightsTaskFor("roguelike", {
      roguelike: { difficulty: 2147483647 },
    })?.params.difficulty,
  ).toBe(2147483647);
  expect(() =>
    validateArknightsExtendedOptions({ roguelike: { difficulty: 2147483646 } }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      roguelike: { startsCount: 2147483647 },
    }),
  ).toThrow();
});

it("only constructs one syntactically restricted official activity route for the worker authorization gate", () => {
  const task = extendedArknightsTaskFor("activity-game", {
    customActivity: { route: "BlackFlowTemporary@Begin", maxRunMinutes: 15 },
  });
  expect(task).toEqual({
    type: "Custom",
    params: { enable: true, task_names: ["BlackFlowTemporary@Begin"] },
  });
  expect(
    extendedArknightsRunMinutes(
      "activity-game",
      { customActivity: { maxRunMinutes: 15 } },
      120,
    ),
  ).toBe(15);
  expect(() => extendedArknightsTaskFor("activity-game")).toThrow(/活动/);
  expect(() =>
    validateArknightsExtendedOptions({ customActivity: { route: "../task" } }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      customActivity: { route: "Gacha", taskNames: ["anything"] },
    }),
  ).toThrow();
});

it("requires explicit material consent and bounded upgrade targets before constructing OperProgress", () => {
  expect(() => extendedArknightsTaskFor("operator-progress")).toThrow();
  const plans = [
    {
      name: "能天使",
      elite: 2 as const,
      skillLevel: 7,
      skillMastery: [1, 0, 3] as [number, number, number],
    },
  ];
  const options = { operProgress: { plans } };
  expect(
    resolveArknightsExtendedOptions(options).operProgress
      .allowMaterialConsumption,
  ).toBe(false);
  expect(() => extendedArknightsTaskFor("operator-progress", options)).toThrow(
    /材料/,
  );
  expect(
    extendedArknightsTaskFor("operator-progress", {
      operProgress: { plans, allowMaterialConsumption: true },
    }),
  ).toEqual({
    type: "OperProgress",
    params: {
      enable: true,
      plans: [
        { name: "能天使", elite: 2, skill_level: 7, skill_mastery: [1, 0, 3] },
      ],
    },
  });
  expect(() =>
    validateArknightsExtendedOptions({
      operProgress: { plans: [{ name: "能天使", elite: 3 }] },
    }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      operProgress: { plans: [{ name: "能天使", skillMastery: [4, 0, 0] }] },
    }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      operProgress: { plans: [{ name: "能天使" }] },
    }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      operProgress: { plans: [{ name: "装置", role: "Drone", elite: 1 }] },
    }),
  ).toThrow();
  expect(() =>
    validateArknightsExtendedOptions({
      operProgress: { maxMaterialCost: 999 },
    }),
  ).toThrow();
});
