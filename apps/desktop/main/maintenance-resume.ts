import type { DeviceLane } from "../../../packages/protocol";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import { taskActive } from "../../../packages/protocol/task-record";
import { dailyLaneScope, maintenanceLanes } from "./daily-policy";
import { mumuResource } from "./execution-coordinator";
import { assertMaintenanceClear } from "./maintenance-guard";

export interface MaintenanceResumeScheduler {
  gateState(scope: string): Promise<{ blocked: boolean }>;
  clearBlocked(scope: string): Promise<void>;
}

export interface MaintenanceResumeInput {
  lanes: DeviceLane[];
  requests: ExecutionRecord[];
  tasks: TaskRecord[];
  getScheduler(
    lane: DeviceLane,
  ): MaintenanceResumeScheduler | Promise<MaintenanceResumeScheduler>;
}

export interface MaintenanceResumeResult {
  released: string[];
  blocked: { laneName: string; message: string }[];
}

export async function releaseMaintenancePauses(
  input: MaintenanceResumeInput,
): Promise<MaintenanceResumeResult> {
  const result: MaintenanceResumeResult = { released: [], blocked: [] };
  const requestsById = new Map(
    input.requests.map((request) => [request.id, request]),
  );
  for (const lane of maintenanceLanes(input.lanes)) {
    try {
      const resource = mumuResource(lane.managerPath, lane.instance);
      const matches = (request: ExecutionRecord) =>
        resource === "*" ||
        request.resources.some((key) => key === "*" || key === resource);
      const busy =
        input.requests.some(
          (request) => request.status === "running" && matches(request),
        ) ||
        input.tasks.some((task) => {
          if (task.plan.mode !== "live" || !taskActive(task.status))
            return false;
          const request = task.executionId
            ? requestsById.get(task.executionId)
            : undefined;
          return request
            ? matches(request)
            : task.laneId === lane.id || !task.laneId;
        });
      if (busy)
        throw Error(
          `${lane.name} 有任务正在执行，仍暂停自动维护；请等待任务结束后在任务详情核对已有请求。`,
        );

      // A settings toggle is not an operator disposition of an uncertain result.
      assertMaintenanceClear(lane, input.requests, input.tasks);
      const scheduler = await input.getScheduler(lane);
      const scope = dailyLaneScope(lane);
      if (!(await scheduler.gateState(scope)).blocked) continue;
      await scheduler.clearBlocked(scope);
      if ((await scheduler.gateState(scope)).blocked)
        throw Error(`${lane.name} 仍暂停自动维护，维护闸门尚未解除。`);
      result.released.push(lane.name);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result.blocked.push({
        laneName: lane.name,
        message: `${lane.name} 的自动维护仍暂停：${detail} 请打开任务详情核对并处理已有请求后再启用维护。`,
      });
    }
  }
  return result;
}
