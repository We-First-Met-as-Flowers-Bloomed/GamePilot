import { createHash } from "node:crypto";
import { canonical } from "../../../packages/protocol/canonical";
import type { DeviceLanes } from "../../../packages/protocol";
import type { ArknightsProfiles } from "../../../games/arknights/config";
import type { PreparedCopilotPlan } from "../../../packages/protocol/copilot";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import type { TaskRecord } from "../../../packages/protocol/task-record";
import {
  historySameDevice,
  readableHistorySnapshot,
  createHistoryIndex,
} from "../../../games/history-gate";
import type { LaneExecutionSnapshot } from "./lane-snapshot";
import { freezeLaneDevice } from "./lane-device";
import { mumuResource } from "./execution-coordinator";
import { assertNativeEffectsKnown } from "../../../games/continuation-history";
import { validStartupFaultAssociation } from "../../../packages/protocol/startup-fault";
import { completedContinuationRequestIds } from "../../../games/continuation-history";

export function copilotConfigurationRevision(
  lanes: DeviceLanes,
  profiles: ArknightsProfiles,
  engine: unknown,
): string {
  return createHash("sha256")
    .update(canonical({ lanes, profiles, engine }))
    .digest("hex");
}
export function copilotBinding(
  lanes: DeviceLanes,
  profiles: ArknightsProfiles,
  profileId: string,
) {
  const matches = lanes.lanes.filter(
    (l) =>
      l.enabled && l.arknights.enabled && l.arknights.profileId === profileId,
  );
  const profile = profiles.profiles.find((p) => p.id === profileId);
  if (
    matches.length !== 1 ||
    !profile ||
    !/^\d{6,12}$/.test(profile.expectedUid)
  )
    throw Error("作业需要唯一启用的设备通道及已填写UID的账号档案");
  if (mumuResource(matches[0].managerPath, matches[0].instance) === "*")
    throw Error("作业需要明确保存的 MuMu 安装路径和实例绑定");
  return {
    lane: freezeLaneDevice(matches[0], ["arknights"]),
    profile: structuredClone(profile),
  };
}
/** Explicit temporary confirmation allows another bounded job, but never bypasses uncertain history. */
export function freezeCopilotExecution(
  plan: PreparedCopilotPlan,
  lanes: DeviceLanes,
  profiles: ArknightsProfiles,
  engine: unknown,
  requests: ExecutionRecord[],
  tasks: TaskRecord[],
  now = new Date(),
): LaneExecutionSnapshot {
  const { lane, profile } = copilotBinding(
    lanes,
    profiles,
    plan.account.profileId,
  );
  if (
    copilotConfigurationRevision(lanes, profiles, engine) !== plan.revision ||
    plan.account.revision !== plan.revision ||
    profile.expectedUid !== plan.account.expectedUid ||
    profile.clientType !== plan.account.clientType ||
    now.getTime() >= Date.parse(plan.expiresAt)
  )
    throw Error("账号、设备或引擎已变化，请重新准备作业");
  const target: ExecutionRecord = {
    version: 1,
    id: "copilot-history-gate",
    source: "single",
    fingerprint: plan.planHash,
    status: "running",
    startedAt: now.toISOString(),
    message: "",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    snapshot: { lane },
  };
  const index = createHistoryIndex(requests, tasks);
  const covered = completedContinuationRequestIds(requests, tasks);
  const unsafe = (status: string) => status !== "succeeded";
  for (const request of requests) {
    if (!historySameDevice(target, request)) continue;
    const linked = index.tasks(request.id);
    for (const task of linked)
      assertNativeEffectsKnown(task, now, request, tasks, []);
    const noTaskStartup =
      request.status === "failed" &&
      !!request.resolution &&
      !!request.startupFault &&
      validStartupFaultAssociation(request) &&
      [
        "mumu-state-unavailable",
        "mumu-launch-failed",
        "mumu-boot-timeout",
      ].includes(request.startupFault.code) &&
      !linked.length &&
      !tasks.some(
        (t) => t.batchId === request.batchId && t.laneId === request.laneId,
      ) &&
      request.resources.length === 1 &&
      request.resources[0] === target.resources[0];
    if (
      !readableHistorySnapshot(request) ||
      index.requests(request.id).length !== 1 ||
      (unsafe(request.status) && !noTaskStartup && !covered.has(request.id)) ||
      linked.some(
        (t) =>
          (unsafe(t.status) && !covered.has(request.id)) ||
          t.executionId !== request.id ||
          t.laneId !== request.laneId ||
          t.batchId !== request.batchId,
      )
    )
      throw Error(
        "设备存在未核对的执行记录；处置说明不能替代提交核验，请完成原请求的账号对账或已验证续跑",
      );
  }
  for (const task of index.orphans())
    if (
      unsafe(task.status) &&
      (task.laneId === lane.id ||
        task.instance === lane.instance ||
        (!task.laneId && task.instance === undefined))
    )
      throw Error("设备存在未关联的任务记录，请先核对");
  lane.onmyoji.enabled = false;
  return {
    lane,
    profile,
    startedAt: now.toISOString(),
    arknightsPlan: { gameId: "arknights", mode: "live", skillIds: ["copilot"] },
    copilot: structuredClone(plan),
  };
}
