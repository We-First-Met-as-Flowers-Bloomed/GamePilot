import { describe, it, expect } from "vitest";
import { validateRoutine } from "../packages/protocol/routine";
import { compileDailyPlan, defaultRoutine } from "../games/routines";
import { games } from "../games/registry";
import { validateDeviceLanes, defaultDeviceLanes } from "../packages/protocol";
import { maintenanceLanes } from "../apps/desktop/main/daily-policy";
import { beijingWeekday } from "../packages/protocol/routine";
import {
  onmyojiHandlers,
  executeOnmyojiSkill,
} from "../games/onmyoji/executor";
import type { GameDevice } from "../packages/runtime/device";
import { arknightsConfigForPlan } from "../games/arknights/daily-plan";
import { defaultArknightsConfig, taskFor } from "../games/arknights/config";
const step = (skillId: string, enabled = true, weekdays?: number[]) => ({
  skillId,
  enabled,
  ...(weekdays ? { weekdays } : {}),
});
const routine = (steps: ReturnType<typeof step>[]) => ({
  version: 1 as const,
  steps,
});
const thursday = new Date("2026-09-24T00:00:00Z");
const friday = new Date("2026-09-25T00:00:00Z");
describe("composable daily routines", () => {
  it("compiles stored account profiles without forwarding profile metadata as task options", () => {
    const profile = {
      ...defaultArknightsConfig,
      id: "official-account",
      name: "账号二 官服",
      stage: "LS-6",
      mail: true,
    };
    const plan = compileDailyPlan("arknights");
    const effective = arknightsConfigForPlan(profile, plan);
    expect(effective).not.toHaveProperty("id");
    expect(effective).not.toHaveProperty("name");
    expect(effective.mail).toBe(true);
    expect(effective.stage).toBe("LS-6");
    expect(taskFor("fight", effective).params).toMatchObject({
      medicine: 0,
      stone: 0,
    });
    const invalidProfile = { ...profile, arbitrary: true };
    expect(() => arknightsConfigForPlan(invalidProfile, plan)).toThrow(
      "不支持",
    );
  });
  it("uses routine recruitment selection and preflights missing fight configuration", () => {
    const config = { ...defaultArknightsConfig, recruit: false };
    const plan = compileDailyPlan("arknights", routine([step("recruit")]));
    const effective = arknightsConfigForPlan(config, plan);
    expect(taskFor("recruit", effective).params.enable).toBe(true);
    expect(config.recruit).toBe(false);
    expect(() =>
      arknightsConfigForPlan(
        config,
        compileDailyPlan("arknights", routine([step("fight")])),
      ),
    ).toThrow("作战关卡");
  });
  it("uses the Beijing date across UTC midnight and provides every registered Onmyoji handler", async () => {
    expect(beijingWeekday(new Date("2026-09-24T15:59:59Z"))).toBe(4);
    expect(beijingWeekday(new Date("2026-09-24T16:00:00Z"))).toBe(5);
    expect(Object.keys(onmyojiHandlers).sort()).toEqual(
      games
        .find((g) => g.id === "onmyoji")!
        .skills.map((s) => s.id)
        .sort(),
    );
    await expect(
      executeOnmyojiSkill(
        "toString",
        {} as GameDevice,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("未注册");
    const abort = new AbortController();
    abort.abort();
    await expect(
      executeOnmyojiSkill("login", {} as GameDevice, abort.signal, () => {}),
    ).rejects.toThrow();
  });
  it("pins login first and Hana last while retaining user order and exclusions", () => {
    const plan = compileDailyPlan(
      "onmyoji",
      routine([
        step("hana-claim"),
        step("mail"),
        step("foster", false),
        step("realm-raid"),
      ]),
      undefined,
      friday,
    );
    expect(plan.skillIds).toEqual([
      "login",
      "mail",
      "realm-raid",
      "hana-claim",
    ]);
  });
  it("intersects user days with the Kirin Monday-Thursday constraint", () => {
    const custom = routine([
      step("guild-kirin", true, [4, 5]),
      step("mail", true, [5]),
    ]);
    expect(
      compileDailyPlan("onmyoji", custom, undefined, thursday).skillIds,
    ).toEqual(["login", "guild-kirin"]);
    expect(
      compileDailyPlan("onmyoji", custom, undefined, friday).skillIds,
    ).toEqual(["login", "mail"]);
  });
  it("keeps foster out of daily defaults and legacy saved daily routines", () => {
    expect(
      defaultRoutine("onmyoji").steps.some(
        (s) => s.skillId === "foster" && s.enabled,
      ),
    ).toBe(false);
    expect(
      compileDailyPlan("onmyoji", routine([step("foster"), step("hana-claim")]))
        .skillIds,
    ).toEqual(["login", "hana-claim"]);
    expect(
      compileDailyPlan(
        "arknights",
        undefined,
        ["login", "friends", "award"],
        friday,
      ).skillIds,
    ).toEqual(["login", "friends", "award"]);
  });
  it("rejects unknown fields, unknown skills, duplicates and invalid weekdays", () => {
    const game = games.find((g) => g.id === "onmyoji")!;
    for (const value of [
      routine([step("shell")]),
      routine([step("mail"), step("mail")]),
      routine([step("mail", true, [7])]),
      routine([step("mail", true, [1, 1])]),
      { ...routine([step("mail")]), script: "x" },
    ])
      expect(() => validateRoutine(value, game)).toThrow();
  });
  it("round-trips per-lane routines and disables background foster when excluded", () => {
    const config = defaultDeviceLanes({
      managerPath: "D:/MuMu/MuMuManager.exe",
      instance: 0,
      closeEmulatorAfterSuccess: false,
    });
    const custom = routine([step("mail"), step("foster", false)]);
    config.lanes[0].onmyoji = { enabled: true, routine: custom };
    expect(validateDeviceLanes(config).lanes[0].onmyoji.routine).toEqual(
      custom,
    );
    expect(maintenanceLanes(config.lanes)).toEqual([]);
  });
});
