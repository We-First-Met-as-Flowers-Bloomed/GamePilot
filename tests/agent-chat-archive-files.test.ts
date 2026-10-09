import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ChatArchivedSession } from "../packages/protocol/agent-chat";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("gp-chat-archive-")
    )
      throw Error("unsafe test cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "gp-chat-archive-"));
  directories.push(directory);
  return directory;
}
const record = (id = "session-a"): ChatArchivedSession => ({
  version: 1,
  id,
  archivedAt: "2026-10-04T04:00:00.000Z",
  session: {
    id,
    title: "保留原文",
    createdAt: "2026-10-04T03:00:00.000Z",
    updatedAt: "2026-10-04T03:00:00.000Z",
    turns: [],
  },
});

it("roundtrips an immutable archive through atomic files and a fresh store", async () => {
  const { chatArchiveFiles } =
    await import("../apps/desktop/main/chat-archive-files");
  const directory = await temporary();
  const store = chatArchiveFiles(directory);
  await store.archive(record());
  expect(await readdir(directory)).toEqual(["chat-session-a.json"]);
  expect(await store.loadArchive("session-a")).toEqual(record());
  const fresh = chatArchiveFiles(directory);
  expect(await fresh.list()).toEqual([
    expect.objectContaining({
      id: "session-a",
      title: "保留原文",
      turnCount: 0,
      sources: [],
    }),
  ]);
  expect(await fresh.loadArchive("missing")).toBeUndefined();
  await fresh.archive({ ...record(), archivedAt: "2026-10-04T05:00:00.000Z" });
  expect((await fresh.loadArchive("session-a"))?.archivedAt).toBe(
    record().archivedAt,
  );
});

it("does not overwrite an earlier archive with altered session content", async () => {
  const { chatArchiveFiles } =
    await import("../apps/desktop/main/chat-archive-files");
  const directory = await temporary();
  const store = chatArchiveFiles(directory);
  await store.archive(record());
  const altered = record();
  altered.session.title = "替换旧原文";
  await expect(store.archive(altered)).rejects.toThrow();
  expect(await store.loadArchive("session-a")).toEqual(record());
});

it("does not publish a partial write or permit a non-atomic EXDEV fallback", async () => {
  const { chatArchiveFiles } =
    await import("../apps/desktop/main/chat-archive-files");
  const directory = await temporary();
  const store = chatArchiveFiles(directory, {
    replace: async (_source, _target, options) => {
      expect(options?.atomicOnly).toBe(true);
      throw Object.assign(Error("cross device"), { code: "EXDEV" });
    },
  });
  await expect(store.archive(record())).rejects.toThrow();
  expect(await store.loadArchive("session-a")).toBeUndefined();
  expect(await store.list()).toEqual([]);
  const recovered = chatArchiveFiles(directory);
  await recovered.archive(record());
  expect(await recovered.loadArchive("session-a")).toEqual(record());
});

it("preserves corrupt original files and rejects unsafe IDs without probing arbitrary paths", async () => {
  const { chatArchiveFiles } =
    await import("../apps/desktop/main/chat-archive-files");
  const directory = await temporary();
  await writeFile(join(directory, "chat-session-a.json"), "{broken", "utf8");
  const store = chatArchiveFiles(directory);
  await expect(store.loadArchive("session-a")).rejects.toThrow();
  await expect(store.archive(record())).rejects.toThrow();
  await expect(store.list()).rejects.toThrow();
  await expect(store.loadArchive("../../private")).rejects.toThrow();
  expect(await readFile(join(directory, "chat-session-a.json"), "utf8")).toBe(
    "{broken",
  );
});

it("enforces an explicit archive storage budget without deleting existing history", async () => {
  const { chatArchiveFiles } =
    await import("../apps/desktop/main/chat-archive-files");
  const directory = await temporary();
  const store = chatArchiveFiles(directory, { maxArchives: 1 });
  await store.archive(record());
  await expect(store.archive(record("session-b"))).rejects.toMatchObject({
    code: "CHAT_ARCHIVE_BUDGET",
  });
  expect(await store.loadArchive("session-a")).toEqual(record());
  expect(await readdir(directory)).toEqual(["chat-session-a.json"]);
});

it("checks total byte budgets before parsing an externally overfull archive directory", async () => {
  const { chatArchiveFiles } =
    await import("../apps/desktop/main/chat-archive-files");
  const directory = await temporary();
  await writeFile(
    join(directory, "chat-session-a.json"),
    JSON.stringify(record()),
    "utf8",
  );
  const store = chatArchiveFiles(directory, { maxBytes: 10 });
  await expect(store.list()).rejects.toMatchObject({
    code: "CHAT_ARCHIVE_BUDGET",
  });
  expect(await store.loadArchive("session-a")).toEqual(record());
});
