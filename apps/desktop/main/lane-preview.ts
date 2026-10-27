import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { win32 as path } from "node:path";
import { promisify } from "node:util";
import { canonical } from "../../../packages/protocol/canonical";
import type { DeviceLane, DeviceLanes } from "../../../packages/protocol";
import type { LanePreviewFrame } from "../../../packages/protocol/lane-preview";
import { captureAndroidDisplay } from "../../../packages/runtime/android-capture";
import { freezeLaneDevice } from "./lane-device";

export interface LanePreviewTarget {
  adbPath: string;
  address: string;
  identityKey: string;
  isCurrent?: () => boolean | Promise<boolean>;
}
export interface LanePreviewCommandOptions {
  encoding: "buffer";
  windowsHide: true;
  shell: false;
  timeout: number;
  maxBuffer: number;
}
export interface LanePreviewContext {
  requestId?: string;
  gameId?: string;
}
export interface LanePreviewBinding extends LanePreviewContext {
  lane: DeviceLane;
  adbPath: string;
  address: string;
  generation: unknown;
  isCurrent?: () => boolean | Promise<boolean>;
}
export interface LanePreviewOptions {
  readLanes: () => Promise<DeviceLanes>;
  resolveIdleTarget?: (
    lane: DeviceLane,
  ) => Promise<LanePreviewTarget | undefined>;
  execute?: (
    file: string,
    args: string[],
    options: LanePreviewCommandOptions,
  ) => Promise<Buffer>;
  checkExecutable?: (file: string) => Promise<boolean>;
  clock?: () => number;
}
const commandOptions: LanePreviewCommandOptions = {
  encoding: "buffer",
  windowsHide: true,
  shell: false,
  timeout: 5000,
  maxBuffer: 12 * 1024 * 1024,
};
const executeFile = promisify(execFile);
const execute: NonNullable<LanePreviewOptions["execute"]> = async (
  file,
  args,
  options,
) => (await executeFile(file, args, options)).stdout;

function sameDeviceLane(current: DeviceLane, frozen: DeviceLane): boolean {
  return (
    current.id === frozen.id &&
    current.name === frozen.name &&
    path.normalize(current.managerPath).toLowerCase() ===
      path.normalize(frozen.managerPath).toLowerCase() &&
    current.instance === frozen.instance &&
    current.enabled === frozen.enabled &&
    current.arknights.profileId === frozen.arknights.profileId
  );
}

function trustedTransport(
  lane: DeviceLane,
  target: { adbPath: string; address: string },
): boolean {
  if (
    !/^[A-Za-z]:[\\/].*[\\/]MuMuManager\.exe$/i.test(lane.managerPath) ||
    lane.managerPath.length > 2048 ||
    /[\x00-\x1f]/.test(lane.managerPath) ||
    !Number.isInteger(lane.instance) ||
    lane.instance < 0 ||
    lane.instance > 999
  )
    return false;
  const port = /^127\.0\.0\.1:([1-9]\d{0,4})$/.exec(target.address)?.[1];
  return (
    !!port &&
    Number(port) <= 65535 &&
    path.normalize(target.adbPath).toLowerCase() ===
      path.join(path.dirname(lane.managerPath), "adb.exe").toLowerCase()
  );
}

function validPng(image: Buffer): boolean {
  if (
    !Buffer.isBuffer(image) ||
    image.length < 45 ||
    image.length > commandOptions.maxBuffer ||
    !image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
    image.readUInt32BE(8) !== 13 ||
    image.toString("ascii", 12, 16) !== "IHDR"
  )
    return false;
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16 * 1024 * 1024
  )
    return false;
  let seenData = false;
  let offset = 8;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > image.length) return false;
    const kind = image.toString("ascii", offset + 4, offset + 8);
    if (kind === "IHDR" && offset !== 8) return false;
    if (kind === "IDAT") seenData = true;
    if (kind === "IEND")
      return length === 0 && seenData && end === image.length;
    offset = end;
  }
  return false;
}

