import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { boundedRead } from "../../../packages/agent/read-file";
import type { GoalStore } from "../../../packages/protocol/agent-goal";
import { replaceFile } from "./replace-file";

/** Atomic local goal records. Frozen device payloads and provider secrets are never stored here. */
export function agentGoalFiles(file: string) {
  const maxBytes = 8 * 1024 * 1024;
  return {
    async load(): Promise<GoalStore | undefined> {
      try {
        return JSON.parse(await boundedRead(file, maxBytes));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    async save(value: GoalStore) {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json, "utf8") > maxBytes)
        throw new Error("目标记录超过预算");
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file + ".tmp", json, "utf8");
      await replaceFile(file + ".tmp", file, { atomicOnly: true });
    },
  };
}
