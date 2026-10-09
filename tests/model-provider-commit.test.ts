import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mutation = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  mutation.rename.mockImplementation(fs.rename);
  return { ...fs, rename: mutation.rename };
});
import { ModelProviderStore } from "../apps/desktop/main/model-provider";
it("model configuration rejects EXDEV without copying over the active configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-model-commit-"));
  try {
    const path = join(dir, "model.json");
    const store = new ModelProviderStore(path, {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from("encrypted"),
      decryptString: () => "fake-key",
    });
    const original = await store.save({
      ...(await store.read()),
      model: "before",
    });
    const bytes = await readFile(path, "utf8");
    mutation.rename.mockRejectedValueOnce(
      Object.assign(new Error("cross-device"), { code: "EXDEV" }),
    );
    await expect(store.save({ ...original, model: "after" })).rejects.toThrow(
      /保存失败/,
    );
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(await store.read()).toEqual(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
