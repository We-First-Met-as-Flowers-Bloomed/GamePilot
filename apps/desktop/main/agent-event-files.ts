import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boundedRead } from "../../../packages/agent/read-file";
import type {
  AgentEvent,
  AgentEventStore,
} from "../../../packages/protocol/agent-events";
import { replaceFile } from "./replace-file";

/** Local semantic receipts. Secrets, screenshots and raw model requests do not belong here. */
export function agentEventFiles(directory: string) {
  const file = join(directory, "current.json");
  const maxFileBytes = 32 * 1024 * 1024;
  const read = async (path: string) =>
    JSON.parse(await boundedRead(path, maxFileBytes));
  const save = async (path: string, value: unknown) => {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > maxFileBytes)
      throw new Error("事件文件超过预算");
    await mkdir(directory, { recursive: true });
    await writeFile(path + ".tmp", json, "utf8");
    await replaceFile(path + ".tmp", path, { atomicOnly: true });
  };
  return {
    verifyCoverage: async (query: { afterSeq: number; beforeSeq: number }) => {
      const names = (await readdir(directory))
        .map((name) => /^archive-(\d{16})-(\d{16})\.json$/.exec(name))
        .filter(
          (m): m is RegExpExecArray =>
            !!m &&
            Number(m[2]) > query.afterSeq &&
            Number(m[1]) < query.beforeSeq,
        )
        .sort((a, b) => Number(a[1]) - Number(b[1]));
      let through = query.afterSeq;
      for (const match of names) {
        if (
          Number(match[1]) > through + 1 ||
          Number(match[2]) < Number(match[1])
        )
          return false;
        through = Math.max(through, Number(match[2]));
      }
      return through >= query.beforeSeq - 1;
    },
    load: async (): Promise<AgentEventStore | undefined> => {
      try {
        return await read(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
    },
    save: (value: AgentEventStore) => save(file, value),
    archive: async (events: AgentEvent[]) => {
      if (!events.length) return;
      const first = String(events[0].seq).padStart(16, "0");
      const last = String(events.at(-1)!.seq).padStart(16, "0");
      await save(join(directory, `archive-${first}-${last}.json`), {
        version: 1,
        events,
      });
    },
    history: async (query: {
      afterSeq: number;
      beforeSeq: number;
      requestId?: string;
      limit: number;
    }) => {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const archives = names
        .map((name) => ({
          name,
          match: /^archive-(\d{16})-(\d{16})\.json$/.exec(name),
        }))
        .filter(
          (item) =>
            item.match &&
            Number(item.match[2]) > query.afterSeq &&
            Number(item.match[1]) < query.beforeSeq,
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      const result: AgentEvent[] = [];
      let coveredThrough = query.afterSeq;
      for (const item of archives) {
        if (Number(item.match![1]) > coveredThrough + 1)
          throw new Error("事件归档缺口");
        const value = await read(join(directory, item.name));
        if (
          value.version !== 1 ||
          !Array.isArray(value.events) ||
          value.events.length > 2048 ||
          value.events[0]?.seq !== Number(item.match![1]) ||
          value.events.at(-1)?.seq !== Number(item.match![2])
        )
          throw new Error("事件归档损坏");
        for (let i = 0; i < value.events.length; i++) {
          const event = value.events[i] as AgentEvent;
          if (i && event.seq !== value.events[i - 1].seq + 1)
            throw new Error("事件归档序号缺失");
          if (
            event.seq > query.afterSeq &&
            event.seq < query.beforeSeq &&
            (!query.requestId ||
              event.requestId === query.requestId ||
              event.parentRequestId === query.requestId)
          )
            result.push(event);
        }
        coveredThrough = Number(item.match![2]);
        // Check global coverage even for an empty filtered request; matching seqs need not be adjacent.
        if (!query.requestId && result.length >= query.limit) break;
      }
      if (query.requestId && coveredThrough < query.beforeSeq - 1)
        throw new Error("事件归档缺口");
      return result.slice(0, query.limit);
    },
  };
}
