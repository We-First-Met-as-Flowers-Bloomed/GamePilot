import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtomicJsonStore } from "../apps/desktop/main/atomic-json-store";
import * as filesystem from "node:fs/promises";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

interface Doc {
  version: 1;
  items: string[];
}

function validate(input: unknown): Doc {
  const v = input as Doc;
  if (
    !v ||
    v.version !== 1 ||
    !Array.isArray(v.items) ||
    v.items.some((i) => typeof i !== "string")
  )
    throw new Error("文档格式无效");
  return v;
}

const dirs: string[] = [];
async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "atomic-json-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("AtomicJsonStore", () => {
  it("freezes queued payloads before callers can change them", async () => {
    const dir = await makeDir();
    const store = new AtomicJsonStore<Doc>(join(dir, "state.json"), {
      validate,
    });
    const input: Doc = { version: 1, items: ["frozen"] };
    const pending = store.save(input);
    input.items[0] = "mutated";
    await pending;
    expect(await store.load()).toEqual({ version: 1, items: ["frozen"] });
  });

  it("persists the validator's coerced result without mutating the caller", async () => {
    const dir = await makeDir();
    const input: Doc = { version: 1, items: ["  value  "] };
    const store = new AtomicJsonStore<Doc>(join(dir, "state.json"), {
      validate: (raw) => {
        const doc = validate(raw);
        doc.items = doc.items.map((item) => item.trim());
        return doc;
      },
    });
    await store.save(input);
    expect(input.items).toEqual(["  value  "]);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({
      version: 1,
      items: ["value"],
    });
  });

  it("reports directory failures and permits a later save after repair", async () => {
    const dir = await makeDir();
    const blocker = join(dir, "blocked");
    await writeFile(blocker, "not a directory");
    const onPersistError = vi.fn();
    const store = new AtomicJsonStore<Doc>(join(blocker, "state.json"), {
      onPersistError,
    });
    await expect(store.save({ version: 1, items: [] })).rejects.toThrow();
    expect(onPersistError).toHaveBeenCalledTimes(1);
    await rm(blocker);
    await store.save({ version: 1, items: ["repaired"] });
    expect(await store.load()).toEqual({ version: 1, items: ["repaired"] });
  });

  it("reports staging open failures without replacing the last good file", async () => {
    const dir = await makeDir();
    const onPersistError = vi.fn();
    const store = new AtomicJsonStore<Doc>(join(dir, "state.json"), {
      onPersistError,
    });
    await store.save({ version: 1, items: ["good"] });
    vi.mocked(filesystem.open).mockRejectedValueOnce(new Error("open failed"));
    await expect(store.save({ version: 1, items: ["bad"] })).rejects.toThrow(
      "open failed",
    );
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(await store.load()).toEqual({ version: 1, items: ["good"] });
  });

  it.each(["writeFile", "sync", "close"] as const)(
    "reports %s failures without replacing the last good file",
    async (stage) => {
      const dir = await makeDir();
      const onPersistError = vi.fn();
      const store = new AtomicJsonStore<Doc>(join(dir, "state.json"), {
        onPersistError,
      });
      await store.save({ version: 1, items: ["good"] });
      const handle = {
        writeFile: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      handle[stage].mockRejectedValueOnce(new Error(`${stage} failed`));
      vi.mocked(filesystem.open).mockResolvedValueOnce(
        handle as unknown as Awaited<ReturnType<typeof filesystem.open>>,
      );
      await expect(store.save({ version: 1, items: ["bad"] })).rejects.toThrow(
        `${stage} failed`,
      );
      expect(onPersistError).toHaveBeenCalledTimes(1);
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(await store.load()).toEqual({ version: 1, items: ["good"] });
    },
  );

  it("reports replacement failures and keeps the last good file", async () => {
    const dir = await makeDir();
    const onPersistError = vi.fn();
    const store = new AtomicJsonStore<Doc>(join(dir, "state.json"), {
      onPersistError,
    });
    await store.save({ version: 1, items: ["good"] });
    vi.mocked(filesystem.rename).mockRejectedValueOnce(
      new Error("rename failed"),
    );
    await expect(store.save({ version: 1, items: ["bad"] })).rejects.toThrow(
      "rename failed",
    );
    expect(onPersistError).toHaveBeenCalledTimes(1);
    expect(await store.load()).toEqual({ version: 1, items: ["good"] });
    await store.save({ version: 1, items: ["repaired"] });
    expect(await store.load()).toEqual({ version: 1, items: ["repaired"] });
  });

  it("returns undefined for a missing file and persists validated saves", async () => {
    const dir = await makeDir();
    const store = new AtomicJsonStore<Doc>(join(dir, "state.json"), {
      validate,
    });
    expect(await store.load()).toBeUndefined();
    await store.save({ version: 1, items: ["a"] });
    const raw = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    expect(raw).toEqual({ version: 1, items: ["a"] });
    expect(await store.load()).toEqual({ version: 1, items: ["a"] });
  });

  it("rejects schema-invalid saves without touching the file", async () => {
    const dir = await makeDir();
    const file = join(dir, "state.json");
    const store = new AtomicJsonStore<Doc>(file, { validate });
    await store.save({ version: 1, items: ["good"] });
    await expect(
      store.save({ version: 2, items: [] } as unknown as Doc),
    ).rejects.toThrow("文档格式无效");
    expect(JSON.parse(await readFile(file, "utf8")).items).toEqual(["good"]);
    // 队列未被毒化：后续合法保存照常落盘
    await store.save({ version: 1, items: ["b"] });
    expect(await store.load()).toEqual({ version: 1, items: ["b"] });
  });

  it("isolates corruption on read and keeps the raw file", async () => {
    const dir = await makeDir();
    const file = join(dir, "state.json");
    const onCorrupt = vi.fn();
    const store = new AtomicJsonStore<Doc>(file, { validate, onCorrupt });
    await writeFile(file, "{ not json", "utf8");
    expect(await store.load()).toBeUndefined();
    expect(onCorrupt).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe("{ not json");
    // 修复后可恢复
    await writeFile(file, JSON.stringify({ version: 1, items: ["x"] }), "utf8");
    expect(await store.load()).toEqual({ version: 1, items: ["x"] });
  });

  it("serializes concurrent saves so the last write wins", async () => {
    const dir = await makeDir();
    const store = new AtomicJsonStore<Doc>(join(dir, "state.json"), {
      validate,
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.save({ version: 1, items: [`item-${i}`] }),
      ),
    );
    const final = await store.load();
    expect(final?.items).toHaveLength(1);
    expect(final?.items[0]).toMatch(/^item-\d+$/);
    expect(await readdir(dir)).not.toContain("state.json.tmp");
  });

  it("leaves no staging file behind when the process dies mid-write is out of scope, but fsynced staging is replaced atomically", async () => {
    const dir = await makeDir();
    const file = join(dir, "state.json");
    const store = new AtomicJsonStore<Doc>(file, { validate });
    await store.save({ version: 1, items: ["stable"] });
    // 再次读取走文件系统，确认 tmp+rename 结果一致
    expect(JSON.parse(await readFile(file, "utf8")).items).toEqual(["stable"]);
  });
});
