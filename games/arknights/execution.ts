import type { Device, SkillResult } from "../../packages/protocol";
import {
  ArknightsTaskEvidence,
  type ArknightsExecutionEvidence,
} from "./evidence";
import type { MaaCoreClient } from "../../packages/runtime/maacore";
import { checkDeviceReady } from "../../packages/runtime/device-ready";
import { recoverConnection } from "../../packages/runtime/connection-recovery";
import { isArknightsDisconnect } from "./result-policy";
import { TaskFaultError } from "../../packages/protocol/fault";
import { setTimeout as delay } from "node:timers/promises";
import {
  readStartupState,
  startupCrash,
  type StartupState,
} from "./startup-recovery";

export interface ArknightsExecutionOptions {
  device: Device;
  task: { type: string; params: Record<string, unknown> };
  signal: AbortSignal;
  log: (message: string) => void;
  maxRunMinutes: number;
  createCore: () => Pick<MaaCoreClient, "connect" | "runTask" | "close">;
  checkReady?: typeof checkDeviceReady;
  pause?: Parameters<typeof recoverConnection>[2];
  publishEvidence?: (evidence: ArknightsExecutionEvidence) => void;
  readStartup?: typeof readStartupState;
}

export async function executeArknightsTask(
  options: ArknightsExecutionOptions,
): Promise<SkillResult> {
  const startup =
    options.task.type === "StartUp" &&
    options.task.params.start_game_enabled === true;
  const inspect = async (): Promise<StartupState | undefined> => {
    if (!startup) return undefined;
    options.signal.throwIfAborted();
    try {
      return await (options.readStartup ?? readStartupState)(
        options.device,
        options.task.params.client_type,
        options.signal,
      );
    } catch {
      options.signal.throwIfAborted();
      options.log("启动诊断不可用；本次不启用崩溃自动重试");
      return undefined;
    }
  };
  for (let retry = 0; ; retry++) {
    const before = await inspect();
    const tracker = new ArknightsTaskEvidence(options.task.type);
    let submitted = false;
    try {
      await runNativeTask(options, tracker, () => {
        submitted = true;
      });
      const evidence = tracker.finish(submitted, true);
      if (evidence.completion !== "native-confirmed")
        throw new TaskFaultError(
          "native-completion-missing",
          "缺少匹配的原生完成回调，任务结果未知，已停止后续步骤",
        );
      return {
        status: "succeeded",
        summary: evidence.lastSettlement
          ? `作战任务链已结束。最近一次结算：${evidence.lastSettlement.stage} · ${evidence.lastSettlement.stars} 星${evidence.lastSettlement.batchRuns === undefined ? " · 本批次数未识别" : ` · 本批 ${evidence.lastSettlement.batchRuns} 次`}；不是整轮累计次数。`
          : "MAA 对应任务链已结束；不代表所有奖励已领取",
        arknights: evidence,
      };
    } catch (error) {
      options.publishEvidence?.(tracker.finish(submitted, false));
      options.signal.throwIfAborted();
      if (!submitted || (error instanceof Error && error.name === "AbortError"))
        throw error;
      const after = await inspect();
      if (startupCrash(before, after)) {
        if (retry >= 2)
          throw new Error(
            "明日方舟启动进程崩溃，已重试2次仍失败；已停止该账号，请检查游戏与模拟器",
            { cause: error },
          );
        options.log(
          `确认本次启动主进程 signal 11 退出且已回桌面，重新检查后仅重试登录 ${retry + 1}/2`,
        );
        await (
          options.pause ?? ((ms, signal) => delay(ms, undefined, { signal }))
        )(2000, options.signal);
        options.signal.throwIfAborted();
        await (options.checkReady ?? checkDeviceReady)(
          options.device,
          options.signal,
        );
        const rechecked = await inspect();
        if (
          !startupCrash(before, rechecked) ||
          rechecked?.latestExit?.key !== after?.latestExit?.key
        )
          throw error;
        options.signal.throwIfAborted();
        continue;
      }
      throw error;
    }
  }
}
async function runNativeTask(
  options: ArknightsExecutionOptions,
  tracker: ArknightsTaskEvidence,
  onSubmit: () => void,
): Promise<void> {
  const {
    device,
    task,
    signal,
    log,
    maxRunMinutes,
    createCore,
    checkReady = checkDeviceReady,
    pause,
  } = options;
  signal.throwIfAborted();
  let core: ReturnType<ArknightsExecutionOptions["createCore"]> | undefined;
  try {
    await recoverConnection(
      async () => {
        core = createCore();
        try {
          await core.connect(device.adbPath, device.address);
        } catch (error) {
          const failed = core;
          core = undefined;
          await failed.close();
          throw error;
        }
      },
      signal,
      pause,
      async (retry) => {
        log(
          `MAA 连接临时失败，重新检查设备后重试 ${retry}/2；尚未提交游戏任务`,
        );
        await checkReady(device, signal);
      },
    );
    signal.throwIfAborted();
    let disconnected = false;
    onSubmit();
    await core!.runTask(
      task.type,
      task.params,
      signal,
      (message) => {
        tracker.accept(message);
        if (isArknightsDisconnect(message)) disconnected = true;
        log(message);
      },
      maxRunMinutes * 60_000 + 60_000,
    );
    signal.throwIfAborted();
    if (disconnected)
      throw new Error(
        "游戏异常确认页面导致任务停止，本步骤结果未确认；请查看失败截图与故障诊断",
      );
  } finally {
    await core?.close();
  }
  signal.throwIfAborted();
}
