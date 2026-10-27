/**
 * 设置与设备存储域的 IPC 注册（组合根第一步的样板切片）。
 *
 * 背景：`apps/desktop/main/index.ts` 目前是一个 4,600+ 行的 `app.whenReady()` 闭包，
 * 69 个 `gp:*` handler 与业务状态混在一起，导致最高风险的编排逻辑无法被 import、
 * 只能靠"切源码 + vm"测试。这里把**第一片内聚的 handler 整体搬出**，保持行为逐字不变：
 * 每个 handler 判断的忙标志组合、抛错文案、调用顺序都与搬出前一致。
 *
 * 关于忙标志：`configuring` 等是 index.ts 闭包里的可变量，所以这里通过 `busy()`
 * 快照读取、通过 `withConfiguring()` 写入——不复制状态，避免两份真相。
 */
import type { DeviceLanes } from "../../../../packages/protocol";
import type { ArknightsProfiles } from "../../../../games/arknights/config";
import { validateArknightsProfiles } from "../../../../games/arknights/config";
import { validateLaneProfiles } from "../daily-policy";
import type { DeviceInspection } from "../../../../packages/protocol/recovery";
import { persistChannelCopies } from "../channel-template";

/** index.ts 闭包里的忙标志快照；handler 各自保留原来的判断组合。 */
export interface MainBusySnapshot {
  starting: boolean;
  connecting: boolean;
  finishing: boolean;
  configuring: boolean;
  automaticReserved: boolean;
  startupInspectionRunning: boolean;
  chatBusy: boolean;
  executionsActive: boolean;
  historyActive: boolean;
}

export interface SettingsIpcPorts {
  /** index.ts 里的 `handle`（含 sender/senderFrame/URL 三重校验与 preview 黑名单）。 */
  register(channel: string, handler: (input: unknown) => unknown): void;
  busy(): MainBusySnapshot;
  withConfiguring<T>(action: () => Promise<T>): Promise<T>;
  anyLaneRunning(lanes: DeviceLanes): boolean;
  validateDeviceLanes(input: unknown): DeviceLanes;
  deviceLanes: {
    read(): Promise<DeviceLanes>;
    save(value: DeviceLanes): Promise<DeviceLanes>;
  };
  arknights: {
    read(): Promise<ArknightsProfiles>;
    save(value: ArknightsProfiles): Promise<ArknightsProfiles>;
  };
  settings: { save(input: unknown): Promise<unknown> };
  automation: { read(): Promise<{ managerPath?: string }> };
  invalidatePreview(): void;
  discoverInstances(managerPath: string): Promise<unknown>;
  probeArknights(): Promise<DeviceInspection | unknown>;
}

export function registerSettingsIpc(ports: SettingsIpcPorts) {
  const { busy } = ports;
  ports.register("gp:arknights", () => ports.arknights.read());
  ports.register("gp:device-lanes", () => ports.deviceLanes.read());
  ports.register("gp:channel-copy", (input) => {
    if (Object.values(busy()).some(Boolean)) throw Error("请在任务结束后复制渠道配置");
    return ports.withConfiguring(async () => {
      if (ports.anyLaneRunning(await ports.deviceLanes.read())) throw Error("设备正在执行任务，暂不能复制渠道");
      const saved = await persistChannelCopies(ports, input);
      ports.invalidatePreview();
      return saved;
    });
  });
  ports.register("gp:mumu-instances", async (input) => {
    const managerPath =
      typeof input === "string" && input
        ? input
        : (await ports.automation.read()).managerPath;
    if (!managerPath) throw new Error("请先检测并选择 MuMu 安装位置");
    return ports.discoverInstances(managerPath);
  });
  ports.register("gp:device-lanes-save", async (input) => {
    const current = await ports.deviceLanes.read();
    const state = busy();
    if (
      state.executionsActive ||
      state.chatBusy ||
      state.starting ||
      state.connecting ||
      state.finishing ||
      state.configuring ||
      state.automaticReserved ||
      state.startupInspectionRunning ||
      ports.anyLaneRunning(current)
    )
      throw new Error("设备槽位运行期间不能修改配置");
    return ports.withConfiguring(async () => {
      const value = ports.validateDeviceLanes(input);
      validateLaneProfiles(value.lanes, await ports.arknights.read());
      const saved = await ports.deviceLanes.save(value);
      ports.invalidatePreview();
      return saved;
    });
  });
  ports.register("gp:arknights-save", async (input) => {
    const state = busy();
    if (
      state.starting ||
      state.chatBusy ||
      state.connecting ||
      state.finishing ||
      state.configuring ||
      state.automaticReserved ||
      state.startupInspectionRunning ||
      state.executionsActive ||
      state.historyActive
    )
      throw Error("任务或设置操作正在进行");
    return ports.withConfiguring(async () => {
      const value = validateArknightsProfiles(input);
      validateLaneProfiles((await ports.deviceLanes.read()).lanes, value);
      return await ports.arknights.save(value);
    });
  });
  ports.register("gp:arknights-probe", async () => {
    const state = busy();
    if (
      state.starting ||
      state.connecting ||
      state.finishing ||
      state.configuring ||
      state.automaticReserved ||
      state.startupInspectionRunning ||
      state.executionsActive ||
      state.historyActive
    )
      throw Error("请在任务结束后检测内核");
    return ports.withConfiguring(() => ports.probeArknights());
  });
  ports.register("gp:settings", async (input) => {
    const state = busy();
    if (
      state.starting ||
      state.chatBusy ||
      state.connecting ||
      state.finishing ||
      state.automaticReserved ||
      state.startupInspectionRunning ||
      state.executionsActive ||
      state.configuring ||
      state.historyActive
    )
      throw Error("任务或设置操作正在进行");
    return ports.withConfiguring(() => ports.settings.save(input));
  });
}
