import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ModelProviderStore } from "../apps/desktop/main/model-provider";
import { validateModelProviderInput } from "../packages/protocol/model-provider";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const secret = "test-credential-do-not-return";
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gp-model-"));
  directories.push(dir);
  const path = join(dir, "model-provider.json");
  const key = randomBytes(32);
  let available = true;
  const vault = {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([
        iv,
        cipher.update(text),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    decryptString: (data: Buffer) => {
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(-16));
      return Buffer.concat([
        cipher.update(data.subarray(12, -16)),
        cipher.final(),
      ]).toString("utf8");
    },
  };
  return {
    path,
    store: new ModelProviderStore(path, vault),
    disable: () => {
      available = false;
    },
  };
}
async function saved() {
  const env = await setup();
  const initial = await env.store.read();
  const view = await env.store.save({
    ...initial,
    provider: "compatible",
    apiKey: secret,
  });
  return { ...env, view };
}
it("encrypts at rest and never returns the key through settings", async () => {
  const { store, path, view } = await saved();
  const bytes = await readFile(path, "utf8");
  expect(bytes).not.toContain(secret);
  expect(JSON.stringify(view)).not.toContain(secret);
  expect(view.hasApiKey).toBe(true);
  expect((await store.resolve()).apiKey).toBe(secret);
  expect(await store.read()).toEqual(view);
});
it("preserves key on model edits but clears it when endpoint changes", async () => {
  const { store, view } = await saved();
  const edited = await store.save({ ...view, model: "another-model" });
  expect((await store.resolve()).apiKey).toBe(secret);
  const moved = await store.save({
    ...edited,
    baseUrl: "https://example.com/v1",
  });
  expect(moved.hasApiKey).toBe(false);
  await expect(store.resolve()).rejects.toThrow(/密钥/);
});
it("supports explicit clear and a new key supplied with a new endpoint", async () => {
  const { store, view } = await saved();
  const replaced = await store.save({
    ...view,
    baseUrl: "https://example.com/v1",
    apiKey: "new-test-key",
  });
  expect((await store.resolve()).apiKey).toBe("new-test-key");
  expect((await store.save({ ...replaced, clearApiKey: true })).hasApiKey).toBe(
    false,
  );
});
it("blocks stale concurrent edits without losing the winning configuration", async () => {
  const { store, view } = await saved();
  const results = await Promise.allSettled([
    store.save({ ...view, model: "first" }),
    store.save({ ...view, model: "second" }),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
  expect((await store.read()).model).toBe("first");
});
it("requires OS encryption for key writes and resolution, never falls back to plaintext", async () => {
  const { store, view, disable, path } = await saved();
  const before = await readFile(path, "utf8");
  disable();
  await expect(
    store.save({ ...view, apiKey: "another-secret" }),
  ).rejects.toThrow(/加密/);
  await expect(store.resolve()).rejects.toThrow(/加密/);
  expect(await readFile(path, "utf8")).toBe(before);
});
it("fails closed on malformed or tampered config without exposing content", async () => {
  const { store, path } = await saved();
  await writeFile(path, JSON.stringify({ version: 1, secret }));
  await expect(store.read()).rejects.toThrow(/配置/);
  await expect(store.read()).rejects.not.toThrow(secret);
});
it("codex selection needs no API key and revision changes on every save", async () => {
  const { store } = await setup();
  const initial = await store.read();
  expect(initial.provider).toBe("codex");
  expect((await store.resolve()).provider).toBe("codex");
  const changed = await store.save({ ...initial, provider: "codex" });
  expect(changed.revision).not.toBe(initial.revision);
});
it("failed writes preserve the previous usable configuration and queue recovers", async () => {
  const { store, path, view } = await saved();
  const before = await readFile(path, "utf8");
  await mkdir(path + ".tmp");
  await expect(store.save({ ...view, model: "new-model" })).rejects.toThrow(
    /保存失败/,
  );
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await store.resolve()).apiKey).toBe(secret);
  await rm(path + ".tmp", { recursive: true });
  expect((await store.save({ ...view, model: "new-model" })).model).toBe(
    "new-model",
  );
});
it("unreadable encrypted credentials produce a safe error without sending them", async () => {
  const { store, path } = await saved();
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.encryptedKey = Buffer.from("tampered").toString("base64");
  await writeFile(path, JSON.stringify(stored));
  await expect(store.resolve()).rejects.toThrow(/无法解密/);
});
it.each([
  "http://example.com",
  "https://user:pass@example.com",
  "https://example.com?api_key=x",
  "https://example.com/#x",
  "file:///test",
])("rejects unsafe endpoint %s", async (baseUrl) => {
  const { store } = await setup();
  const initial = await store.read();
  expect(() =>
    validateModelProviderInput({ ...initial, provider: "compatible", baseUrl }),
  ).toThrow();
});
it("normalizes trailing slash and validates model, key and clear conflicts", async () => {
  const { store } = await setup();
  const initial = await store.read();
  expect(
    validateModelProviderInput({
      ...initial,
      baseUrl: "https://api.deepseek.com/",
    }).baseUrl,
  ).toBe("https://api.deepseek.com");
  for (const change of [
    { model: "" },
    { apiKey: "bad\r\nkey" },
    { apiKey: "new", clearApiKey: true },
  ])
    expect(() =>
      validateModelProviderInput({ ...initial, ...change }),
    ).toThrow();
});
