import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExecutionRecord } from "../protocol/execution";
import { validExitObservation } from "../protocol/execution-observation";
import {
  taskRecordKey,
  readTaskRecord,
  type TaskRecord,
} from "../protocol/task-record";

/** Never use the app's store.load here: it recovers interrupted records by writing them. */
export async function readEvidence(data: string) {
  const requests: ExecutionRecord[] = [],
    tasks: TaskRecord[] = [],
    errors: string[] = [];
  for (const directory of ["execution-requests", "task-runs"]) {
    let names: string[];
    try {
      names = await readdir(join(data, directory));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        errors.push(`${directory}: 无法读取`);
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        const raw = JSON.parse(
          await readFile(join(data, directory, name), "utf8"),
        );
        let key: string;
        if (directory === "task-runs") {
          const task = readTaskRecord(raw);
          key = taskRecordKey(task);
          if (createHash("sha256").update(key).digest("hex") + ".json" !== name)
            throw Error("标识不匹配");
          tasks.push(task);
        } else {
          if (
            raw?.version !== 1 ||
            typeof raw.id !== "string" ||
            !/^[a-zA-Z0-9:._-]{1,160}$/.test(raw.id) ||
            !["single", "daily", "maintenance"].includes(raw.source) ||
            ![
              "running",
              "succeeded",
              "failed",
              "cancelled",
              "unknown",
            ].includes(raw.status) ||
            typeof raw.startedAt !== "string" ||
            !Number.isFinite(Date.parse(raw.startedAt)) ||
            (raw.finishedAt !== undefined &&
              !Number.isFinite(Date.parse(raw.finishedAt))) ||
            !raw.snapshot ||
            typeof raw.snapshot !== "object" ||
            Array.isArray(raw.snapshot)
          )
            throw Error("字段无效");
          key = raw.id;
          if (createHash("sha256").update(key).digest("hex") + ".json" !== name)
            throw Error("标识不匹配");
          requests.push(raw);
          if (
            raw.observations !== undefined &&
            (!Array.isArray(raw.observations) ||
              raw.observations.length > 16 ||
              raw.observations.some(
                (o: unknown) => !validExitObservation(o, raw),
              ) ||
              new Set(raw.observations.map((o: { gameId: string }) => o.gameId))
                .size !== raw.observations.length)
          )
            errors.push(
              `${directory}/${name}: 退出观察字段无效，不能作为验收证明`,
            );
        }
      } catch {
        errors.push(`${directory}/${name}: 记录无效或正在变更，需重新采集`);
      }
    }
  }
  return { requests, tasks, errors };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
