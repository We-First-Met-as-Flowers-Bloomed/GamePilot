import type { DeviceLane, Plan, RunEvent } from "../../../packages/protocol";
import type { LaneWorker } from "./lane-runtime";
import { SkillResultQueue } from "./skill-results";
import { gamePlugins } from "../../../games/registry";

export interface LanePlanActions {
  gameStarted?(gameId: string): void;
  prepare(lane: DeviceLane): Promise<unknown>;
  arknights(lane: DeviceLane): Promise<unknown>;
  closeArknights(lane: DeviceLane): Promise<unknown>;
  onmyoji(lane: DeviceLane): Promise<unknown>;
}

export interface LanePlanResult {
  arknights: "succeeded" | "skipped";
  closeArknights: "succeeded" | "skipped";
  onmyoji: "succeeded" | "skipped";
}

export async function executeLanePlan(
  lane: DeviceLane,
  actions: LanePlanActions,
  signal?: AbortSignal,
): Promise<LanePlanResult> {
  signal?.throwIfAborted();
  await actions.prepare(lane);
  signal?.throwIfAborted();
  const result: LanePlanResult = {
    arknights: "skipped",
    closeArknights: "skipped",
    onmyoji: "skipped",
  };
  for (const plugin of gamePlugins.list().sort((a, b) => a.order - b.order)) {
    const binding = plugin.lane;
    if (!binding?.enabled(lane)) continue;
    const run = actions[binding.actionKey as "arknights" | "onmyoji"];
    if (!run) throw Error("设备槽位游戏执行动作未注册");
    actions.gameStarted?.(plugin.descriptor.id);
    await run(lane);
    signal?.throwIfAborted();
    (result as LanePlanResult & Record<string, string>)[binding.actionKey] =
      "succeeded";
    if (binding.afterRunAction) {
      const after = actions[binding.afterRunAction as "closeArknights"];
      if (!after) throw Error("设备槽位游戏结束动作未注册");
      await after(lane);
      signal?.throwIfAborted();
      (result as LanePlanResult & Record<string, string>)[
        binding.afterRunAction
      ] = "succeeded";
    }
  }
  return result;
}

export async function runWorkerPlan(
  worker: LaneWorker,
  plan: Plan,
  signal?: AbortSignal,
  saveResult: (event: RunEvent) => Promise<void> = async () => {},
) {
  signal?.throwIfAborted();
  let runId = "";
  const results = new SkillResultQueue(plan, saveResult);
  const terminal = new Map<string, RunEvent>();
  let resolve!: (event: RunEvent) => void;
  let reject!: (error: Error) => void;
  const completed = new Promise<RunEvent>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  void completed.catch(() => {});
  const exited = () => reject(new Error("设备执行器已退出，任务结果未知"));
  worker.once("exit", exited);
  const listener = (event: RunEvent) => {
    results.accept(event);
    if (
      !event.status ||
      !["succeeded", "failed", "cancelled"].includes(event.status)
    )
      return;
    if (runId && event.runId === runId) resolve(event);
    else terminal.set(event.runId, event);
  };
  worker.on("event", listener);
  const abort = () => {
    void worker.request("stop", undefined, 70000).catch(reject);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const started = await worker.request<{ runId: string }>("start", plan);
    runId = started.runId;
    results.bind(runId);
    const event = terminal.get(runId) ?? (await completed);
    await results.flush();
    signal?.throwIfAborted();
    if (event.status !== "succeeded") {
      const error = new Error(
        event.message ||
          `任务${event.status === "cancelled" ? "已取消" : "失败"}`,
      );
      if (event.status === "cancelled") error.name = "AbortError";
      throw error;
    }
    return event;
  } finally {
    if (!runId) results.bind("");
    worker.off("event", listener);
    worker.off("exit", exited);
    signal?.removeEventListener("abort", abort);
    await results.flush();
  }
}
