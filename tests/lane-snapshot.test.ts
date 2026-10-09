import { expect, it } from "vitest";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import { defaultArknightsProfiles } from "../games/arknights/config";
import { defaultDeviceLanes } from "../packages/protocol";
const makeLane = () =>
  defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }).lanes[0]!;

it("second daily round freezes only enabled Arknights without mutating either game", () => {
  const lane = makeLane();
  lane.arknights.enabled = true;
  lane.onmyoji.enabled = true;
  const before = structuredClone(lane);
  const frozen = freezeLaneExecution(
    lane,
    defaultArknightsProfiles,
    false,
    new Date(),
    "secondary",
  );
  expect(frozen.onmyojiPlan).toBeUndefined();
  expect(frozen.arknightsPlan?.skillIds[0]).toBe("login");
  expect(frozen.lane.onmyoji.enabled).toBe(false);
  expect(frozen.profile?.id).toBe(lane.arknights.profileId);
  expect(lane).toEqual(before);
  lane.arknights.enabled = false;
  const disabled = freezeLaneExecution(
    lane,
    defaultArknightsProfiles,
    false,
    new Date(),
    "secondary",
  );
  expect(disabled.arknightsPlan).toBeUndefined();
});

it("freezes the device, account configuration and ordered plans before admission", () => {
  const lane = makeLane();
  lane.arknights.enabled = true;
  lane.onmyoji.enabled = true;
  const profiles = structuredClone(defaultArknightsProfiles);
  const frozen = freezeLaneExecution(
    lane,
    profiles,
    false,
    new Date("2026-09-25T00:00:00Z"),
  );
  lane.instance = 5;
  profiles.profiles[0]!.stage = "changed";
  expect(frozen.lane.instance).toBe(0);
  expect(frozen.profile?.stage).toBe("");
  expect(frozen.arknightsPlan?.skillIds[0]).toBe("login");
  expect(frozen.onmyojiPlan?.skillIds.at(-1)).toBe("hana-claim");
  expect(frozen.onmyojiPlan?.skillIds).not.toContain("guild-kirin");
});

it("maintenance only freezes login and foster, even when Arknights is enabled", () => {
  const lane = makeLane();
  lane.arknights.enabled = true;
  lane.onmyoji.enabled = true;
  const frozen = freezeLaneExecution(lane, defaultArknightsProfiles, true);
  expect(lane.arknights.enabled).toBe(true);
  expect(frozen.lane.arknights.enabled).toBe(false);
  expect(frozen.arknightsPlan).toBeUndefined();
  expect(frozen.onmyojiPlan?.skillIds).toEqual(["login", "foster"]);
});
