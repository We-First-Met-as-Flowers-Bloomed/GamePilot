import { describe, expect, it } from "vitest";
import type { DeviceLane } from "../packages/protocol";
import { slotDashboardState } from "../apps/desktop/renderer/slot-dashboard-state";

describe("game account slots use game plus account identity", () => {
  it("expands two dual-game account channels into four slots sharing two actual devices", () => {
    const lanes: DeviceLane[] = [0, 1].map((instance) => ({
      id: `lane-${instance}`,
      name: `账号${instance + 1} · 双游戏`,
      instance,
      managerPath: "D:/mumu12/manager.exe",
      enabled: true,
      arknights: { enabled: true, profileId: `profile-${instance}` },
      onmyoji: { enabled: true },
      closeEmulatorAfterSuccess: false,
    }));
    const value = slotDashboardState({
      lanes,
      profiles: [],
      dailyStates: {},
      laneStatuses: {},
    });
    expect(value.slots.map((slot) => slot.id)).toEqual([
      "lane-0:arknights",
      "lane-0:onmyoji",
      "lane-1:arknights",
      "lane-1:onmyoji",
    ]);
    expect(value.counts.configured).toBe(4);
    expect(value.deviceCount).toBe(2);
    expect(value.slots.every((slot) => slot.sharedWith.length === 1)).toBe(
      true,
    );
  });
});
