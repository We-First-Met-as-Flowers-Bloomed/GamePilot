import type { ExecutionLease } from "./execution-coordinator";
import type { LaneExecutionSnapshot } from "./lane-snapshot";

/** All admissions are durable before any game operation. */
export async function launchAgentBatch(
  snapshots: LaneExecutionSnapshot[],
  batchId: string,
  signal: AbortSignal,
  deps: {
    admit(
      snapshot: LaneExecutionSnapshot,
      batchId: string,
      signal: AbortSignal,
    ): Promise<ExecutionLease>;
    run(
      snapshot: LaneExecutionSnapshot,
      lease: ExecutionLease,
      batchId: string,
      signal: AbortSignal,
    ): Promise<unknown>;
  },
) {
  const leases: ExecutionLease[] = [];
  try {
    for (const snapshot of snapshots) {
      signal.throwIfAborted();
      leases.push(await deps.admit(snapshot, batchId, signal));
    }
    signal.throwIfAborted();
  } catch (error) {
    await Promise.allSettled(
      leases.map((l) =>
        l.finish("cancelled", "本批次未全部受理，没有启动游戏"),
      ),
    );
    throw error;
  }
  const jobs = snapshots.map((snapshot, i) => {
    const job = (async () => {
      try {
        signal.throwIfAborted();
        return await deps.run(snapshot, leases[i], batchId, signal);
      } catch (error) {
        await leases[i].finish(
          error instanceof Error && error.name === "AbortError"
            ? "cancelled"
            : "unknown",
          "执行中断，请核对原任务记录与现场",
        );
        throw error;
      }
    })();
    void job.catch(() => {});
    return { laneId: snapshot.lane.id, job };
  });
  return { jobs };
}
