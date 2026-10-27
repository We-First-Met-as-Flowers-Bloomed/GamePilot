/** Explicit App-owned daily options for the pinned MaaCore contract. No raw native JSON. */
export const infrastructureFacilities = [
  "Mfg",
  "Trade",
  "Power",
  "Control",
  "Reception",
  "Office",
  "Recycle",
  "Dorm",
  "Processing",
  "Training",
  "AssistantChange",
] as const;
export const droneUses = [
  "_NotUse",
  "Money",
  "SyntheticJade",
  "CombatRecord",
  "PureGold",
  "OriginStone",
  "Chip",
] as const;
export const fiammettaTargets = [
  "清流",
  "可露希尔",
  "但书",
  "巫恋",
  "龙舌兰",
  "歌蕾蒂娅",
] as const;
export interface FightOptions {
  /** Ordered stages; the profile's stage remains authoritative for the first entry. */
  stages: string[];
  times: number;
  series: number;
  medicine: number;
  stone: number;
  medicineExpireDays: number;
  /** Native per-run item targets; any reached target ends the queue. */
  drops: Record<string, number>;
  drGrandet: boolean;
  restartOnCrash: boolean;
  /** App activity resolution only; never forwarded as a native task parameter. */
  followActivity: boolean;
  fallbackStage: string;
}
export interface RecruitOptions {
  times: number;
  refresh: boolean;
  select: number[];
  confirm: number[];
  preserveTags: string[];
  firstTags: string[];
  extraTagsMode: number;
  reserveRecruitmentCount: number;
  recruitmentTime: { "3": number; "4": number };
}
export interface MallOptions {
  visitFriends: boolean;
  buyFirst: string[];
  blacklist: string[];
  forceShoppingIfCreditFull: boolean;
  onlyBuyDiscount: boolean;
  reserveMaxCredit: boolean;
  creditFight: boolean;
  formationIndex: number;
}
export interface InfrastructureOptions {
  mode: 0 | 10000 | 20000;
  facility: (typeof infrastructureFacilities)[number][];
  drones: (typeof droneUses)[number];
  threshold: number;
  replenish: boolean;
  dormNotStationed: boolean;
  dormTrust: boolean;
  fiammettaRecovery: boolean;
  fiammettaTargets: string[];
  usePinusSylvestris: boolean;
  usePerceptionInformation: boolean;
  useWorldlyPlight: boolean;
  useAbyssalHunter: boolean;
  receptionMessageBoard: boolean;
  receptionClueExchange: boolean;
  receptionSendClue: boolean;
  continueTraining: boolean;
  filename: string;
  planIndex: number;
}
export interface ArknightsTaskOptions {
  fight?: Partial<FightOptions>;
  recruit?: Partial<RecruitOptions>;
  mall?: Partial<MallOptions>;
  infrastructure?: Partial<InfrastructureOptions>;
}
export const defaultTaskOptions = {
  fight: {
    stages: [],
    times: 2147483647,
    series: 0,
    medicine: 0,
    stone: 0,
    medicineExpireDays: 0,
    drops: {},
    drGrandet: false,
    restartOnCrash: false,
    followActivity: false,
    fallbackStage: "LS-6",
  } satisfies FightOptions,
  recruit: {
    times: 4,
    refresh: false,
    select: [3],
    confirm: [3],
    preserveTags: ["高级资深干员", "资深干员", "支援机械"],
    firstTags: [],
    extraTagsMode: 0,
    reserveRecruitmentCount: 0,
    recruitmentTime: { "3": 540, "4": 540 },
  } satisfies RecruitOptions,
  mall: {
    visitFriends: true,
    buyFirst: ["招聘许可", "龙门币"],
    blacklist: ["家具零件", "加急许可", "碳"],
    forceShoppingIfCreditFull: true,
    onlyBuyDiscount: true,
    reserveMaxCredit: true,
    creditFight: false,
    formationIndex: 0,
  } satisfies MallOptions,
  infrastructure: {
    mode: 20000,
    facility: ["Trade", "Reception"],
    drones: "Money",
    threshold: 0.3,
    replenish: false,
    dormNotStationed: false,
    dormTrust: false,
    fiammettaRecovery: false,
    fiammettaTargets: ["清流", "可露希尔", "但书"],
    usePinusSylvestris: false,
    usePerceptionInformation: false,
    useWorldlyPlight: false,
    useAbyssalHunter: false,
    receptionMessageBoard: true,
    receptionClueExchange: true,
    receptionSendClue: true,
    continueTraining: false,
    filename: "",
    planIndex: 0,
  } satisfies InfrastructureOptions,
};
type Check = (value: unknown) => boolean;
const integer =
  (min: number, max: number): Check =>
  (value) =>
    Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const bool: Check = (value) => typeof value === "boolean";
