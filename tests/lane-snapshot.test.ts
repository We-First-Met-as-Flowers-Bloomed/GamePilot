import { expect, it } from "vitest";
import {
  freezeLaneExecution,
  freezeLaneExecutionForGame,
  scheduledGames,
} from "../apps/desktop/main/lane-snapshot";
import { defaultArknightsProfiles } from "../games/arknights/config";
import { defaultDeviceLanes } from "../packages/protocol";
const makeLane = () =>
  defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }).lanes[0]!;

it("resolves each game's override into an immutable physical device snapshot", () => {
  const lane = makeLane();
  lane.arknights.enabled = lane.onmyoji.enabled = true;
  lane.deviceInstances = { arknights: 0, onmyoji: 2 };
  const before = structuredClone(lane);
  const ark = freezeLaneExecutionForGame(
    lane,
    defaultArknightsProfiles,
    "arknights",
    false,
  )!;
  const yys = freezeLaneExecutionForGame(
    lane,
    defaultArknightsProfiles,
    "onmyoji",
    false,
  )!;
  expect(ark.lane.instance).toBe(0);
  expect(yys.lane.instance).toBe(2);
  expect(yys.lane.deviceInstances).toBeUndefined();
  expect(lane).toEqual(before);
  lane.deviceInstances.onmyoji = 7;
  expect(yys.lane.instance).toBe(2);
});

it("rejects a combined plan whose games need different devices", () => {
  const lane = makeLane();
  lane.arknights.enabled = lane.onmyoji.enabled = true;
  lane.deviceInstances = { onmyoji: 2 };
  expect(() =>
    freezeLaneExecution(lane, defaultArknightsProfiles, false),
  ).toThrow(/不同.*实例.*分别/);
  const maintenance = freezeLaneExecution(lane, defaultArknightsProfiles, true);
  expect(maintenance.lane.instance).toBe(2);
});

it("supports shared overrides and falls back to the configured instance", () => {
  const lane = makeLane();
  lane.arknights.enabled = lane.onmyoji.enabled = true;
  lane.deviceInstances = { arknights: 3, onmyoji: 3 };
  expect(
    freezeLaneExecution(lane, defaultArknightsProfiles, false).lane.instance,
  ).toBe(3);
  delete lane.deviceInstances;
  expect(
    freezeLaneExecution(lane, defaultArknightsProfiles, false).lane.instance,
  ).toBe(0);
  lane.instance = 7;
  lane.deviceInstances = { arknights: 0, onmyoji: 0 };
  expect(
    freezeLaneExecution(lane, defaultArknightsProfiles, false).lane.instance,
  ).toBe(0);
});

it("freezes one game at a time so each game can get its own request", () => {
  // 2026-10-15（账号级 Actor · P1a'）：一次 lane 请求同时冻结两个游戏，
  // 会让"方舟失败"连阴阳师的当日机会一起吃。拆成每游戏一份之后互不牵连。
  const lane = makeLane();
  lane.arknights.enabled = true;
  lane.onmyoji.enabled = true;
  const before = structuredClone(lane);
  const ark = freezeLaneExecutionForGame(
    lane,
    defaultArknightsProfiles,
    "arknights",
    false,
  );
  expect(ark?.arknightsPlan?.skillIds[0]).toBe("login");
  expect(ark?.onmyojiPlan).toBeUndefined(); // ← 关键：不含另一个游戏
  expect(ark?.lane.onmyoji.enabled).toBe(false);
  const yys = freezeLaneExecutionForGame(
    lane,
    defaultArknightsProfiles,
    "onmyoji",
    false,
  );
  expect(yys?.onmyojiPlan?.skillIds.at(-1)).toBe("hana-claim");
  expect(yys?.arknightsPlan).toBeUndefined(); // ← 关键
  expect(lane).toEqual(before); // 冻结不改原配置
});

it("lists the games a slot should run, and none for a disabled game", () => {
  const lane = makeLane();
  lane.arknights.enabled = true;
  lane.onmyoji.enabled = true;
  const primary = scheduledGames(lane, false, "primary");
  expect(primary).toContain("arknights");
  expect(primary).toContain("onmyoji");
  // 第二时段（20:00）只跑方舟——与既有用例一致。
  expect(scheduledGames(lane, false, "secondary")).toEqual(["arknights"]);
  lane.onmyoji.enabled = false;
  expect(scheduledGames(lane, false, "primary")).toEqual(["arknights"]);
  expect(
    freezeLaneExecutionForGame(
      lane,
      defaultArknightsProfiles,
      "onmyoji",
      false,
    ),
  ).toBeUndefined();
});

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
