import { replaceFile } from "./replace-file";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunEvent } from "../../../packages/protocol";
import {
  aggregateStatus,
  boundRunHistory,
  isActiveStatus,
  latestRunStates,
} from "../../../packages/protocol/run-state";

export class HistoryStore {
  private events: RunEvent[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(private path: string) {}
  async load() {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !Array.isArray(value) ||
        value.some(
          (event) =>
            !event ||
            typeof event.runId !== "string" ||
            typeof event.message !== "string" ||
            typeof event.at !== "string" ||
            !["status", "step", "log", "engine"].includes(event.type),
        )
      )
        throw new Error("执行记录格式无效");
      this.events = boundRunHistory(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const event of latestRunStates(this.events)) {
      if (["queued", "running", "stopping"].includes(event.status!))
        await this.append({
          runId: event.runId,
          ...(event.gameId ? { gameId: event.gameId } : {}),
          ...(event.laneId ? { laneId: event.laneId } : {}),
          ...(event.batchId ? { batchId: event.batchId } : {}),
          ...(event.startedAt ? { startedAt: event.startedAt } : {}),
          ...(event.planKey ? { planKey: event.planKey } : {}),
          ...(event.executionSource
            ? { executionSource: event.executionSource }
            : {}),
          ...(typeof event.maintenance === "boolean"
            ? { maintenance: event.maintenance }
            : {}),
          type: "status",
          status: "failed",
          message: "应用中断，任务结果未知；请检查游戏状态后重新执行。",
          at: new Date().toISOString(),
        });
    }
  }
  snapshot(): RunEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
  get active() {
    return isActiveStatus(aggregateStatus(this.events));
  }
  append(event: RunEvent): Promise<void> {
    const all = [...this.events, { ...event }];
    this.events = boundRunHistory(all);
    const contents = JSON.stringify(this.events, null, 2);
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, contents, "utf8");
      await replaceFile(`${this.path}.tmp`, this.path);
    });
    this.writes = write.catch(() => {});
    return write;
  }
  flush() {
    return this.writes;
  }
}
