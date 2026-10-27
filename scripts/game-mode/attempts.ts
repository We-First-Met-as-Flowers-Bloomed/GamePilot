import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ActorAttempt } from "../actors/runtime";

/** One immutable identity per CLI process; reserve before any engine can submit. */
export function reserveActorAttempt(
  directory: string,
  actor: Pick<ActorAttempt, "lane" | "game">,
) {
  mkdirSync(directory, { recursive: true });
  const attempt: ActorAttempt = {
    id: randomUUID(),
    ...actor,
    startedAt: new Date().toISOString(),
    result: "running",
  };
  const file = join(directory, `${attempt.id}.json`);
  writeFileSync(file, JSON.stringify(attempt), { flag: "wx" });
  return { file, attempt };
}

export function finishActorAttempt(
  file: string,
  result: ActorAttempt["result"],
) {
  const attempt = JSON.parse(readFileSync(file, "utf8")) as ActorAttempt;
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      ...attempt,
      result,
      finishedAt: new Date().toISOString(),
    }),
    { flag: "wx" },
  );
  renameSync(temporary, file);
}

export function readActorAttempts(directory: string): ActorAttempt[] {
  let files: string[];
  try {
    files = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const value = JSON.parse(
        readFileSync(join(directory, file), "utf8"),
      ) as ActorAttempt;
      if (
        !value ||
        typeof value.id !== "string" ||
        file !== `${value.id}.json` ||
        typeof value.lane !== "string" ||
        !["onmyoji", "arknights"].includes(value.game) ||
        !Number.isFinite(Date.parse(value.startedAt)) ||
        ![
          "running",
          "succeeded",
          "skipped",
          "failed",
          "unknown",
          "cancelled",
        ].includes(value.result)
      )
        throw Error(`尝试记录 ${file} 无效，停止自动补跑`);
      return value;
    });
}
