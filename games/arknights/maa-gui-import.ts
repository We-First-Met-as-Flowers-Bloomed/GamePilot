import { validateArknightsConfig, type ArknightsConfig } from "./config";
import {
  resolveArknightsCopilotOptions,
  validateArknightsCopilotOptions,
} from "./copilot-options";
import {
  resolveArknightsTaskOptions,
  validateArknightsTaskOptions,
  type ArknightsTaskOptions,
} from "./task-options";
import {
  resolveArknightsExtendedOptions,
  validateArknightsExtendedOptions,
  type ArknightsExtendedOptions,
  type RoguelikeMode,
  type ReclamationOptions,
} from "./extended-options";

const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : typeof v === "string"
      ? v
          .split(/[;；\n]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : [];

/** Reads only explicit GUI task fields. Credentials, scripts, connection and update settings never leave the source. */
export function importMaaGuiConfig(
  input: unknown,
  base: ArknightsConfig,
  configurationName?: string,
): {
  config: ArknightsConfig;
  warnings: string[];
  customInfrastructureFile?: string;
} {
  const root = record(input),
    configurations = record(root?.Configurations);
  if (!configurations || !Object.keys(configurations).length)
    throw Error("请选择包含 Configurations 的 MAA config/gui.new.json");
  const names = Object.keys(configurations);
  const name =
    configurationName ??
    (Object.hasOwn(configurations, "Default")
      ? "Default"
      : names.length === 1
        ? names[0]
        : undefined);
  if (!name || !Object.hasOwn(configurations, name))
    throw Error("MAA 包含多个配置，请明确选择配置名称");
  const source = record(configurations[name]);
  if (!source || !Array.isArray(source.TaskQueue))
    throw Error("MAA 配置缺少 TaskQueue");
  if (source.TaskQueue.length > 100) throw Error("MAA 任务队列过长");
  const config = structuredClone(validateArknightsConfig(base));
  const options = resolveArknightsTaskOptions(config.taskOptions);
  const taskOptions: ArknightsTaskOptions = structuredClone(
    config.taskOptions ?? {},
  );
  const extendedDefaults = resolveArknightsExtendedOptions(
    config.extendedOptions,
  );
  let extendedOptions: ArknightsExtendedOptions = structuredClone(
    config.extendedOptions ?? {},
  );
  const warnings = [
    `已读取 MAA 配置「${name}」；仅迁入支持的任务参数，账号匹配、凭据、连接、脚本和定时设置保留 App 当前值。`,
  ];
  if (!configurationName && names.length > 1)
    warnings.push("源文件含多个配置，默认读取 Default；其他配置未导入。");
  if (record(record(source.Gui)?.RuntimeSettings))
    warnings.push(
      "GUI 通用运行设置尚未迁移；运行时限、启动行为和脚本保留 App 当前设置。",
    );
  let customInfrastructureFile: string | undefined;
  const seen = new Set<string>();
  const assign = (
    target: object,
    source: Record<string, unknown>,
    mapping: Record<string, string>,
  ) => {
    for (const [from, to] of Object.entries(mapping))
      if (source[from] !== undefined)
        (target as Record<string, unknown>)[to] = source[from];
  };
  const guiCopilot = record(source.Copilot);
  if (guiCopilot) {
    const copilot = resolveArknightsCopilotOptions(
      config.copilotOptions,
      config.copilotLoopTimes,
    );
    assign(copilot, guiCopilot, {
      UseFormation: "formation",
      SelectFormation: "formationIndex",
      LoopTimes: "loopTimes",
    });
    if (guiCopilot.EnableUserAdditional === false) copilot.userAdditional = [];
    if (
      guiCopilot.EnableUserAdditional === true &&
      Array.isArray(guiCopilot.UserAdditional)
    )
      copilot.userAdditional = guiCopilot.UserAdditional.map((raw) => {
        const oper = record(raw);
        return {
          name: oper?.name ?? oper?.Name,
          skill: oper?.skill ?? oper?.Skill ?? 0,
        };
      }) as typeof copilot.userAdditional;
    if (guiCopilot.SupportMode !== undefined)
      warnings.push(
        "GUI Copilot 助战启用状态未持久化，保留 App 当前助战策略，请在普通作业参数中确认。",
      );
    copilot.useSanityPotion = config.copilotOptions?.useSanityPotion ?? false;
    if (guiCopilot.UseSanityPotion === true)
      warnings.push(
        "GUI Copilot 用药许可未自动提升；请在 App 明确允许消耗理智药。",
      );
    try {
      config.copilotOptions = validateArknightsCopilotOptions(copilot);
    } catch {
      warnings.push(
        "GUI Copilot 参数不适用于当前配置，保留 App 原普通作业参数。",
      );
    }
    warnings.push(
      "已迁入 GUI Copilot 支持的编队、循环和额外干员选项；作业列表与外部路径未自动导入，请在 App 逐项确认。",
    );
  }
  function saveAdvanced(group: keyof ArknightsExtendedOptions, value: object) {
    try {
      extendedOptions = validateArknightsExtendedOptions({
        ...extendedOptions,
        [group]: value,
      });
    } catch (reason) {
      warnings.push(
        `${group} 的源参数不适用于当前内核，保留 App 当前高级设置：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }
  for (const raw of source.TaskQueue) {
    const task = record(raw);
    if (!task || typeof task.TaskType !== "string")
      throw Error("MAA 任务格式无效");
    if (seen.has(task.TaskType)) {
      warnings.push(`重复的 ${task.TaskType} 任务未覆盖首次导入的参数。`);
      continue;
    }
    seen.add(task.TaskType);
    if (task.IsEnable === false)
      warnings.push(
        `${task.TaskType} 的 IsEnable=false 仅表示 GUI 临时勾选状态，App 完整日常不会因此删除或禁用步骤。`,
      );
    switch (task.TaskType) {
      case "StartUp":
        break;
      case "Fight": {
        const fight = structuredClone(options.fight);
        const stages = list(task.StagePlan);
        if (stages.length) {
          if (config.stage && config.stage !== stages[0])
            warnings.push(
              `保留 App 已保存关卡 ${config.stage}，替代 GUI 临时首关 ${stages[0]}。`,
            );
          if (!config.stage) config.stage = stages[0];
          fight.stages = [...new Set([config.stage, ...stages.slice(1)])];
        }
        assign(fight, task, { Series: "series", IsDrGrandet: "drGrandet" });
        fight.medicine =
          task.UseMedicine === true ? Number(task.MedicineCount ?? 0) : 0;
        fight.stone = task.UseStone === true ? Number(task.StoneCount ?? 0) : 0;
        fight.times =
          task.EnableTimesLimit === true ? Number(task.TimesLimit) : 2147483647;
        fight.medicineExpireDays =
          task.UseExpiringMedicine === true
            ? Number(task.MedicineExpireDays ?? 0)
            : 0;
        fight.drops = {};
        if (task.EnableTargetDrop === true) {
          if (task.IsInventoryTarget === true)
            warnings.push(
              "库存总量目标需要最新仓库识别，本次未转成作战新增掉落目标。",
            );
          else if (typeof task.DropId === "string" && task.DropId)
            fight.drops = { [task.DropId]: Number(task.DropCount) };
        }
        if (task.UseWeeklySchedule === true)
          warnings.push("作战周计划尚未迁移，仅导入当前关卡队列。");
        if (task.UseOptionalStage === true)
          warnings.push("GUI 备用关卡时段判断未迁移，App 按当前队列顺序执行。");
        if (task.UseCustomAnnihilation === true)
          warnings.push(
            "剿灭自定义导航未自动替换主关卡；可在 App 队列中选择对应剿灭编号。",
          );
        taskOptions.fight = fight;
        break;
      }
      case "Recruit": {
        const recruit = structuredClone(options.recruit);
        assign(recruit, task, {
          MaxTimes: "times",
          RefreshLevel3: "refresh",
          ExtraTagMode: "extraTagsMode",
        });
        recruit.select = [3, 4].filter(
          (star) => task[`Level${star}Choose`] === true,
        );
        recruit.confirm = [...recruit.select];
        recruit.preserveTags = [
          ...new Set([
            "高级资深干员",
            "资深干员",
            ...(task.PreserveTagEnabled === true
              ? list(task.PreserveTagList)
              : ["支援机械"]),
          ]),
        ];
        recruit.firstTags =
          task.PreferTagEnabled === true ? list(task.Level3PreferTags) : [];
        recruit.reserveRecruitmentCount =
          task.Level3RecruitmentPermitReserveEnabled === true
            ? Number(task.Level3RecruitmentPermitReserve)
            : 0;
        if (task.Level3Time !== undefined)
          recruit.recruitmentTime["3"] = Number(task.Level3Time);
        if (task.Level4Time !== undefined)
          recruit.recruitmentTime["4"] = Number(task.Level4Time);
        if (task.Level5Choose === true || task.Level6Choose === true)
          warnings.push(
            "App 保留资深/高级资深标签，不自动确认五星或六星公招。",
          );
        if (task.ForceRefresh === true)
          warnings.push("GUI 强制刷新策略未迁移；仅使用原生三星标签刷新开关。");
        taskOptions.recruit = recruit;
        break;
      }
      case "Mall": {
        const mall = structuredClone(options.mall);
        if (task.Shopping !== undefined)
          config.creditShopping = task.Shopping as boolean;
        assign(mall, task, {
          VisitFriends: "visitFriends",
          CreditFight: "creditFight",
          CreditFightFormation: "formationIndex",
          ShoppingIgnoreBlackListWhenFull: "forceShoppingIfCreditFull",
          OnlyBuyDiscount: "onlyBuyDiscount",
          ReserveMaxCredit: "reserveMaxCredit",
        });
        if (task.FirstList !== undefined) mall.buyFirst = list(task.FirstList);
        if (task.BlackList !== undefined) mall.blacklist = list(task.BlackList);
        if (
          task.VisitFriendsOnceADay === true ||
          task.CreditFightOnceADay === true
        )
          warnings.push(
            "好友/信用作战的 GUI 日期缓存未导入，App 由已保存日常计划控制执行频率。",
          );
        taskOptions.mall = mall;
        break;
      }
      case "Infrast": {
        const infrastructure = structuredClone(options.infrastructure);
        if (task.Mode !== undefined) {
          const modes: Record<string, 0 | 10000 | 20000> = {
            Normal: 0,
            Default: 0,
            Custom: 10000,
            Rotation: 20000,
          };
          if (typeof task.Mode !== "string" || !Object.hasOwn(modes, task.Mode))
            throw Error("不支持的 MAA 基建模式");
          infrastructure.mode = modes[task.Mode];
        }
        assign(infrastructure, task, {
          UsesOfDrones: "drones",
          DormTrustEnabled: "dormTrust",
          OriginiumShardAutoReplenishment: "replenish",
          DormFilterNotStationed: "dormNotStationed",
          ReceptionMessageBoard: "receptionMessageBoard",
          ReceptionClueExchange: "receptionClueExchange",
          SendClue: "receptionSendClue",
          ContinueTraining: "continueTraining",
          FiammettaRecoveryEnabled: "fiammettaRecovery",
          UsePinusSylvestris: "usePinusSylvestris",
          UsePerceptionInformation: "usePerceptionInformation",
          UseWorldlyPlight: "useWorldlyPlight",
          UseAbyssalHunter: "useAbyssalHunter",
        });
        if (task.DormThreshold !== undefined)
          infrastructure.threshold = Number(task.DormThreshold) / 100;
        if (Array.isArray(task.RoomList))
          infrastructure.facility = task.RoomList.map(
            (room) => record(room)?.Room,
          ) as typeof infrastructure.facility;
        const fiammetta = [
          task.FiammettaTarget1,
          task.FiammettaTarget2,
          task.FiammettaTarget3,
        ].filter(
          (target): target is string =>
            typeof target === "string" && target !== "",
        );
        if (fiammetta.length)
          infrastructure.fiammettaTargets = [...new Set(fiammetta)];
        if (infrastructure.mode === 10000) {
          if (typeof task.Filename !== "string" || !task.Filename)
            throw Error("MAA 自定义基建没有可导入的排班 JSON");
          customInfrastructureFile = task.Filename;
          infrastructure.filename = task.Filename;
          infrastructure.planIndex = Number(task.PlanSelect ?? 0);
          warnings.push(
            "自定义基建排班文件将由 App 托管复制；仅导入当前方案序号。",
          );
        }
        if (task.UseWeeklySchedule === true)
          warnings.push("基建周排班未迁移，仅导入当前模式和方案。");
        taskOptions.infrastructure = infrastructure;
        break;
      }
      case "Award":
        assign(config, task, {
          Award: "taskAward",
          Mail: "mail",
          FreeGacha: "freeRecruit",
          Orundum: "eventOrundum",
          Mining: "eventMining",
          SpecialAccess: "specialAccess",
          SignInEvent: "signInEvent",
        });
        break;
      case "Roguelike": {
        const rogue = structuredClone(extendedDefaults.roguelike);
        const modes: Record<string, RoguelikeMode> = {
          Exp: 0,
          Investment: 1,
          Collectible: 4,
          CLP_PDS: 5,
          Squad: 6,
          Exploration: 7,
          FastPass: 10001,
          FindPlaytime: 20001,
          BlackFlowBabyAnimal: 30001,
          BlackFlowStartRun: 30003,
        };
        assign(rogue, task, {
          Theme: "theme",
          Squad: "squad",
          Roles: "roles",
          Difficulty: "difficulty",
          Investment: "investmentEnabled",
          InvestCount: "investmentsCount",
          InvestWithMoreScore: "investmentWithMoreScore",
          StopWhenDepositFull: "stopWhenInvestmentFull",
          StopAtFinalBoss: "stopAtFinalBoss",
          StopWhenLevelMax: "stopAtMaxLevel",
          UseSupportNonFriend: "useNonfriendSupport",
          RefreshTraderWithDice: "refreshTraderWithDice",
          MonthlySquadAutoIterate: "monthlySquadAutoIterate",
          MonthlySquadCheckComms: "monthlySquadCheckComms",
          DeepExplorationAutoIterate: "deepExplorationAutoIterate",
          CollectibleShopping: "collectibleModeShopping",
          SquadCollectible: "collectibleModeSquad",
        });
        if (typeof task.Mode === "string" && Object.hasOwn(modes, task.Mode))
          rogue.mode = modes[task.Mode];
        else if (task.Mode !== undefined)
          warnings.push("肉鸽 GUI 模式无法映射，保留 App 当前模式。");
        if (Number.isInteger(task.StartCount) && Number(task.StartCount) > 0) {
          rogue.startsCount = Math.min(Number(task.StartCount), 999);
          if (Number(task.StartCount) > 999)
            warnings.push(
              `肉鸽次数 ${task.StartCount} 已限制为 App 单次最多 999 次，运行时仍受总时限约束。`,
            );
        }
        if (Array.isArray(task.StartingOpers)) {
          const selected =
            task.UseAdditionalStartingOpers === true
              ? task.StartingOpers.slice(0, 3)
              : task.StartingOpers.slice(0, 1);
          const operators = selected.map((item) => record(item));
          if (
            operators.every(
              (item) => typeof item?.Name === "string" && item.Name.trim(),
            )
          )
            rogue.coreChars = operators.map((item) => ({
              name: String(item!.Name).trim(),
              useSupport: item!.UseSupport === true,
            }));
          else
            warnings.push("肉鸽开局干员格式无法识别，保留 App 当前干员列表。");
        }
        if (rogue.mode === 4) {
          assign(rogue, task, {
            StartWithEliteTwo: "startWithEliteTwo",
            StartWithEliteTwoOnly: "onlyStartWithEliteTwo",
          });
          if (typeof task.CollectibleStartAwards === "string") {
            const rewardNames: Record<string, string> = {
              HotWater: "hotWater",
              Shield: "shield",
              Ingot: "ingot",
              Hope: "hope",
              Random: "random",
              Key: "key",
              Dice: "dice",
              Idea: "ideas",
              Ideas: "ideas",
              Ticket: "ticket",
            };
            const rewards = task.CollectibleStartAwards.split(/[,;；]/)
              .map((value) => value.trim())
              .filter(Boolean);
            rogue.collectibleModeStartList = Object.fromEntries(
              rewards
                .filter((value) => Object.hasOwn(rewardNames, value))
                .map((value) => [rewardNames[value], true]),
            );
            if (rewards.some((value) => !Object.hasOwn(rewardNames, value)))
              warnings.push("部分肉鸽开局奖励未被识别，仅迁移已知奖励。");
          }
        }
        if (task.StartWithSeed === true && typeof task.Seed === "string")
          rogue.startWithSeed = task.Seed;
        else if (task.StartWithSeed === false) rogue.startWithSeed = "";
        if (typeof task.ExpectedCollapsalParadigms === "string")
          rogue.expectedCollapsalParadigms = list(
            task.ExpectedCollapsalParadigms,
          );
        if (
          task.SamiFirstFloorFoldartal === true ||
          task.SamiNewSquad2StartingFoldartal === true
        )
          warnings.push(
            "GUI 萨米密文板字符串策略未自动迁移，请在高级参数中重新确认。",
          );
        if (rogue.theme === "BlackFlow" || rogue.mode === 20001)
          warnings.push(
            "GUI 黑流动物/结局/飞行和界园常乐目标枚举未自动迁移，请在高级参数中确认对应策略。",
          );
        saveAdvanced("roguelike", rogue);
        warnings.push("肉鸽参数仅保存到高级设置，不会自动加入六项日常。");
        break;
      }
      case "Reclamation": {
        const reclamation = structuredClone(extendedDefaults.reclamation);
        const modes: Record<string, ReclamationOptions["mode"]> = {
          ProsperityNoSave: 0,
          ProsperityInSave: 1,
          RA1: 16,
          RA15: 32,
          RA4: 48,
        };
        assign(reclamation, task, {
          Theme: "theme",
          IncrementMode: "incrementMode",
          ClearStore: "clearStore",
          MaxCraftCountPerRound: "numCraftBatches",
        });
        if (typeof task.Mode === "string" && Object.hasOwn(modes, task.Mode))
          reclamation.mode = modes[task.Mode];
        else if (task.Mode !== undefined)
          warnings.push("生息演算 GUI 模式无法映射，保留 App 当前模式。");
        if (task.ToolToCraft !== undefined)
          reclamation.toolsToCraft = list(task.ToolToCraft);
        saveAdvanced("reclamation", reclamation);
        warnings.push(
          "生息演算参数仅保存到高级设置，不会自动加入日常；手动执行前请核对组装和清空商店选项。",
        );
        break;
      }
      case "UserDataUpdate": {
        if (typeof task.UpdateDepot === "boolean")
          saveAdvanced("depot", {
            ...extendedDefaults.depot,
            enabled: task.UpdateDepot,
          });
        if (typeof task.UpdateOperBox === "boolean")
          saveAdvanced("operatorBox", {
            ...extendedDefaults.operatorBox,
            enabled: task.UpdateOperBox,
          });
        warnings.push(
          "已迁入仓库/干员识别选项；GUI 更新触发频率和日期缓存未迁移，不会自动执行识别或上传数据。",
        );
        break;
      }
      default:
        warnings.push(
          `${task.TaskType} 不属于本次六项日常参数迁移范围，未导入。`,
        );
    }
  }
  config.taskOptions = validateArknightsTaskOptions(taskOptions);
  if (Object.keys(extendedOptions).length)
    config.extendedOptions = validateArknightsExtendedOptions(extendedOptions);
  return {
    config: validateArknightsConfig(config),
    warnings,
    ...(customInfrastructureFile ? { customInfrastructureFile } : {}),
  };
}
