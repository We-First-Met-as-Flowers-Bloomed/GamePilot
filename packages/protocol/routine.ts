import type { Game } from "./index";

export interface RoutineStep {
  skillId: string;
  enabled: boolean;
  /** Beijing calendar weekdays: Sunday=0, Saturday=6. */
  weekdays?: number[];
}
export interface Routine {
  version: 1;
  steps: RoutineStep[];
}

export function validateRoutine(input: unknown, game?: Game): Routine {
  const object = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !keys.includes(k))
    )
      throw Error("任务清单包含不支持的字段");
    return value as Record<string, unknown>;
  };
  const value = object(input, ["version", "steps"]);
  if (
    value.version !== 1 ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 32
  )
    throw Error("任务清单版本或步骤数无效");
  const seen = new Set<string>();
  const steps = value.steps.map((raw) => {
    const s = object(raw, ["skillId", "enabled", "weekdays"]);
    if (
      typeof s.skillId !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(s.skillId) ||
      typeof s.enabled !== "boolean"
    )
      throw Error("任务步骤无效");
    if (seen.has(s.skillId)) throw Error("任务步骤不能重复");
    seen.add(s.skillId);
    if (game && !game.skills.some((skill) => skill.id === s.skillId))
      throw Error("未知技能：" + s.skillId);
    let weekdays: number[] | undefined;
    if (s.weekdays !== undefined) {
      if (
        !Array.isArray(s.weekdays) ||
        s.weekdays.length < 1 ||
        s.weekdays.length > 7 ||
        s.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
        new Set(s.weekdays).size !== s.weekdays.length
      )
        throw Error("执行星期必须为不重复的0至6");
      weekdays = [...s.weekdays].sort((a, b) => a - b);
    }
    return {
      skillId: s.skillId,
      enabled: s.enabled,
      ...(weekdays ? { weekdays } : {}),
    };
  });
  if (!steps.some((s) => s.enabled)) throw Error("至少启用一个任务");
  return { version: 1, steps };
}

export function beijingWeekday(date = new Date()) {
  if (!Number.isFinite(date.getTime())) throw Error("任务执行日期无效");
  return new Date(date.getTime() + 8 * 3600000).getUTCDay();
}
