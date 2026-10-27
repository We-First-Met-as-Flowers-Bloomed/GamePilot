/** Shared evidence-based daily acceptance; business day is Asia/Shanghai. */
export interface DailyStepOutcome {
  readonly skill: string;
  readonly status: string;
  /** A skip must reference an earlier real success in these supplied records. */
  readonly evidence?: { readonly kind: string; readonly runStartedAt: string };
}
export interface DailyRunRecord {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcomes: readonly DailyStepOutcome[];
}
export interface DailyRunSummary {
  readonly index: number;
  readonly finishedAt: string;
  readonly succeeded: number;
  readonly skipped: number;
  readonly skippedSkills: readonly string[];
  readonly failed: number;
  readonly failedSkills: readonly string[];
  readonly missing: readonly string[];
}
export interface IdempotencyReport {
  readonly runs: number;
  readonly perRun: readonly DailyRunSummary[];
  readonly idempotent: boolean;
  readonly reasons: readonly string[];
}
export {
  summarizeDailyIdempotency,
  toDailyRunRecord,
} from "./daily-idempotency-core.mjs";
