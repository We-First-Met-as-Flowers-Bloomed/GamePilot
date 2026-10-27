import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { registerArknightsAutomationIpc } from "../apps/desktop/main/ipc/arknights-automation";
import {
  ArknightsAutomationService,
  type ArknightsAutomationDocument,
} from "../apps/desktop/main/arknights-automation";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { DeviceLane } from "../packages/protocol";
import type { ArknightsAutomationConfig } from "../packages/protocol/arknights-automation";
async function fixture() {
  const dataDir = await mkdtemp(join(resolve("artifacts"), "ark-ipc-test-"));
  const lane: DeviceLane = {
    id: "ark-a",
    name: "A",
    enabled: false,
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    arknights: { enabled: true, profileId: "default" },
    onmyoji: { enabled: false },
    closeEmulatorAfterSuccess: false,
  };
  const config: ArknightsAutomationConfig = {
    version: 1,
    enabled: false,
    jobs: [
      {
        id: "am",
        name: "Morning",
        laneId: "ark-a",
        enabled: true,
        time: "08:00",
        weekdays: [1],
        skillIds: ["login"],
        catchUp: true,
      },
    ],
  };
  let saved: ArknightsAutomationDocument = { version: 1, config, runs: [] },
    configuring = false,
    ownPlans = false,
    busy = false;
  const service = new ArknightsAutomationService({
    store: {
      read: async () => structuredClone(saved),
      save: async (value) => {
        saved = structuredClone(value);
      },
    },
    isBusy: () => busy || (configuring && !ownPlans),
    run: async () => {
      throw Error("no execution in settings test");
    },
  });
  const handlers = new Map<string, (input: unknown) => any>();
  let selected: string | undefined;
  const choose = vi.fn(async () => selected);
  registerArknightsAutomationIpc({
    register: (key, fn) => {
      handlers.set(key, fn);
    },
    dataDir,
    service,
    activity: {
      catalog: async () => ({
        source: "fixture",
        stale: false,
        stages: [],
        message: "",
      }),
    },
    readLanes: async () => [lane],
    readProfiles: async () => ({
      version: 1,
      activeProfileId: "default",
      profiles: [
        {
          ...defaultArknightsConfig,
          id: "default",
          name: "Saved",
          stage: "LS-6",
        },
      ],
    }),
    busy: () => busy || configuring,
    withConfiguring: async (action, purpose) => {
      configuring = true;
      ownPlans = purpose === "plans";
      try {
        return await action();
      } finally {
        configuring = false;
        ownPlans = false;
      }
    },
    chooseMaaFile: choose,
  });
  return {
    dataDir,
    lane,
    config,
    handlers,
    service,
    choose,
    select: (file: string) => {
      selected = file;
    },
    busy: () => {
      busy = true;
    },
    saved: () => saved,
  };
}
it("saves a paused channel plan without enabling it or rejecting its own configuration lock", async () => {
  const s = await fixture(),
    value = {
      ...s.config,
      jobs: s.config.jobs.map((job) => ({ ...job, time: "09:42" })),
    };
  expect(await s.handlers.get("gp:arknights-automation-save")!(value)).toEqual(
    value,
  );
  expect(s.lane.enabled).toBe(false);
  expect(s.saved().config.jobs[0].time).toBe("09:42");
  const invalid = {
    ...value,
    jobs: value.jobs.map((job) => ({ ...job, skillIds: ["sss-copilot"] })),
  };
  await expect(
    s.handlers.get("gp:arknights-automation-save")!(invalid),
  ).rejects.toThrow();
  expect(s.saved().config).toEqual(value);
});
it("blocks configuration while busy and rejects unsupported activity query parameters before fetching", async () => {
  const s = await fixture();
  s.busy();
  await expect(
    s.handlers.get("gp:arknights-maa-import")!({ profileId: "default" }),
  ).rejects.toThrow();
  expect(s.choose).not.toHaveBeenCalled();
  expect(() =>
    s.handlers.get("gp:arknights-activity")!({ clientType: "arbitrary" }),
  ).toThrow();
});
it("imports a selected GUI plus a content-addressed App-owned infrastructure file as a draft", async () => {
  const s = await fixture(),
    schedule = join(s.dataDir, "external-schedule.json"),
    source = join(s.dataDir, "gui.new.json");
  const content = JSON.stringify({ plans: [{ name: "Day", rooms: {} }] });
  await writeFile(schedule, content);
  await writeFile(
    source,
    JSON.stringify({
      Configurations: {
        Default: {
          TaskQueue: [
            {
              TaskType: "Infrast",
              Mode: "Custom",
              Filename: schedule,
              PlanSelect: 0,
              RoomList: [{ Room: "Mfg" }],
            },
          ],
        },
      },
    }),
  );
  s.select(source);
  const imported = await s.handlers.get("gp:arknights-maa-import")!({
    profileId: "default",
  });
  const owned = imported.config.taskOptions.infrastructure.filename;
  expect(owned.startsWith(join(s.dataDir, "arknights-infrastructure"))).toBe(
    true,
  );
  expect(await readFile(owned, "utf8")).toBe(content);
  expect(s.saved().config).toEqual(s.config);
  expect(imported.config.stage).toBe("LS-6");
});
