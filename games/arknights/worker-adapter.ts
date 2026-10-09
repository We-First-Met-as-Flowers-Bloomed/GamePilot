import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { Device, SkillResult } from "../../packages/protocol";
import type { DeviceInspection } from "../../packages/protocol/recovery";
import type { MaaCoreClient } from "../../packages/runtime/maacore";
import type { GameWorkerAdapter } from "../plugin";
import { taskFor, type ArknightsConfig } from "./config";
import { validateArknightsCapabilities } from "./capabilities";
import { executeArknightsTask } from "./execution";
import { verifyArknightsProfileLogin } from "./profile-login";
import { verifyCreditShopping, type CreditShopFrame } from "./credit-shopping";

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
      const task = taskFor(id, config);
      if (task.type === "Copilot") {
        const filename = String(task.params.filename ?? "");
        try {
          await access(filename);
        } catch {
          throw Error(`找不到作业 JSON：${filename}`);
        }
      }
      signal.throwIfAborted();
      await ports.disconnectEngine();
      const result = await executeArknightsTask({
        device,
        task,
        signal,
        log,
        maxRunMinutes: config.maxRunMinutes,
        createCore: ports.createCore,
        publishEvidence: (arknights) =>
          log("任务提交状态已记录", { arknights }),
      });
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
              await executeFile(
                device.adbPath,
                [
                  "-s",
                  device.address,
                  "shell",
                  "input",
                  "tap",
                  String(x),
                  String(y),
                ],
                { windowsHide: true, timeout: 10000, signal },
              );
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
