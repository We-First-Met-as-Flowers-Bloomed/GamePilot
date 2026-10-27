import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { defaultDeviceLanes, validateDeviceLanes } from "../packages/protocol";
import { DeviceLaneStore } from "../apps/desktop/main/device-lanes";

const laneA = {
  id: "lane-a",
  name: "MuMu 0",
  managerPath: "D:\\MuMu\\nx_main\\MuMuManager.exe",
  instance: 0,
  enabled: true,
  arknights: { enabled: true, profileId: "b-account" },
  onmyoji: { enabled: true },
  closeEmulatorAfterSuccess: false,
};
const laneB = {
  ...laneA,
  id: "lane-b",
  name: "MuMu 1",
  instance: 1,
  arknights: { enabled: true, profileId: "official-account" },
  onmyoji: { enabled: false },
};

describe("device lanes", () => {
  it("rejects unknown routine skills before saving and round-trips valid routines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gamepilot-routines-"));
    const store = new DeviceLaneStore(join(dir, "lanes.json"), () => ({
      managerPath: laneA.managerPath,
      instance: 0,
      closeEmulatorAfterSuccess: false,
    }));
    const custom = {
      version: 1,
      lanes: [
        {
          ...laneA,
          onmyoji: {
            enabled: true,
            routine: {
              version: 1,
              steps: [{ skillId: "mail", enabled: true, weekdays: [1, 4] }],
            },
          },
        },
      ],
    };
    const saved = await store.save(custom);
    expect(saved.version).toBe(2);
    expect(saved.lanes).toHaveLength(2);
    expect(saved.lanes[1].onmyoji.routine).toEqual(
      custom.lanes[0].onmyoji.routine,
    );
    expect(await store.read()).toEqual(saved);
    custom.lanes[0].onmyoji.routine.steps[0].skillId = "shell";
    await expect(store.save(custom)).rejects.toThrow("未知技能");
    expect(
      (await store.read()).lanes[0].onmyoji.routine!.steps[0].skillId,
    ).toBe("mail");
  });
  it("validates two distinct lanes and disabled Onmyoji", () => {
    expect(validateDeviceLanes({ version: 1, lanes: [laneA, laneB] })).toEqual({
      version: 1,
      lanes: [laneA, laneB],
    });
  });

  it("rejects duplicate identifiers, instances, and unknown fields", () => {
    expect(() =>
      validateDeviceLanes({
        version: 1,
        lanes: [laneA, { ...laneB, instance: 0 }],
      }),
    ).toThrow("MuMu 实例不能重复");
    expect(() =>
      validateDeviceLanes({
        version: 1,
        lanes: [laneA, { ...laneB, id: "lane-a" }],
      }),
    ).toThrow("设备槽位编号不能重复");
    expect(() =>
      validateDeviceLanes({
        version: 1,
        lanes: [{ ...laneA, command: "shell" }],
      }),
    ).toThrow("不支持的设备槽位字段");
  });

  it("migrates the legacy automation instance into lane A", () => {
    expect(
      defaultDeviceLanes({
        managerPath: laneA.managerPath,
        instance: 0,
        closeEmulatorAfterSuccess: true,
      }).lanes[0],
    ).toMatchObject({
      id: "lane-a",
      managerPath: laneA.managerPath,
      instance: 0,
      closeEmulatorAfterSuccess: true,
      onmyoji: { enabled: true },
    });
  });

  it("persists validated lanes atomically and migrates a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gamepilot-lanes-"));
    const file = join(dir, "device-lanes.json");
    const store = new DeviceLaneStore(file, () => ({
      managerPath: laneA.managerPath,
      instance: 0,
      closeEmulatorAfterSuccess: false,
    }));
    expect((await store.read()).lanes[0].instance).toBe(0);
    const saved = await store.save({ version: 1, lanes: [laneA, laneB] });
    expect(saved.version).toBe(2);
    expect(saved.lanes.map((lane) => lane.id)).toEqual([
      "lane-a",
      "lane-a-onmyoji",
      "lane-b",
    ]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(saved);
  });
});

describe("device lanes · per-game instances", () => {
  const withInstances = (deviceInstances: Record<string, unknown>) => ({
    version: 1,
    lanes: [{ ...laneA, deviceInstances }],
  });

  it("round-trips valid per-game instances", () => {
    const parsed = validateDeviceLanes(
      withInstances({ arknights: 0, onmyoji: 2 }),
    );
    expect(parsed.lanes[0].deviceInstances).toEqual({
      arknights: 0,
      onmyoji: 2,
    });
  });

  it("keeps them optional", () => {
    const parsed = validateDeviceLanes({ version: 1, lanes: [laneA] });
    expect(parsed.lanes[0].deviceInstances).toBeUndefined();
  });

  it.each([-1, 1000, 1.5, "2"])("rejects invalid instance %s", (bad) => {
    expect(() =>
      validateDeviceLanes(withInstances({ arknights: bad })),
    ).toThrow();
  });

  it("rejects unknown per-game keys", () => {
    expect(() => validateDeviceLanes(withInstances({ starrail: 1 }))).toThrow();
  });
});
