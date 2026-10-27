import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "../../../packages/protocol";
import {
  interruptTaskRecords,
  reduceTaskRecords,
  taskRecordKey,
  taskActive,
  readTaskRecord,
  validateTaskRecord,
  type TaskRecord,
} from "../../../packages/protocol/task-record";
import { replaceFile } from "./replace-file";

export class RunLedger {
  private records: TaskRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  error?: string;
  // 惰性索引：账本只增改，排序视图与 executionId 分组在变更时失效重建，
  // 避免 snapshot()/forExecution() 每次调用全量排序/过滤。
  private version = 0;
  private cachedVersion = -1;
  private cachedSorted: TaskRecord[] | undefined;
  private cachedByExecution: Map<string, TaskRecord[]> | undefined;
  constructor(private directory: string) {}
  assertHealthy() {
    if (this.error) throw Error(this.error);
  }
  private file(record: TaskRecord) {
    return join(
      this.directory,
      createHash("sha256").update(taskRecordKey(record)).digest("hex") +
        ".json",
    );
  }
  async load() {
    let names: string[];
    try {
      await mkdir(this.directory, { recursive: true });
      names = await readdir(this.directory);
    } catch {
      this.error = "任务记录不可用，修复存储后才能启动任务";
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = readTaskRecord(
          JSON.parse(await readFile(join(this.directory, name), "utf8")),
        );
        if (this.file(record) !== join(this.directory, name))
          throw Error("任务记录标识不匹配");
        this.records.push(record);
      } catch {
        // Unreadable evidence may describe unfinished work on any device.
        // Keep loading valid records for review, but fail closed for starts.
        this.error = "任务记录读取失败，已保留原文件；修复记录后才能启动任务";
      }
    }
    const recovered = interruptTaskRecords(
      this.records,
      new Date().toISOString(),
    );
    for (let i = 0; i < recovered.length; i++) {
      if (recovered[i] !== this.records[i]) {
        try {
          await this.persist(recovered[i]);
        } catch {
          /* Keep the UI available to show the storage error, block starts. */
        }
      }
    }
    this.records = recovered;
    this.version++;
  }
  snapshot(limit = 100): TaskRecord[] {
    // Keep active work even when old completed runs fill the display window.
    const sorted = this.sorted();
    const active = sorted.filter((r) => taskActive(r.status));
    return structuredClone([
      ...active,
      ...sorted
        .filter((r) => !taskActive(r.status))
        .slice(0, Math.max(0, limit - active.length)),
    ]);
  }
  forExecution(executionId: string): TaskRecord[] {
    const group = this.byExecution().get(executionId);
    return group ? structuredClone(group) : [];
  }

  private sorted(): TaskRecord[] {
    if (this.cachedVersion !== this.version || !this.cachedSorted) {
      this.cachedSorted = [...this.records].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt),
      );
      const groups = new Map<string, TaskRecord[]>();
      for (const record of this.records) {
        const key = record.executionId ?? "";
        const group = groups.get(key);
        if (group) group.push(record);
        else groups.set(key, [record]);
      }
      this.cachedByExecution = groups;
      this.cachedVersion = this.version;
    }
    return this.cachedSorted;
  }

  private byExecution(): Map<string, TaskRecord[]> {
    this.sorted(); // 确保索引与当前版本一致
    return this.cachedByExecution ?? new Map();
  }
  private persist(record: TaskRecord) {
    const path = this.file(record),
      contents = JSON.stringify(record, null, 2);
    const write = this.writes.then(async () => {
      await writeFile(path + ".tmp", contents, "utf8");
      await replaceFile(path + ".tmp", path);
    });
    this.writes = write.catch((e) => {
      this.error = "任务记录保存失败：" + String(e);
    });
    return write;
  }
  append(event: RunEvent): Promise<void> {
    try {
      this.assertHealthy();
    } catch (e) {
      return Promise.reject(e);
    }
    const next = reduceTaskRecords(this.records, event);
    if (next === this.records) return Promise.resolve();
    const changed = next.filter((r, i) => r !== this.records[i]);
    try {
      for (const record of changed) validateTaskRecord(record);
    } catch {
      this.error =
        "新任务原生证据未通过当前协议验证，结果尚未确认；已停止保存该结果与后续启动，请核对";
      return Promise.reject(Error(this.error));
    }
    this.records = next;
    this.version++;
    return Promise.all(changed.map((r) => this.persist(r))).then(() => {});
  }
  async flush() {
    await this.writes;
    this.assertHealthy();
  }
}
