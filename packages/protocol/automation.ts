export interface AutomationJob<S extends string = string> {
  id: string;
  name: string;
  laneId: string;
  enabled: boolean;
  /** Local wall-clock time, HH:mm. Weekdays follow Date.getDay(): Sunday is 0. */
  time: string;
  weekdays: number[];
  skillIds: S[];
  /** Only today's latest due job for a channel is eligible for catch-up. */
  catchUp: boolean;
}
export interface AutomationConfig<S extends string = string> {
  version: 1;
  enabled: boolean;
  jobs: AutomationJob<S>[];
}
export interface RunAutomationJobInput {
  jobId: string;
  requestId?: string;
}

function record(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw Error("自动任务包含不支持的字段");
  return input as Record<string, unknown>;
}
export function validateAutomation<S extends string>(
  input: unknown,
  skills: readonly S[],
): AutomationConfig<S> {
  const value = record(input, ["version", "enabled", "jobs"]);
  if (
    value.version !== 1 ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 128
  )
    throw Error("自动任务配置无效");
  const jobs = value.jobs.map((inputJob) => {
    const job = record(inputJob, [
      "id",
      "name",
      "laneId",
      "enabled",
      "time",
      "weekdays",
      "skillIds",
      "catchUp",
    ]);
    for (const id of [job.id, job.laneId])
      if (
        typeof id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
      )
        throw Error("自动任务或渠道编号无效");
    if (
      typeof job.name !== "string" ||
      !job.name.trim() ||
      job.name.trim().length > 80 ||
      /[\x00-\x1f\x7f]/.test(job.name)
    )
      throw Error("自动任务名称无效");
    if (typeof job.enabled !== "boolean" || typeof job.catchUp !== "boolean")
      throw Error("自动任务开关无效");
    if (
      typeof job.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(job.time)
    )
      throw Error("定时时间必须为 HH:mm");
    if (
      !Array.isArray(job.weekdays) ||
      !job.weekdays.length ||
      job.weekdays.length > 7 ||
      job.weekdays.some(
        (day) => !Number.isInteger(day) || day < 0 || day > 6,
      ) ||
      new Set(job.weekdays).size !== job.weekdays.length
    )
      throw Error("请选择不重复的星期，周日为 0，周六为 6");
    if (
      !Array.isArray(job.skillIds) ||
      !job.skillIds.length ||
      job.skillIds.length > skills.length ||
      job.skillIds.some((id) => !skills.includes(id)) ||
      new Set(job.skillIds).size !== job.skillIds.length
    )
      throw Error("请选择不重复的任务步骤");
    return {
      id: job.id as string,
      name: job.name.trim(),
      laneId: job.laneId as string,
      enabled: job.enabled,
      time: job.time,
      weekdays: [...job.weekdays] as number[],
      skillIds: [...job.skillIds] as S[],
      catchUp: job.catchUp,
    };
  });
  if (new Set(jobs.map((job) => job.id)).size !== jobs.length)
    throw Error("自动任务编号不能重复");
  return { version: 1, enabled: value.enabled, jobs };
}