const text: Check = (value) =>
  typeof value === "string" &&
  value.length <= 100 &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value);
const strings =
  (allowed?: readonly string[], max = 50): Check =>
  (value) =>
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    value.every(
      (item) =>
        text(item) && item !== "" && (!allowed || allowed.includes(item)),
    );
const stars: Check = (value) =>
  Array.isArray(value) &&
  value.length <= 2 &&
  new Set(value).size === value.length &&
  value.every((item) => item === 3 || item === 4);
const schema: Record<keyof ArknightsTaskOptions, Record<string, Check>> = {
  fight: {
    stages: (value) =>
      strings(undefined, 20)(value) &&
      (value as string[]).every((stage) =>
        /^[A-Za-z0-9@_-]{1,80}$/.test(stage),
      ),
    times: integer(1, 2147483647),
    series: integer(-1, 10),
    medicine: integer(0, 999),
    stone: integer(0, 999),
    medicineExpireDays: integer(0, 365),
    drops: (value) =>
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length <= 20 &&
      Object.entries(value).every(
        ([key, count]) =>
          /^[A-Za-z0-9_-]{1,80}$/.test(key) && integer(1, 1_000_000)(count),
      ),
    drGrandet: bool,
    restartOnCrash: bool,
    followActivity: bool,
    fallbackStage: (value) =>
      typeof value === "string" &&
      /^(?:\d{1,2}-\d{1,2}(?:-(?:NORMAL|HARD))?|(?:LS|CE)-[56]|(?:CA|AP|SK)-5|PR-[A-D]-[12]|OF-(?:1|F3)|(?:(?:Chernobog|LungmenOutskirts|LungmenDowntown)@)?Annihilation)$/.test(
        value,
      ),
  },
  recruit: {
    times: integer(0, 999),
    refresh: bool,
    select: stars,
    confirm: stars,
    preserveTags: (value) =>
      strings()(value) &&
      ["高级资深干员", "资深干员"].every((tag) =>
        (value as string[]).includes(tag),
      ),
    firstTags: strings(),
    extraTagsMode: integer(0, 2),
    reserveRecruitmentCount: integer(0, 999),
    recruitmentTime: (value) =>
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 2 &&
      Object.entries(value).every(
        ([key, minutes]) =>
          ["3", "4"].includes(key) && integer(60, 540)(minutes),
      ),
  },
  mall: {
    visitFriends: bool,
    buyFirst: strings(),
    blacklist: strings(),
    forceShoppingIfCreditFull: bool,
    onlyBuyDiscount: bool,
    reserveMaxCredit: bool,
    creditFight: bool,
    formationIndex: integer(0, 4),
  },
  infrastructure: {
    mode: (value) => [0, 10000, 20000].includes(value as number),
    facility: strings(
      infrastructureFacilities,
      infrastructureFacilities.length,
    ),
    drones: (value) =>
      droneUses.includes(value as InfrastructureOptions["drones"]),
    threshold: (value) =>
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    replenish: bool,
    dormNotStationed: bool,
    dormTrust: bool,
    fiammettaRecovery: bool,
    fiammettaTargets: strings(fiammettaTargets, 6),
    usePinusSylvestris: bool,
    usePerceptionInformation: bool,
    useWorldlyPlight: bool,
    useAbyssalHunter: bool,
    receptionMessageBoard: bool,
    receptionClueExchange: bool,
    receptionSendClue: bool,
    continueTraining: bool,
    filename: (value) =>
      typeof value === "string" &&
      value.length <= 1024 &&
      !/[\x00-\x1f\x7f-\x9f]/.test(value) &&
      (value === "" || /\.json$/i.test(value)),
    planIndex: integer(0, 99),
  },
};
export function validateArknightsTaskOptions(
  input: unknown,
): ArknightsTaskOptions {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("方舟任务参数无效");
  const result: Record<string, unknown> = {};
  for (const [group, fields] of Object.entries(input)) {
    if (
      !Object.hasOwn(schema, group) ||
      !fields ||
      typeof fields !== "object" ||
      Array.isArray(fields)
    )
      throw Error("不支持的方舟任务参数组");
    const checks = schema[group as keyof ArknightsTaskOptions];
    for (const [key, value] of Object.entries(fields))
      if (!Object.hasOwn(checks, key) || !checks[key](value))
        throw Error(`方舟任务参数 ${group}.${key} 无效或不支持`);
    result[group] = structuredClone(fields);
  }
  const validated = result as ArknightsTaskOptions;
  const base = {
    ...defaultTaskOptions.infrastructure,
    ...validated.infrastructure,
  };
  if (base.mode === 10000 && !base.filename)
    throw Error("自定义基建需要 App 内排班 JSON 文件");
  return validated;
}
export function resolveArknightsTaskOptions(options?: ArknightsTaskOptions) {
  const valid =
    options === undefined ? {} : validateArknightsTaskOptions(options);
  return {
    fight: {
      ...structuredClone(defaultTaskOptions.fight),
      ...valid.fight,
    } as FightOptions,
    recruit: {
      ...structuredClone(defaultTaskOptions.recruit),
      ...valid.recruit,
    } as RecruitOptions,
    mall: {
      ...structuredClone(defaultTaskOptions.mall),
      ...valid.mall,
    } as MallOptions,
    infrastructure: {
      ...structuredClone(defaultTaskOptions.infrastructure),
      ...valid.infrastructure,
    } as InfrastructureOptions,
  };
}
export function nativeRecruitOptions(options: RecruitOptions) {
  return {
    times: options.times,
    refresh: options.refresh,
    select: options.select,
    confirm: options.confirm,
    preserve_tags: options.preserveTags,
    first_tags: options.firstTags,
    extra_tags_mode: options.extraTagsMode,
    level3_recruitment_permit_reserve: options.reserveRecruitmentCount,
    recruitment_time: options.recruitmentTime,
  };
}
export function nativeMallOptions(options: MallOptions) {
  return {
    visit_friends: options.visitFriends,
    buy_first: options.buyFirst,
    blacklist: options.blacklist,
    force_shopping_if_credit_full: options.forceShoppingIfCreditFull,
    only_buy_discount: options.onlyBuyDiscount,
    reserve_max_credit: options.reserveMaxCredit,
    credit_fight: options.creditFight,
    formation_index: options.formationIndex,
  };
}
export function nativeInfrastructureOptions(options: InfrastructureOptions) {
  return {
    mode: options.mode,
    facility:
      options.mode === 20000 && options.drones === "_NotUse"
        ? options.facility.filter(
            (facility) => !["Mfg", "Trade"].includes(facility),
          )
        : options.facility,
    drones: options.drones,
    threshold: options.threshold,
    replenish: options.replenish,
    dorm_notstationed_enabled: options.dormNotStationed,
    dorm_trust_enabled: options.dormTrust,
    fiammetta_recovery_enabled: options.fiammettaRecovery,
    fiammetta_targets: options.fiammettaTargets,
    use_pinus_sylvestris: options.usePinusSylvestris,
    use_perception_information: options.usePerceptionInformation,
    use_worldly_plight: options.useWorldlyPlight,
    use_abyssal_hunter: options.useAbyssalHunter,
    reception_message_board: options.receptionMessageBoard,
    reception_clue_exchange: options.receptionClueExchange,
    reception_send_clue: options.receptionSendClue,
    continue_training: options.continueTraining,
    ...(options.mode === 10000
      ? { filename: options.filename, plan_index: options.planIndex }
      : {}),
  };
}
