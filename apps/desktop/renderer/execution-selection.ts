import type { RunEvent } from "../../../packages/protocol";
import type { ExecutionRecord } from "../../../packages/protocol/execution";

/** A batch is shared by accounts, so only exact IDs or unique lane+batch matches are usable. */
export function executionForEvent(
  event: Pick<RunEvent, "executionId" | "laneId" | "batchId"> | undefined,
  records: readonly ExecutionRecord[] = [],
): string | undefined {
  if (!event) return;
  if (event.executionId) {
    const known = records.filter((record) => record.id === event.executionId);
    if (
      known.length > 1 ||
      known.some(
        (record) =>
          record.laneId !== event.laneId || record.batchId !== event.batchId,
      )
    )
      return;
    // The read-only detail query can retrieve records outside the recent snapshot.
    return event.executionId;
  }
  if (!event.laneId || !event.batchId) return;
  const candidates = records.filter(
    (record) =>
      record.laneId === event.laneId && record.batchId === event.batchId,
  );
  return candidates.length === 1 ? candidates[0].id : undefined;
}
