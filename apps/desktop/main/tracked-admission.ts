import type { LaneExecutionSnapshot } from "./lane-snapshot";

/** Register cancellation before the first durable admission; keep it until all jobs settle. */
export async function withTrackedAdmission<
  T extends { jobs: { job: Promise<unknown> }[] },
>(
  snapshots: LaneExecutionSnapshot[],
  external: AbortSignal,
  preparations: Map<string, AbortController>,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (snapshots.some((snapshot) => preparations.has(snapshot.lane.id)))
    throw new Error("目标账号正在受理");
  const controller = new AbortController();
  const cancel = () => controller.abort(external.reason);
  external.addEventListener("abort", cancel, { once: true });
  if (external.aborted) cancel();
  for (const snapshot of snapshots)
    preparations.set(snapshot.lane.id, controller);
  const clear = () => {
    external.removeEventListener("abort", cancel);
    for (const snapshot of snapshots)
      if (preparations.get(snapshot.lane.id) === controller)
        preparations.delete(snapshot.lane.id);
  };
  try {
    const result = await work(controller.signal);
    void Promise.allSettled(result.jobs.map((entry) => entry.job)).then(clear);
    return result;
  } catch (error) {
    clear();
    throw error;
  }
}
