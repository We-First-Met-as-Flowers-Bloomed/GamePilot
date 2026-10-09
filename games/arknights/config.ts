import { validateArknightsCapabilities } from "./capabilities";

export interface ArknightsConfig {
  accountName: string;
  expectedUid: string;
  clientType: "Official" | "Bilibili";
  stage: string;
  mail: boolean;
  /** Native Award flag; omitted stored values retain the saved daily behavior. */
  taskAward?: boolean;
  recruit: boolean;
  creditShopping: boolean;
  copilotFile: string;
  copilotLoopTimes: number;
  freeRecruit: boolean;
  eventOrundum: boolean;
  eventMining: boolean;
  specialAccess: boolean;
  signInEvent: boolean;
  maxRunMinutes: number;
}
export interface ArknightsProfile extends ArknightsConfig {
  id: string;
  name: string;
}
export interface ArknightsProfiles {
  version: 1;
  activeProfileId: string;
  profiles: ArknightsProfile[];
}
export const defaultArknightsConfig: ArknightsConfig = {
  accountName: "",
  expectedUid: "",
  clientType: "Official",
  stage: "",
  mail: false,
  recruit: true,
  creditShopping: false,
  copilotFile: "",
  copilotLoopTimes: 1,
  freeRecruit: false,
  eventOrundum: false,
  eventMining: false,
  specialAccess: false,
  signInEvent: false,
  maxRunMinutes: 120,
};
export const defaultArknightsProfiles: ArknightsProfiles = {
  version: 1,
  activeProfileId: "default",
  profiles: [{ id: "default", name: "当前账号", ...defaultArknightsConfig }],
};
export function validateArknightsConfig(input: unknown): ArknightsConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("明日方舟配置无效");
  const v = input as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "accountName",
          "expectedUid",
          "clientType",
          "stage",
          "times",
          "mail",
          "taskAward",
          "recruit",
          "creditShopping",
          "copilotFile",
          "copilotLoopTimes",
          "freeRecruit",
          "eventOrundum",
          "eventMining",
          "specialAccess",
          "signInEvent",
          "maxRunMinutes",
        ].includes(k),
    )
  )
    throw Error("不支持的明日方舟配置字段");
  if (v.clientType !== "Official" && v.clientType !== "Bilibili")
    throw Error("请选择官服或 B 服");
  const accountName = v.accountName ?? "";
  const expectedUid = v.expectedUid ?? "";
  if (
    typeof expectedUid !== "string" ||
    !/^(?:[0-9]{6,12})?$/.test(expectedUid.trim())
  )
    throw Error("UID 应为 6 至 12 位数字，或留空表示尚未绑定");
  if (
    typeof accountName !== "string" ||
    accountName.length > 100 ||
    /[\x00-\x1f\x7f-\x9f]/.test(accountName)
  )
    throw Error("账号匹配文本无效");
  if (typeof v.stage !== "string" || !/^[A-Za-z0-9@_-]{0,80}$/.test(v.stage))
    throw Error("关卡编号无效");
  if (
    v.times !== undefined &&
    (!Number.isInteger(v.times) || Number(v.times) < 1 || Number(v.times) > 999)
  )
    throw Error("旧版作战次数必须为 1 至 999");
  if (typeof v.mail !== "boolean") throw Error("邮件开关无效");
  if (v.taskAward !== undefined && typeof v.taskAward !== "boolean")
    throw Error("任务奖励开关无效");
  const recruit = v.recruit ?? true;
  if (typeof recruit !== "boolean") throw Error("公招开关无效");
  const creditShopping = v.creditShopping ?? false;
  if (typeof creditShopping !== "boolean") throw Error("信用商店开关无效");
  const copilotFile = v.copilotFile ?? "";
  if (
    typeof copilotFile !== "string" ||
    copilotFile.length > 1024 ||
    /[\x00-\x1f\x7f-\x9f]/.test(copilotFile) ||
    (copilotFile !== "" && !/\.json$/i.test(copilotFile))
  )
    throw Error("作业 JSON 路径无效");
  const copilotLoopTimes = v.copilotLoopTimes ?? 1;
  if (
    !Number.isInteger(copilotLoopTimes) ||
    Number(copilotLoopTimes) < 1 ||
    Number(copilotLoopTimes) > 99
  )
    throw Error("作业循环次数必须为 1 至 99");
  const rewardValues = [
    v.freeRecruit,
    v.eventOrundum,
    v.eventMining,
    v.specialAccess,
    v.signInEvent,
  ];
  if (
    rewardValues.some(
      (value) => value !== undefined && typeof value !== "boolean",
    )
  )
    throw Error("活动奖励开关无效");
  const rewardFlags = {
    freeRecruit: (v.freeRecruit as boolean | undefined) ?? false,
    eventOrundum: (v.eventOrundum as boolean | undefined) ?? false,
    eventMining: (v.eventMining as boolean | undefined) ?? false,
    specialAccess: (v.specialAccess as boolean | undefined) ?? false,
    signInEvent: (v.signInEvent as boolean | undefined) ?? false,
  };
  const maxRunMinutes = v.maxRunMinutes ?? 120;
  if (
    !Number.isInteger(maxRunMinutes) ||
    Number(maxRunMinutes) < 5 ||
    Number(maxRunMinutes) > 360
  )
    throw Error("运行时长上限必须为 5 至 360 分钟");
  return {
    accountName: accountName.trim(),
    expectedUid: expectedUid.trim(),
    clientType: v.clientType,
    stage: v.stage,
    mail: v.mail,
    ...(v.taskAward === undefined ? {} : { taskAward: v.taskAward as boolean }),
    recruit,
    creditShopping,
    copilotFile: copilotFile.trim(),
    copilotLoopTimes: Number(copilotLoopTimes),
    ...rewardFlags,
    maxRunMinutes: Number(maxRunMinutes),
  };
}
export function validateArknightsProfiles(input: unknown): ArknightsProfiles {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("明日方舟账号档案无效");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) => !["version", "activeProfileId", "profiles"].includes(key),
    ) ||
    value.version !== 1 ||
    typeof value.activeProfileId !== "string" ||
    !Array.isArray(value.profiles) ||
    value.profiles.length < 1 ||
    value.profiles.length > 20
  )
    throw Error("明日方舟账号档案无效");
  const profiles = value.profiles.map((inputProfile) => {
    if (
      !inputProfile ||
      typeof inputProfile !== "object" ||
      Array.isArray(inputProfile)
    )
      throw Error("明日方舟账号档案无效");
    const profile = inputProfile as Record<string, unknown>;
    if (
      Object.keys(profile).some(
        (key) =>
          ![
            "id",
            "name",
            "accountName",
            "expectedUid",
            "clientType",
            "stage",
            "times",
            "mail",
            "taskAward",
            "recruit",
            "creditShopping",
            "copilotFile",
            "copilotLoopTimes",
            "freeRecruit",
            "eventOrundum",
            "eventMining",
            "specialAccess",
            "signInEvent",
            "maxRunMinutes",
          ].includes(key),
      ) ||
      typeof profile.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile.id) ||
      typeof profile.name !== "string" ||
      !profile.name.trim() ||
      profile.name.trim().length > 40 ||
      /[\x00-\x1f\x7f-\x9f]/.test(profile.name)
    )
      throw Error("明日方舟账号档案名称或编号无效");
    return {
      id: profile.id,
      name: profile.name.trim(),
      ...validateArknightsConfig({
        accountName: profile.accountName,
        expectedUid: profile.expectedUid,
        clientType: profile.clientType,
        stage: profile.stage,
        ...(profile.times === undefined ? {} : { times: profile.times }),
        mail: profile.mail,
        ...(profile.taskAward === undefined
          ? {}
          : { taskAward: profile.taskAward }),
        ...(profile.recruit === undefined ? {} : { recruit: profile.recruit }),
        ...(profile.creditShopping === undefined
          ? {}
          : { creditShopping: profile.creditShopping }),
        ...(profile.copilotFile === undefined
          ? {}
          : { copilotFile: profile.copilotFile }),
        ...(profile.copilotLoopTimes === undefined
          ? {}
          : { copilotLoopTimes: profile.copilotLoopTimes }),
        ...(profile.freeRecruit === undefined
          ? {}
          : { freeRecruit: profile.freeRecruit }),
        ...(profile.eventOrundum === undefined
          ? {}
          : { eventOrundum: profile.eventOrundum }),
        ...(profile.eventMining === undefined
          ? {}
          : { eventMining: profile.eventMining }),
        ...(profile.specialAccess === undefined
          ? {}
          : { specialAccess: profile.specialAccess }),
        ...(profile.signInEvent === undefined
          ? {}
          : { signInEvent: profile.signInEvent }),
        ...(profile.maxRunMinutes === undefined
          ? {}
          : { maxRunMinutes: profile.maxRunMinutes }),
      }),
    };
  });
  if (
    new Set(profiles.map((profile) => profile.id)).size !== profiles.length ||
    new Set(profiles.map((profile) => profile.name)).size !== profiles.length ||
    !profiles.some((profile) => profile.id === value.activeProfileId)
  )
    throw Error("明日方舟账号档案存在重复项或当前档案不存在");
  return {
    version: 1,
    activeProfileId: value.activeProfileId,
    profiles,
  };
}
export function activeArknightsConfig(
  input: ArknightsProfiles,
): ArknightsConfig {
  const profiles = validateArknightsProfiles(input);
  const {
    id: _id,
    name: _name,
    ...config
  } = profiles.profiles.find(
    (profile) => profile.id === profiles.activeProfileId,
  )!;
  return config;
}
export function arknightsPackage(input: ArknightsConfig) {
  const config = validateArknightsConfig(input);
  return config.clientType === "Bilibili"
    ? "com.hypergryph.arknights.bilibili"
    : "com.hypergryph.arknights";
}
export function taskFor(
  id: string,
  input: ArknightsConfig,
): { type: string; params: Record<string, unknown> } {
  const config = validateArknightsConfig(input);
  validateArknightsCapabilities(config, [id]);
  switch (id) {
    case "close":
      return {
        type: "CloseDown",
        params: { client_type: config.clientType },
      };
    case "login":
      return {
        type: "StartUp",
        params: {
          client_type: config.clientType,
          start_game_enabled: true,
          ...(config.accountName ? { account_name: config.accountName } : {}),
        },
      };
    case "recruit":
      return {
        type: "Recruit",
        params: {
          enable: config.recruit,
          refresh: false,
          select: [3],
          confirm: [3],
          times: 4,
          set_time: true,
          expedite: false,
          preserve_tags: ["高级资深干员", "资深干员", "支援机械"],
          recruitment_time: { "3": 540 },
          report_to_penguin: false,
          report_to_yituliu: false,
          server: "CN",
        },
      };
    case "recruit-recognition":
      return {
        type: "Recruit",
        params: {
          enable: true,
          refresh: false,
          select: [5, 4, 3, 2, 1],
          confirm: [],
          times: 0,
          set_time: false,
          expedite: false,
          preserve_tags: [],
          report_to_penguin: false,
          report_to_yituliu: false,
          server: "CN",
        },
      };
    case "friends":
      return {
        type: "Mall",
        params: {
          visit_friends: true,
          shopping: config.creditShopping,
          buy_first: ["招聘许可", "龙门币"],
          blacklist: ["家具零件", "加急许可", "碳"],
          force_shopping_if_credit_full: config.creditShopping,
          only_buy_discount: true,
          reserve_max_credit: true,
          credit_fight: false,
        },
      };
    case "fight":
      if (!config.stage) throw Error("请先填写作战关卡");
      return {
        type: "Fight",
        params: {
          stage: config.stage,
          medicine: 0,
          medicine_expire_days: 0,
          stone: 0,
          expiring_medicine: 0,
          series: 0,
          report_to_penguin: false,
          report_to_yituliu: false,
        },
      };
    case "infrastructure":
      return {
        type: "Infrast",
        params: {
          enable: true,
          mode: 20000,
          facility: [
            "Mfg",
            "Trade",
            "Power",
            "Control",
            "Reception",
            "Office",
            "Dorm",
          ],
          drones: "Money",
          replenish: false,
          dorm_notstationed_enabled: false,
          dorm_trust_enabled: false,
          fiammetta_recovery_enabled: false,
          use_pinus_sylvestris: false,
          use_perception_information: false,
          use_worldly_plight: false,
          use_abyssal_hunter: false,
          reception_message_board: true,
          reception_clue_exchange: true,
          reception_send_clue: true,
          continue_training: false,
        },
      };
    case "award":
      return {
        type: "Award",
        params: {
          award: config.taskAward ?? true,
          mail: config.mail,
          recruit: config.freeRecruit,
          orundum: config.eventOrundum,
          mining: config.eventMining,
          specialaccess: config.specialAccess,
        },
      };
    case "depot":
      return { type: "Depot", params: { enable: true } };
    case "operator-box":
      return { type: "OperBox", params: { enable: true } };
    case "copilot":
      if (!config.copilotFile) throw Error("请先填写本地作业 JSON 路径");
      return {
        type: "Copilot",
        params: {
          enable: true,
          filename: config.copilotFile,
          loop_times: config.copilotLoopTimes,
          use_sanity_potion: false,
          formation: true,
          add_trust: false,
          ignore_requirements: false,
          support_unit_usage: 0,
        },
      };
    case "roguelike":
      return {
        type: "Roguelike",
        params: {
          enable: true,
          theme: "BlackFlow",
          mode: 0,
          squad: "指挥分队",
          roles: "取长补短",
          core_char_list: [],
          use_nonfriend_support: false,
          starts_count: 1,
          difficulty: -1,
          stop_at_final_boss: true,
        },
      };
    case "reclamation":
      return {
        type: "Reclamation",
        params: {
          enable: true,
          theme: "RelaunchAnchor",
          mode: 16,
          tools_to_craft: [],
          clear_store: false,
          increment_mode: 0,
          num_craft_batches: 1,
        },
      };
    default:
      throw Error("未知明日方舟技能");
  }
}
