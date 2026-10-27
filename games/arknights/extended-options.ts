/** Typed App options verified against MaaAssistantArknights v6.20.1 task setters.
 * Time budgets are enforced by the App worker; they are never sent as native parameters.
 */
export const roguelikeThemes = [
  "Phantom",
  "Mizuki",
  "Sami",
  "Sarkaz",
  "JieGarden",
  "BlackFlow",
] as const;
export type RoguelikeTheme = (typeof roguelikeThemes)[number];
export type RoguelikeMode =
  0 | 1 | 4 | 5 | 6 | 7 | 10001 | 20001 | 30001 | 30003;
export const blackflowAnimals = [
  "swaddled_cat",
  "swaddled_dog",
  "swaddled_cerberus",
  "swaddled_feathered_serpent",
] as const;
export type BlackflowAnimal = (typeof blackflowAnimals)[number];
export interface RoguelikeOptions {
  theme: RoguelikeTheme;
  mode: RoguelikeMode;
  squad: string;
  roles: string;
  coreChars: { name: string; useSupport: boolean }[];
  useNonfriendSupport: boolean;
  startsCount: number;
  difficulty: number;
  stopAtFinalBoss: boolean;
  stopAtMaxLevel: boolean;
  investmentEnabled: boolean;
  investmentsCount: number;
  stopWhenInvestmentFull: boolean;
  investmentWithMoreScore: boolean;
  startWithEliteTwo: boolean;
  onlyStartWithEliteTwo: boolean;
  refreshTraderWithDice: boolean;
  firstFloorFoldartal: string;
  startFoldartalList: string[];
  collectibleModeStartList: Partial<
    Record<
      | "hotWater"
      | "shield"
      | "ingot"
      | "hope"
      | "random"
      | "key"
      | "dice"
      | "ideas"
      | "ticket",
      boolean
    >
  >;
  useFoldartal: boolean;
  checkCollapsalParadigms: boolean;
  doubleCheckCollapsalParadigms: boolean;
  expectedCollapsalParadigms: string[];
  monthlySquadAutoIterate: boolean;
  monthlySquadCheckComms: boolean;
  deepExplorationAutoIterate: boolean;
  collectibleModeShopping: boolean;
  collectibleModeSquad: string;
  startWithSeed: string;
  blackflowStrategy:
    | ""
    | "baby_animal"
    | "investment"
    | "burn_with_investment"
    | "burn"
    | "ending1"
    | "ending2"
    | "ending3";
  blackflowCultivationTarget: BlackflowAnimal;
  blackflowStartAnimals: BlackflowAnimal[];
  blackflowStartRewards: number;
  findPlayTimeTarget: 1 | 2 | 3;
  maxRunMinutes: number;
}
export interface ReclamationOptions {
  theme: "Tales" | "RelaunchAnchor";
  mode: 0 | 1 | 16 | 32 | 48;
  toolsToCraft: string[];
  clearStore: boolean;
  incrementMode: 0 | 1;
  numCraftBatches: number;
  maxRunMinutes: number;
}
export interface SssCopilotOptions {
  filename: string;
  loopTimes: number;
  maxRunMinutes: number;
}
export interface ParadoxCopilotOptions {
  filename: string;
  list: { id: number; filename: string }[];
  maxRunMinutes: number;
}
export interface RecognitionOptions {
  enabled: boolean;
  maxRunMinutes: number;
}
export interface VideoRecognitionOptions {
  filename: string;
  maxRunMinutes: number;
}
export const operatorRoles = [
  "Pioneer",
  "Warrior",
  "Tank",
  "Sniper",
  "Caster",
  "Medic",
  "Support",
  "Special",
] as const;
export interface OperatorProgressPlan {
  name: string;
  role?: (typeof operatorRoles)[number];
  elite?: 1 | 2;
  skillLevel?: number;
  skillMastery?: [number, number, number];
}
export interface OperatorProgressOptions {
  plans: OperatorProgressPlan[];
  /** Explicit consent to consume existing upgrade materials. Native Core has no item-count budget API. */
  allowMaterialConsumption: boolean;
  maxRunMinutes: number;
}
export interface CustomActivityOptions {
  /** Syntax only; the worker must authorize this exact route against the current official catalogue. */
  route: string;
  maxRunMinutes: number;
}
export interface ArknightsExtendedOptions {
  roguelike?: Partial<RoguelikeOptions>;
  reclamation?: Partial<ReclamationOptions>;
  sssCopilot?: Partial<SssCopilotOptions>;
  paradoxCopilot?: Partial<ParadoxCopilotOptions>;
  switchTheme?: { themes?: string[] };
  depot?: Partial<RecognitionOptions>;
  operatorBox?: Partial<RecognitionOptions>;
  videoRecognition?: Partial<VideoRecognitionOptions>;
  customActivity?: Partial<CustomActivityOptions>;
  operProgress?: Partial<OperatorProgressOptions>;
}
export interface ResolvedArknightsExtendedOptions {
  roguelike: RoguelikeOptions;
  reclamation: ReclamationOptions;
  sssCopilot: SssCopilotOptions;
  paradoxCopilot: ParadoxCopilotOptions;
  switchTheme: { themes: string[] };
  depot: RecognitionOptions;
  operatorBox: RecognitionOptions;
  videoRecognition: VideoRecognitionOptions;
  customActivity: CustomActivityOptions;
  operProgress: OperatorProgressOptions;
}
export const defaultExtendedOptions: ResolvedArknightsExtendedOptions = {
  roguelike: {
    theme: "BlackFlow",
    mode: 0,
    squad: "指挥分队",
    roles: "取长补短",
    coreChars: [],
    useNonfriendSupport: false,
    startsCount: 1,
    difficulty: -1,
    stopAtFinalBoss: true,
    stopAtMaxLevel: false,
    investmentEnabled: true,
    investmentsCount: 999,
    stopWhenInvestmentFull: true,
    investmentWithMoreScore: false,
    startWithEliteTwo: false,
    onlyStartWithEliteTwo: false,
    refreshTraderWithDice: false,
    firstFloorFoldartal: "",
    startFoldartalList: [],
    collectibleModeStartList: {},
    useFoldartal: true,
    checkCollapsalParadigms: false,
    doubleCheckCollapsalParadigms: false,
    expectedCollapsalParadigms: ["目空一些", "睁眼瞎", "图像损坏", "一抹黑"],
    monthlySquadAutoIterate: false,
    monthlySquadCheckComms: false,
    deepExplorationAutoIterate: false,
    collectibleModeShopping: false,
    collectibleModeSquad: "",
    startWithSeed: "",
    blackflowStrategy: "",
    blackflowCultivationTarget: "swaddled_cat",
    blackflowStartAnimals: [],
    blackflowStartRewards: 0,
    findPlayTimeTarget: 1,
    maxRunMinutes: 120,
  },
  reclamation: {
    theme: "RelaunchAnchor",
    mode: 16,
    toolsToCraft: [],
    clearStore: false,
    incrementMode: 0,
    numCraftBatches: 1,
    maxRunMinutes: 60,
  },
  sssCopilot: { filename: "", loopTimes: 1, maxRunMinutes: 120 },
  paradoxCopilot: { filename: "", list: [], maxRunMinutes: 120 },
  switchTheme: { themes: [] },
  depot: { enabled: true, maxRunMinutes: 30 },
  operatorBox: { enabled: true, maxRunMinutes: 30 },
  videoRecognition: { filename: "", maxRunMinutes: 120 },
  customActivity: { route: "", maxRunMinutes: 30 },
  operProgress: {
    plans: [],
    allowMaterialConsumption: false,
    maxRunMinutes: 30,
  },
};

