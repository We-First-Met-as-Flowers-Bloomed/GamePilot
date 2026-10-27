import { afterEach, expect, it, vi } from "vitest";
import * as activityResources from "../packages/runtime/maa-activity-resource";
import { createArknightsWorkerAdapter } from "../games/arknights/worker-adapter";
import {
  defaultArknightsConfig,
  type ArknightsConfig,
} from "../games/arknights/config";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function setup(config: ArknightsConfig) {
  let id = 0;
  const runTask = vi.fn(
    async (
      type: string,
      _params: Record<string, unknown>,
      _signal: AbortSignal,
      log: (message: string) => void,
      _timeout: number,
    ) => {
      id++;
      log(`MAA 10001: ${JSON.stringify({ taskchain: type, taskid: id })}`);
      log(`MAA 10002: ${JSON.stringify({ taskchain: type, taskid: id })}`);
    },
  );
  const disconnectEngine = vi.fn(async () => {});
  const adapter = createArknightsWorkerAdapter({
    config: () => config,
    device: () => ({
      name: "fixture",
      adbPath: "fixture-adb",
      address: "fixture-address",
    }),
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
it("dispatches every queued stage through the worker instead of silently running only its first task", async () => {
  const { adapter, runTask, disconnectEngine } = setup({
    ...defaultArknightsConfig,
    stage: "LS-6",
    taskOptions: { fight: { stages: ["LS-6", "AP-5"], times: 2 } },
  });
  const result = await adapter.run(
    "fight",
    new AbortController().signal,
    vi.fn(),
    { gameId: "arknights", skillIds: ["fight"], mode: "live" },
  );
  if (!result) throw Error("Expected native skill result");
  expect(runTask.mock.calls.map((call) => call[1].stage)).toEqual([
    "LS-6",
    "AP-5",
  ]);
  expect(disconnectEngine).toHaveBeenCalledOnce();
  expect(result.status).toBe("succeeded");
  expect(result.summary).toContain("2/2");
});
it("applies a task's smaller time budget without sending App-only fields to MaaCore", async () => {
  const { adapter, runTask } = setup({
    ...defaultArknightsConfig,
    maxRunMinutes: 120,
    extendedOptions: {
      roguelike: { theme: "Sami", mode: 5, maxRunMinutes: 30 },
    },
  });
  await adapter.run("roguelike", new AbortController().signal, vi.fn(), {
    gameId: "arknights",
    skillIds: ["roguelike"],
    mode: "live",
  });
  expect(runTask.mock.calls[0][0]).toBe("Roguelike");
  expect(runTask.mock.calls[0][1]).toMatchObject({ theme: "Sami", mode: 5 });
  expect(runTask.mock.calls[0][1]).not.toHaveProperty("maxRunMinutes");
  expect(runTask.mock.calls[0][4]).toBe(1_860_000);
});
it("checks every Paradox playlist file before releasing the current engine or submitting native tasks", async () => {
  const { adapter, runTask, disconnectEngine } = setup({
    ...defaultArknightsConfig,
    extendedOptions: {
      paradoxCopilot: {
        list: [{ id: 1, filename: "D:/does-not-exist-gamepilot-fixture.json" }],
      },
    },
  });
  await expect(
    adapter.run("paradox-copilot", new AbortController().signal, vi.fn(), {
      gameId: "arknights",
      skillIds: ["paradox-copilot"],
      mode: "live",
    }),
  ).rejects.toThrow(/找不到.*JSON/);
  expect(runTask).not.toHaveBeenCalled();
  expect(disconnectEngine).not.toHaveBeenCalled();
});
it("never submits material-consuming operator progress without the explicit stored consent", async () => {
  const { adapter, runTask, disconnectEngine } = setup({
    ...defaultArknightsConfig,
    extendedOptions: {
      operProgress: {
        plans: [{ name: "芬", skillLevel: 2 }],
        allowMaterialConsumption: false,
      },
    },
  });
  await expect(
    adapter.run("operator-progress", new AbortController().signal, vi.fn(), {
      gameId: "arknights",
      skillIds: ["operator-progress"],
      mode: "live",
    }),
  ).rejects.toThrow(/允许消耗材料/);
  expect(runTask).not.toHaveBeenCalled();
  expect(disconnectEngine).not.toHaveBeenCalled();
});

it("awaits exact official activity authorization before disconnecting or submitting Custom", async () => {
  vi.stubEnv("GAMEPILOT_MAA_ACTIVITY_ROOT", "D:/fixture/official-activity");
  let authorize!: () => void;
  const guard = vi
    .spyOn(activityResources, "assertOfficialActivityRoute")
    .mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          authorize = resolve;
        }),
    );
  const { adapter, runTask, disconnectEngine } = setup({
    ...defaultArknightsConfig,
    clientType: "Bilibili",
    extendedOptions: { customActivity: { route: "OfficialEvent@Begin" } },
  });
  const running = adapter.run(
    "activity-game",
    new AbortController().signal,
    vi.fn(),
    {
      gameId: "arknights",
      skillIds: ["activity-game"],
      mode: "live",
    },
  );
  expect(guard).toHaveBeenCalledWith(
    "D:/fixture/official-activity",
    "OfficialEvent@Begin",
    "Bilibili",
  );
  expect(disconnectEngine).not.toHaveBeenCalled();
  expect(runTask).not.toHaveBeenCalled();
  authorize();
  await running;
  expect(runTask.mock.calls[0][0]).toBe("Custom");
  expect(runTask.mock.calls[0][1]).toEqual({
    enable: true,
    task_names: ["OfficialEvent@Begin"],
  });
});

it("rejects a syntactically valid activity route when official authorization rejects it", async () => {
  vi.stubEnv("GAMEPILOT_MAA_ACTIVITY_ROOT", "D:/fixture/official-activity");
  vi.spyOn(activityResources, "assertOfficialActivityRoute").mockRejectedValue(
    Error("official activity expired"),
  );
  const { adapter, runTask, disconnectEngine } = setup({
    ...defaultArknightsConfig,
    extendedOptions: { customActivity: { route: "Gacha" } },
  });
  await expect(
    adapter.run("activity-game", new AbortController().signal, vi.fn(), {
      gameId: "arknights",
      skillIds: ["activity-game"],
      mode: "live",
    }),
  ).rejects.toThrow("official activity expired");
  expect(runTask).not.toHaveBeenCalled();
  expect(disconnectEngine).not.toHaveBeenCalled();
});
