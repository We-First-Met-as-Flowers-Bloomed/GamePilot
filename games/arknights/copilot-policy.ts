import engineContract from "./engine-contract.json";
export interface CopilotOperator {
  name: string;
  role?: string;
  skill?: number;
  skillUsage?: number;
  skillTimes?: number;
  requirements?: {
    elite?: number;
    level?: number;
    skillLevel?: number;
    module?: number;
  };
}

export interface CopilotAction {
  type: string;
  name?: string;
  location?: [number, number];
  direction?: string;
  kills?: number;
  costs?: number;
  costChanges?: number;
  cooling?: number;
  elapsedTime?: number;
  preDelay?: number;
  postDelay?: number;
  timeout?: number;
  skillUsage?: number;
  skillTimes?: number;
  doc?: string;
}

export interface CopilotJob {
  stageName: string;
  minimumRequired: string;
  opers: CopilotOperator[];
  groups: { name: string; opers: CopilotOperator[] }[];
  actions: CopilotAction[];
  difficulty?: number;
  /** 原始 JSON，写盘时使用，保证字段无损 */
  raw: Record<string, unknown>;
}

const ACTION_TYPES = new Set([
  "Deploy",
  "Skill",
  "Retreat",
  "SpeedUp",
  "BulletTime",
  "SkillUsage",
  "Output",
  "SkillDaemon",
  "MoveCamera",
  "ResetStopwatch",
  "Click",
  "Swipe",
  "SetUnitLocation",
  "部署",
  "技能",
  "撤退",
  "二倍速",
  "子弹时间",
  "技能用法",
  "打印",
  "摆完挂机",
  "移动镜头",
  "重置全局计时器",
  "点击",
  "滑动",
  "设置单位坐标",
]);

