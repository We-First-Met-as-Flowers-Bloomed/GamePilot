import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { DeviceLane, RunEvent } from "../../../packages/protocol";
import { WorkerClient } from "./worker-client";
import { mumuResource } from "./execution-coordinator";

export interface LaneWorker extends EventEmitter {
  readonly exitPending?: boolean;
  request<T>(method: string, payload?: unknown, timeout?: number): Promise<T>;
  close(): void;
  closeAndWait?(): Promise<void>;
}

type WorkerFactory = (laneId: string, dataDir: string) => LaneWorker;

export class LaneRuntimeManager extends EventEmitter {
  private workers = new Map<string, LaneWorker>();
  private running = new Set<string>();
  private batches = new Map<string, string>();
  private metadata = new Map<string, Partial<RunEvent>>();
  private controllers = new Map<string, AbortController>();
  private disposing = false;
  private closing = false;
  private resources = new Map<string, string[]>();

  constructor(
    private workerFile: string,
    private dataDir: string,
    private create: WorkerFactory = (laneId, laneDataDir) =>
      new WorkerClient(this.workerFile, laneDataDir),
    private trackWorker: (
      worker: LaneWorker,
      resources: () => string[],
    ) => void = () => {},
  ) {
    super();
  }

  get(laneId: string): LaneWorker {
    if (this.disposing || this.closing) throw new Error("执行器正在确认退出");
    const current = this.workers.get(laneId);
    if (current?.exitPending)
      throw new Error("执行器退出未确认，设备暂不可重新使用");
    if (current) return current;
    const worker = this.create(laneId, join(this.dataDir, "lanes", laneId));
    this.trackWorker(worker, () => this.resources.get(laneId) ?? ["*"]);
    worker.on("event", (event: RunEvent) =>
      this.emit("event", {
        ...event,
        ...this.metadata.get(laneId),
        profileId:
          event.gameId === "arknights"
            ? this.metadata.get(laneId)?.profileId
            : undefined,
        laneId,
        ...(this.batches.get(laneId)
          ? { batchId: this.batches.get(laneId) }
          : {}),
      }),
    );
    worker.on("exit", () => {
      if (this.workers.get(laneId) === worker) {
        this.workers.delete(laneId);
        this.resources.delete(laneId);
      }
    });
    this.workers.set(laneId, worker);
    return worker;
  }

  async run<T>(
    lane: DeviceLane,
    execute: (
      lane: DeviceLane,
      worker: LaneWorker,
      signal: AbortSignal,
    ) => Promise<T>,
    batchId?: string,
    maintenance = false,
  ): Promise<T> {
    if (this.disposing || this.closing) throw new Error("执行器正在确认退出");
    if (this.workers.get(lane.id)?.exitPending)
      throw new Error("执行器退出未确认，设备暂不可重新使用");
    if (this.running.has(lane.id))
      throw new Error(`设备槽位 ${lane.name} 正在运行`);
    this.running.add(lane.id);
    this.resources.set(lane.id, [
      mumuResource(lane.managerPath, lane.instance),
    ]);
    this.metadata.set(lane.id, {
      executionId: batchId ? `${batchId}:${lane.id}` : undefined,
      laneName: lane.name,
      instance: lane.instance,
      profileId: lane.arknights.profileId,
      maintenance,
    });
    const controller = new AbortController();
    this.controllers.set(lane.id, controller);
    if (batchId) this.batches.set(lane.id, batchId);
    try {
      return await execute(lane, this.get(lane.id), controller.signal);
    } finally {
      this.running.delete(lane.id);
      this.batches.delete(lane.id);
      this.metadata.delete(lane.id);
      this.controllers.delete(lane.id);
    }
  }

  runAll<T>(
    lanes: DeviceLane[],
    execute: (lane: DeviceLane, worker: LaneWorker) => Promise<T>,
    batchId?: string,
  ) {
    return Promise.allSettled(
      lanes
        .filter((lane) => lane.enabled)
        .map((lane) => this.run(lane, execute, batchId)),
    );
  }

  async stop(laneId: string) {
    this.controllers.get(laneId)?.abort();
    const worker = this.workers.get(laneId);
    if (worker) await worker.request("stop", undefined, 70000);
  }

  async stopAll() {
    await Promise.allSettled(
      [...this.workers.keys()].map((id) => this.stop(id)),
    );
  }

  async disposeIdle(): Promise<void> {
    if (this.active || this.disposing || this.closing)
      throw new Error("执行器仍在使用中");
    this.disposing = true;
    try {
      for (const [id, worker] of this.workers) {
        if (!worker.closeAndWait) throw new Error("执行器不支持退出核验");
        await worker.closeAndWait();
        if (this.workers.get(id) === worker) {
          this.workers.delete(id);
          this.resources.delete(id);
        }
      }
    } finally {
      this.disposing = false;
    }
  }

  close() {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const worker of this.workers.values()) worker.close();
  }

  isRunning(laneId: string) {
    return this.running.has(laneId);
  }
  isRunningBatch(laneId: string, batchId: string) {
    return this.running.has(laneId) && this.batches.get(laneId) === batchId;
  }
  get active() {
    return this.running.size > 0;
  }
}
