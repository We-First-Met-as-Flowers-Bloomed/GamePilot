import { expect, it } from "vitest";
import { defaultArknightsConfig } from "../games/arknights/config";
import { arknightsDailySkills } from "../games/arknights/daily-plan";
import {
  dailyLaneScope,
  maintenanceLanes,
  validateLaneProfiles,
} from "../apps/desktop/main/daily-policy";
import { defaultArknightsProfiles } from "../games/arknights/config";
import { defaultDeviceLanes } from "../packages/protocol";
it("skips blank combat stage and disabled recruitment without losing base or rewards", () => {
  expect(
    arknightsDailySkills({
      ...defaultArknightsConfig,
      stage: "",
      recruit: false,
    }),
  ).toEqual(["login", "infrastructure", "friends", "award"]);
  expect(
    arknightsDailySkills({ ...defaultArknightsConfig, stage: "LS-6" }),
  ).toContain("fight");
});
it("schedules foster only for enabled Onmyoji lanes and keeps scopes separate", () => {
  const lanes = defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }).lanes;
  const a = { ...lanes[0], enabled: true, onmyoji: { enabled: false } };
  const b = { ...a, id: "lane-b", instance: 1, onmyoji: { enabled: true } };
  expect(
    maintenanceLanes([a, b, { ...b, id: "disabled", enabled: false }]),
  ).toEqual([b]);
  expect(dailyLaneScope(a)).not.toBe(dailyLaneScope(b));
  expect(() =>
    validateLaneProfiles(
      [{ ...b, arknights: { enabled: true, profileId: "missing" } }],
      defaultArknightsProfiles,
    ),
  ).toThrow("重新绑定");
  expect(() =>
    validateLaneProfiles(
      [{ ...b, arknights: { enabled: false, profileId: "missing" } }],
      defaultArknightsProfiles,
    ),
  ).not.toThrow();
});
