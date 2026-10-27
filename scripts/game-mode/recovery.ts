/**
 * 游戏模式：有界恢复策略（纯函数，可测）。
 *
 * 原则与 App 的安全立场一致：**不认识的情况宁可停下，也不自动重放**。
 * 这里只做"要不要再试一次"的判断，不做任何点击决策；真正的操作永远由各游戏技能实现执行。
 */
import type { GameModeStep } from "./plans";

export type FailureClass =
  /** 界面判据读不到/读错：需要改锚点，重试无用。 */
  | "anchor-miss"
  /** 时序竞态：转场、动画、双帧不一致，重试通常有效。 */
  | "timing"
  /** 传输/引擎抖动：设备未就绪、桥断了、作业超时。 */
  | "transport"
  /** 游戏侧的正常限制：今日次数用完、理智不足、无可用对象。 */
  | "game-limit"
  /** 判断不了。 */
  | "unknown";

export interface RecoveryDecision {
  action: "retry" | "skip" | "stop";
  reason: string;
}

const PATTERNS: [FailureClass, RegExp][] = [
  [
    "game-limit",
    /次数.*(?:用完|上限)|已达上限|今日.*(?:已|上限)|无法挑战|不满足|不足|没有可|无待领取|理智不足|已挑战|已完成/,
  ],
  ["timing", /未得到新鲜|双帧|画面发生变化|超时|不稳定|请稍后/],
  [
    "anchor-miss",
    // "无法确认/未能确认/未识别"这类都是"判据没认出界面"，重试无用、必须改锚点：
    // 2026-10-15 地域鬼王的艺术字难度页签就是这个形态。
    /读不到|未识别|未能识别|未能确认|无法确认|不在|找不到|锚点|未进入|不符合预期/,
  ],
  [
    "transport",
    // 2026-10-22 实测：lane-b 首跑报 Command failed: ...adb.exe -s ... get-state，
    // 其中既没有「设备未就绪」也没有大写 ADB，会被判成 unknown；这里把 adb 命令失败明确归为传输抖动。
    /设备未就绪|尚未完成启动|断线|断开服务器|重连|连接失败|连接|ADB|adb|桥|bridge|native|MAA|作业|RPC|timeout|ECONN|EPIPE/,
  ],
];

export function classifyFailure(message: string): FailureClass {
  const text = message.replace(/\s/g, "");
  for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind;
  return "unknown";
}

/**
 * 决策表（刻意保守）：
 *  - game-limit：跳过（这是游戏的正常状态，不是故障）；
 *  - timing / transport：最多重试 1 次；
 *  - anchor-miss：直接停（重试不会让锚点自己变对，需要人来改代码）；
 *  - unknown：重试 1 次，再失败就停。
 * 必做步骤不会因为失败被"跳过"：只有 game-limit 才允许跳过。
 */
export function decideRecovery(
  step: GameModeStep,
  failure: FailureClass,
  attempts: number,
): RecoveryDecision {
  if (failure === "game-limit")
    return {
      action: "skip",
      reason: `${step.label}：游戏侧今日已不可做（${failure}），按跳过记录`,
    };
  if (failure === "anchor-miss")
    return {
      action: "stop",
      reason: `${step.label}：界面判据与现场不一致（anchor-miss），需修锚点后重跑，不自动重放`,
    };
  if (attempts >= 2)
    return {
      action: "stop",
      reason: `${step.label}：已重试 ${attempts - 1} 次仍失败（${failure}），停止并等待人工核对`,
    };
  return {
    action: "retry",
    reason: `${step.label}：${failure} 属于可重试类别，重试第 ${attempts} 次`,
  };
}
