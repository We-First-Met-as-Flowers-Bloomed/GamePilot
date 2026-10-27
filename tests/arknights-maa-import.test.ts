import { describe, expect, it } from "vitest";
import { defaultArknightsConfig } from "../games/arknights/config";
import { importMaaGuiConfig } from "../games/arknights/maa-gui-import";

const gui = (tasks: unknown[]) => ({
  Configurations: {
    Default: {
      TaskQueue: tasks,
      Settings: { Game: { ClientType: "Bilibili" } },
    },
  },
  Global: { Password: "private" },
});
describe("MAA GUI allowlist import", () => {
  it("keeps the existing App stage and full daily flags, without copying credentials", () => {
    const result = importMaaGuiConfig(
      gui([
        { TaskType: "StartUp", AccountName: "private-login", IsEnable: false },
        {
          TaskType: "Fight",
          StagePlan: ["LS-5", "1-7"],
          IsEnable: false,
          UseMedicine: false,
          MedicineCount: 99,
          UseStone: true,
          StoneCount: 2,
          EnableTimesLimit: true,
          TimesLimit: 8,
          Series: 2,
        },
        { TaskType: "Award", Award: true, Mail: true },
      ]),
      { ...defaultArknightsConfig, stage: "LS-6", accountName: "saved" },
    );
    expect(result.config.stage).toBe("LS-6");
    expect(result.config.accountName).toBe("saved");
    expect(result.config.taskOptions?.fight).toMatchObject({
      stages: ["LS-6", "1-7"],
      medicine: 0,
      stone: 2,
      times: 8,
      series: 2,
    });
    expect(result.config.mail).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/LS-6/);
    expect(result.warnings.join(" ")).toMatch(/IsEnable/);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("maps supported recruitment, infrastructure, mall and award parameters", () => {
    const { config, customInfrastructureFile } = importMaaGuiConfig(
      gui([
        {
          TaskType: "Recruit",
          MaxTimes: 2,
          RefreshLevel3: true,
          Level3Choose: true,
          Level4Choose: true,
          Level5Choose: true,
          Level3Time: 540,
          Level4Time: 460,
          PreserveTagEnabled: true,
          PreserveTagList: ["支援机械"],
          Level3RecruitmentPermitReserveEnabled: true,
          Level3RecruitmentPermitReserve: 8,
        },
        {
          TaskType: "Infrast",
          Mode: "Custom",
          Filename: "D:/plans/base.json",
          PlanSelect: 1,
          DormThreshold: 30,
          RoomList: [{ Room: "Mfg" }, { Room: "Trade" }],
          UsesOfDrones: "PureGold",
          DormTrustEnabled: true,
        },
        {
          TaskType: "Mall",
          Shopping: true,
          FirstList: "招聘许可;龙门币",
          BlackList: "碳;家具",
          OnlyBuyDiscount: false,
          ReserveMaxCredit: false,
        },
        {
          TaskType: "Award",
          Award: false,
          Mail: true,
          FreeGacha: true,
          Orundum: true,
          Mining: true,
          SpecialAccess: true,
          SignInEvent: true,
        },
      ]),
      defaultArknightsConfig,
    );
    expect(config.taskOptions?.recruit).toMatchObject({
      times: 2,
      refresh: true,
      select: [3, 4],
      confirm: [3, 4],
      reserveRecruitmentCount: 8,
      recruitmentTime: { "3": 540, "4": 460 },
    });
    expect(config.taskOptions?.recruit?.preserveTags).toEqual([
      "高级资深干员",
      "资深干员",
      "支援机械",
    ]);
    expect(config.taskOptions?.infrastructure).toMatchObject({
      mode: 10000,
      threshold: 0.3,
      facility: ["Mfg", "Trade"],
      drones: "PureGold",
      planIndex: 1,
    });
    expect(customInfrastructureFile).toBe("D:/plans/base.json");
    expect(config.taskOptions?.mall).toMatchObject({
      buyFirst: ["招聘许可", "龙门币"],
      blacklist: ["碳", "家具"],
    });
    expect(config).toMatchObject({
      taskAward: false,
      mail: true,
      freeRecruit: true,
      eventOrundum: true,
      eventMining: true,
      specialAccess: true,
      signInEvent: true,
      creditShopping: true,
    });
  });
  it("does not convert inventory targets, weekly schedules, or unknown native fields into executable settings", () => {
    const { config, warnings } = importMaaGuiConfig(
      gui([
        {
          TaskType: "Fight",
          StagePlan: ["NEW-8"],
          EnableTargetDrop: true,
          IsInventoryTarget: true,
          DropId: "30011",
          DropCount: 100,
          UseWeeklySchedule: true,
          native: { arbitrary: true },
        },
      ]),
      defaultArknightsConfig,
    );
    expect(config.taskOptions?.fight?.drops).toEqual({});
    expect(warnings.join(" ")).toMatch(/库存/);
    expect(warnings.join(" ")).toMatch(/周计划/);
    expect(JSON.stringify(config)).not.toContain("arbitrary");
  });
  it("requires an explicit configuration when the document contains several", () => {
    const input = {
      Configurations: { one: { TaskQueue: [] }, two: { TaskQueue: [] } },
    };
    expect(() => importMaaGuiConfig(input, defaultArknightsConfig)).toThrow(
      /配置/,
    );
    expect(
      importMaaGuiConfig(input, defaultArknightsConfig, "two").config,
    ).toMatchObject(defaultArknightsConfig);
    expect(() => importMaaGuiConfig({}, defaultArknightsConfig)).toThrow();
  });
  it("imports disabled advanced GUI settings without adding them to the six daily tasks", () => {
    const result = importMaaGuiConfig(
      gui([
        {
          TaskType: "Roguelike",
          IsEnable: false,
          Theme: "Phantom",
          Mode: "Exp",
          Difficulty: 2147483647,
          StartCount: 999999,
          Investment: true,
          InvestCount: 999,
          StopAtFinalBoss: false,
          StartingOpers: [],
          UseAdditionalStartingOpers: false,
          Seed: "private-unused-seed",
          StartWithSeed: false,
        },
        {
          TaskType: "Reclamation",
          IsEnable: false,
          Theme: "Tales",
          Mode: "ProsperityInSave",
          ToolToCraft: "荧光棒;采集站",
          IncrementMode: 0,
          MaxCraftCountPerRound: 16,
          ClearStore: true,
        },
        {
          TaskType: "UserDataUpdate",
          IsEnable: false,
          UpdateDepot: true,
          UpdateOperBox: true,
          TriggerInterval: "EveryTime",
          UserToken: "private-token",
        },
      ]),
      defaultArknightsConfig,
    );
    expect(result.config.extendedOptions?.roguelike).toMatchObject({
      theme: "Phantom",
      mode: 0,
      difficulty: 2147483647,
      startsCount: 999,
      stopAtFinalBoss: false,
      startWithSeed: "",
    });
    expect(result.config.extendedOptions?.reclamation).toMatchObject({
      theme: "Tales",
      mode: 1,
      numCraftBatches: 16,
      toolsToCraft: ["荧光棒", "采集站"],
      clearStore: true,
    });
    expect(result.config.extendedOptions?.depot?.enabled).toBe(true);
    expect(result.warnings.join(" ")).toContain("999");
    expect(result.warnings.join(" ")).toContain("不会自动加入");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("reports unmigrated common GUI and Copilot settings while preserving App identity and budgets", () => {
    const input = gui([]);
    Object.assign(input.Configurations.Default, {
      Gui: {
        RuntimeSettings: {
          ClientType: "Official",
          EnableRunDurationLimit: true,
          RunDurationLimitMinutes: 300,
          PreRunScript: "private-script",
        },
      },
      Copilot: {
        UseFormation: false,
        LoopTimes: 50,
        TaskList: ["private-path"],
      },
    });
    const base = {
      ...defaultArknightsConfig,
      clientType: "Bilibili" as const,
      expectedUid: "123456789",
      stage: "LS-6",
      maxRunMinutes: 60,
    };
    const result = importMaaGuiConfig(input, base);
    expect(result.config).toMatchObject(base);
    expect(result.warnings.join(" ")).toContain("GUI 通用运行设置");
    expect(result.warnings.join(" ")).toContain("Copilot");
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
