import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultArknightsConfig,
  taskFor,
  validateArknightsConfig,
  validateArknightsProfiles,
} from "../games/arknights/config";
import { createArknightsWorkerAdapter } from "../games/arknights/worker-adapter";
import { importMaaGuiConfig } from "../games/arknights/maa-gui-import";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0))
    await rm(path, { recursive: true, force: true });
});

it("persists typed ordinary Copilot options and constructs the native list without requiring a legacy filename", () => {
  const input = {
    ...defaultArknightsConfig,
    copilotOptions: {
      list: [
        { filename: "D:/plans/battle.json", stageName: "1-7", isRaid: true },
      ],
      formationIndex: 2,
      supportUnitUsage: 2 as const,
      supportUnitName: "能天使",
      userAdditional: [{ name: "芬", skill: 1 }],
      useSanityPotion: true,
      maxRunMinutes: 20,
    },
  };
  const config = validateArknightsConfig(input);
  expect(
    validateArknightsProfiles({
      version: 1,
      activeProfileId: "a",
      profiles: [{ ...input, id: "a", name: "a" }],
    }).profiles[0].copilotOptions,
  ).toEqual(input.copilotOptions);
  const task = taskFor("copilot", config);
  expect(task.params).toMatchObject({
    copilot_list: [
      {
        id: 0,
        filename: "D:/plans/battle.json",
        nav_name_override: "1-7",
        is_raid: true,
      },
    ],
    formation_index: 2,
    support_unit_usage: 2,
    support_unit_name: "能天使",
    user_additional: [{ name: "芬", skill: 1 }],
    use_sanity_potion: true,
  });
  expect(task.params).not.toHaveProperty("filename");
  expect(task.params).not.toHaveProperty("maxRunMinutes");
  expect(() =>
    validateArknightsConfig({ ...input, copilotOptions: { rawNative: {} } }),
  ).toThrow();
});

function worker(config: ReturnType<typeof validateArknightsConfig>) {
  const runTask = vi.fn(
    async (
      type: string,
      _params: unknown,
      _signal: AbortSignal,
      log: (line: string) => void,
      _timeout: number,
    ) => {
      log(`MAA 10001: ${JSON.stringify({ taskchain: type, taskid: 1 })}`);
      log(`MAA 10002: ${JSON.stringify({ taskchain: type, taskid: 1 })}`);
    },
  );
  const disconnectEngine = vi.fn(async () => {});
  const adapter = createArknightsWorkerAdapter({
    config: () => config,
    device: () => ({ name: "fixture", adbPath: "fixture", address: "fixture" }),
    disconnectEngine,
    createCore: () => ({
      connect: vi.fn(async () => {}),
      runTask,
      close: vi.fn(async () => {}),
    }),
    inspect: vi.fn(),
    inspectShop: vi.fn(),
    returnHome: vi.fn(),
  });
  return { adapter, runTask, disconnectEngine };
}
it("checks every Copilot list and OperBox file before any native submission", async () => {
  const state = worker(
    validateArknightsConfig({
      ...defaultArknightsConfig,
      copilotOptions: {
        list: [{ filename: "D:/missing-gamepilot-copilot.json" }],
      },
    }),
  );
  await expect(
    state.adapter.run("copilot", new AbortController().signal, vi.fn(), {
      gameId: "arknights",
      skillIds: ["copilot"],
      mode: "live",
    }),
  ).rejects.toThrow(/找不到/);
  expect(state.runTask).not.toHaveBeenCalled();
  expect(state.disconnectEngine).not.toHaveBeenCalled();
});

it("uses the smaller Copilot/global deadline and requires the optional OperBox file to exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gp-copilot-worker-"));
  temporary.push(directory);
  const filename = join(directory, "battle.json");
  await writeFile(filename, "{}");
  const options = { list: [{ filename }], maxRunMinutes: 15 };
  const missing = worker(
    validateArknightsConfig({
      ...defaultArknightsConfig,
      copilotOptions: {
        ...options,
        operboxDataPath: join(directory, "missing.json"),
      },
    }),
  );
  await expect(
    missing.adapter.run("copilot", new AbortController().signal, vi.fn(), {
      gameId: "arknights",
      skillIds: ["copilot"],
      mode: "live",
    }),
  ).rejects.toThrow(/找不到/);
  expect(missing.disconnectEngine).not.toHaveBeenCalled();
  const state = worker(
    validateArknightsConfig({
      ...defaultArknightsConfig,
      maxRunMinutes: 60,
      copilotOptions: options,
    }),
  );
  await state.adapter.run("copilot", new AbortController().signal, vi.fn(), {
    gameId: "arknights",
    skillIds: ["copilot"],
    mode: "live",
  });
  expect(state.runTask.mock.calls[0][4]).toBe(15 * 60000 + 60000);
});

it("imports safe ordinary Copilot GUI fields without lifting potion permission or replacing its local file", () => {
  const base = {
    ...defaultArknightsConfig,
    copilotFile: "D:/plans/saved.json",
  };
  const result = importMaaGuiConfig(
    {
      Configurations: {
        Default: {
          TaskQueue: [],
          Copilot: {
            UseFormation: false,
            SelectFormation: 2,
            SupportMode: "WhenNeeded",
            SupportUnitName: "能天使",
            LoopTimes: 3,
            EnableUserAdditional: true,
            UserAdditional: [{ Name: "芬", Skill: 1 }],
            UseSanityPotion: true,
            TaskList: [{ filename: "private-path" }],
          },
        },
      },
    },
    base,
  );
  expect(result.config.copilotFile).toBe(base.copilotFile);
  expect(result.config.copilotOptions).toMatchObject({
    formation: false,
    formationIndex: 2,
    loopTimes: 3,
    useSanityPotion: false,
  });
  expect(result.warnings.join(" ")).toContain("作业列表");
  expect(JSON.stringify(result)).not.toContain("private");
});