type Check = (value: unknown) => boolean;
const integer =
  (minimum: number, maximum: number): Check =>
  (value) =>
    Number.isInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum;
const bool: Check = (value) => typeof value === "boolean";
const text: Check = (value) =>
  typeof value === "string" &&
  value.length <= 100 &&
  value === value.trim() &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value);
const member =
  (allowed: readonly unknown[]): Check =>
  (value) =>
    allowed.includes(value);
const strings =
  (maximum = 50): Check =>
  (value) =>
    Array.isArray(value) &&
    value.length <= maximum &&
    new Set(value).size === value.length &&
    value.every((item) => text(item) && item !== "");
const minutes = integer(5, 360);
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function localFile(value: unknown, extension: RegExp): boolean {
  return (
    typeof value === "string" &&
    value.length <= 1024 &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f-\x9f]/.test(value) &&
    !/^[a-z][a-z\d+.-]*:\/\//i.test(value) &&
    (value === "" || extension.test(value))
  );
}
const jsonFile: Check = (value) => localFile(value, /\.json$/i);
const startRewards = [
  "hotWater",
  "shield",
  "ingot",
  "hope",
  "random",
  "key",
  "dice",
  "ideas",
  "ticket",
];
const schema: Record<keyof ArknightsExtendedOptions, Record<string, Check>> = {
  roguelike: {
    theme: member(roguelikeThemes),
    mode: member([0, 1, 4, 5, 6, 7, 10001, 20001, 30001, 30003]),
    squad: text,
    roles: text,
    coreChars: (value) =>
      Array.isArray(value) &&
      value.length <= 3 &&
      new Set(value.map((item) => (plain(item) ? item.name : undefined)))
        .size === value.length &&
      value.every(
        (item) =>
          plain(item) &&
          Object.keys(item).length === 2 &&
          text(item.name) &&
          item.name !== "" &&
          bool(item.useSupport),
      ),
    useNonfriendSupport: bool,
    startsCount: integer(1, 999),
    difficulty: (value) => integer(-1, 99)(value) || value === 2147483647,
    stopAtFinalBoss: bool,
    stopAtMaxLevel: bool,
    investmentEnabled: bool,
    investmentsCount: integer(0, 99_999),
    stopWhenInvestmentFull: bool,
    investmentWithMoreScore: bool,
    startWithEliteTwo: bool,
    onlyStartWithEliteTwo: bool,
    refreshTraderWithDice: bool,
    firstFloorFoldartal: text,
    startFoldartalList: strings(),
    collectibleModeStartList: (value) =>
      plain(value) &&
      Object.entries(value).every(
        ([key, enabled]) => startRewards.includes(key) && bool(enabled),
      ),
    useFoldartal: bool,
    checkCollapsalParadigms: bool,
    doubleCheckCollapsalParadigms: bool,
    expectedCollapsalParadigms: strings(),
    monthlySquadAutoIterate: bool,
    monthlySquadCheckComms: bool,
    deepExplorationAutoIterate: bool,
    collectibleModeShopping: bool,
    collectibleModeSquad: text,
    startWithSeed: (value) =>
      text(value) && /^[A-Za-z0-9]*$/.test(value as string),
    blackflowStrategy: member([
      "",
      "baby_animal",
      "investment",
      "burn_with_investment",
      "burn",
      "ending1",
      "ending2",
      "ending3",
    ]),
    blackflowCultivationTarget: member(blackflowAnimals),
    blackflowStartAnimals: (value) =>
      Array.isArray(value) &&
      value.length <= 2 &&
      value.every(member(blackflowAnimals)) &&
      value.filter((animal) => animal === "swaddled_feathered_serpent")
        .length <= 1,
    blackflowStartRewards: integer(0, 4095),
    findPlayTimeTarget: member([1, 2, 3]),
    maxRunMinutes: minutes,
  },
  reclamation: {
    theme: member(["Tales", "RelaunchAnchor"]),
    mode: member([0, 1, 16, 32, 48]),
    toolsToCraft: strings(20),
    clearStore: bool,
    incrementMode: member([0, 1]),
    numCraftBatches: integer(1, 99),
    maxRunMinutes: minutes,
  },
  sssCopilot: {
    filename: jsonFile,
    loopTimes: integer(1, 99),
    maxRunMinutes: minutes,
  },
  paradoxCopilot: {
    filename: jsonFile,
    list: (value) =>
      Array.isArray(value) &&
      value.length <= 50 &&
      new Set(value.map((item) => (plain(item) ? item.id : undefined))).size ===
        value.length &&
      value.every(
        (item) =>
          plain(item) &&
          Object.keys(item).length === 2 &&
          integer(0, 2147483647)(item.id) &&
          jsonFile(item.filename) &&
          item.filename !== "",
      ),
    maxRunMinutes: minutes,
  },
  switchTheme: { themes: strings(50) },
  depot: { enabled: bool, maxRunMinutes: minutes },
  operatorBox: { enabled: bool, maxRunMinutes: minutes },
  videoRecognition: {
    filename: (value) => localFile(value, /\.(?:mp4|mkv|avi|mov|webm)$/i),
    maxRunMinutes: minutes,
  },
  customActivity: {
    route: (value) =>
      typeof value === "string" &&
      (value === "" || /^[A-Za-z][A-Za-z0-9_@-]{0,119}$/.test(value)),
    maxRunMinutes: minutes,
  },
  operProgress: {
    allowMaterialConsumption: bool,
    maxRunMinutes: minutes,
    plans: (value) =>
      Array.isArray(value) &&
      value.length <= 20 &&
      value.every(
        (plan) =>
          plain(plan) &&
          Object.keys(plan).every((key) =>
            ["name", "role", "elite", "skillLevel", "skillMastery"].includes(
              key,
            ),
          ) &&
          text(plan.name) &&
          plan.name !== "" &&
          (plan.role === undefined || member(operatorRoles)(plan.role)) &&
          (plan.elite === undefined || member([1, 2])(plan.elite)) &&
          (plan.skillLevel === undefined || integer(2, 7)(plan.skillLevel)) &&
          (plan.skillMastery === undefined ||
            (Array.isArray(plan.skillMastery) &&
              plan.skillMastery.length === 3 &&
              plan.skillMastery.every(integer(0, 3)))) &&
          (plan.elite !== undefined ||
            plan.skillLevel !== undefined ||
            (Array.isArray(plan.skillMastery) &&
              plan.skillMastery.some((level) => Number(level) > 0))),
      ) &&
      new Set(value.map((plan) => `${plan.name}|${plan.role ?? ""}`)).size ===
        value.length,
  },
};

