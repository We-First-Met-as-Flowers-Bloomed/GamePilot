import { describe, expect, it } from "vitest";
import type { DeviceLane } from "../packages/protocol";
import { defaultArknightsConfig } from "../games/arknights/config";
import { slotDashboardState } from "../apps/desktop/renderer/slot-dashboard-state";

const now = new Date("2026-10-24T10:00:00+08:00");
const lane = (id = "lane-a", instance = 0): DeviceLane => ({
  id,
  name: id,
  enabled: true,
  instance,
  managerPath: "",
  arknights: { enabled: true, profileId: "a" },
  onmyoji: { enabled: true },
  closeEmulatorAfterSuccess: false,
});
const profile = {
  ...defaultArknightsConfig,
  id: "a",
  name: "账号档案一",
  expectedUid: "123456789",
  clientType: "Official" as const,
};
const project = (
  lanes: DeviceLane[],
  extra: Partial<Parameters<typeof slotDashboardState>[0]> = {},
) =>
  slotDashboardState({
    lanes,
    profiles: [profile],
    dailyStates: {},
    laneStatuses: {},
    now,
    ...extra,
  });

describe("game account slot projection", () => {
  it("keeps four single-game channels on four devices independent", () => {
    const lanes = [0, 1, 2, 3].map((instance) => ({
      ...lane(`channel-${instance}`, instance),
      arknights: { enabled: instance < 2, profileId: "a" },
      onmyoji: { enabled: instance >= 2 },
    }));
    const value = project(lanes);
    expect(value.counts).toEqual({ configured: 4, enabled: 4, active: 0 });
    expect(value.deviceCount).toBe(4);
    expect(
      value.slots.every((slot) => !slot.sharedWith.length && slot.canRun),
    ).toBe(true);
  });
  it("can stop the current single-game channel when a saved bulk run owns it", () => {
    const current = { ...lane(), onmyoji: { enabled: false } };
    const value = project([current], {
      requests: [
        {
          version: 1,
          id: "bulk:lane-a",
          laneId: current.id,
          batchId: "bulk",
          source: "daily",
          resources: [],
          fingerprint: "test",
          status: "running",
          startedAt: now.toISOString(),
          message: "running",
          snapshot: {
            lane: current,
            arknightsPlan: {
              gameId: "arknights",
              mode: "live",
              skillIds: ["login"],
            },
          },
        },
      ],
    });
    expect(value.slots[0].canStop).toBe(true);
    expect(value.slots[0].stopKind).toBe("channel");
  });
  it("projects two games on two accounts into four stable slots while keeping two physical instances", () => {
    const value = project([lane(), lane("lane-b", 1)], {
      profiles: [profile, { ...profile, id: "unused" }],
    });
    expect(value.slots.map((s) => s.id)).toEqual([
      "lane-a:arknights",
      "lane-a:onmyoji",
      "lane-b:arknights",
      "lane-b:onmyoji",
    ]);
    expect(value.counts).toEqual({ configured: 4, enabled: 4, active: 0 });
    expect(value.deviceCount).toBe(2);
    expect(value.slots.map((s) => s.game.instance)).toEqual([0, 0, 1, 1]);
    expect(value.slots.every((s) => s.sharedWith.length === 1)).toBe(true);
  });
  it("uses the selected game's actual device override and never combines two games in a slot", () => {
    const value = project([
      { ...lane(), instance: 4, deviceInstances: { arknights: 7, onmyoji: 9 } },
    ]);
    expect(value.slots.map((s) => [s.game.id, s.game.instance])).toEqual([
      ["arknights", 7],
      ["onmyoji", 9],
    ]);
    expect(value.slots.every((s) => s.sharedWith.length === 0)).toBe(true);
    expect(value.deviceCount).toBe(2);
  });
  it("does not create slots from extra profiles, disabled games or an empty lane", () => {
    expect(project([]).slots).toEqual([]);
    const disabledGame = { ...lane(), onmyoji: { enabled: false } };
    expect(project([disabledGame]).slots.map((s) => s.id)).toEqual([
      "lane-a:arknights",
    ]);
    expect(
      project([
        { ...disabledGame, arknights: { enabled: false, profileId: "a" } },
      ]).slots,
    ).toEqual([]);
    const disabledLane = project([{ ...lane(), enabled: false }]);
    expect(disabledLane.counts).toEqual({
      configured: 2,
      enabled: 0,
      active: 0,
    });
    expect(disabledLane.slots.every((s) => !s.canRun)).toBe(true);
  });
  it("never borrows the Arknights profile or server identity for Onmyoji", () => {
    const slots = project([lane()]).slots;
    expect(slots[0].game).toMatchObject({
      profileName: "账号档案一",
      clientLabel: "官服",
      identityLabel: "UID 已配置 · 运行时核对",
    });
    expect(JSON.stringify(slots[0].game)).not.toContain("123456789");
    expect(JSON.stringify(slots[1].game)).not.toContain("账号档案一");
    expect(JSON.stringify(slots[1].game)).not.toContain("官服");
    expect(JSON.stringify(slots[1].game)).not.toContain("UID 已配置");
    expect(project([lane()], { profiles: [] }).slots[0].game.profileName).toBe(
      "账号档案缺失",
    );
  });
  it("does not infer that both game slots are running from a legacy lane-only status", () => {
    const value = project([lane()], { laneStatuses: { "lane-a": "running" } });
    expect(value.counts.active).toBe(0);
    expect(value.slots.every((s) => !s.active && !s.canStop)).toBe(true);
    expect(value.slots.every((s) => !s.label.includes("已完成"))).toBe(true);
  });
});
