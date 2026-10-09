import {
  ArknightsStatisticsCollector,
  validArknightsStatistics,
  type ArknightsStatistics,
} from "./statistics";

export interface ArknightsExecutionEvidence {
  version: 1;
  taskType: string;
  submission: "not-submitted" | "submitted";
  completion: "not-started" | "native-confirmed" | "unknown";
  observedAt: string;
  taskId?: number;
  /** Last recognized settlement batch, never the cumulative run count. */
  lastSettlement?: ArknightsSettlement;
  statistics?: ArknightsStatistics;
  login?: {
    expectedUid: string;
    observedUid: string;
    observedAt: string;
    home: true;
    method?: "profile";
    homeObservedAt?: string;
  };
}
export interface ArknightsSettlement {
  stage: string;
  stars: number;
  batchRuns?: number;
}
function validSettlement(input: unknown): input is ArknightsSettlement {
  const value = input as ArknightsSettlement | undefined;
  return Boolean(
    value &&
    typeof value.stage === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.stage) &&
    Number.isInteger(value.stars) &&
    value.stars >= 0 &&
    value.stars <= 3 &&
    (value.batchRuns === undefined ||
      (Number.isSafeInteger(value.batchRuns) &&
        value.batchRuns >= 1 &&
        value.batchRuns <= 999)),
  );
}
export function validArknightsEvidence(
  input: unknown,
): input is ArknightsExecutionEvidence {
  const e = input as ArknightsExecutionEvidence | undefined;
  if (
    !e ||
    e.version !== 1 ||
    typeof e.taskType !== "string" ||
    !e.taskType ||
    e.taskType.length > 80 ||
    typeof e.observedAt !== "string" ||
    !Number.isFinite(Date.parse(e.observedAt))
  )
    return false;
  if (
    e.taskId !== undefined &&
    (!Number.isSafeInteger(e.taskId) || e.taskId < 1)
  )
    return false;
  if (e.submission === "not-submitted") {
    if (
      e.completion !== "not-started" ||
      e.taskId !== undefined ||
      e.login !== undefined
    )
      return false;
  } else if (
    e.submission !== "submitted" ||
    !["native-confirmed", "unknown"].includes(e.completion) ||
    (e.completion === "native-confirmed" && e.taskId === undefined)
  )
    return false;
  if (
    e.lastSettlement !== undefined &&
    (e.taskType !== "Fight" ||
      e.submission !== "submitted" ||
      e.taskId === undefined ||
      !validSettlement(e.lastSettlement))
  )
    return false;
  if (
    e.statistics !== undefined &&
    (e.submission !== "submitted" ||
      e.taskId === undefined ||
      !validArknightsStatistics(e.statistics, e.taskType))
  )
    return false;
  if (
    e.login &&
    (e.taskType !== "StartUp" ||
      e.completion !== "native-confirmed" ||
      e.login.home !== true ||
      typeof e.login.expectedUid !== "string" ||
      !/^\d{6,12}$/.test(e.login.expectedUid) ||
      e.login.observedUid !== e.login.expectedUid ||
      typeof e.login.observedAt !== "string" ||
      !Number.isFinite(Date.parse(e.login.observedAt)))
  )
    return false;
  if (
    e.login &&
    (e.login.method !== undefined || e.login.homeObservedAt !== undefined)
  ) {
    if (
      e.login.method !== "profile" ||
      typeof e.login.homeObservedAt !== "string" ||
      !Number.isFinite(Date.parse(e.login.homeObservedAt)) ||
      Date.parse(e.login.homeObservedAt) < Date.parse(e.login.observedAt)
    )
      return false;
  }
  return true;
}
/** Tracks one fresh MaaCore task. Callback success is native flow evidence, not reward verification. */
export class ArknightsTaskEvidence {
  private taskId?: number;
  private completed = false;
  private invalid = false;
  private lastSettlement?: ArknightsSettlement;
  private statistics?: ArknightsStatisticsCollector;
  constructor(private taskType: string) {
    this.statistics = new ArknightsStatisticsCollector(taskType);
  }
  accept(message: string) {
    const match = /^MAA (\d+): (.+)$/s.exec(message);
    if (!match) return;
    const code = Number(match[1]);
    if (
      [20000, 20001, 20002, 20003].includes(code) &&
      this.taskId !== undefined &&
      !this.completed &&
      !this.invalid
    ) {
      try {
        const value = JSON.parse(match[2]);
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.taskchain !== this.taskType ||
          value.taskid !== this.taskId
        )
          return;
        this.statistics?.accept(code, value);
        if (
          code !== 20003 ||
          this.taskType !== "Fight" ||
          value.what !== "StageDrops"
        )
          return;
        const details = value.details;
        const settlement = {
          stage: details?.stage?.stageCode,
          stars: details?.stars,
          ...(details?.cur_times === undefined
            ? {}
            : { batchRuns: details.cur_times }),
        };
        if (validSettlement(settlement)) this.lastSettlement = settlement;
      } catch {
        /* Missing/unreadable optional OCR evidence cannot fabricate a result. */
      }
      return;
    }
    if ([0, 1, 10000, 10004].includes(code)) {
      this.invalid = true;
      return;
    }
    if (code !== 10001 && code !== 10002) return;
    try {
      const value = JSON.parse(match[2]);
      if (
        value.taskchain !== this.taskType ||
        !Number.isSafeInteger(value.taskid) ||
        value.taskid < 1
      ) {
        this.invalid = true;
        this.statistics = undefined;
        return;
      }
      if (code === 10001) {
        if (this.taskId !== undefined && this.taskId !== value.taskid) {
          this.invalid = true;
          this.lastSettlement = undefined;
          this.statistics = undefined;
        }
        this.taskId = value.taskid;
      } else {
        if (this.taskId !== value.taskid) {
          this.invalid = true;
          this.statistics = undefined;
        } else this.completed = true;
      }
    } catch {
      this.invalid = true;
      this.statistics = undefined;
    }
  }
  finish(submitted: boolean, returned: boolean): ArknightsExecutionEvidence {
    const nativeConfirmed = returned && this.completed && !this.invalid;
    const statistics =
      submitted && this.taskId !== undefined
        ? this.statistics?.finish(nativeConfirmed)
        : undefined;
    return {
      version: 1,
      taskType: this.taskType,
      submission: submitted ? "submitted" : "not-submitted",
      completion: !submitted
        ? "not-started"
        : nativeConfirmed
          ? "native-confirmed"
          : "unknown",
      observedAt: new Date().toISOString(),
      ...(submitted && this.taskId !== undefined
        ? { taskId: this.taskId }
        : {}),
      ...(submitted && this.lastSettlement
        ? { lastSettlement: { ...this.lastSettlement } }
        : {}),
      ...(statistics ? { statistics } : {}),
    };
  }
}
