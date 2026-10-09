import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceFile } from "./replace-file";
import type { RunEvent } from "../../../packages/protocol";

export interface RunObservation {
  version: 1;
  id: string;
  laneId: string;
  startedAt: string;
  finishedAt: string;
  status: "succeeded" | "failed" | "cancelled";
  gameId: "arknights" | "onmyoji";
  message: string;
  appVersion: string;
  profileId?: string;
  stage?: string;
  mail?: boolean;
}

function validPathId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    return false;
  // Require UTC ISO timestamps, rejecting normalized impossible dates (e.g. Feb 30).
  const canonical = new Date(value).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function validate(input: unknown): RunObservation {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("运行观察记录格式无效");
  const value = input as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !validPathId(value.id) ||
    !validPathId(value.laneId) ||
    !validDate(value.startedAt) ||
    !validDate(value.finishedAt) ||
    Date.parse(value.finishedAt) < Date.parse(value.startedAt) ||
    !["succeeded", "failed", "cancelled"].includes(value.status as string) ||
    !["arknights", "onmyoji"].includes(value.gameId as string) ||
    typeof value.message !== "string" ||
    typeof value.appVersion !== "string" ||
    !value.appVersion.trim() ||
    (value.profileId !== undefined && typeof value.profileId !== "string") ||
    (value.stage !== undefined && typeof value.stage !== "string") ||
    (value.mail !== undefined && typeof value.mail !== "boolean")
  )
    throw new Error("运行观察记录字段无效");
  // Copy only the declared summary fields; credentials and image payloads are not part of this format.
  return {
    version: 1,
    id: value.id,
    laneId: value.laneId,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    status: value.status as RunObservation["status"],
    gameId: value.gameId as RunObservation["gameId"],
    message: value.message,
    appVersion: value.appVersion,
    ...(value.profileId !== undefined ? { profileId: value.profileId } : {}),
    ...(value.stage !== undefined ? { stage: value.stage } : {}),
    ...(value.mail !== undefined ? { mail: value.mail } : {}),
  };
}

/** Independent files retain run summaries beyond the rolling UI history. Use one store per directory. */
export class RunObservationStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private dir: string) {}
  async recoverInterrupted(events: RunEvent[]): Promise<void> {
    for (const event of events) {
      if (
        event.type !== "status" ||
        event.runId !== event.batchId ||
        !event.laneId ||
        event.maintenance === true ||
        !event.startedAt ||
        (event.gameId !== "arknights" && event.gameId !== "onmyoji") ||
        event.status !== "failed" ||
        event.message !== "应用中断，任务结果未知；请检查游戏状态后重新执行。"
      )
        continue;
      await this.write(
        validate({
          version: 1,
          id: event.runId,
          laneId: event.laneId,
          startedAt: event.startedAt,
          finishedAt: event.at,
          status: "failed",
          gameId: event.gameId,
          message: event.message,
          appVersion: "unknown",
        }),
        true,
      );
    }
  }
  async save(input: unknown): Promise<RunObservation> {
    const value = validate(input);
    await this.write(value);
    return value;
  }
  private write(value: RunObservation, onlyMissing = false): Promise<void> {
    const directory = join(this.dir, value.laneId);
    const target = join(directory, value.id + ".json");
    const contents = JSON.stringify(value, null, 2);
    const write = this.writes.then(async () => {
      // Check within the queue so an earlier save cannot be overwritten by recovery.
      if (onlyMissing) {
        try {
          await access(target);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await mkdir(directory, { recursive: true });
      await writeFile(target + ".tmp", contents, "utf8");
      await replaceFile(target + ".tmp", target);
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
