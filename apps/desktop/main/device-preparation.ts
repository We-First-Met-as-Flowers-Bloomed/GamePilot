import {
  validateDevice,
  type Device,
  type DeviceLane,
  type EngineInfo,
} from "../../../packages/protocol";
import { checkDeviceReady } from "../../../packages/runtime/device-ready";
import { connectWhenReady, ensureMuMu, resolveMuMu } from "./mumu";
import type { LaneWorker } from "./lane-runtime";
import type { LanePreviewService } from "./lane-preview";
import { resolveMuMuPreviewTarget } from "./lane-preview-target";

interface PreparationEffects {
  resolve: typeof resolveMuMu;
  start: typeof ensureMuMu;
  checkReady: typeof checkDeviceReady;
  previewTarget: typeof resolveMuMuPreviewTarget;
  pause?: Parameters<typeof connectWhenReady>[2];
}
interface PreparationInput {
  name: string;
  managerPath: string;
  adbPath?: string;
  instance: number;
  worker: LaneWorker;
  signal: AbortSignal;
  log(message: string): void | Promise<void>;
  onResolved?(managerPath: string): Promise<void>;
  preview?: {
    lane: DeviceLane;
    service: Pick<LanePreviewService, "registerConnected" | "unregister">;
    requestId?: string;
    gameId?: string;
    isQuitting(): boolean;
  };
}
export interface PreparedMuMuDevice {
  owned: Awaited<ReturnType<typeof ensureMuMu>>;
  device: Device;
  engine: EngineInfo;
}

/** Device I/O starts only after the caller has acquired its execution lease. */
export class DevicePreparationService {
  private effects: PreparationEffects;

  constructor(effects: Partial<PreparationEffects> = {}) {
    this.effects = {
      resolve: resolveMuMu,
      start: ensureMuMu,
      checkReady: checkDeviceReady,
      previewTarget: resolveMuMuPreviewTarget,
      ...effects,
    };
  }

  async prepareMuMu(input: PreparationInput): Promise<PreparedMuMuDevice> {
    const { worker, signal, log } = input;
    signal.throwIfAborted();
    const resolved = await this.effects.resolve(
      input.managerPath,
      input.adbPath ?? "",
    );
    signal.throwIfAborted();
    await input.onResolved?.(resolved.managerPath);
    signal.throwIfAborted();
    const owned = await this.effects.start(
      resolved.managerPath,
      input.instance,
      signal,
      (message) => void log(message),
    );
    signal.throwIfAborted();
    const device: Device = {
      name: input.name,
      adbPath: owned.adbPath,
      address: owned.address,
    };
    const engine = await connectWhenReady(
      () => worker.request<EngineInfo>("connect", device, 60000),
      signal,
      this.effects.pause,
      async (retry) => {
        await log(`设备连接临时失败，重新检查后重试 ${retry}/2`);
        await this.effects.checkReady(device, signal);
      },
    );
    signal.throwIfAborted();
    if (input.preview) {
      const { lane, service, requestId, gameId, isQuitting } = input.preview;
      // Preview discovery is optional and never starts a second emulator.
      const target = await this.effects
        .previewTarget({
          ...lane,
          managerPath: resolved.managerPath,
        })
        .catch(() => undefined);
      signal.throwIfAborted();
      if (
        target &&
        target.address === device.address &&
        target.adbPath.toLowerCase() === device.adbPath.toLowerCase()
      ) {
        service.registerConnected({
          lane,
          ...device,
          generation: worker,
          isCurrent: async () =>
            !isQuitting() &&
            !worker.exitPending &&
            (await target.isCurrent?.()) === true,
          requestId,
          gameId,
        });
        worker.once("exit", () => service.unregister(lane.id, worker));
      }
    }
    return { owned, device, engine };
  }

  async ensureConnected(input: {
    worker: Pick<LaneWorker, "request">;
    signal: AbortSignal;
    readDevice(): Promise<Pick<Device, "adbPath" | "address">>;
  }): Promise<{ engine: EngineInfo; device?: Device }> {
    input.signal.throwIfAborted();
    let engine = await input.worker.request<EngineInfo>("info");
    input.signal.throwIfAborted();
    if (engine.connected) return { engine };
    const saved = await input.readDevice();
    input.signal.throwIfAborted();
    if (!saved.adbPath || !saved.address)
      throw new Error(
        "请前往设备页连接模拟器，保存 ADB 路径和设备地址后再执行每日任务",
      );
    const device = validateDevice({
      name: "已保存的设备",
      adbPath: saved.adbPath,
      address: saved.address,
    });
    engine = await input.worker.request<EngineInfo>("connect", device, 60000);
    input.signal.throwIfAborted();
    return { engine, device };
  }
}
