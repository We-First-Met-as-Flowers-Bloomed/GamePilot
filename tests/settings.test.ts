import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, defaultSettings } from "../apps/desktop/main/settings";
const dirs: string[] = [];
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-test-"));
  dirs.push(dir);
  return join(dir, "settings.json");
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
it("persists settings across store instances", async () => {
  const path = await setup(),
    store = new SettingsStore(path);
  expect(await store.read()).toEqual(defaultSettings);
  const value = { ...defaultSettings, address: "127.0.0.1:16384" };
  await store.save(value);
  expect(await new SettingsStore(path).read()).toEqual(value);
});
it("serializes writes and preserves the last value", async () => {
  const path = await setup(),
    store = new SettingsStore(path);
  await Promise.all([
    store.save({ ...defaultSettings, modelName: "one" }),
    store.save({ ...defaultSettings, modelName: "two" }),
  ]);
  expect(JSON.parse(await readFile(path, "utf8")).modelName).toBe("two");
});
it("reports corruption instead of silently replacing settings", async () => {
  const path = await setup();
  await writeFile(path, "{broken");
  await expect(new SettingsStore(path).read()).rejects.toThrow("损坏");
});
