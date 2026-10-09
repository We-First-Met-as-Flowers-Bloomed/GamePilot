import type { RunEvent, RunStatus } from "./index";
import type { ExecutionRecord } from "./execution";
/** Older events require an exact receipt association; missing scope remains unknown. */
export function eventExecutionSource(
  event: RunEvent,
  requests: readonly ExecutionRecord[] = [],
): ExecutionRecord["source"] | undefined {
  const matches = requests.filter(
    (r) =>
      r.laneId === event.laneId &&
      (event.executionId
        ? r.id === event.executionId
        : Boolean(event.batchId) && r.batchId === event.batchId),
  );
  if (matches.length > 1) return undefined;
  const declared = event.executionSource;
  const receipt = matches[0]?.source;
  if (declared && receipt && declared !== receipt) return undefined;
  const source =
    receipt ?? declared ?? (event.maintenance ? "maintenance" : undefined);
  if (event.maintenance && source !== "maintenance") return undefined;
  return source && ["daily", "single", "maintenance"].includes(source)
    ? source
    : undefined;
}
export const isActiveStatus = (status?: RunStatus | null) =>
  status === "queued" || status === "running" || status === "stopping";
export const runKey = (event: RunEvent) =>
  JSON.stringify([event.laneId ?? "", event.runId]);
export function latestRunStates(events: RunEvent[]) {
  const states = new Map<string, RunEvent>();
  for (const event of events)
    if (event.status) states.set(runKey(event), event);
  return [...states.values()];
}
export function aggregateStatus(events: RunEvent[]): RunStatus | null {
  const active = latestRunStates(events).filter((event) =>
    isActiveStatus(event.status),
  );
  if (active.length)
    return active.every((event) => event.status === "stopping")
      ? "stopping"
      : "running";
  return [...events].reverse().find((event) => event.status)?.status ?? null;
}
export function boundRunHistory(events: RunEvent[], limit = 500): RunEvent[] {
  // Keep daily, single, maintenance and legacy-unknown results independently.
  // Keys include lane id: parallel lanes deliberately share a batch run id.
  const states = latestRunStates(events);
  const perLane = new Map<string, RunEvent>();
  for (const event of events)
    if (event.status && (!event.laneId || event.runId === event.batchId))
      perLane.set(
        JSON.stringify([
          event.laneId ?? "",
          eventExecutionSource(event) ?? "unknown",
        ]),
        event,
      );
  const pinned = new Set([
    ...states.filter((event) => isActiveStatus(event.status)),
    ...perLane.values(),
  ]);
  // Reserve all status slots before filling with logs. Trimming a provisional
  // tail after prepending missing pins can evict a different pin from that tail.
  const indices = new Set<number>();
  for (let i = events.length - 1; i >= 0 && indices.size < limit; i--)
    if (pinned.has(events[i])) indices.add(i);
  for (let i = events.length - 1; i >= 0 && indices.size < limit; i--)
    indices.add(i);
  return [...indices].sort((a, b) => a - b).map((index) => events[index]);
}
