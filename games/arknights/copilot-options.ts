/** MaaAssistantArknights v6.20.1: docs/zh-cn/protocol/integration.md (Copilot),
 * src/MaaCore/Task/Interface/CopilotTask.{cpp,h}, BattleFormationTask.h.
 * stageNavigation and time limits belong to the App; they are not native keys.
 */
export interface CopilotAdditionalOperator {
  name: string;
  /** 0 keeps the game's selected skill; 1–3 selects a skill. */
  skill: number;
}
export interface CopilotListEntry {
  filename: string;
  /** Native nav_name_override; omit to infer the navigation code from the file. */
  stageName?: string;
  isRaid?: boolean;
}
export interface ResolvedArknightsCopilotOptions {
  formation: boolean;
  formationIndex: number;
  supportUnitUsage: 0 | 1 | 2 | 3;
  supportUnitName: string;
  userAdditional: CopilotAdditionalOperator[];
  loopTimes: number;
  /** Uses a one-entry copilot_list for navigation, because Core has no stage_navigation key. */
  stageNavigation: boolean;
  stageName: string;
  isRaid: boolean;
  list: CopilotListEntry[];
  /** Explicit user consent. Core exposes a boolean, with no potion-count limit. */
  useSanityPotion: boolean;
  addTrust: boolean;
  ignoreRequirements: boolean;
  operboxDataPath: string;
  maxRunMinutes: number;
}
export type ArknightsCopilotOptions = Partial<ResolvedArknightsCopilotOptions>;
export interface ArknightsCopilotConfigInput {
  copilotFile?: string;
  copilotLoopTimes?: number;
  copilotOptions?: ArknightsCopilotOptions;
}

export const defaultArknightsCopilotOptions: ResolvedArknightsCopilotOptions = {
  // Preserve the App's existing automatic-formation behavior for old profiles.
  formation: true,
  formationIndex: 0,
  supportUnitUsage: 0,
  supportUnitName: "",
  userAdditional: [],
  loopTimes: 1,
  stageNavigation: false,
  stageName: "",
  isRaid: false,
  list: [],
  useSanityPotion: false,
  addTrust: false,
  ignoreRequirements: false,
  operboxDataPath: "",
  maxRunMinutes: 120,
};

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const text = (value: unknown, max = 100): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  value === value.trim() &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value);
const jsonPath = (value: unknown, optional = false): value is string =>
  text(value, 1024) &&
  ((optional && value === "") ||
    (/\.json$/i.test(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)));
const knownKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const checks: Record<
  keyof ResolvedArknightsCopilotOptions,
  (value: unknown) => boolean
> = {
  formation: (value) => typeof value === "boolean",
  formationIndex: (value) => integer(value, 0, 4),
  supportUnitUsage: (value) => integer(value, 0, 3),
  supportUnitName: text,
  userAdditional: (value) =>
    Array.isArray(value) &&
    value.length <= 12 &&
    value.every(
      (oper) =>
        plain(oper) &&
        knownKeys(oper, ["name", "skill"]) &&
        text(oper.name) &&
        oper.name !== "" &&
        integer(oper.skill, 0, 3),
    ) &&
    new Set(value.map((oper) => oper.name)).size === value.length,
  loopTimes: (value) => integer(value, 1, 99),
  stageNavigation: (value) => typeof value === "boolean",
  stageName: text,
  isRaid: (value) => typeof value === "boolean",
  list: (value) =>
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (entry) =>
        plain(entry) &&
        knownKeys(entry, ["filename", "stageName", "isRaid"]) &&
        jsonPath(entry.filename) &&
        (entry.stageName === undefined || text(entry.stageName)) &&
        (entry.isRaid === undefined || typeof entry.isRaid === "boolean"),
    ),
  useSanityPotion: (value) => typeof value === "boolean",
  addTrust: (value) => typeof value === "boolean",
  ignoreRequirements: (value) => typeof value === "boolean",
  operboxDataPath: (value) => jsonPath(value, true),
  maxRunMinutes: (value) => integer(value, 5, 360),
};

export function validateArknightsCopilotOptions(
  input: unknown,
): ArknightsCopilotOptions {
  if (!plain(input)) throw Error("方舟普通作业参数无效");
  for (const [key, value] of Object.entries(input)) {
    if (
      !Object.hasOwn(checks, key) ||
      !checks[key as keyof typeof checks](value)
    )
      throw Error(`方舟普通作业参数 ${key} 无效或不支持`);
  }
  const valid = structuredClone(input) as ArknightsCopilotOptions;
  if (valid.supportUnitUsage === 2 && !valid.supportUnitName)
    throw Error("指定助战模式需要填写助战干员名称");
  if (
    (valid.stageNavigation || valid.list?.length) &&
    (valid.loopTimes ?? 1) !== 1
  )
    throw Error("循环次数仅支持不导航的单文件作业；导航或队列只能执行一遍");
  if (valid.isRaid && !valid.stageNavigation && !valid.list?.length)
    throw Error("突袭模式需要开启关卡导航");
  return valid;
}

export function resolveArknightsCopilotOptions(
  options?: ArknightsCopilotOptions,
  legacyLoopTimes = 1,
): ResolvedArknightsCopilotOptions {
  if (!integer(legacyLoopTimes, 1, 99))
    throw Error("普通作业循环次数必须为 1–99");
  const valid =
    options === undefined ? {} : validateArknightsCopilotOptions(options);
  const value = {
    ...structuredClone(defaultArknightsCopilotOptions),
    loopTimes: legacyLoopTimes,
    ...valid,
  };
  if ((value.stageNavigation || value.list.length) && value.loopTimes !== 1)
    throw Error("循环次数仅支持不导航的单文件作业；导航或队列只能执行一遍");
  return value;
}

/** A closed mapping: no caller-supplied native JSON, remote URLs, or supply-count aliases. */
export function nativeCopilotTaskOptions(
  config: ArknightsCopilotConfigInput = {},
): Record<string, unknown> {
  const value = resolveArknightsCopilotOptions(
    config.copilotOptions,
    config.copilotLoopTimes ?? 1,
  );
  const queue = value.list.length
    ? value.list
    : value.stageNavigation
      ? [
          {
            filename: config.copilotFile ?? "",
            stageName: value.stageName,
            isRaid: value.isRaid,
          },
        ]
      : undefined;
  if (queue) {
    if (queue.some((entry) => !jsonPath(entry.filename)))
      throw Error("请为每项作业填写本地 JSON 路径");
  } else if (!jsonPath(config.copilotFile))
    throw Error("请先填写本地作业 JSON 路径");
  return {
    enable: true,
    ...(queue
      ? {
          copilot_list: queue.map((entry, id) => ({
            id,
            filename: entry.filename,
            ...(entry.stageName ? { nav_name_override: entry.stageName } : {}),
            is_raid: entry.isRaid ?? false,
          })),
        }
      : { filename: config.copilotFile, loop_times: value.loopTimes }),
    formation: value.formation,
    formation_index: value.formationIndex,
    support_unit_usage: value.supportUnitUsage,
    support_unit_name: value.supportUnitName,
    user_additional: value.userAdditional,
    use_sanity_potion: value.useSanityPotion,
    add_trust: value.addTrust,
    ignore_requirements: value.ignoreRequirements,
    ...(value.operboxDataPath
      ? { operbox_data_path: value.operboxDataPath }
      : {}),
  };
}
