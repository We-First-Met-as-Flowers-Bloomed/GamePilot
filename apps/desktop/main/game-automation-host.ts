import type { DeviceLane, GameSlotTarget } from "../../../packages/protocol";
import type { AutomationJob } from "../../../packages/protocol/automation";
import {
  validateRequestId,
  type ExecutionRecord,
} from "../../../packages/protocol/execution";
import type { AutomationOptions, AutomationOutcome } from "./game-automation";
import type { DailyOccurrence } from "./scheduler";

export interface AutomationHost<S extends string> {
  readLanes(): Promise<DeviceLane[]>;
  isPreview(): boolean;
  launchLane(
    lane: DeviceLane,
    batchId: string,
    maintenance: boolean,
    signal: AbortSignal,
    occurrence: DailyOccurrence,
    game: string,
    gameSlot: GameSlotTarget | undefined,
    automationJob: AutomationJob<S>,
  ): Promise<{ job: Promise<unknown> }>;
  readExecution(
    id: string,
  ): Pick<ExecutionRecord, "status" | "message"> | undefined;
}

/** The scheduler and manual saved-job entry share the App's ordinary lane admission. */
export function createAutomationRun<S extends string>(
  host: AutomationHost<S>,
  gameId: "arknights" | "onmyoji",
): AutomationOptions<S>["run"] {
  return async (input, dueAt, signal, requestId) => {
    if (host.isPreview()) throw Error("预览不能执行真实游戏任务");
    signal.throwIfAborted();
    const job = structuredClone(input);
    validateRequestId(`${requestId}:${job.laneId}`);
    const lane = (await host.readLanes()).find(
      (item) => item.id === job.laneId,
    );
    signal.throwIfAborted();
    if (!lane) throw Error("计划绑定的游戏账号不存在");
    const { job: running } = await host.launchLane(
      structuredClone(lane),
      requestId,
      false,
      signal,
      { slot: "secondary", dueAt: new Date(dueAt) },
      gameId,
      undefined,
      job,
    );
    const outcome = (): AutomationOutcome => {
      try {
        const record = host.readExecution(`${requestId}:${lane.id}`);
        if (!record)
          return {
            status: "unknown",
            message: "游戏执行回执不存在，结果尚未确认",
          };
        return {
          status: record.status === "running" ? "unknown" : record.status,
          message: record.message,
        };
      } catch (error) {
        return {
          status: "unknown",
          message: `游戏执行回执不可用，结果尚未确认：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    return { batchId: requestId, completion: running.then(outcome, outcome) };
  };
}