export function roguelikeModesForTheme(theme: RoguelikeTheme): RoguelikeMode[] {
  if (theme === "BlackFlow") return [0, 1, 30001, 30003];
  return [
    0,
    1,
    4,
    6,
    7,
    ...(theme === "Sami" ? [5 as const] : []),
    ...(theme === "Sarkaz" ? [10001 as const] : []),
    ...(theme === "JieGarden" ? [20001 as const] : []),
  ];
}

export function validateArknightsExtendedOptions(
  input: unknown,
): ArknightsExtendedOptions {
  if (!plain(input)) throw Error("方舟高级参数无效");
  const result: Record<string, unknown> = {};
  for (const [group, fields] of Object.entries(input)) {
    if (!Object.hasOwn(schema, group) || !plain(fields))
      throw Error("不支持的方舟高级参数组");
    const checks = schema[group as keyof ArknightsExtendedOptions];
    for (const [key, value] of Object.entries(fields))
      if (!Object.hasOwn(checks, key) || !checks[key](value))
        throw Error(`方舟高级参数 ${group}.${key} 无效或不支持`);
    result[group] = structuredClone(fields);
  }
  const valid = result as ArknightsExtendedOptions;
  const rogue = { ...defaultExtendedOptions.roguelike, ...valid.roguelike };
  if (!roguelikeModesForTheme(rogue.theme).includes(rogue.mode))
    throw Error("肉鸽主题与模式不匹配");
  if (
    (rogue.startWithEliteTwo || rogue.onlyStartWithEliteTwo) &&
    rogue.mode !== 4
  )
    throw Error("肉鸽精二开局只支持模式 4");
  if (rogue.onlyStartWithEliteTwo && !rogue.startWithEliteTwo)
    throw Error("只凹精二需要同时启用精二开局");
  if (
    rogue.startFoldartalList.length &&
    (rogue.theme !== "Sami" ||
      rogue.mode !== 4 ||
      rogue.squad !== "生活至上分队")
  )
    throw Error("开局密文板需要萨米模式 4 与生活至上分队");
  const reclamation = {
    ...defaultExtendedOptions.reclamation,
    ...valid.reclamation,
  };
  if (
    !(reclamation.theme === "Tales" ? [0, 1] : [16, 32, 48]).includes(
      reclamation.mode,
    )
  )
    throw Error("生息演算主题与模式不匹配");
  const paradox = {
    ...defaultExtendedOptions.paradoxCopilot,
    ...valid.paradoxCopilot,
  };
  if (paradox.filename && paradox.list.length)
    throw Error("悖论作业单文件与列表只能选择一种");
  return valid;
}

