import { describe, expect, it } from "vitest";
import {
  validatePlan,
  validateSettings,
  validateDeviceLanes,
} from "../packages/protocol";
import { onmyoji } from "../games/onmyoji";
import { dailySkills, games } from "../games/registry";
const plan = {
  gameId: "onmyoji",
  skillIds: ["login", "check-in"],
  mode: "rehearsal",
};
describe("plan boundary", () => {
  it("accepts an explicit rehearsal of known skills", () =>
    expect(validatePlan(plan, [onmyoji])).toEqual(plan));
  it("rejects unknown skills", () =>
    expect(() =>
      validatePlan({ ...plan, skillIds: ["shell"] }, [onmyoji]),
    ).toThrow("技能"));
  it("opens the live-validated check-in and keeps the daily order", () => {
    expect(validatePlan({ ...plan, mode: "live" }, games)).toMatchObject({
      gameId: "onmyoji",
      skillIds: ["login", "check-in"],
    });
    expect(dailySkills("onmyoji")).toEqual([
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "guild-quest",
      "guild-kirin",
      "realm-raid",
      "hana-claim",
    ]);
    expect(
      dailySkills("onmyoji").every(
        (id) => onmyoji.skills.find((skill) => skill.id === id)?.ready,
      ),
    ).toBe(true);
  });
  it("rejects injected fields", () =>
    expect(() =>
      validatePlan({ ...plan, command: "anything" }, [onmyoji]),
    ).toThrow("字段"));
  it("rejects empty and duplicate plans", () => {
    expect(() => validatePlan({ ...plan, skillIds: [] }, [onmyoji])).toThrow();
    expect(() =>
      validatePlan({ ...plan, skillIds: ["login", "login"] }, [onmyoji]),
    ).toThrow();
  });
});
describe("settings boundary", () => {
  it("accepts empty initial settings", () =>
    expect(
      validateSettings({
        adbPath: "",
        address: "",
        modelEndpoint: "",
        modelName: "",
      }),
    ).toEqual({ adbPath: "", address: "", modelEndpoint: "", modelName: "" }));
  it("rejects malformed endpoints and non-string fields", () => {
    expect(() =>
      validateSettings({
        adbPath: 3,
        address: "",
        modelEndpoint: "",
        modelName: "",
      }),
    ).toThrow();
    expect(() =>
      validateSettings({
        adbPath: "",
        address: "",
        modelEndpoint: "file:///secret",
        modelName: "",
      }),
    ).toThrow();
  });
});

it("rejects a lane with neither game enabled", () => {
  expect(() =>
    validateDeviceLanes({
      version: 1,
      lanes: [
        {
          id: "lane-a",
          name: "MuMu 0",
          managerPath: "D:\\MuMu\\nx_main\\MuMuManager.exe",
          instance: 0,
          enabled: true,
          arknights: { enabled: false, profileId: "default" },
          onmyoji: { enabled: false },
          closeEmulatorAfterSuccess: false,
        },
      ],
    }),
  ).toThrow("至少启用一个游戏");
});
