import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunEvent } from "../../../packages/protocol";
import {
  interruptTaskRecords,
  reduceTaskRecords,
  taskRecordKey,
  taskActive,
  validateTaskRecord,
  type TaskRecord,
} from "../../../packages/protocol/task-record";
import { replaceFile } from "./replace-file";

export class RunLedger {
  private records: TaskRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  error?: string;
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
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = validateTaskRecord(
          JSON.parse(await readFile(join(this.directory, name), "utf8")),
        );
        if (this.file(record) !== join(this.directory, name))
          throw Error("任务记录标识不匹配");
        this.records.push(record);
      } catch {
        this.error =
          "任务记录读取失败，已保留原文件；请检查任务账本后再启动任务";
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
  }
  snapshot(limit = 100): TaskRecord[] {
    // Keep active work even when old completed runs fill the display window.
    const sorted = [...this.records].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    const active = sorted.filter((r) => taskActive(r.status));
    return structuredClone([
      ...active,
      ...sorted
        .filter((r) => !taskActive(r.status))
        .slice(0, Math.max(0, limit - active.length)),
    ]);
  }
  forExecution(executionId: string): TaskRecord[] {
    return structuredClone(
      this.records.filter((r) => r.executionId === executionId),
    );
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
    this.records = next;
    return Promise.all(changed.map((r) => this.persist(r))).then(() => {});
  }
  async flush() {
    await this.writes;
    this.assertHealthy();
  }
}
