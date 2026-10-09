import { win32 } from "node:path";
import {
  validateDevice,
  type AutomationSettings,
  type DeviceLane,
  type DeviceLanes,
  type Settings,
} from "../../../packages/protocol";
import type { ExecutionRecord } from "../../../packages/protocol/execution";
import {
  assessExecution,
  type DeviceInspection,
} from "../../../packages/protocol/recovery";
import { ExecutionCoordinator, mumuResource } from "./execution-coordinator";
import { RunLedger } from "./run-ledger";
import { currentMuMuDevice } from "./mumu";

export async function recoveryDevice(
  record: ExecutionRecord,
  lanes: DeviceLanes,
  automation: AutomationSettings,
  settings: Settings,
  lookup = currentMuMuDevice,
) {
  if (record.laneId) {
    const original = record.snapshot.lane as DeviceLane | undefined;
    const current = lanes.lanes.find((l) => l.id === record.laneId);
    if (
      !original ||
      !current ||
      original.id !== record.laneId ||
      mumuResource(original.managerPath, original.instance) === "*" ||
      mumuResource(original.managerPath, original.instance) !==
        mumuResource(current.managerPath, current.instance) ||
      original.arknights?.profileId !== current.arknights.profileId
    )
      throw Error("设备或账号绑定已变化，不能使用新绑定核对旧请求");
    return lookup(original.managerPath, original.instance);
  }
  const original = record.snapshot.automation as AutomationSettings | undefined;
  if (!original || original.launchEmulator !== automation.launchEmulator)
    throw Error("原单项设备绑定不完整或已变化");
  if (original.launchEmulator) {
    if (
      mumuResource(original.managerPath, original.instance) !==
      mumuResource(automation.managerPath, automation.instance)
    )
      throw Error("单项 MuMu 绑定已变化");
    return lookup(original.managerPath, original.instance);
  }
  const device = record.snapshot.device as Settings | undefined;
  if (
    !device ||
    !device.adbPath ||
    !device.address ||
    device.address !== settings.address ||
    win32.normalize(device.adbPath).toLowerCase() !==
      win32.normalize(settings.adbPath).toLowerCase()
  )
    throw Error("单项 ADB 绑定已变化或缺失");
  return validateDevice({
    name: "原单项设备",
    adbPath: device.adbPath,
    address: device.address,
  });
}

export class RecoveryService {
  constructor(
    private executions: ExecutionCoordinator,
    private ledger: RunLedger,
    private appVersion: string,
    private captureDevice: (
      record: ExecutionRecord,
    ) => Promise<DeviceInspection>,
  ) {}
  review(id: string) {
    this.ledger.assertHealthy();
    const record = this.executions.get(id);
    return assessExecution(
      record,
      this.ledger.forExecution(id),
      this.appVersion,
    );
  }
  async capture(id: string) {
    const record = this.executions.get(id);
    if (record.status === "running" || record.resolution)
      throw Error("请先停止任务；已结束处理的请求不能重新抓取现场");
    if (
      (record.snapshot.plan as { mode?: string } | undefined)?.mode ===
      "rehearsal"
    )
      throw Error("演练请求不连接真实设备");
    // Conservative global read lock also excludes legacy device/setup operations.
    return this.executions.inspect(["*"], () => this.captureDevice(record));
  }
  resolve(id: string, note: string) {
    return this.executions.resolve(id, note);
  }
}
