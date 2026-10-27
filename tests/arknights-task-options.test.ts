import { describe, expect, it } from "vitest";
import {
  defaultArknightsConfig,
  taskFor,
  validateArknightsConfig,
  validateArknightsProfiles,
  defaultArknightsProfiles,
} from "../games/arknights/config";
import { resolveArknightsTaskOptions } from "../games/arknights/task-options";

describe("typed internal daily options", () => {
  it("avoids production room visits when drones are disabled in preset mode", () => {
    const config = {
      ...defaultArknightsConfig,
      taskOptions: { infrastructure: { drones: "_NotUse" as const } },
    };
    expect(taskFor("infrastructure", config).params.facility).toEqual(["Reception"]);
    expect(
      taskFor("infrastructure", {
        ...config,
        taskOptions: {
          infrastructure: { mode: 0, facility: ["Trade"], drones: "_NotUse" },
        },
      }).params.facility,
    ).toEqual(["Trade"]);
  });
  it("keeps reception chores and trading drones alongside overview preset staffing", () => {
    const task = taskFor("infrastructure", defaultArknightsConfig);
    expect(task).toMatchObject({
      type: "Infrast",
      params: {
        mode: 20000,
        facility: ["Trade", "Reception"],
        drones: "Money",
        replenish: false,
        dorm_notstationed_enabled: false,
        dorm_trust_enabled: false,
        reception_message_board: true,
        reception_clue_exchange: true,
        reception_send_clue: true,
        continue_training: false,
      },
    });
    const defaults = resolveArknightsTaskOptions().infrastructure;
    expect(defaults.facility).toEqual(["Trade", "Reception"]);
    expect(defaults.receptionMessageBoard).toBe(true);
    expect(defaults.receptionClueExchange).toBe(true);
    expect(defaults.receptionSendClue).toBe(true);
    const explicit = taskFor("infrastructure", {
      ...defaultArknightsConfig,
      taskOptions: {
        infrastructure: {
          mode: 20000,
          facility: ["Trade", "Reception"],
          receptionClueExchange: true,
        },
      },
    });
    expect(explicit.params.facility).toEqual(["Trade", "Reception"]);
    expect(explicit.params.reception_clue_exchange).toBe(true);
  });
  it("preserves an explicitly disabled reception configuration", () => {
    const task = taskFor("infrastructure", {
      ...defaultArknightsConfig,
      taskOptions: { infrastructure: {
        facility: ["Trade"], receptionMessageBoard: false,
        receptionClueExchange: false, receptionSendClue: false,
      } },
    });
    expect(task.params).toMatchObject({facility:["Trade"],reception_message_board:false,reception_clue_exchange:false,reception_send_clue:false});
  });
  it("maps explicit bounded fight options and persists them on the bound profile", () => {
    const config = validateArknightsConfig({
      ...defaultArknightsConfig,
      stage: "LS-6",
      taskOptions: {
        fight: {
          times: 8,
          series: 2,
          medicine: 1,
          stone: 0,
          medicineExpireDays: 2,
          followActivity: true,
          drops: { "30011": 5 },
          restartOnCrash: true,
          drGrandet: true,
        },
      },
    });
    expect(taskFor("fight", config).params).toMatchObject({
      stage: "LS-6",
      times: 8,
      series: 2,
      medicine: 1,
      stone: 0,
      medicine_expire_days: 2,
      drops: { "30011": 5 },
      client_type: "Official",
      DrGrandet: true,
    });
    expect(taskFor("fight", config).params).not.toHaveProperty(
      "followActivity",
    );
    const profiles = validateArknightsProfiles({
      ...defaultArknightsProfiles,
      profiles: [{ ...defaultArknightsProfiles.profiles[0], ...config }],
    });
    expect(profiles.profiles[0].taskOptions).toEqual(config.taskOptions);
  });
  it("maps recruitment, mall and normal base options instead of hardcoded defaults", () => {
    const config = validateArknightsConfig({
      ...defaultArknightsConfig,
      creditShopping: true,
      taskOptions: {
        recruit: {
          times: 2,
          refresh: true,
          select: [3, 4],
          confirm: [3, 4],
          reserveRecruitmentCount: 8,
          recruitmentTime: { "3": 540, "4": 460 },
        },
        mall: {
          visitFriends: false,
          buyFirst: ["招聘许可"],
          blacklist: ["碳"],
          forceShoppingIfCreditFull: false,
          onlyBuyDiscount: false,
          reserveMaxCredit: false,
        },
        infrastructure: {
          mode: 0,
          facility: ["Mfg", "Recycle", "Training"],
          threshold: 0.4,
          drones: "PureGold",
          continueTraining: true,
        },
      },
    });
    expect(taskFor("recruit", config).params).toMatchObject({
      times: 2,
      refresh: true,
      select: [3, 4],
      confirm: [3, 4],
      level3_recruitment_permit_reserve: 8,
      recruitment_time: { "3": 540, "4": 460 },
      preserve_tags: ["高级资深干员", "资深干员", "支援机械"],
      expedite: false,
    });
    expect(taskFor("friends", config).params).toMatchObject({
      visit_friends: false,
      shopping: true,
      buy_first: ["招聘许可"],
      blacklist: ["碳"],
      force_shopping_if_credit_full: false,
      only_buy_discount: false,
      reserve_max_credit: false,
    });
    expect(taskFor("infrastructure", config).params).toMatchObject({
      mode: 0,
      facility: ["Mfg", "Recycle", "Training"],
      threshold: 0.4,
      drones: "PureGold",
      continue_training: true,
    });
  });
  it("rejects raw native passthrough, invalid bounds and unprotected high rarity recruitment", () => {
    for (const taskOptions of [
      { raw: {} },
      { fight: { stone: -1 } },
      { fight: { series: 11 } },
      { fight: { times: 0 } },
      { fight: { medicine: 1.5 } },
      { fight: { followActivity: "yes" } },
      { fight: { fallbackStage: "NEW-8" } },
      { fight: { drops: { "30011": 0 } } },
      { fight: { drops: { "30011": 1.5 } } },
      { fight: { restartOnCrash: 1 } },
      { mall: { shopping: true } },
      { infrastructure: { facility: ["Unknown"] } },
      { infrastructure: { threshold: 1.1 } },
      { recruit: { confirm: [6] } },
      { recruit: { preserveTags: [] } },
    ])
      expect(() =>
        validateArknightsConfig({ ...defaultArknightsConfig, taskOptions }),
      ).toThrow();
  });
  it("enables sign-in rewards only through the pinned upgraded engine contract", () => {
    expect(
      taskFor("award", { ...defaultArknightsConfig, signInEvent: true }).params
        .signinevent,
    ).toBe(true);
  });
});
