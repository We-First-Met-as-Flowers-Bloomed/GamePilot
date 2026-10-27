import type { Plan } from "../packages/protocol";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import { parseExecutionSnapshot } from "../packages/protocol/execution-snapshot";
import { asRecord } from "../packages/protocol/struct";
import { historyGameDay, historyPlan } from "./agent-history";

export function readableHistorySnapshot(request: ExecutionRecord) {
  const view = parseExecutionSnapshot(request.snapshot);
  return view && ["legacy", "current"].includes(view.schemaStatus)
    ? view
    : undefined;
}
export function frozenHistoryPlans(
  request: ExecutionRecord,
): Plan[] | undefined {
  try {
    const snapshot = readableHistorySnapshot(request)?.raw;
    if (!snapshot) return;
    const raw = [
      snapshot.plan,
      snapshot.arknightsPlan,
      snapshot.onmyojiPlan,
    ].filter((p) => p !== undefined);
    return raw.length ? raw.map(historyPlan) : undefined;
  } catch {
    return;
  }
}
function managerPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value))
    return;
  const segments: string[] = [];
  for (const segment of value.replace(/\\/g, "/").toLowerCase().split("/")) {
    if (segment === ".") continue;
    if (segment === ".." && segments.length > 1) segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}
function canonicalResource(value: string): string {
  const match = /^mumu:(.+)#(\d+)$/i.exec(value);
  return match
    ? `mumu:${managerPath(match[1]) ?? match[1].toLowerCase()}#${Number(match[2])}`
    : value;
}
/** Physical overlap is conservative even when a snapshot cannot be interpreted. */
export function historySameDevice(
  parent: ExecutionRecord,
  other: ExecutionRecord,
): boolean {
  const resources = parent.resources.map(canonicalResource);
  if (
    resources.includes("*") ||
    other.resources.includes("*") ||
    other.resources.some((item) => resources.includes(canonicalResource(item)))
  )
    return true;
  const left = asRecord(parent.snapshot.lane),
    right = asRecord(other.snapshot.lane);
  const leftPath = managerPath(left?.managerPath),
    rightPath = managerPath(right?.managerPath);
  return (
    !!leftPath && leftPath === rightPath && left?.instance === right?.instance
  );
}
export function historyTouchesDay(
  gameId: string,
  start: string,
  end: string | undefined,
  now: Date,
): boolean {
  const first = historyGameDay(gameId, start),
    last = end ? historyGameDay(gameId, end) : undefined;
  const today = historyGameDay(gameId, now.toISOString());
  return !first || !last || !today || (first <= today && last >= today);
}
/** Duplicate and orphan evidence is retained; indexing never chooses an arbitrary winner. */
export function createHistoryIndex(
  requests: readonly ExecutionRecord[],
  tasks: readonly TaskRecord[],
) {
  const byRequest = new Map<string, ExecutionRecord[]>(),
    byExecution = new Map<string, TaskRecord[]>();
  for (const request of requests) {
    const group = byRequest.get(request.id) ?? [];
    group.push(request);
    byRequest.set(request.id, group);
  }
  for (const task of tasks) {
    const key = task.executionId ?? "";
    const group = byExecution.get(key) ?? [];
    group.push(task);
    byExecution.set(key, group);
  }
  return {
    requests: (id: string) => [...(byRequest.get(id) ?? [])],
    tasks: (id: string) => [...(byExecution.get(id) ?? [])],
    orphans: () =>
      tasks.filter((t) => !t.executionId || !byRequest.has(t.executionId)),
  };
}
