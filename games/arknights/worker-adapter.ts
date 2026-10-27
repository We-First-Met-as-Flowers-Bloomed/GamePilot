import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Device, SkillResult } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import type { MaaCoreClient } from "../../packages/runtime/maacore";
import type { GameWorkerAdapter } from "../plugin";
import { taskFor, fightTasksFor, type ArknightsConfig } from "./config";
import { validateArknightsCapabilities } from "./capabilities";
import { executeArknightsTask } from "./execution";
import { executeArknightsFightQueue } from "./fight-queue";
import type { ArknightsExecutionEvidence } from "./evidence";
import { extendedArknightsRunMinutes } from "./extended-options";
import { resolveArknightsCopilotOptions } from "./copilot-options";
import { assertOfficialActivityRoute } from "../../packages/runtime/maa-activity-resource";
import { verifyArknightsProfileLogin } from "./profile-login";
import {
  verifyCreditShopping,
  dismissCreditRewardBeforeLogin,
  type CreditShopFrame,
} from "./credit-shopping";

interface Ports {
  config(): ArknightsConfig;
  device(): Device | undefined;
  disconnectEngine(): Promise<void>;
  createCore(): Pick<MaaCoreClient, "connect" | "runTask" | "close">;
  inspect(device: Device, config: ArknightsConfig): Promise<DeviceInspection>;
  inspectShop(device: Device): Promise<CreditShopFrame>;
  returnHome(
    device: Device,
    config: ArknightsConfig,
    signal: AbortSignal,
    log: (message: string) => void,
  ): Promise<DeviceInspection>;
}
/** Imported by the worker only. Native clients remain injected and lazy. */
export function createArknightsWorkerAdapter(ports: Ports): GameWorkerAdapter {
  const executeFile = promisify(execFile);
  return {
    get maxRunMinutes() {
      return ports.config().maxRunMinutes;
    },
    validate: (plan) => {
      if (plan.mode === "live")
        validateArknightsCapabilities(ports.config(), plan.skillIds);
    },
    async run(id, signal, log) {
      const device = ports.device();
      if (!device) throw Error("请先连接设备");
      const config = ports.config();
      const tasks =
        id === "fight" ? fightTasksFor(config) : [taskFor(id, config)];
      const task = tasks[0];
      if (task.type === "Custom") {
        const root = process.env.GAMEPILOT_MAA_ACTIVITY_ROOT;
        const route = Array.isArray(task.params.task_names)
          ? task.params.task_names[0]
          : undefined;
        if (!root || typeof route !== "string")
          throw Error("活动小游戏缺少已核验的官方资源目录");
        await assertOfficialActivityRoute(root, route, config.clientType);
      }
      if (
        task.type === "OperProgress" &&
        (config.extendedOptions?.operProgress?.allowMaterialConsumption !==
          true ||
          !config.extendedOptions.operProgress.plans?.length)
      )
        throw Error("干员养成需要配置计划并明确允许消耗材料");
      /**
       * 2026-10-16：MuMu 15 是多标签/多显示（桌面=0、阴阳师=2、方舟=3），
       * `adb shell input` 默认只打 display 0 —— 于是"识别得到主页、点击却落在桌面"，
       * 表现就是打开个人名片失败。这里先解析"前台是方舟的那块显示"，点击时带上
       * `-d <显示号>`；解析不到就退回旧行为（不带 -d），由后续判据决定成败。
       */
      let displayId: number | undefined;
      let displayResolved = false;
      const resolveDisplayId = async () => {
        if (displayResolved) return displayId;
        displayResolved = true;
        try {
          displayId = (await ports.inspect(device, config)).displayId;
        } catch {
          displayId = undefined;
        }
        return displayId;
      };
      const tapArgs = async (x: number, y: number) => {
        const resolved = await resolveDisplayId();
        return [
          "-s",
          device.address,
          "shell",
          "input",
          ...(resolved === undefined ? [] : ["-d", String(resolved)]),
          "tap",
          String(x),
          String(y),
        ];
      };
      const dismissReward = async ([x, y]: [number, number]) => {
        signal.throwIfAborted();
        log(
          "信用商店收尾：双帧确认招聘许可物资结果和确认按钮，仅关闭一次，不重复购买",
        );
        await executeFile(device.adbPath, await tapArgs(x, y), {
          windowsHide: true,
          timeout: 10000,
          signal,
        });
        await delay(750, undefined, { signal });
      };
      const dismissProductDetail = async () => {
        signal.throwIfAborted();
        const displayId = await resolveDisplayId();
        log("信用商店收尾：双帧确认商品详情，仅返回一次，不点击购买");
        await executeFile(
          device.adbPath,
          [
            "-s",
            device.address,
            "shell",
            "input",
            ...(displayId === undefined ? [] : ["-d", String(displayId)]),
            "keyevent",
            "4",
          ],
          { windowsHide: true, timeout: 10000, signal },
        );
        await delay(750, undefined, { signal });
      };
      if (id === "login" && config.expectedUid) {
        await dismissCreditRewardBeforeLogin(device, config, signal, {
          inspect: () => ports.inspectShop(device),
          wait: () => delay(500, undefined, { signal }),
          dismissReward,
          dismissProductDetail,
          returnHome: () => ports.returnHome(device, config, signal, log),
        });
      }
      if (
        [
          "Copilot",
          "SSSCopilot",
          "ParadoxCopilot",
          "VideoRecognition",
        ].includes(task.type) ||
        (task.type === "Infrast" && task.params.mode === 10000)
      ) {
        const fileLabel =
          task.type === "VideoRecognition" ? "本地战斗录屏" : "作业或排班 JSON";
        const filenames = [
          ...(typeof task.params.filename === "string"
            ? [task.params.filename]
            : []),
          ...(Array.isArray(task.params.list)
            ? task.params.list.map((item) => item.filename)
            : []),
          ...(Array.isArray(task.params.copilot_list)
            ? task.params.copilot_list.map((item) => item.filename)
            : []),
          ...(typeof task.params.operbox_data_path === "string" &&
          task.params.operbox_data_path
            ? [task.params.operbox_data_path]
            : []),
        ];
        if (!filenames.length) throw Error(`请先配置${fileLabel}`);
        for (const filename of filenames) {
          signal.throwIfAborted();
          try {
            await access(filename);
          } catch {
            throw Error(`找不到${fileLabel}：${filename}`);
          }
        }
      }
      signal.throwIfAborted();
      await ports.disconnectEngine();
      const execution = {
        device,
        task,
        signal,
        log,
        maxRunMinutes: Math.min(
          extendedArknightsRunMinutes(
            id,
            config.extendedOptions,
            config.maxRunMinutes,
          ),
          id === "copilot"
            ? resolveArknightsCopilotOptions(
                config.copilotOptions,
                config.copilotLoopTimes,
              ).maxRunMinutes
            : config.maxRunMinutes,
        ),
        createCore: ports.createCore,
        publishEvidence: (arknights: ArknightsExecutionEvidence) =>
          log("任务提交状态已记录", { arknights }),
      };
      const result = await (id === "fight"
        ? executeArknightsFightQueue({ ...execution, tasks })
        : executeArknightsTask(execution));
      try {
        if (id === "friends")
          return await verifyCreditShopping(result, config, device, signal, {
            inspect: () => ports.inspectShop(device),
            wait: () => delay(500, undefined, { signal }),
            publish: (checked: SkillResult) =>
              log("信用购物后置核验记录已更新", checked),
            returnHome: () => {
              log("信用余额已确认，返回主页并核对双帧场景");
              return ports.returnHome(device, config, signal, log);
            },
            dismissReward,
            dismissProductDetail,
          });
        if (id !== "login") return result;
        return await verifyArknightsProfileLogin(
          result,
          config,
          () => ports.inspect(device, config),
          signal,
          {
            openProfile: async ([x, y]) => {
              signal.throwIfAborted();
              log("主页已识别好友入口，打开自己的个人名片核验 UID");
              await executeFile(device.adbPath, await tapArgs(x, y), {
                windowsHide: true,
                timeout: 10000,
                signal,
              });
              await delay(750, undefined, { signal });
            },
            returnHome: async () => {
              log("已核对个人名片双帧 UID，返回后确认主页");
              await ports.returnHome(device, config, signal, log);
            },
          },
        );
      } catch (error) {
        if (id === "login")
          log("原生登录流程已结束，账号后置核验未通过", result);
        throw error;
      }
    },
  };
}
