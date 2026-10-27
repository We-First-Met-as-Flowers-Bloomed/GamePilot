import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, relative, isAbsolute } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  defaultArknightsConfig,
  taskFor,
  type ArknightsConfig,
} from "../games/arknights/config";
import { ArknightsAutomationStore } from "../apps/desktop/main/arknights-automation";
const run = promisify(execFile),
  directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const rel = relative(resolve("artifacts"), directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw Error("unsafe cleanup");
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture() {
  const dir = await mkdtemp(join(resolve("artifacts"), "ark-migration-test-"));
  directories.push(dir);
  const lanes = {
    version: 1,
    lanes: [0, 1].map((instance) => ({
      id: `lane-${instance ? "b" : "a"}`,
      name: `账号${instance + 1} · 双游戏`,
      managerPath: "D:/MuMu/MuMuManager.exe",
      instance,
      enabled: true,
      arknights: { enabled: true, profileId: `p${instance}` },
      onmyoji: { enabled: true },
      deviceInstances: { onmyoji: instance + 2 },
      closeEmulatorAfterSuccess: false,
    })),
  };
  const profiles = {
    version: 1,
    activeProfileId: "p0",
    profiles: [0, 1].map((i) => ({
      ...defaultArknightsConfig,
      id: `p${i}`,
      name: `P${i}`,
      clientType: i ? "Official" : "Bilibili",
      expectedUid: `12345678${i}`,
      stage: "LS-6",
      taskOptions: undefined as ArknightsConfig["taskOptions"],
    })),
  };
  for (const [name, value] of Object.entries({
    "device-lanes.json": lanes,
    "arknights.json": profiles,
    "automation.json": { scheduleEnabled: false, launchEmulator: false },
  }))
    await writeFile(join(dir, name), JSON.stringify(value));
  const source = join(dir, "gui.new.json");
  await writeFile(
    source,
    JSON.stringify({
      Configurations: {
        Default: {
          TaskQueue: [
            {
              TaskType: "Fight",
              StagePlan: ["LS-5"],
              UseMedicine: false,
              UseStone: false,
            },
          ],
        },
      },
    }),
  );
  const sources = join(dir, "sources.json");
  await writeFile(sources, JSON.stringify({ p0: source, p1: source }));
  return {
    dir,
    sources,
    source,
    profiles,
    call: async (apply = false) =>
      run(
        process.execPath,
        [
          "scripts/migrate-arknights-internal.mjs",
          "--profile-dir",
          dir,
          "--sources",
          sources,
          ...(apply ? ["--apply"] : []),
        ],
        { windowsHide: true },
      ),
  };
}
it("previews four correct physical channels and leaves all source bytes untouched", async () => {
  const s = await fixture(),
    before = await readFile(join(s.dir, "device-lanes.json"));
  const output = JSON.parse((await s.call()).stdout);
  expect(output.applied).toBe(false);
  expect(output.channels.map((l: any) => l.instance)).toEqual([0, 2, 1, 3]);
  expect(await readFile(join(s.dir, "device-lanes.json"))).toEqual(before);
  await expect(
    readFile(join(s.dir, "arknights-automation.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("preserves the effective App infrastructure strategy instead of importing a different GUI staffing mode", async () => {
  const s = await fixture();
  s.profiles.profiles[1].taskOptions = {
    infrastructure: {
      mode: 20000,
      facility: ["Mfg", "Trade", "Dorm"],
      drones: "PureGold",
      dormTrust: false,
    },
  };
  await writeFile(join(s.dir, "arknights.json"), JSON.stringify(s.profiles));
  await writeFile(
    s.source,
    JSON.stringify({
      Configurations: {
        Default: {
          TaskQueue: [
            {
              TaskType: "Infrast",
              Mode: "Normal",
              RoomList: [{ Room: "Dorm" }],
              DormTrustEnabled: true,
              DormFilterNotStationed: true,
              OriginiumShardAutoReplenishment: true,
            },
            { TaskType: "Mall", Shopping: true, ReserveMaxCredit: false },
          ],
        },
      },
    }),
  );
  const infrastructure = ({ id, name, ...config }: any) =>
    taskFor("infrastructure", config).params;
  const before = s.profiles.profiles.map(infrastructure);
  const report = JSON.parse((await s.call(true)).stdout);
  const after = JSON.parse(
    await readFile(join(s.dir, "arknights.json"), "utf8"),
  );
  expect(after.profiles.map(infrastructure)).toEqual(before);
  expect(
    after.profiles.every(
      (p: any) => p.taskOptions.mall.reserveMaxCredit === false,
    ),
  ).toBe(true);
  expect(
    report.warnings.some((w: any) =>
      w.message.includes("保留 App 当前基建策略"),
    ),
  ).toBe(true);
});
it("ignores an unused external custom base file while retaining explicit App infrastructure settings", async () => {
  const s = await fixture();
  const existing = {
    mode: 10000 as const,
    filename: "D:/plans/saved-base.json",
    planIndex: 2,
    facility: ["Trade", "Mfg"] as ["Trade", "Mfg"],
    dormTrust: false,
  };
  s.profiles.profiles[1].taskOptions = { infrastructure: existing };
  await writeFile(join(s.dir, "arknights.json"), JSON.stringify(s.profiles));
  await writeFile(
    s.source,
    JSON.stringify({
      Configurations: {
        Default: {
          TaskQueue: [{ TaskType: "Infrast", Mode: "Custom", Filename: "" }],
        },
      },
    }),
  );
  await s.call(true);
  const after = JSON.parse(
    await readFile(join(s.dir, "arknights.json"), "utf8"),
  );
  expect(after.profiles[0].taskOptions?.infrastructure).toBeUndefined();
  expect(after.profiles[1].taskOptions.infrastructure).toEqual(existing);
});
it("backs up exact source bytes and migrates two profiles with inert plans and truthful past-period skips", async () => {
  const s = await fixture(),
    original = await readFile(join(s.dir, "arknights.json"));
  const report = JSON.parse((await s.call(true)).stdout);
  expect(await readFile(join(report.backup, "arknights.json"))).toEqual(
    original,
  );
  const profiles = JSON.parse(
    await readFile(join(s.dir, "arknights.json"), "utf8"),
  );
  expect(
    profiles.profiles.map((p: any) => [p.expectedUid, p.clientType, p.stage]),
  ).toEqual(
    s.profiles.profiles.map((p) => [p.expectedUid, p.clientType, p.stage]),
  );
  const plans = JSON.parse(
    await readFile(join(s.dir, "arknights-automation.json"), "utf8"),
  );
  expect(
    await new ArknightsAutomationStore(
      join(s.dir, "arknights-automation.json"),
    ).read(),
  ).toEqual(plans);
  expect(plans.config.enabled).toBe(false);
  expect(plans.config.jobs).toHaveLength(4);
  expect(
    plans.runs.every(
      (r: any) => r.status === "skipped" && r.message.includes("不是游戏成功"),
    ),
  ).toBe(true);
  const lanes = JSON.parse(
    await readFile(join(s.dir, "device-lanes.json"), "utf8"),
  );
  expect(lanes.version).toBe(2);
  expect(lanes.lanes.some((l: any) => l.name.includes("双游戏"))).toBe(false);
});
it("refuses a second migration instead of overwriting user-edited internal plans", async () => {
  const s = await fixture();
  await s.call(true);
  const path = join(s.dir, "arknights-automation.json"),
    bytes = await readFile(path);
  const error = await s.call(true).catch((error) => error);
  expect(error.code).toBe(1);
  expect(await readFile(path)).toEqual(bytes);
});
