import {
  ArknightsStatisticsCollector,
  validArknightsStatistics,
  type ArknightsStatistics,
} from "./statistics";
import { canonical, recordWithKeys } from "../../packages/protocol/struct";
import {
  copilotHash,
  type FrozenCopilotJob,
} from "../../packages/protocol/copilot";
import {
  RecognitionCollector,
  validRecognitionOutput,
  type RecognitionOutput,
} from "./recognition";

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
  copilot?: CopilotSettlementEvidence;
  recognition?: RecognitionOutput;
  login?: {
    expectedUid: string;
    observedUid: string;
    observedAt: string;
    home: true;
    method?: "profile";
    homeObservedAt?: string;
  };
}
export interface CopilotIdentityProof {
  /** Native StartUp task whose profile/home verification produced this proof. */
  taskId: number;
  expectedUid: string;
  observedUid: string;
  method: "profile";
  observedAt: string;
  homeObservedAt: string;
  home: true;
}
export interface CopilotVerificationEvidence {
  planHash: string;
  expectedUid: string;
  before: CopilotIdentityProof;
  submittedAt?: string;
  completedAt?: string;
  after?: CopilotIdentityProof;
}
export interface CopilotSettlementEvidence {
  planHash: string;
  stageId: string;
  plannedRuns: number;
  verification?: CopilotVerificationEvidence;
  settlements: {
    index: number;
    jobId: number;
    sha256: string;
    stage: string;
    stars: 3;
    node: "Copilot@StageDrops-Stars-3" | "Copilot@StageDrops-Stars-Adverse";
  }[];
}
function validCopilotSettlement(
  value: unknown,
): value is CopilotSettlementEvidence {
  const v = recordWithKeys(value, [
    "planHash",
    "stageId",
    "plannedRuns",
    "settlements",
    "verification",
  ]);
  return Boolean(
    v &&
    copilotHash(v.planHash) &&
    typeof v.stageId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v.stageId) &&
    Number.isSafeInteger(v.plannedRuns) &&
    Number(v.plannedRuns) >= 1 &&
    Number(v.plannedRuns) <= 3 &&
    Array.isArray(v.settlements) &&
    v.settlements.length <= Number(v.plannedRuns) &&
    v.settlements.every((raw, index) => {
      const e = recordWithKeys(raw, [
        "index",
        "jobId",
        "sha256",
        "stage",
        "stars",
        "node",
      ]);
      return (
        e &&
        e.index === index &&
        Number.isSafeInteger(e.jobId) &&
        Number(e.jobId) > 0 &&
        copilotHash(e.sha256) &&
        e.stage === v.stageId &&
        e.stars === 3 &&
        [
          "Copilot@StageDrops-Stars-3",
          "Copilot@StageDrops-Stars-Adverse",
        ].includes(String(e.node))
      );
    }),
  );
}
function validCopilotIdentity(
  value: unknown,
  uid: string,
): value is CopilotIdentityProof {
  const p = recordWithKeys(value, [
    "taskId",
    "expectedUid",
    "observedUid",
    "method",
    "observedAt",
    "homeObservedAt",
    "home",
  ]);
  return Boolean(
    p &&
    Number.isSafeInteger(p.taskId) &&
    Number(p.taskId) > 0 &&
    p.expectedUid === uid &&
    p.observedUid === uid &&
    p.method === "profile" &&
    p.home === true &&
    typeof p.observedAt === "string" &&
    Number.isFinite(Date.parse(p.observedAt)) &&
    typeof p.homeObservedAt === "string" &&
    Number.isFinite(Date.parse(p.homeObservedAt)) &&
    Date.parse(p.observedAt) <= Date.parse(p.homeObservedAt),
  );
}
function validCopilotVerification(
  value: unknown,
  planHash: string,
  observedAt: string,
  complete: boolean,
): boolean {
  const v = recordWithKeys(value, [
    "planHash",
    "expectedUid",
    "before",
    "submittedAt",
    "completedAt",
    "after",
  ]);
  if (
    !v ||
    v.planHash !== planHash ||
    typeof v.expectedUid !== "string" ||
    !/^\d{6,12}$/.test(v.expectedUid) ||
    !validCopilotIdentity(v.before, v.expectedUid)
  )
    return false;
  const timestamp = (value: unknown) =>
    typeof value === "string" && Number.isFinite(Date.parse(value))
      ? Date.parse(value)
      : undefined;
  const submitted = timestamp(v.submittedAt),
    completed = timestamp(v.completedAt),
    observed = Date.parse(observedAt);
  if (
    Date.parse(v.before.homeObservedAt) > observed ||
    (submitted !== undefined && submitted > observed) ||
    (completed !== undefined && completed > observed)
  )
    return false;
  if (
    (v.submittedAt !== undefined && submitted === undefined) ||
    (v.completedAt !== undefined && completed === undefined)
  )
    return false;
  if (
    submitted !== undefined &&
    (submitted < Date.parse(v.before.homeObservedAt) ||
      submitted - Date.parse(v.before.homeObservedAt) > 15000)
  )
    return false;
  if (
    completed !== undefined &&
    (submitted === undefined ||
      completed < submitted ||
      completed - submitted > 360 * 60000 + 60000)
  )
    return false;
  if (v.after !== undefined) {
    if (
      !validCopilotIdentity(v.after, v.expectedUid) ||
      completed === undefined ||
      Date.parse(v.after.observedAt) < completed ||
      Date.parse(v.after.homeObservedAt) > Date.parse(observedAt) ||
      Date.parse(observedAt) - Date.parse(v.after.homeObservedAt) > 15000
    )
      return false;
  }
  return (
    !complete ||
    (submitted !== undefined &&
      completed !== undefined &&
      v.after !== undefined)
  );
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
    e.recognition !== undefined &&
    (e.completion !== "native-confirmed" ||
      e.submission !== "submitted" ||
      e.taskId === undefined ||
      !validRecognitionOutput(e.recognition, e.taskType, e.taskId))
  )
    return false;
  if (
    e.copilot !== undefined &&
    (e.taskType !== "Copilot" ||
      e.submission !== "submitted" ||
      e.taskId === undefined ||
      !validCopilotSettlement(e.copilot) ||
      (e.completion === "native-confirmed" &&
        (e.copilot.settlements.length !== e.copilot.plannedRuns ||
          !validCopilotVerification(
            e.copilot.verification,
            e.copilot.planHash,
            e.observedAt,
            true,
          ))))
  )
    return false;
  if (
    e.taskType === "Copilot" &&
    e.completion === "native-confirmed" &&
    !e.copilot
  )
    return false;
  if (
    e.copilot?.verification !== undefined &&
    !validCopilotVerification(
      e.copilot.verification,
      e.copilot.planHash,
      e.observedAt,
      false,
    )
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
/** Historical compatibility only: the old six-field Copilot receipt proves no battle or account/home outcome. */
export function isLegacyCopilotEvidence(
  value: unknown,
): value is ArknightsExecutionEvidence {
  const e = recordWithKeys(value, [
    "version",
    "taskType",
    "submission",
    "completion",
    "observedAt",
    "taskId",
  ]);
  return Boolean(
    e &&
    Object.keys(e).length === 6 &&
    e.version === 1 &&
    e.taskType === "Copilot" &&
    e.submission === "submitted" &&
    e.completion === "native-confirmed" &&
    typeof e.observedAt === "string" &&
    Number.isFinite(Date.parse(e.observedAt)) &&
    Number.isSafeInteger(e.taskId) &&
    Number(e.taskId) > 0,
  );
}
/** Tracks one fresh MaaCore task. Callback success is native flow evidence, not reward verification. */
export class ArknightsTaskEvidence {
  private taskId?: number;
  private completed = false;
  private invalid = false;
  private lastSettlement?: ArknightsSettlement;
  private statistics?: ArknightsStatisticsCollector;
  private recognition: RecognitionCollector;
  constructor(private taskType: string) {
    this.recognition = new RecognitionCollector(taskType);
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
        this.recognition.accept(code, value);
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
      ...(nativeConfirmed &&
      this.taskId !== undefined &&
      this.recognition.finish(this.taskId)
        ? { recognition: this.recognition.finish(this.taskId) }
        : {}),
    };
  }
}
export class CopilotTaskEvidence {
  private base = new ArknightsTaskEvidence("Copilot");
  private taskId?: number;
  private completed = false;
  private invalid = false;
  private loaded?: number;
  private pending?: { node: string; details: string };
  private settlements: CopilotSettlementEvidence["settlements"] = [];
  private jobs: FrozenCopilotJob[];
  constructor(
    private hash: string,
    private stage: string,
    jobs: FrozenCopilotJob[],
  ) {
    this.jobs = structuredClone(jobs);
  }
  accept(message: string) {
    this.base.accept(message);
    const parsed = /^MAA (\d+): (.+)$/s.exec(message);
    if (!parsed) return;
    const code = Number(parsed[1]);
    if ([0, 1, 10000, 10004].includes(code)) {
      this.invalid = true;
      return;
    }
    try {
      const v = JSON.parse(parsed[2]);
      if (!v || v.taskchain !== "Copilot") return;
      if (code === 10001) {
        if (this.taskId !== undefined) this.invalid = true;
        else this.taskId = v.taskid;
        return;
      }
      if (
        v.taskid !== this.taskId ||
        !Number.isSafeInteger(this.taskId) ||
        Number(this.taskId) < 1
      ) {
        this.invalid = true;
        return;
      }
      if (code === 10002) {
        this.completed = true;
        return;
      }
      if (this.completed || this.invalid) return;
      if (code === 20001) {
        this.invalid = true;
        return;
      }
      if (code === 20003 && v.what === "CopilotListLoadTaskFileSuccess") {
        const d = v.details,
          index = d?.id,
          job = this.jobs[index];
        if (
          index !== this.settlements.length ||
          this.loaded !== undefined ||
          !job ||
          d.stage_name !== job.stageName ||
          d.file_name !== job.file
        ) {
          this.invalid = true;
          return;
        }
        this.loaded = index;
        this.pending = undefined;
        return;
      }
      if (v.what !== "ProcessTask" || ![20000, 20002].includes(code)) return;
      const d = v.details,
        node = d?.task;
      if (
        ![
          "Copilot@StageDrops-Stars-3",
          "Copilot@StageDrops-Stars-Adverse",
        ].includes(node)
      )
        return;
      if (
        this.loaded === undefined ||
        d.algorithm !== "MatchTemplate" ||
        !Number.isSafeInteger(d.exec_times) ||
        d.exec_times < 1
      ) {
        this.invalid = true;
        return;
      }
      if (code === 20000) {
        if (this.pending) this.invalid = true;
        else this.pending = { node, details: canonical(d) };
        return;
      }
      if (
        !this.pending ||
        this.pending.node !== node ||
        this.pending.details !== canonical(d)
      ) {
        this.invalid = true;
        return;
      }
      const job = this.jobs[this.loaded];
      this.settlements.push({
        index: this.loaded,
        jobId: job.id,
        sha256: job.sha256,
        stage: job.stageName,
        stars: 3,
        node,
      });
      this.pending = undefined;
      this.loaded = undefined;
    } catch {
      this.invalid = true;
    }
  }
  finish(submitted: boolean, returned: boolean): ArknightsExecutionEvidence {
    const base = this.base.finish(submitted, returned),
      confirmed =
        !this.invalid &&
        this.settlements.length === this.jobs.length &&
        base.completion === "native-confirmed";
    return {
      ...base,
      completion: submitted
        ? confirmed
          ? "native-confirmed"
          : "unknown"
        : "not-started",
      ...(submitted && base.taskId
        ? {
            copilot: {
              planHash: this.hash,
              stageId: this.stage,
              plannedRuns: this.jobs.length,
              settlements: structuredClone(this.settlements),
            },
          }
        : {}),
    };
  }
}
