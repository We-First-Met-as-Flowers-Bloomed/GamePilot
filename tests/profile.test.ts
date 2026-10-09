import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProfile } from "../apps/desktop/main/profile";
import { AutomationStore } from "../apps/desktop/main/automation";
import { resolveMuMu, detectMuMu } from "../apps/desktop/main/mumu";
const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "gp-profile-"));
  roots.push(home);
  const appData = join(home, "AppData");
  const legacy = join(appData, "GamePilot");
  mkdirSync(legacy, { recursive: true });
  let current = legacy;
  const app = {
    getPath: (key: "home" | "appData" | "userData") =>
      ({ home, appData, userData: current })[key],
    setPath: (_key: "userData", value: string) => {
      if (!existsSync(value)) throw new Error("Profile path must exist");
      current = value;
    },
  };
  return { home, legacy, app };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("migrates only known user JSON files to a stable home profile", () => {
  const { home, legacy, app } = fixture();
  writeFileSync(join(legacy, "automation.json"), '{"launchEmulator":false}');
  writeFileSync(join(legacy, "Cookies"), "private cache");
  initializeProfile(app);
  expect(app.getPath("userData")).toBe(join(home, ".gamepilot"));
  expect(
    JSON.parse(readFileSync(join(home, ".gamepilot/automation.json"), "utf8")),
  ).toEqual({ launchEmulator: false });
  expect(existsSync(join(home, ".gamepilot/Cookies"))).toBe(false);
});
it("preserves existing stable settings and explicit preview profile overrides", () => {
  const { home, legacy, app } = fixture();
  mkdirSync(join(home, ".gamepilot"));
  writeFileSync(join(home, ".gamepilot/settings.json"), "new");
  writeFileSync(join(legacy, "settings.json"), "old");
  initializeProfile(app);
  expect(readFileSync(join(home, ".gamepilot/settings.json"), "utf8")).toBe(
    "new",
  );
  writeFileSync(join(legacy, "automation.json"), '{"launchEmulator":false}');
  initializeProfile(app);
  expect(existsSync(join(home, ".gamepilot/automation.json"))).toBe(false);
  const preview = join(home, "preview");
  mkdirSync(preview);
  app.setPath("userData", preview);
  initializeProfile(app);
  expect(app.getPath("userData")).toBe(preview);
});
it("uses a valid saved MuMu before any installation discovery", async () => {
  const { home } = fixture();
  const managerPath = join(home, "MuMuManager.exe");
  const adbPath = join(home, "adb.exe");
  writeFileSync(managerPath, "");
  writeFileSync(adbPath, "");
  expect(await detectMuMu(managerPath)).toEqual([{ managerPath, adbPath }]);
});
it("does not leave a partial canonical profile when migration fails", () => {
  const { home, legacy, app } = fixture();
  writeFileSync(join(legacy, "settings.json"), "{}");
  writeFileSync(join(legacy, "automation.json"), "broken JSON");
  expect(() => initializeProfile(app)).toThrow();
  expect(existsSync(join(home, ".gamepilot"))).toBe(false);
  expect(app.getPath("userData")).toBe(legacy);
});
it("enables emulator launch only for missing automation files and preserves saved false", async () => {
  const { home } = fixture();
  const store = new AutomationStore(join(home, "automation.json"));
  expect((await store.read()).launchEmulator).toBe(true);
  await store.save({ launchEmulator: false });
  expect((await store.read()).launchEmulator).toBe(false);
});
it("resolves a sole detected MuMu without a configured adb and rejects missing or ambiguous installations", async () => {
  const install = {
    managerPath: "D:\\MuMu\\MuMuManager.exe",
    adbPath: "D:\\MuMu\\adb.exe",
  };
  const detect = vi.fn(async () => [install]);
  expect(await resolveMuMu("", "", detect)).toEqual(install);
  await expect(resolveMuMu("", "", async () => [])).rejects.toThrow("未检测到");
  await expect(
    resolveMuMu("", "", async () => [
      install,
      { ...install, managerPath: "E:\\MuMu\\MuMuManager.exe" },
    ]),
  ).rejects.toThrow("多个");
});
