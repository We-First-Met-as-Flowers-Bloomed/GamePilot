import { describe, expect, it } from "vitest";
import { dailySkills, games } from "../games/registry";
import {
  defaultArknightsConfig,
  defaultArknightsProfiles,
  activeArknightsConfig,
  validateArknightsConfig,
  validateArknightsProfiles,
  taskFor,
} from "../games/arknights/config";
import { validatePlan } from "../packages/protocol";
describe("Arknights integration boundaries", () => {
  it("maps conservative recruitment without expedited permits", () => {
    expect(taskFor("recruit", defaultArknightsConfig)).toEqual({
      type: "Recruit",
      params: {
        enable: true,
        refresh: false,
        select: [3],
        confirm: [3],
        times: 4,
        set_time: true,
        expedite: false,
        preserve_tags: ["高级资深干员", "资深干员", "支援机械"],
        recruitment_time: { "3": 540 },
        report_to_penguin: false,
        report_to_yituliu: false,
        server: "CN",
      },
    });
  });
  it("maps explicit client shutdown", () => {
    expect(taskFor("close", defaultArknightsConfig)).toEqual({
      type: "CloseDown",
      params: { client_type: "Official" },
    });
  });
  it("registers both games and opens only the live-validated Arknights skills", () => {
    expect(games.map((g) => g.id)).toEqual(["onmyoji", "arknights"]);
    expect(games.find((game) => game.id === "arknights")?.skills).toMatchObject(
      [
        { id: "login", ready: true },
        { id: "recruit", ready: true },
        { id: "friends", ready: true },
        { id: "fight", ready: true },
        { id: "infrastructure", ready: true },
        { id: "award", ready: true },
        { id: "depot", ready: true },
        { id: "operator-box", ready: true },
        { id: "recruit-recognition", ready: true },
        { id: "copilot", ready: true },
        { id: "roguelike", ready: true },
        { id: "reclamation", ready: true },
      ],
    );
    expect(
      validatePlan(
        {
          gameId: "arknights",
          skillIds: dailySkills("arknights"),
          mode: "live",
        },
        games,
      ).gameId,
    ).toBe("arknights");
    expect(dailySkills("arknights")).toEqual([
      "login",
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ]);
  });
  it("rejects extra fields and invalid combat limits", () => {
    expect(() =>
      validateArknightsConfig({ ...defaultArknightsConfig, stone: 1 }),
    ).toThrow();
    expect(() =>
      validateArknightsConfig({ ...defaultArknightsConfig, times: 0 }),
    ).toThrow();
    expect(() =>
      validateArknightsConfig({
        ...defaultArknightsConfig,
        maxRunMinutes: 4,
      }),
    ).toThrow(/运行时长/);
    expect(() =>
      validateArknightsConfig({
        ...defaultArknightsConfig,
        clientType: "unknown",
      }),
    ).toThrow();
    expect(
      validateArknightsConfig({ ...defaultArknightsConfig, times: 2 }),
    ).toEqual(defaultArknightsConfig);
    expect(
      validateArknightsConfig({
        clientType: "Official",
        stage: "",
        mail: false,
      }),
    ).toEqual(defaultArknightsConfig);
  });
  it("validates a bounded profile collection and resolves the active account", () => {
    const profiles = validateArknightsProfiles({
      version: 1,
      activeProfileId: "bili",
      profiles: [
        {
          id: "default",
          name: "官服",
          ...defaultArknightsConfig,
        },
        {
          id: "bili",
          name: "  B服主号  ",
          ...defaultArknightsConfig,
          accountName: "博士",
          clientType: "Bilibili",
          stage: "LS-6",
        },
      ],
    });
    expect(profiles.profiles[1].name).toBe("B服主号");
    expect(activeArknightsConfig(profiles)).toEqual({
      accountName: "博士",
      expectedUid: "",
      clientType: "Bilibili",
      stage: "LS-6",
      mail: false,
      recruit: true,
      creditShopping: false,
      copilotFile: "",
      copilotLoopTimes: 1,
      freeRecruit: false,
      eventOrundum: false,
      eventMining: false,
      specialAccess: false,
      signInEvent: false,
      maxRunMinutes: 120,
    });
    expect(defaultArknightsProfiles.profiles).toHaveLength(1);
    for (const invalid of [
      { ...profiles, activeProfileId: "missing" },
      { ...profiles, profiles: [] },
      {
        ...profiles,
        profiles: profiles.profiles.map((profile) => ({
          ...profile,
          id: "same",
        })),
      },
      {
        ...profiles,
        profiles: profiles.profiles.map((profile) => ({
          ...profile,
          name: "同名",
        })),
      },
    ])
      expect(() => validateArknightsProfiles(invalid)).toThrow();
    expect(() =>
      validateArknightsConfig({
        ...defaultArknightsConfig,
        accountName: "博士\u007f昵称",
      }),
    ).toThrow(/账号匹配文本/);
    expect(() =>
      validateArknightsProfiles({
        version: 1,
        activeProfileId: "default",
        profiles: [
          {
            ...defaultArknightsProfiles.profiles[0],
            name: "主号\u0085备注",
          },
        ],
      }),
    ).toThrow(/名称或编号/);
  });
  it("selects an already logged-in account only when a match is configured", () => {
    const selected = validateArknightsConfig({
      ...defaultArknightsConfig,
      accountName: "  博士昵称  ",
    });
    expect(taskFor("login", selected)).toEqual({
      type: "StartUp",
      params: {
        client_type: "Official",
        start_game_enabled: true,
        account_name: "博士昵称",
      },
    });
    expect(taskFor("login", defaultArknightsConfig).params).not.toHaveProperty(
      "account_name",
    );
  });
  it("uses current sanity only and disables purchases and every refill source", () => {
    expect(() => taskFor("fight", defaultArknightsConfig)).toThrow(/关卡/);
    const fight = taskFor("fight", {
      ...defaultArknightsConfig,
      stage: "1-7",
    });
    expect(fight.params).toMatchObject({
      stage: "1-7",
      series: 0,
      medicine: 0,
      medicine_expire_days: 0,
      expiring_medicine: 0,
      stone: 0,
    });
    expect(fight.params).not.toHaveProperty("times");
    expect(taskFor("friends", defaultArknightsConfig).params).toMatchObject({
      visit_friends: true,
      shopping: false,
      buy_first: ["招聘许可", "龙门币"],
      blacklist: ["家具零件", "加急许可", "碳"],
      force_shopping_if_credit_full: false,
      only_buy_discount: true,
      reserve_max_credit: true,
      credit_fight: false,
    });
    expect(
      taskFor("friends", {
        ...defaultArknightsConfig,
        creditShopping: true,
      }).params,
    ).toMatchObject({ shopping: true, force_shopping_if_credit_full: true });
  });
  it("keeps optional reward actions disabled", () => {
    expect(taskFor("award", defaultArknightsConfig).params).toMatchObject({
      award: true,
      mail: false,
      recruit: false,
      orundum: false,
      mining: false,
      specialaccess: false,
    });
    expect(
      taskFor("award", {
        ...defaultArknightsConfig,
        mail: true,
        freeRecruit: true,
        eventOrundum: true,
        eventMining: true,
        specialAccess: true,
      }).params,
    ).toMatchObject({
      award: true,
      mail: true,
      recruit: true,
      orundum: true,
      mining: true,
      specialaccess: true,
    });
    expect(() => taskFor("realm-raid", defaultArknightsConfig)).toThrow();
  });
  it("maps read-only account recognition tools", () => {
    expect(taskFor("depot", defaultArknightsConfig)).toEqual({
      type: "Depot",
      params: { enable: true },
    });
    expect(taskFor("operator-box", defaultArknightsConfig)).toEqual({
      type: "OperBox",
      params: { enable: true },
    });
    expect(taskFor("recruit-recognition", defaultArknightsConfig)).toEqual({
      type: "Recruit",
      params: {
        enable: true,
        refresh: false,
        select: [5, 4, 3, 2, 1],
        confirm: [],
        times: 0,
        set_time: false,
        expedite: false,
        preserve_tags: [],
        report_to_penguin: false,
        report_to_yituliu: false,
        server: "CN",
      },
    });
  });
  it("maps a local copilot file without sanity potion use", () => {
    expect(() => taskFor("copilot", defaultArknightsConfig)).toThrow(
      /作业 JSON/,
    );
    expect(
      taskFor("copilot", {
        ...defaultArknightsConfig,
        copilotFile: "D:\\plans\\stage.json",
        copilotLoopTimes: 3,
      }),
    ).toEqual({
      type: "Copilot",
      params: {
        enable: true,
        filename: "D:\\plans\\stage.json",
        loop_times: 3,
        use_sanity_potion: false,
        formation: true,
        add_trust: false,
        ignore_requirements: false,
        support_unit_usage: 0,
      },
    });
  });
  it("bounds advanced modes to one supervised run by default", () => {
    expect(taskFor("roguelike", defaultArknightsConfig)).toEqual({
      type: "Roguelike",
      params: {
        enable: true,
        theme: "BlackFlow",
        mode: 0,
        squad: "指挥分队",
        roles: "取长补短",
        core_char_list: [],
        use_nonfriend_support: false,
        starts_count: 1,
        difficulty: -1,
        stop_at_final_boss: true,
      },
    });
    expect(taskFor("reclamation", defaultArknightsConfig)).toEqual({
      type: "Reclamation",
      params: {
        enable: true,
        theme: "RelaunchAnchor",
        mode: 16,
        tools_to_craft: [],
        clear_store: false,
        increment_mode: 0,
        num_craft_batches: 1,
      },
    });
  });
  it("uses one-key overview rotation while retaining base collection actions", () => {
    expect(taskFor("infrastructure", defaultArknightsConfig)).toEqual({
      type: "Infrast",
      params: {
        enable: true,
        mode: 20000,
        facility: [
          "Mfg",
          "Trade",
          "Power",
          "Control",
          "Reception",
          "Office",
          "Dorm",
        ],
        drones: "Money",
        replenish: false,
        dorm_notstationed_enabled: false,
        dorm_trust_enabled: false,
        fiammetta_recovery_enabled: false,
        use_pinus_sylvestris: false,
        use_perception_information: false,
        use_worldly_plight: false,
        use_abyssal_hunter: false,
        reception_message_board: true,
        reception_clue_exchange: true,
        reception_send_clue: true,
        continue_training: false,
      },
    });
    expect(
      taskFor("infrastructure", defaultArknightsConfig).params,
    ).not.toHaveProperty("threshold");
  });
});