const DIRECTIONS = new Set([
  "Left",
  "Right",
  "Up",
  "Down",
  "None",
  "左",
  "右",
  "上",
  "下",
  "无",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function numberField(
  raw: Record<string, unknown>,
  key: string,
  min = 0,
  max = 999999999,
) {
  const value = raw[key];
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw Error(`${key} 必须是 ${min} 至 ${max} 范围内的整数`);
}
function stringField(
  raw: Record<string, unknown>,
  key: string,
  max = 160,
  allowEmpty = false,
) {
  if (
    raw[key] !== undefined &&
    (typeof raw[key] !== "string" ||
      (!allowEmpty && !raw[key]) ||
      (raw[key] as string).length > max)
  )
    throw Error(`${key} 字符串无效`);
}
function keys(raw: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(raw).some((key) => !allowed.includes(key)))
    throw Error(`${label} 包含当前协议不支持的字段`);
}
export function compareCopilotVersions(left: string, right: string): number {
  const parse = (v: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/.exec(v);
    if (!match) throw Error("MAA 版本号无效");
    return [
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      match[4] ? ["alpha", "beta", "rc"].indexOf(match[4]) : 3,
      Number(match[5] ?? 0),
    ];
  };
  const a = parse(left),
    b = parse(right);
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function parseOperator(raw: unknown, where: string): CopilotOperator {
  if (!isRecord(raw) || typeof raw.name !== "string" || !raw.name)
    throw Error(`${where}：干员缺少 name`);
  const op: CopilotOperator = { name: raw.name };
  keys(
    raw,
    ["name", "role", "skill", "skill_usage", "skill_times", "requirements"],
    where,
  );
  stringField(raw, "name");
  stringField(raw, "role");
  numberField(raw, "skill", 0, 3);
  numberField(raw, "skill_usage", 0, 3);
  numberField(raw, "skill_times");
  if (raw.requirements !== undefined && !isRecord(raw.requirements))
    throw Error(`${where}：requirements 无效`);
  if (typeof raw.role === "string") op.role = raw.role;
  if (typeof raw.skill === "number") op.skill = raw.skill;
  if (typeof raw.skill_usage === "number") op.skillUsage = raw.skill_usage;
  if (typeof raw.skill_times === "number") op.skillTimes = raw.skill_times;
  if (isRecord(raw.requirements)) {
    const r = raw.requirements;
    keys(r, ["elite", "level", "skill_level", "module"], "requirements");
    for (const [key, max] of [
      ["elite", 2],
      ["level", 90],
      ["skill_level", 10],
      ["module", 4],
    ] as const)
      numberField(r, key, -1, max);
    op.requirements = {};
    if (typeof r.elite === "number") op.requirements.elite = r.elite;
    if (typeof r.level === "number") op.requirements.level = r.level;
    if (typeof r.skill_level === "number")
      op.requirements.skillLevel = r.skill_level;
    if (typeof r.module === "number") op.requirements.module = r.module;
  }
  const impliedElite = Math.max(
    0,
    (op.skill ?? 1) - 1,
    (op.requirements?.skillLevel ?? 0) > 7
      ? 2
      : (op.requirements?.skillLevel ?? 0) > 4
        ? 1
        : 0,
    (op.requirements?.module ?? 0) > 0 ? 2 : 0,
  );
  if (
    op.requirements?.elite !== undefined &&
    op.requirements.elite >= 0 &&
    op.requirements.elite < impliedElite
  )
    throw Error(`${where}：精英化要求与技能或模组矛盾`);
  if (impliedElite > 0)
    op.requirements = {
      ...op.requirements,
      elite: Math.max(op.requirements?.elite ?? 0, impliedElite),
    };
  return op;
}

function parseLocation(raw: unknown, where: string): [number, number] {
  if (
    !Array.isArray(raw) ||
    raw.length !== 2 ||
    raw.some(
      (n) =>
        typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 100,
    )
  )
    throw Error(`${where}：location 必须是 [x, y] 数字数组`);
  return [raw[0] as number, raw[1] as number];
}

/** 严格校验作业 JSON，任何结构错误都会抛错，绝不放行到执行链。 */
export function validateCopilotJob(
  input: unknown,
  options: { engineVersion?: string; stageAliases?: string[] } = {},
): CopilotJob {
  if (!isRecord(input)) throw Error("作业必须是 JSON 对象");
  if (typeof input.stage_name !== "string" || !input.stage_name)
    throw Error("作业缺少 stage_name");
  if (
    typeof input.minimum_required !== "string" ||
    !/^v?\d+\.\d+\.\d+/.test(input.minimum_required)
  )
    throw Error("作业缺少有效的 minimum_required 版本号");
  if (
    compareCopilotVersions(
      input.minimum_required,
      options.engineVersion ?? engineContract.version,
    ) > 0
  )
    throw Error("作业最低版本高于当前 MAA 引擎版本");
  keys(
    input,
    [
      "stage_name",
      "minimum_required",
      "opers",
      "groups",
      "actions",
      "difficulty",
      "doc",
    ],
    "作业",
  );
  stringField(input, "stage_name");
  if (
    options.stageAliases &&
    !options.stageAliases.some(
      (alias) =>
        alias.toLowerCase() === input.stage_name?.toString().toLowerCase(),
    )
  )
    throw Error("作业关卡与本次目标关卡不一致");
  for (const key of ["opers", "groups"])
    if (input[key] !== undefined && !Array.isArray(input[key]))
      throw Error(`${key} 必须是数组`);
  numberField(input, "difficulty", 0, 3);
  if (input.doc !== undefined) {
    if (!isRecord(input.doc)) throw Error("doc 无效");
    keys(
      input.doc,
      ["title", "title_color", "details", "details_color"],
      "doc",
    );
    for (const key of Object.keys(input.doc))
      stringField(input.doc, key, 32768, true);
  }
  if (!Array.isArray(input.actions) || input.actions.length === 0)
    throw Error("作业缺少 actions 操作列表");
  if (
    input.actions.length > 10000 ||
    (Array.isArray(input.opers) && input.opers.length > 64) ||
    (Array.isArray(input.groups) && input.groups.length > 64)
  )
    throw Error("作业内容超出数量上限");

  const opers: CopilotOperator[] = Array.isArray(input.opers)
    ? input.opers.map((o, i) => parseOperator(o, `opers[${i}]`))
    : [];
  const groups: CopilotJob["groups"] = Array.isArray(input.groups)
    ? input.groups.map((g, i) => {
        if (!isRecord(g) || typeof g.name !== "string" || !g.name)
          throw Error(`groups[${i}]：群组缺少 name`);
        if (!Array.isArray(g.opers) || g.opers.length === 0)
          throw Error(`groups[${i}]：群组缺少候选干员`);
        keys(g, ["name", "opers"], "group");
        stringField(g, "name");
        if (g.opers.length > 64) throw Error("候选干员超出数量上限");
        return {
          name: g.name,
          opers: g.opers.map((o, j) =>
            parseOperator(o, `groups[${i}].opers[${j}]`),
          ),
        };
      })
    : [];

  const actions = input.actions.map((raw, i): CopilotAction => {
    const where = `actions[${i}]`;
    if (!isRecord(raw)) throw Error(`${where}：操作必须是对象`);
    keys(
      raw,
      [
        "type",
        "name",
        "role",
        "location",
        "direction",
        "kills",
        "costs",
        "cost_changes",
        "cooling",
        "elapsed_time",
        "pre_delay",
        "post_delay",
        "timeout",
        "skill_usage",
        "skill_times",
        "doc",
        "doc_color",
        "distance",
        "keep_kills",
        "rect",
        "begin",
        "end",
        "duration",
        "extra_swipe",
        "slope_in",
        "slope_out",
        "with_pause",
        "high_resolution_swipe_fix",
      ],
      where,
    );
    for (const key of ["type", "name", "role", "direction"])
      stringField(raw, key);
    for (const key of ["doc", "doc_color"]) stringField(raw, key, 32768, true);
    for (const key of [
      "kills",
      "costs",
      "elapsed_time",
      "pre_delay",
      "post_delay",
      "skill_times",
      "duration",
      "slope_in",
      "slope_out",
    ])
      numberField(raw, key);
    numberField(raw, "cooling", -1);
    numberField(raw, "timeout", -1);
    numberField(raw, "cost_changes", -999999999);
    numberField(raw, "skill_usage", 0, 3);
    numberField(raw, "extra_swipe", 0, 4);
    for (const key of ["keep_kills", "with_pause", "high_resolution_swipe_fix"])
      if (raw[key] !== undefined && typeof raw[key] !== "boolean")
        throw Error(`${key} 必须是布尔值`);
    for (const key of ["rect", "begin", "end"]) {
      const rect = raw[key];
      if (
        rect !== undefined &&
        (!Array.isArray(rect) ||
          rect.length !== 4 ||
          rect.some((n) => !Number.isSafeInteger(n) || n < 0) ||
          rect[2] <= 0 ||
          rect[3] <= 0 ||
          rect[0] + rect[2] > 1280 ||
          rect[1] + rect[3] > 720)
      )
        throw Error(`${key} 必须是720p画面内的有效矩形`);
    }
    if (
      raw.distance !== undefined &&
      (!Array.isArray(raw.distance) ||
        raw.distance.length !== 2 ||
        raw.distance.some(
          (n) =>
            typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > 100,
        ))
    )
      throw Error("distance 无效");
    const type = raw.type == null ? "Deploy" : String(raw.type);
    if (!ACTION_TYPES.has(type)) throw Error(`${where}：未知操作类型 ${type}`);
    const action: CopilotAction = { type };
    if (typeof raw.name === "string") action.name = raw.name;
    if (raw.location != null)
      action.location = parseLocation(raw.location, where);
    if (typeof raw.direction === "string") {
      if (!DIRECTIONS.has(raw.direction))
        throw Error(`${where}：未知朝向 ${raw.direction}`);
      action.direction = raw.direction;
    }
    if (
      (type === "Deploy" || type === "部署") &&
      (!action.name || !action.location || !action.direction)
    )
      throw Error(`${where}：部署操作必须包含 name、location 与 direction`);
    if (
      [
        "Skill",
        "技能",
        "Retreat",
        "撤退",
        "BulletTime",
        "子弹时间",
        "SkillUsage",
        "技能用法",
      ].includes(type) &&
      !action.name &&
      !action.location
    )
      throw Error(`${where}：操作缺少干员或位置`);
    if (
      ["SkillUsage", "技能用法"].includes(type) &&
      raw.skill_usage === undefined
    )
      throw Error("技能用法缺少 skill_usage");
    if (
      ["SetUnitLocation", "设置单位坐标"].includes(type) &&
      (!action.name || !action.location)
    )
      throw Error("设置单位坐标缺少 name/location");
    if (["Click", "点击"].includes(type) && !action.location && !raw.rect)
      throw Error("点击缺少位置");
    if (["Swipe", "滑动"].includes(type) && (!raw.begin || !raw.end))
      throw Error("滑动缺少起止位置");
    if (["MoveCamera", "移动镜头"].includes(type) && !raw.distance)
      throw Error("移动镜头缺少 distance");
    for (const [key, field] of [
      ["kills", "kills"],
      ["costs", "costs"],
      ["cost_changes", "costChanges"],
      ["cooling", "cooling"],
      ["elapsed_time", "elapsedTime"],
      ["pre_delay", "preDelay"],
      ["post_delay", "postDelay"],
      ["timeout", "timeout"],
      ["skill_usage", "skillUsage"],
      ["skill_times", "skillTimes"],
    ] as const) {
      if (typeof raw[key] === "number")
        (action as unknown as Record<string, unknown>)[field] = raw[key];
    }
    if (typeof raw.doc === "string") action.doc = raw.doc;
    return action;
  });

  return {
    stageName: input.stage_name,
    minimumRequired: input.minimum_required,
    opers,
    groups,
    actions,
    difficulty:
      typeof input.difficulty === "number" ? input.difficulty : undefined,
    raw: input,
  };
}
