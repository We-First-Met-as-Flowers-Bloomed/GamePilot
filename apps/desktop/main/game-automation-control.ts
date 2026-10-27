import type { DeviceLane } from "../../../packages/protocol";
import { agentObject } from "../../../packages/protocol/agent";
import {
  validateRequestId,
  type ExecutionRecord,
} from "../../../packages/protocol/execution";
import type { AutomationDocument } from "./game-automation";

type GameId = "arknights" | "onmyoji";
interface Ports {
  readLanes(): Promise<DeviceLane[]>;
  findExecution(
    id: string,
  ):
    | Pick<
        ExecutionRecord,
        "batchId" | "laneId" | "status" | "message" | "snapshot"
      >
    | undefined;
  launch(lane: DeviceLane, gameId: GameId, requestId: string): Promise<void>;
  service(gameId: GameId): {
    state(): Promise<AutomationDocument>;
    tick(): Promise<{ batchId: string }[]>;
    runNow(input: {
      jobId: string;
      requestId?: string;
    }): Promise<{ batchId: string }>;
    enableWithCutover(): Promise<unknown>;
  };
  busy(): boolean;
}
function game(value: unknown): GameId {
  if (value !== "arknights" && value !== "onmyoji") throw Error("游戏范围无效");
  return value;
}
/** Fixed saved-plan API; no controller, address, skill or budget overrides cross this boundary. */
export function createGameAutomationControl(p: Ports) {
  function idle() {
    if (p.busy()) throw Error("自动计划或设置操作正在进行");
  }
  function record(input: Record<string, unknown>) {
    const gameId = game(input.gameId);
    const entry = p.findExecution(
      validateRequestId(`${input.batchId}:${input.laneId}`),
    );
    if (
      !entry ||
      (gameId === "arknights"
        ? !entry.snapshot.arknightsPlan || !!entry.snapshot.onmyojiPlan
        : !entry.snapshot.onmyojiPlan || !!entry.snapshot.arknightsPlan)
    )
      throw Error("请求不属于此游戏范围");
    return {
      gameId,
      batchId: entry.batchId,
      laneId: entry.laneId,
      status: entry.status,
      message: entry.message,
    };
  }
  return {
    "game-automation": async (input: Record<string, unknown>) =>
      p.service(game(input.gameId)).state(),
    "game-tick": async (input: Record<string, unknown>) => {
      idle();
      return { batches: await p.service(game(input.gameId)).tick() };
    },
    "game-run-status": async (input: Record<string, unknown>) => record(input),
    "game-run-job": async (input: Record<string, unknown>) => {
      idle();
      const value = agentObject(input, ["gameId", "jobId", "requestId"]);
      return p.service(game(value.gameId)).runNow({
        jobId: value.jobId as string,
        requestId: value.requestId as string,
      });
    },
    "game-run-channel": async (input: Record<string, unknown>) => {
      idle();
      const value = agentObject(input, ["gameId", "laneId", "requestId"]);
      const gameId = game(value.gameId),
        batchId = validateRequestId(value.requestId);
      const lane = (await p.readLanes()).find(
        (item) => item.id === value.laneId,
      );
      if (!lane?.enabled || !lane[gameId].enabled)
        throw Error("账号渠道未启用或不存在");
      const existing = p.findExecution(
        validateRequestId(`${batchId}:${lane.id}`),
      );
      if (existing) return record({ gameId, laneId: lane.id, batchId });
      await p.launch(lane, gameId, batchId);
      return { batchId };
    },
    "onmyoji-migrate-schedule": async (_input: Record<string, unknown>) => {
      idle();
      return p.service("onmyoji").enableWithCutover();
    },
  };
}
