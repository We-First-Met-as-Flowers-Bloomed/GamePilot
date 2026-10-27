import type { DeviceLane, Plan, RunEvent } from "../../../packages/protocol";
import type { LaneWorker } from "./lane-runtime";
import { SkillResultQueue } from "./skill-results";
import { gamePlugins } from "../../../games/registry";
import type { TrustedGameRegistry } from "../../../games/plugin";

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
  const executed = await executeRegisteredLanePlan(
    lane,
    gamePlugins,
    actions as unknown as Record<
      string,
      (lane: DeviceLane) => Promise<unknown>
    >,
    signal,
    actions.gameStarted,
  );
  return {
    arknights: executed.arknights ?? "skipped",
    closeArknights: executed.closeArknights ?? "skipped",
    onmyoji: executed.onmyoji ?? "skipped",
  };
}

/**
 * Registered action keys support additional trusted plugins without a game-name switch.
 *
 * ⚠️ 2026-10-15（账号级 Actor · P1 调研结论，勿删）：**不要在游戏之间加"失败也继续"的错误边界**。
 * `tests/lane-plan.test.ts` 里有两条刻意保留的安全性质：
 *   - 前一个游戏失败 → 不关模拟器、也**不启动下一个游戏**；
 *   - 前一个游戏成功但退出未确认 → 同样不启动下一个游戏。
 * 原因是硬件层的：一台设备同一时刻只能有一套引擎栈在驱动（方舟 = MaaCore 桥，
 * 阴阳师 = MaaFramework），上一个没干净释放就换引擎，等于让两套原生层抢同一台设备。
 *
 * 所以"每个账号 × 游戏独立"必须在**状态层与调度层**实现：
 *  - 状态层：某游戏的失败/未知只挡住**它自己**的重跑（需要可信证据，见下方注释）；
 *  - 调度层（P2）：设备不干净时由 actor 先做**设备恢复**（确认退出/重启模拟器）再跑另一个游戏。
 */
export async function executeRegisteredLanePlan(
  lane: DeviceLane,
  registry: TrustedGameRegistry,
  actions: Readonly<Record<string, (lane: DeviceLane) => Promise<unknown>>>,
  signal?: AbortSignal,
  gameStarted?: (gameId: string) => void,
): Promise<Record<string, "succeeded">> {
  signal?.throwIfAborted();
  if (
    !Object.hasOwn(actions, "prepare") ||
    typeof actions.prepare !== "function"
  )
    throw Error("设备准备动作未注册");
  await actions.prepare(lane);
  signal?.throwIfAborted();
  const result: Record<string, "succeeded"> = Object.create(null);
  for (const plugin of registry.list().sort((a, b) => a.order - b.order)) {
    const binding = plugin.lane;
    if (!binding?.enabled(lane)) continue;
    const run = Object.hasOwn(actions, binding.actionKey)
      ? actions[binding.actionKey]
      : undefined;
    if (typeof run !== "function") throw Error("设备槽位游戏执行动作未注册");
    gameStarted?.(plugin.descriptor.id);
    await run(lane);
    signal?.throwIfAborted();
    result[binding.actionKey] = "succeeded";
    if (binding.afterRunAction) {
      const after = Object.hasOwn(actions, binding.afterRunAction)
        ? actions[binding.afterRunAction]
        : undefined;
      if (typeof after !== "function")
        throw Error("设备槽位游戏结束动作未注册");
      await after(lane);
      signal?.throwIfAborted();
      result[binding.afterRunAction] = "succeeded";
    }
  }
  return result;
}

export async function runWorkerPlan(
  worker: LaneWorker,
  plan: Plan,
  signal?: AbortSignal,
  saveResult: (event: RunEvent) => Promise<void> = async () => {},
  start: () => Promise<{ runId: string }> = () => worker.request("start", plan),
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
    const started = await start();
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