export function resolveArknightsExtendedOptions(
  options?: ArknightsExtendedOptions,
): ResolvedArknightsExtendedOptions {
  const valid =
    options === undefined ? {} : validateArknightsExtendedOptions(options);
  const defaults = structuredClone(defaultExtendedOptions);
  const rogue = { ...defaults.roguelike, ...valid.roguelike };
  if (rogue.mode === 5) {
    rogue.useFoldartal = valid.roguelike?.useFoldartal ?? false;
    rogue.checkCollapsalParadigms =
      valid.roguelike?.checkCollapsalParadigms ?? true;
    rogue.doubleCheckCollapsalParadigms =
      valid.roguelike?.doubleCheckCollapsalParadigms ?? true;
  }
  return {
    roguelike: rogue,
    reclamation: { ...defaults.reclamation, ...valid.reclamation },
    sssCopilot: { ...defaults.sssCopilot, ...valid.sssCopilot },
    paradoxCopilot: { ...defaults.paradoxCopilot, ...valid.paradoxCopilot },
    switchTheme: { ...defaults.switchTheme, ...valid.switchTheme },
    depot: { ...defaults.depot, ...valid.depot },
    operatorBox: { ...defaults.operatorBox, ...valid.operatorBox },
    videoRecognition: {
      ...defaults.videoRecognition,
      ...valid.videoRecognition,
    },
    customActivity: { ...defaults.customActivity, ...valid.customActivity },
    operProgress: { ...defaults.operProgress, ...valid.operProgress },
  };
}

