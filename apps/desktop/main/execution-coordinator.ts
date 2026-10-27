import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { replaceFile } from "./replace-file";
import {
  validStartupFaultAssociation,
  type StartupFault,
} from "../../../packages/protocol/startup-fault";
import {
  validateRequestId,
  type ExecutionRecord,
  type ExecutionRequest,
  type ExecutionStatus,
} from "../../../packages/protocol/execution";
import {
  executionSnapshotForWrite,
  parseExecutionSnapshot,
} from "../../../packages/protocol/execution-snapshot";
import {
  frozenMuMuResource,
  validExitObservation,
  type WorkerExitObservation,
} from "../../../packages/protocol/execution-observation";

export interface ExecutionLease {
  observe?(value: WorkerExitObservation): Promise<void>;
  finish(
    status: Exclude<ExecutionStatus, "running">,
    message: string,
    startupFault?: StartupFault,
  ): Promise<void>;
}

interface WorkerExitSource {
  readonly exitPending?: boolean;
  on(event: "terminating" | "exit", listener: () => void): unknown;
}

function overlaps(left: string[], right: string[]) {
  return (
    left.includes("*") ||
    right.includes("*") ||
    left.some((r) => right.includes(r))
  );
}

// Discovery-only targets cannot safely be distinguished before resolution.
export function mumuResource(managerPath: string, instance: number): string {
  if (!managerPath.trim() || !win32.isAbsolute(managerPath)) return "*";
  return `mumu:${win32.normalize(managerPath).toLowerCase()}#${instance}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function requestCopy(
  value: ExecutionRequest,
  mode: "new" | "load" = "new",
): ExecutionRequest {
  const input =
    mode === "new"
      ? { ...value, snapshot: executionSnapshotForWrite(value.snapshot) }
      : value;
  const copy = JSON.parse(JSON.stringify(input)) as ExecutionRequest;
  if (mode === "new") copy.snapshot = executionSnapshotForWrite(copy.snapshot);
  validateRequestId(copy.id);
  if (
    !["single", "daily", "maintenance"].includes(copy.source) ||
    !Array.isArray(copy.resources) ||
    copy.resources.length === 0 ||
    copy.resources.length > 16 ||
    copy.resources.some(
      (r) => typeof r !== "string" || !r || r.length > 1024,
    ) ||
    !copy.snapshot ||
    typeof copy.snapshot !== "object" ||
    Array.isArray(copy.snapshot) ||
    (copy.laneId !== undefined && typeof copy.laneId !== "string") ||
    (copy.batchId !== undefined && typeof copy.batchId !== "string")
  )
    throw Error("执行请求参数无效");
  return {
    id: copy.id,
    source: copy.source,
    resources: [...new Set(copy.resources)].sort(),
    snapshot: copy.snapshot,
    ...(copy.laneId ? { laneId: copy.laneId } : {}),
    ...(copy.batchId ? { batchId: copy.batchId } : {}),
  };
}
function fingerprint(request: ExecutionRequest) {
  const { startedAt: _admissionTime, ...snapshot } = request.snapshot;
  return createHash("sha256")
    .update(canonical({ ...request, snapshot }))
    .digest("hex");
}

/** All entrypoints acquire before preparing devices; no game code lives here. */
export class ExecutionCoordinator {
  private records = new Map<string, ExecutionRecord>();
  private owners = new Map<string, string[]>();
  private unconfirmedWorkers = new Map<WorkerExitSource, string[]>();
  private trackedWorkers = new WeakSet<WorkerExitSource>();
  private writes: Promise<void> = Promise.resolve();
  error?: string;
  constructor(private directory: string) {}

  /** Termination is announced before failed receipts; only actual exit releases isolation. */
  trackWorker(worker: WorkerExitSource, resources: () => string[]) {
    if (this.trackedWorkers.has(worker)) throw Error("执行器已登记退出核验");
    this.trackedWorkers.add(worker);
    const isolate = () => {
      if (this.unconfirmedWorkers.has(worker)) return;
      let targets = ["*"];
      try {
        const current = resources();
        if (
          Array.isArray(current) &&
          current.length &&
          current.every((r) => typeof r === "string" && r.trim())
        )
          targets = [...new Set(current)];
      } catch {
        /* Unknown binding must block all device operations. */
      }
      this.unconfirmedWorkers.set(worker, targets);
    };
    worker.on("terminating", isolate);
    worker.on("exit", () => {
      if (worker.exitPending === false) this.unconfirmedWorkers.delete(worker);
    });
    if (worker.exitPending) isolate();
  }

  hasUnconfirmedExit(resources: string[] = ["*"]) {
    return [...this.unconfirmedWorkers.values()].some((targets) =>
      overlaps(targets, resources),
    );
  }

  private file(id: string) {
    return join(
      this.directory,
      createHash("sha256").update(id).digest("hex") + ".json",
    );
  }
  assertHealthy() {
    if (this.error) throw Error(this.error);
  }
  async load() {
    try {
      await mkdir(this.directory, { recursive: true });
      for (const name of await readdir(this.directory)) {
        if (!name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(
            await readFile(join(this.directory, name), "utf8"),
          ) as ExecutionRecord;
          const request = requestCopy(record, "load");
          if (
            record.version !== 1 ||
            !validStartupFaultAssociation(record) ||
            fingerprint(request) !== record.fingerprint ||
            this.file(record.id) !== join(this.directory, name) ||
            ![
              "running",
              "succeeded",
              "failed",
              "cancelled",
              "unknown",
            ].includes(record.status) ||
            typeof record.message !== "string" ||
            (record.resolution !== undefined &&
              (record.resolution.action !== "abandoned" ||
                !Number.isFinite(Date.parse(record.resolution.at)) ||
                typeof record.resolution.note !== "string" ||
                !record.resolution.note.trim() ||
                record.resolution.note.length > 1000 ||
                record.status === "running")) ||
            !Number.isFinite(Date.parse(record.startedAt)) ||
            (record.finishedAt !== undefined &&
              !Number.isFinite(Date.parse(record.finishedAt)))
          )
            throw Error("执行请求记录格式无效");
          const schema = parseExecutionSnapshot(record.snapshot)!;
          if (
            schema.schemaStatus === "unsupported" ||
            schema.schemaStatus === "invalid"
          ) {
            this.records.set(record.id, record);
            this.error =
              "执行快照版本不受支持，已保留原记录；核对记录后才能启动任务";
            continue;
          }
          if (
            record.observations !== undefined &&
            (!Array.isArray(record.observations) ||
              record.observations.length > 16 ||
              record.observations.some(
                (value) => !validExitObservation(value, record),
              ))
          )
            throw Error("执行请求退出证据无效");
          if (record.status === "running") {
            record.status = "unknown";
            record.finishedAt = new Date().toISOString();
            record.message = "应用在请求结束前退出，现场结果待核对；未自动重放";
            await this.persist(record);
          }
          this.records.set(record.id, record);
        } catch {
          this.error =
            "执行请求记录读取失败，已保留原文件；修复记录后才能启动任务";
        }
      }
    } catch (error) {
      this.error = "执行请求记录不可用：" + String(error);
    }
  }
  private persist(record: ExecutionRecord): Promise<void> {
    const path = this.file(record.id),
      content = JSON.stringify(record, null, 2);
    const writing = this.writes.then(async () => {
      await writeFile(path + ".tmp", content, "utf8");
      await replaceFile(path + ".tmp", path);
    });
    this.writes = writing.catch((error) => {
      this.error = "执行请求记录保存失败：" + String(error);
    });
    return writing;
  }
  async begin(
    input: ExecutionRequest,
    signal?: AbortSignal,
  ): Promise<ExecutionLease> {
    signal?.throwIfAborted();
    this.assertHealthy();
    const request = requestCopy(input),
      hash = fingerprint(request);
    const previous = this.records.get(request.id);
    if (previous) {
      // Legacy receipts retain their original hash contract, including the
      // absence of schemaVersion. Compare without stamping for deduplication.
      const comparisonHash =
        parseExecutionSnapshot(previous.snapshot)?.schemaStatus === "legacy"
          ? fingerprint(requestCopy(input, "load"))
          : hash;
      if (previous.fingerprint !== comparisonHash)
        throw Error(`请求 ${request.id} 参数不一致，不能复用编号`);
      throw Error(
        `请求 ${request.id} 已受理（${previous.status}），不会重复执行`,
      );
    }
    this.assertAvailable(request.resources);
    const record: ExecutionRecord = {
      ...request,
      version: 1,
      fingerprint: hash,
      status: "running",
      startedAt: new Date().toISOString(),
      message: "请求已受理，准备执行",
    };
    // Reserve synchronously, before any asynchronous file operation.
    this.records.set(record.id, record);
    this.owners.set(record.id, record.resources);
    try {
      await this.persist(record);
    } catch (error) {
      this.owners.delete(record.id);
      throw error;
    }
    let completion: Promise<void> | undefined;
    const lease: ExecutionLease = {
      observe: async (value) => {
        const current = this.records.get(record.id)!;
        if (completion || current.status !== "running")
          throw Error("执行请求已结束，不能追加退出证据");
        const observation = {
          ...structuredClone(value),
          physicalResource: frozenMuMuResource(record.snapshot),
          executionId: record.id,
          fingerprint: record.fingerprint,
          ...(record.laneId ? { laneId: record.laneId } : {}),
          ...(record.batchId ? { batchId: record.batchId } : {}),
        };
        if (
          !validExitObservation(observation, current) ||
          Date.parse(observation.observedAt) > Date.now()
        )
          throw Error("执行请求退出证据无效或与冻结设备不符");
        if (current.observations?.some((o) => o.gameId === observation.gameId))
          throw Error("退出证据重复，原观察不能覆盖");
        const next = {
          ...current,
          observations: [...(current.observations ?? []), observation],
        };
        this.records.set(record.id, next);
        await this.persist(next);
      },
      finish: (status, message, startupFault) => {
        if (!completion) {
          const next = {
            ...this.records.get(record.id)!,
            status,
            message,
            finishedAt: new Date().toISOString(),
            ...(startupFault
              ? { startupFault: structuredClone(startupFault) }
              : {}),
          };
          if (!validStartupFaultAssociation(next))
            throw Error("启动故障与执行请求不匹配");
          this.records.set(record.id, next);
          completion = this.persist(next).finally(() =>
            this.owners.delete(record.id),
          );
        }
        return completion;
      },
    };
    if (signal?.aborted) {
      await lease.finish("cancelled", "启动已取消，尚未交给游戏执行器");
      signal.throwIfAborted();
    }
    return lease;
  }
  get active() {
    return this.owners.size > 0 || this.unconfirmedWorkers.size > 0;
  }
  get(id: string): ExecutionRecord {
    validateRequestId(id);
    const record = this.records.get(id);
    if (!record) throw Error("执行请求不存在");
    return structuredClone(record);
  }
  /** Read-only scheduling probe; the real begin() still atomically owns the device. */
  canStart(resources: string[]): boolean {
    this.assertHealthy();
    try {
      this.assertAvailable(resources);
      return true;
    } catch {
      return false;
    }
  }
  private assertAvailable(targets: string[]) {
    if (!targets.length || targets.some((r) => typeof r !== "string" || !r))
      throw Error("核对目标无效");
    if (this.hasUnconfirmedExit(targets))
      throw Error("执行器退出未确认，目标设备仍被隔离，请等待真实退出");
    for (const resources of this.owners.values())
      if (
        resources.includes("*") ||
        targets.includes("*") ||
        targets.some((r) => resources.includes(r))
      )
        throw Error("目标设备已被其他执行请求占用，请等待完成或停止当前任务");
  }
  async inspect<T>(resources: string[], action: () => Promise<T>): Promise<T> {
    this.assertHealthy();
    this.assertAvailable(resources);
    const owner = `inspection:${randomUUID()}`;
    this.owners.set(owner, [...resources]);
    try {
      return await action();
    } finally {
      this.owners.delete(owner);
    }
  }
  async resolve(id: string, note: string): Promise<ExecutionRecord> {
    const record = this.get(id);
    if (!["unknown", "failed", "cancelled"].includes(record.status))
      throw Error("只能处理已结束的中断请求");
    if (record.resolution) throw Error("该请求已处理，原始处置说明不再覆盖");
    if (typeof note !== "string" || !note.trim() || note.length > 1000)
      throw Error("请填写1至1000字的处置说明");
    return this.inspect(record.resources, async () => {
      const next: ExecutionRecord = {
        ...record,
        resolution: {
          action: "abandoned",
          at: new Date().toISOString(),
          note: note.trim(),
        },
      };
      await this.persist(next);
      this.records.set(id, next);
      return structuredClone(next);
    });
  }
  snapshot(limit = 100): ExecutionRecord[] {
    const values = [...this.records.values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    const unresolved = values.filter(
      (r) =>
        r.status === "running" ||
        (!r.resolution &&
          ["unknown", "failed", "cancelled"].includes(r.status)),
    );
    return structuredClone([
      ...unresolved,
      ...values
        .filter((r) => !unresolved.includes(r))
        .slice(0, Math.max(0, limit - unresolved.length)),
    ]);
  }
  async flush() {
    await this.writes;
    this.assertHealthy();
  }
}
