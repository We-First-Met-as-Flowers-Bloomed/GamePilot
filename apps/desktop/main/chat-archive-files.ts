import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boundedRead } from "../../../packages/agent/read-file";
import { canonical } from "../../../packages/acceptance/files";
import { AgentToolError } from "../../../packages/protocol/agent";
import type { ChatArchivedSession } from "../../../packages/protocol/agent-chat";
import { chatArchiveEntry, validateChatArchive } from "./agent-chat";
import { replaceFile } from "./replace-file";

const archiveBytes = 8 * 1024 * 1024;
/** Immutable local history. A failed archive never replaces the active chat store. */
export function chatArchiveFiles(
  directory: string,
  options: {
    replace?: typeof replaceFile;
    maxArchives?: number;
    maxBytes?: number;
  } = {},
) {
  const replace = options.replace ?? replaceFile;
  const maxArchives = options.maxArchives ?? 256;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxArchives) ||
    maxArchives < 1 ||
    maxArchives > 256 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024
  )
    throw Error("归档存储预算无效");
  let writes = Promise.resolve();
  const file = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
      throw new AgentToolError("INVALID_INPUT", "归档编号无效");
    return join(directory, `chat-${id}.json`);
  };
  const read = async (id: string): Promise<ChatArchivedSession | undefined> => {
    let value: ChatArchivedSession;
    try {
      value = JSON.parse(await boundedRead(file(id), archiveBytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    validateChatArchive(value);
    if (value.id !== id) throw Error("归档身份不匹配");
    return value;
  };
  const names = async () => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const archives = entries
      .map((name) => /^chat-([A-Za-z0-9_-]{1,200})\.json$/.exec(name))
      .filter((match) => match !== null)
      .map((match) => match[1]);
    if (archives.length > maxArchives)
      throw new AgentToolError(
        "CHAT_ARCHIVE_BUDGET",
        "归档数量已达到存储预算，请保留并整理历史文件",
      );
    return archives;
  };
  return {
    archive: (record: ChatArchivedSession) => {
      const frozen = structuredClone(record);
      const job = writes.then(async () => {
        validateChatArchive(frozen);
        const previous = await read(frozen.id);
        if (previous) {
          if (canonical(previous.session) !== canonical(frozen.session))
            throw Error("归档原文不能替换");
          return;
        }
        const existing = await names();
        const sizes = await Promise.all(
          existing.map(async (id) => (await stat(file(id))).size),
        );
        const json = JSON.stringify(frozen);
        if (
          existing.length >= maxArchives ||
          sizes.reduce((sum, size) => sum + size, 0) +
            Buffer.byteLength(json, "utf8") >
            maxBytes
        )
          throw new AgentToolError(
            "CHAT_ARCHIVE_BUDGET",
            "归档数量或字节已达到存储预算；原会话保留，请手动整理历史",
          );
        await mkdir(directory, { recursive: true });
        const target = file(frozen.id);
        await writeFile(target + ".tmp", json, "utf8");
        await replace(target + ".tmp", target, { atomicOnly: true });
      });
      writes = job.catch(() => {});
      return job;
    },
    list: async () => {
      await writes;
      const ids = await names();
      const sizes = await Promise.all(
        ids.map(async (id) => (await stat(file(id))).size),
      );
      if (
        sizes.some((size) => size > archiveBytes) ||
        sizes.reduce((total, size) => total + size, 0) > maxBytes
      )
        throw new AgentToolError(
          "CHAT_ARCHIVE_BUDGET",
          "归档字节已超出存储预算，原文件保留",
        );
      const records = await Promise.all(ids.map(read));
      return records.map((record) => {
        if (!record) throw Error("归档列表中的原文件缺失");
        return chatArchiveEntry(record);
      });
    },
    loadArchive: async (id: string) => {
      await writes;
      return read(id);
    },
  };
}