async function boundedCommand(pending: Promise<Buffer>): Promise<Buffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(
          () => reject(Error("预览读取超时")),
          commandOptions.timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class LanePreviewService {
  private bindings = new Map<string, LanePreviewBinding>();
  private run: NonNullable<LanePreviewOptions["execute"]>;
  private clock: () => number;
  private inFlight = new Set<string>();
  private lastAttempt = new Map<string, number>();
  private epoch = 0;

  constructor(private options: LanePreviewOptions) {
    this.run = options.execute ?? execute;
    this.clock = options.clock ?? Date.now;
  }

  registerConnected(binding: LanePreviewBinding): void {
    this.bindings.set(binding.lane.id, {
      ...binding,
      lane: structuredClone(binding.lane),
    });
  }

  unregister(laneId: string, generation?: unknown): void {
    const binding = this.bindings.get(laneId);
    if (
      binding &&
      (generation === undefined || binding.generation === generation)
    )
      this.bindings.delete(laneId);
  }

  invalidateAll(): void {
    this.epoch++;
    this.bindings.clear();
  }

  updateContext(
    laneId: string,
    generation: unknown,
    context: LanePreviewContext,
  ): void {
    const binding = this.bindings.get(laneId);
    if (binding && binding.generation === generation) {
      this.bindings.set(laneId, {
        ...binding,
        requestId: context.requestId,
        gameId: context.gameId,
      });
    }
  }

  async capture(laneId: unknown): Promise<LanePreviewFrame> {
    let lane: DeviceLane | undefined;
    const unavailable: LanePreviewFrame = {
      status: "unavailable",
      laneId: "",
      laneName: "未知账号",
      instance: null,
      message: "设备画面暂不可用",
    };
    if (typeof laneId !== "string") return unavailable;
    let ownsFlight = false;
    let commandFinished = true;
    let captureReturned = false;
    try {
      lane = (await this.options.readLanes()).lanes.find(
        (item) => item.id === laneId,
      );
      if (!lane) return unavailable;
      lane = structuredClone(lane);
      Object.assign(unavailable, {
        laneId: lane.id,
        laneName: lane.name,
        instance: lane.instance,
      });
      const now = this.clock();
      if (
        this.inFlight.has(lane.id) ||
        now - (this.lastAttempt.get(lane.id) ?? -Infinity) < 1000
      )
        return unavailable;
      this.inFlight.add(lane.id);
      this.lastAttempt.set(lane.id, now);
      ownsFlight = true;
      const binding = this.bindings.get(lane.id);
      const configurationKey = canonical(lane);
      if (binding) {
        const gameIds = (["arknights", "onmyoji"] as const).filter(
          (gameId) => binding.lane[gameId].enabled,
        );
        lane = freezeLaneDevice(lane, gameIds);
        unavailable.instance = lane.instance;
      }
      const epoch = this.epoch;
      if (
        binding &&
        (!sameDeviceLane(lane, binding.lane) ||
          !trustedTransport(lane, binding))
      )
        return unavailable;
      // An invalid registered binding must never discover a different idle target.
      const target =
        binding ??
        (await this.options.resolveIdleTarget?.(structuredClone(lane)));
      if (
        !target ||
        !trustedTransport(lane, target) ||
        (!binding &&
          (!("identityKey" in target) ||
            typeof target.identityKey !== "string" ||
            !target.identityKey ||
            target.identityKey.length > 4096))
      )
        return unavailable;
      const current = async () => {
        const configured = (await this.options.readLanes()).lanes.find(
          (item) => item.id === laneId,
        );
        if (
          !configured ||
          canonical(configured) !== configurationKey ||
          this.epoch !== epoch ||
          this.bindings.get(laneId) !== binding
        )
          return false;
        if (!binding && !target.isCurrent) {
          const latest = await this.options.resolveIdleTarget?.(
            structuredClone(lane!),
          );
          if (
            !latest ||
            !("identityKey" in target) ||
            latest.identityKey !== target.identityKey ||
            latest.address !== target.address ||
            path.normalize(latest.adbPath).toLowerCase() !==
              path.normalize(target.adbPath).toLowerCase()
          )
            return false;
        }
        if (target.isCurrent && !(await target.isCurrent())) return false;
        return this.epoch === epoch && this.bindings.get(laneId) === binding;
      };
      const existing =
        this.options.checkExecutable ??
        (async (file: string) => (await stat(file)).isFile());
      if (!(await existing(target.adbPath))) return unavailable;
      if (!(await current())) return unavailable;
      commandFinished = false;
      const pending = Promise.resolve()
        .then(() =>
          captureAndroidDisplay(
            target,
            (file, args) => this.run(file, args, commandOptions),
            commandOptions.maxBuffer,
          ),
        )
        .then((capture) => capture.image)
        .finally(() => {
          commandFinished = true;
          if (captureReturned) this.inFlight.delete(laneId);
        });
      const image = await boundedCommand(pending);
      if (!validPng(image) || !(await current())) return unavailable;
      return {
        status: "connected",
        laneId: lane.id,
        laneName: lane.name,
        instance: lane.instance,
        ...(binding?.requestId ? { requestId: binding.requestId } : {}),
        ...(binding?.gameId ? { gameId: binding.gameId } : {}),
        capturedAt: new Date(this.clock()).toISOString(),
        imageDataUrl: `data:image/png;base64,${image.toString("base64")}`,
        message: "设备画面已更新",
      };
    } catch {
      return unavailable;
    } finally {
      captureReturned = true;
      // A timed-out process retains its slot until execFile confirms completion.
      if (ownsFlight && lane && commandFinished) this.inFlight.delete(lane.id);
    }
  }
}
