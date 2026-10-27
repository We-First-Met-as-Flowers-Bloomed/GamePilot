import { describe, expect, it } from "vitest";
import { defaultDeviceLanes } from "../packages/protocol";
import { defaultArknightsProfiles } from "../games/arknights/config";
import {
  prepareChannelCopies,
  persistChannelCopies,
} from "../apps/desktop/main/channel-template";
import { validateLaneProfiles } from "../apps/desktop/main/daily-policy";
import { freezeLaneExecutionForGame } from "../apps/desktop/main/lane-snapshot";

function fixture() {
  const lanes = defaultDeviceLanes({
    managerPath: "D:/MuMu/nx_main/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  });
  lanes.lanes[0].arknights.routine = {
    version: 1,
    steps: [{ skillId: "login", enabled: true }],
  };
  const profiles = structuredClone(defaultArknightsProfiles);
  profiles.profiles[0].expectedUid = "123456789";
  profiles.profiles[0].accountName = "原账号";
  profiles.profiles[0].copilotFile = "D:/private/copilot.json";
  return { lanes, profiles };
}
const request = {
  sourceLaneId: "lane-a",
  gameId: "arknights",
  targets: [
    { instance: 2, name: "账号三" },
    { instance: 3, name: "账号四" },
  ],
};

describe("standard channel copies", () => {
  it("creates paused single-game channels and distinct profiles without copying identity or private files", () => {
    const { lanes, profiles } = fixture();
    const original = structuredClone({ lanes, profiles });
    let sequence = 0;
    const result = prepareChannelCopies(
      lanes,
      profiles,
      request,
      () => `copy-${++sequence}`,
    );
    expect(result.lanes.lanes).toHaveLength(3);
    expect(result.profiles.profiles).toHaveLength(3);
    const copies = result.lanes.lanes.slice(1);
    expect(copies.map((c) => c.enabled)).toEqual([false, false]);
    expect(copies.map((c) => c.instance)).toEqual([2, 3]);
    expect(new Set(copies.map((c) => c.id)).size).toBe(2);
    expect(new Set(copies.map((c) => c.arknights.profileId)).size).toBe(2);
    for (const c of copies) {
      expect(c.onmyoji.enabled).toBe(false);
      expect(c.identityRequired).toBe(true);
      expect(c.deviceInstances).toBeUndefined();
      const p = result.profiles.profiles.find(
        (p) => p.id === c.arknights.profileId,
      )!;
      expect(p.expectedUid).toBe("");
      expect(p.accountName).toBe("");
      expect(p.copilotFile).toBe("");
    }
    copies[0].arknights.routine!.steps[0].enabled = false;
    expect(copies[1].arknights.routine!.steps[0].enabled).toBe(true);
    expect({ lanes, profiles }).toEqual(original);
  });
  it("clears Onmyoji identity when copying its workflow", () => {
    const { lanes, profiles } = fixture();
    const result = prepareChannelCopies(
      lanes,
      profiles,
      {
        ...request,
        gameId: "onmyoji",
        targets: [{ instance: 2, name: "阴阳师三" }],
      },
      () => "fresh",
    );
    const c = result.lanes.lanes[1];
    expect(c.arknights.enabled).toBe(false);
    expect(c.onmyoji.enabled).toBe(true);
    expect(c.onmyoji.identity).toBeUndefined();
    expect(result.profiles).toEqual(profiles);
  });
  it("rejects existing devices and duplicate batch targets without changing input", () => {
    const { lanes, profiles } = fixture();
    const original = structuredClone(lanes);
    expect(() =>
      prepareChannelCopies(lanes, profiles, {
        ...request,
        targets: [{ instance: 0, name: "冲突" }],
      }),
    ).toThrow(/绑定|占用/);
    expect(() =>
      prepareChannelCopies(lanes, profiles, {
        ...request,
        targets: [
          { instance: 2, name: "一" },
          { instance: 2, name: "二" },
        ],
      }),
    ).toThrow(/重复/);
    expect(lanes).toEqual(original);
  });
  it("rejects bad targets, unsupported games and missing source", () => {
    const { lanes, profiles } = fixture();
    for (const r of [
      { ...request, sourceLaneId: "missing" },
      { ...request, gameId: "shell" },
      { ...request, targets: [] },
      { ...request, targets: [{ instance: -1, name: "bad" }] },
    ]) {
      expect(() => prepareChannelCopies(lanes, profiles, r)).toThrow();
    }
  });
  it("cannot enable a copied account until its own identity is bound", () => {
    const { lanes, profiles } = fixture();
    const result = prepareChannelCopies(lanes, profiles, {
      ...request,
      targets: [request.targets[0]],
    });
    result.lanes.lanes[1].enabled = true;
    expect(() =>
      validateLaneProfiles(result.lanes.lanes, result.profiles),
    ).toThrow(/UID/);
    expect(() =>
      freezeLaneExecutionForGame(
        result.lanes.lanes[1],
        result.profiles,
        "arknights",
        false,
      ),
    ).toThrow(/UID/);
    result.profiles.profiles[1].expectedUid = "987654321";
    expect(() =>
      validateLaneProfiles(result.lanes.lanes, result.profiles),
    ).not.toThrow();
  });
  it("accepts a 40-character channel name while keeping its profile name valid", () => {
    const { lanes, profiles } = fixture();
    const result = prepareChannelCopies(lanes, profiles, {
      ...request,
      targets: [{ instance: 2, name: "长".repeat(40) }],
    });
    expect(result.profiles.profiles[1].name.length).toBeLessThanOrEqual(40);
  });
  it("rolls back new profiles if saving channels fails", async () => {
    const original = fixture();
    let storedProfiles = structuredClone(original.profiles);
    const saved: string[][] = [];
    await expect(
      persistChannelCopies(
        {
          deviceLanes: {
            read: async () => original.lanes,
            save: async () => {
              throw Error("disk failure");
            },
          },
          arknights: {
            read: async () => storedProfiles,
            save: async (value) => {
              storedProfiles = structuredClone(value);
              saved.push(value.profiles.map((p) => p.id));
              return value;
            },
          },
        },
        request,
      ),
    ).rejects.toThrow("disk failure");
    expect(storedProfiles).toEqual(original.profiles);
    expect(saved).toHaveLength(2);
    expect(original.lanes.lanes).toHaveLength(1);
  });
});
