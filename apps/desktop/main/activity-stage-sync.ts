/**
 * 运行前解析"跟随当前活动关卡"（P1-2 收尾）
 *
 * 设计约束：
 * - **不擅自改用户配置**：只在本次运行的配置副本上覆盖 stage，档案里的 stage 保持不变；
 * - **读不到就回退**：找不到 maa-cli / 解析失败 / 开关关闭 → 用档案关卡，绝不猜一个关卡；
 * - 纯逻辑 + 注入式依赖，便于单测（不需要真的跑 maa-cli）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ArknightsClientType } from "../../../packages/runtime/activity-stage";

export interface StageResolverPort {
  resolve(
    clientType: ArknightsClientType,
  ): Promise<{ stage: string; name: string } | null>;
}

export interface ResolveMaaCliPorts {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
}

/**
 * 找 maa-cli：环境变量优先，其次常见的用户级安装位置。
 * 找不到返回 null（上层据此回退档案关卡）。
 */
export function resolveMaaCliPath(ports: ResolveMaaCliPorts = {}): string | null {
  const env = ports.env ?? process.env;
  const exists = ports.exists ?? ((path: string) => existsSync(path));
  const candidates: string[] = [];
  const override = env.GAMEPILOT_MAA_CLI;
  if (override) candidates.push(override);
  const localAppData = env.LOCALAPPDATA;
  if (localAppData) candidates.push(join(localAppData, "Programs", "maa-cli", "maa.exe"));
  if (env.USERPROFILE)
    candidates.push(join(env.USERPROFILE, "AppData", "Local", "Programs", "maa-cli", "maa.exe"));
  candidates.push("D:\\maa-cli\\maa.exe", "C:\\maa-cli\\maa.exe");
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

export interface FollowRunStageInput {
  readonly enabled: boolean;
  readonly clientType: ArknightsClientType;
  readonly configuredStage: string;
  readonly resolver: StageResolverPort | null;
  /**
   * 活动结束/解析不到活动关卡时，用来替换"已失效的活动关卡"的主线关卡。
   * 2026-10-23 实测：昨日海结束后档案仍是 YW-8，理智作战必然失败；此时应回退主线。
   */
  readonly fallbackStage?: string;
}

/** 主线/常驻关卡：纯数字章节点（1-7）或常驻资源关卡（CE/LS/CA/AP/SK/PR-*）。 */
export function isMainlineStage(stage: string): boolean {
  const value = stage.trim();
  return /^\d{1,2}-\d{1,2}$/.test(value) || /^(CE|LS|CA|AP|SK|PR)-/i.test(value);
}

/**
 * 是否是"可能随活动结束而失效"的关卡（如 `YW-8`）。
 * 注意：CE-5/LS-5 这类是玩家自选的常驻资源关，**不能**当成失效活动关覆盖掉。
 */
export function looksLikeActivityStage(stage: string): boolean {
  const value = stage.trim();
  if (!value || isMainlineStage(value)) return false;
  return /^[A-Za-z]{1,6}-\d{1,2}$/.test(value);
}

export interface FollowRunStageResult {
  readonly stage: string;
  readonly followed: boolean;
  readonly note: string;
}

/** 计算本次运行应使用的关卡（不修改任何持久化配置）。 */
export async function resolveRunStage(
  input: FollowRunStageInput,
): Promise<FollowRunStageResult> {
  if (!input.enabled)
    return {
      stage: input.configuredStage,
      followed: false,
      note: `未开启"跟随活动关卡"，使用档案关卡 ${input.configuredStage || "（空）"}`,
    };
  if (!input.resolver)
    return {
      stage: input.configuredStage,
      followed: false,
      note: `未找到 maa-cli，无法跟随活动关卡，回退档案关卡 ${input.configuredStage || "（空）"}`,
    };
  let resolved: { stage: string; name: string } | null = null;
  try {
    resolved = await input.resolver.resolve(input.clientType);
  } catch {
    resolved = null;
  }
  if (!resolved) {
    const configured = input.configuredStage;
    // 活动结束时 maa-cli 只剩小游戏：档案里的活动关卡已失效，继续用会必然失败。
    if (input.fallbackStage && looksLikeActivityStage(configured))
      return {
        stage: input.fallbackStage,
        followed: false,
        note: `活动已结束/解析不到活动关卡，回退主线关卡 ${input.fallbackStage}（档案关卡 ${configured} 已失效）`,
      };
    return {
      stage: configured,
      followed: false,
      note: `未能解析当前活动关卡，回退档案关卡 ${configured || "（空）"}`,
    };
  }
  return {
    stage: resolved.stage,
    followed: true,
    note: `跟随当前活动关卡：${resolved.stage}（${resolved.name}）`,
  };
}