export function extendedArknightsTaskFor(
  id: string,
  options?: ArknightsExtendedOptions,
): { type: string; params: Record<string, unknown> } | undefined {
  const value = resolveArknightsExtendedOptions(options);
  switch (id) {
    case "roguelike": {
      const r = value.roguelike;
      return {
        type: "Roguelike",
        params: {
          enable: true,
          theme: r.theme,
          mode: r.mode,
          squad: r.squad,
          roles: r.roles,
          core_char_list: r.coreChars.map((oper) => ({
            name: oper.name,
            use_support: oper.useSupport,
          })),
          use_nonfriend_support: r.useNonfriendSupport,
          starts_count: r.startsCount,
          difficulty: r.difficulty,
          ...(r.theme === "Phantom"
            ? {}
            : { stop_at_final_boss: r.stopAtFinalBoss }),
          stop_at_max_level: r.stopAtMaxLevel,
          investment_enabled: r.investmentEnabled,
          investments_count: r.investmentsCount,
          stop_when_investment_full: r.stopWhenInvestmentFull,
          investment_with_more_score: r.investmentWithMoreScore,
          ...(r.mode === 4
            ? {
                start_with_elite_two: r.startWithEliteTwo,
                only_start_with_elite_two: r.onlyStartWithEliteTwo,
                collectible_mode_shopping: r.collectibleModeShopping,
                collectible_mode_squad: r.collectibleModeSquad || r.squad,
                collectible_mode_start_list: Object.fromEntries(
                  Object.entries(r.collectibleModeStartList).map(
                    ([key, enabled]) => [
                      key === "hotWater" ? "hot_water" : key,
                      enabled,
                    ],
                  ),
                ),
              }
            : {}),
          ...(r.theme === "Mizuki"
            ? { refresh_trader_with_dice: r.refreshTraderWithDice }
            : {}),
          ...(r.theme === "Sami"
            ? {
                first_floor_foldartal: r.firstFloorFoldartal,
                use_foldartal: r.useFoldartal,
                ...(r.startFoldartalList.length
                  ? { start_foldartal_list: r.startFoldartalList }
                  : {}),
                check_collapsal_paradigms: r.checkCollapsalParadigms,
                double_check_collapsal_paradigms:
                  r.doubleCheckCollapsalParadigms,
                expected_collapsal_paradigms: r.expectedCollapsalParadigms,
              }
            : {}),
          monthly_squad_auto_iterate: r.monthlySquadAutoIterate,
          monthly_squad_check_comms: r.monthlySquadCheckComms,
          deep_exploration_auto_iterate: r.deepExplorationAutoIterate,
          ...(r.theme === "Sarkaz" ? { start_with_seed: r.startWithSeed } : {}),
          ...(r.theme === "JieGarden" && r.mode === 20001
            ? { find_playTime_target: r.findPlayTimeTarget }
            : {}),
          ...(r.theme === "BlackFlow"
            ? {
                ...(r.mode === 30001
                  ? { blackflow_strategy: "baby_animal" }
                  : r.blackflowStrategy
                    ? { blackflow_strategy: r.blackflowStrategy }
                    : {}),
                blackflow_cultivation_target: r.blackflowCultivationTarget,
                ...(r.mode === 30003
                  ? {
                      blackflow_start_animals: r.blackflowStartAnimals,
                      blackflow_start_rewards: r.blackflowStartRewards,
                      collectible_mode_squad: r.collectibleModeSquad || r.squad,
                    }
                  : {}),
              }
            : {}),
        },
      };
    }
    case "reclamation": {
      const r = value.reclamation;
      return {
        type: "Reclamation",
        params: {
          enable: true,
          theme: r.theme,
          mode: r.mode,
          tools_to_craft: r.toolsToCraft,
          clear_store: r.clearStore,
          increment_mode: r.incrementMode,
          num_craft_batches: r.numCraftBatches,
        },
      };
    }
    case "sss-copilot": {
      const s = value.sssCopilot;
      if (!s.filename) throw Error("请先选择保全作业 JSON 文件");
      return {
        type: "SSSCopilot",
        params: { enable: true, filename: s.filename, loop_times: s.loopTimes },
      };
    }
    case "paradox-copilot": {
      const p = value.paradoxCopilot;
      if (!p.filename && !p.list.length)
        throw Error("请先选择悖论模拟作业 JSON 文件");
      return {
        type: "ParadoxCopilot",
        params: {
          enable: true,
          ...(p.filename ? { filename: p.filename } : { list: p.list }),
        },
      };
    }
    case "switch-theme":
      return {
        type: "SwitchTheme",
        params: { enable: true, themes: value.switchTheme.themes },
      };
    case "depot":
      return { type: "Depot", params: { enable: value.depot.enabled } };
    case "operator-box":
      return { type: "OperBox", params: { enable: value.operatorBox.enabled } };
    case "video-recognition": {
      if (!value.videoRecognition.filename)
        throw Error("请先选择本地作战录像文件");
      return {
        type: "VideoRecognition",
        params: { enable: true, filename: value.videoRecognition.filename },
      };
    }
    case "activity-game": {
      if (!value.customActivity.route)
        throw Error("请先从官方目录选择当前活动玩法");
      // This does not grant execution authority: the worker checks the official current route and navigation hash.
      return {
        type: "Custom",
        params: { enable: true, task_names: [value.customActivity.route] },
      };
    }
    case "operator-progress": {
      const progress = value.operProgress;
      if (!progress.allowMaterialConsumption)
        throw Error(
          "干员养成需要明确同意消耗现有材料，原生不支持逐物品数量上限",
        );
      if (!progress.plans.length) throw Error("请先选择明确的干员养成目标");
      return {
        type: "OperProgress",
        params: {
          enable: true,
          plans: progress.plans.map((plan) => ({
            name: plan.name,
            ...(plan.role === undefined ? {} : { role: plan.role }),
            ...(plan.elite === undefined ? {} : { elite: plan.elite }),
            ...(plan.skillLevel === undefined
              ? {}
              : { skill_level: plan.skillLevel }),
            ...(plan.skillMastery === undefined
              ? {}
              : { skill_mastery: plan.skillMastery }),
          })),
        },
      };
    }
    default:
      return undefined;
  }
}

export function extendedArknightsRunMinutes(
  id: string,
  options: ArknightsExtendedOptions | undefined,
  globalMinutes: number,
): number {
  if (!minutes(globalMinutes)) throw Error("运行时长上限必须为 5 至 360 分钟");
  const value = resolveArknightsExtendedOptions(options);
  const groups: Record<
    string,
    Exclude<keyof ResolvedArknightsExtendedOptions, "switchTheme">
  > = {
    roguelike: "roguelike",
    reclamation: "reclamation",
    "sss-copilot": "sssCopilot",
    "paradox-copilot": "paradoxCopilot",
    depot: "depot",
    "operator-box": "operatorBox",
    "video-recognition": "videoRecognition",
    "activity-game": "customActivity",
    "operator-progress": "operProgress",
  };
  const group = Object.hasOwn(groups, id) ? groups[id] : undefined;
  return group
    ? Math.min(globalMinutes, value[group].maxRunMinutes)
    : globalMinutes;
}
