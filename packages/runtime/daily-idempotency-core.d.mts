import type { DailyRunRecord, IdempotencyReport } from "./daily-idempotency";
export function summarizeDailyIdempotency(
  runs: readonly DailyRunRecord[],
  expectedSkills: readonly string[],
): IdempotencyReport;
export function toDailyRunRecord(input: unknown): DailyRunRecord | null;
