import { describe, expect, it } from "vitest";
import {
  nativeCopilotTaskOptions,
  resolveArknightsCopilotOptions,
  validateArknightsCopilotOptions,
} from "../games/arknights/copilot-options";

describe("ordinary Copilot options for MaaCore 6.20.1", () => {
  it("preserves legacy single-file loops without granting potion use", () => {
    const task = nativeCopilotTaskOptions({
      copilotFile: "D:/plans/1-7.json",
      copilotLoopTimes: 3,
    });
    expect(task).toMatchObject({
      filename: "D:/plans/1-7.json",
      loop_times: 3,
      use_sanity_potion: false,
      formation: true,
    });
    expect(task).not.toHaveProperty("copilot_list");
    expect(task).not.toHaveProperty("medicine");
    expect(task).not.toHaveProperty("stone");
  });

  it("maps a navigated single file through the real native list structure", () => {
    const task = nativeCopilotTaskOptions({
      copilotFile: "D:/plans/battle.json",
      copilotOptions: {
        stageNavigation: true,
        stageName: "H12-4",
        isRaid: true,
      },
    });
    expect(task.copilot_list).toEqual([
      {
        id: 0,
        filename: "D:/plans/battle.json",
        nav_name_override: "H12-4",
        is_raid: true,
      },
    ]);
    expect(task).not.toHaveProperty("filename");
    expect(task).not.toHaveProperty("stage_navigation");
    expect(task).not.toHaveProperty("is_raid");
    expect(task).not.toHaveProperty("loop_times");
  });

  it("keeps queue order and per-file navigation without sending a shadowing legacy filename", () => {
    const task = nativeCopilotTaskOptions({
      copilotFile: "D:/plans/old.json",
      copilotOptions: {
        list: [
          { filename: "D:/plans/first.json", isRaid: true },
          { filename: "D:/plans/second.json", stageName: "1-7" },
        ],
      },
    });
    expect(task.copilot_list).toEqual([
      { id: 0, filename: "D:/plans/first.json", is_raid: true },
      {
        id: 1,
        filename: "D:/plans/second.json",
        nav_name_override: "1-7",
        is_raid: false,
      },
    ]);
    expect(task).not.toHaveProperty("filename");
    expect(task).not.toHaveProperty("loop_times");
  });

  it("maps supported formation and operator-check parameters without forwarding the App time budget", () => {
    const task = nativeCopilotTaskOptions({
      copilotFile: "battle.json",
      copilotOptions: {
        formation: true,
        formationIndex: 4,
        supportUnitUsage: 2,
        supportUnitName: "艾雅法拉",
        userAdditional: [
          { name: "芬", skill: 0 },
          { name: "能天使", skill: 3 },
        ],
        useSanityPotion: true,
        addTrust: true,
        ignoreRequirements: true,
        operboxDataPath: "D:/plans/operators.json",
        maxRunMinutes: 10,
      },
    });
    expect(task).toMatchObject({
      formation_index: 4,
      support_unit_usage: 2,
      support_unit_name: "艾雅法拉",
      user_additional: [
        { name: "芬", skill: 0 },
        { name: "能天使", skill: 3 },
      ],
      use_sanity_potion: true,
      add_trust: true,
      ignore_requirements: true,
      operbox_data_path: "D:/plans/operators.json",
    });
    expect(task).not.toHaveProperty("maxRunMinutes");
    expect(task).not.toHaveProperty("max_run_minutes");
  });

  it("rejects loops that Core would silently ignore for navigation and queues", () => {
    expect(() =>
      nativeCopilotTaskOptions({
        copilotFile: "battle.json",
        copilotLoopTimes: 2,
        copilotOptions: { stageNavigation: true },
      }),
    ).toThrow(/单文件|循环/);
    expect(() =>
      validateArknightsCopilotOptions({
        list: [{ filename: "battle.json" }],
        loopTimes: 2,
      }),
    ).toThrow(/单文件|循环/);
    expect(() =>
      nativeCopilotTaskOptions({
        copilotFile: "battle.json",
        copilotOptions: { isRaid: true },
      }),
    ).toThrow(/导航/);
  });

  it.each([
    { loopTimes: 0 },
    { loopTimes: 100 },
    { loopTimes: 1.5 },
    { formationIndex: 5 },
    { supportUnitUsage: 4 },
    { supportUnitUsage: 2 },
    { maxRunMinutes: 4 },
    { maxRunMinutes: 361 },
    { useSanityPotion: "true" },
    { userAdditional: [{ name: "芬", skill: 4 }] },
    {
      userAdditional: [
        { name: "芬", skill: 1 },
        { name: "芬", skill: 2 },
      ],
    },
    { list: Array.from({ length: 21 }, () => ({ filename: "battle.json" })) },
    { list: [{ filename: "https://example.com/battle.json" }] },
    { list: [{ filename: "battle.exe" }] },
    { list: [{ filename: "battle.json", params: { stone: 999 } }] },
    { use_sanity_potion: true },
    { medicine: 999 },
    { stone: 1 },
  ])("rejects unsupported or unbounded values: %j", (input) => {
    expect(() => validateArknightsCopilotOptions(input)).toThrow();
  });

  it("clones nested options so resolving one profile cannot mutate another", () => {
    const first = resolveArknightsCopilotOptions();
    first.list.push({ filename: "battle.json" });
    first.userAdditional.push({ name: "芬", skill: 1 });
    const next = resolveArknightsCopilotOptions();
    expect(next.list).toEqual([]);
    expect(next.userAdditional).toEqual([]);
    expect(next.useSanityPotion).toBe(false);
    expect(() => nativeCopilotTaskOptions()).toThrow(/路径|作业/);
  });
});
