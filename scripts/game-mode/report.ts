/**
 * 游戏模式：日报渲染（纯函数）。
 *
 * 输出给人看，也给每天 08:45 / 20:45 / 23:00 的监督回合看：
 * 一句话结论 + 逐步骤明细 + 欠账清单 + 下一步建议。
 */
import type { GameId } from "./plans";
import type { FailureClass } from "./recovery";
import type { SkillResult } from "../../packages/protocol";
import { completionState, isSettledOutcome } from "./outcome";

export interface StepOutcome extends Omit<SkillResult, "status"> {
  skill: string;
  label: string;
  required: boolean;
  status: "succeeded" | "skipped" | "failed" | "blocked" | "unknown";
  /** 每步实际运行时间；不能用后续批次结束时间刷新旧证据。 */
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  failure?: { class: FailureClass; message: string };
  /** 实际尝试次数（1 表示一次通过）。 */
  attempts: number;
}

export interface LaneRun {
  lane: string;
  laneName: string;
  game: GameId;
  address: string;
  startedAt: string;
  finishedAt: string;
  outcomes: StepOutcome[];
}

export interface LaneSummary {
  done: number;
  total: number;
  /** 必做但没完成的步骤标签。 */
  missing: string[];
  /** 因游戏侧限制而跳过（不算欠账）。 */
  skipped: string[];
  unknown: string[];
}

export interface AppRunOutcome {
  lane: string;
  batchId: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  message?: string;
}

/** App requests have their own receipts; they do not produce a standalone per-step aggregate. */
export function gameModeRunSucceeded(input: {
  combos: { lane: string; game: GameId }[];
  results: { lane: string; game: GameId; code: number }[];
  runs: LaneRun[];
  appRuns: AppRunOutcome[];
}): boolean {
  return (
    input.combos.length > 0 &&
    input.combos.every((combo) => {
      const results = input.results.filter(
        (result) => result.lane === combo.lane && result.game === combo.game,
      );
      if (results.length !== 1 || results[0].code !== 0) return false;
      if (combo.game === "arknights") {
        const receipts = input.appRuns.filter((run) => run.lane === combo.lane);
        return (
          receipts.length === 1 &&
          !!receipts[0].batchId &&
          receipts[0].status === "succeeded"
        );
      }
      const runs = input.runs.filter(
        (run) => run.lane === combo.lane && run.game === combo.game,
      );
      return (
        runs.length === 1 &&
        runs[0].outcomes.length > 0 &&
        summarizeRun(runs[0]).missing.length === 0
      );
    })
  );
}

/**
 * 把新一次运行合并进当天已有记录：**按技能取"更确定"的那条**，其余保留。
 *
 * 2026-10-15 踩过两次：
 *  1) 暖机只跑 login，却把当天已经跑完 7 步的记录整份覆盖成 1 步；
 *  2) 一次失败运行会把后面所有步骤写成 blocked 占位（"上游步骤已停止，本步未执行"），
 *     这些占位又把**当天早些时候真的做成功**的步骤覆盖掉，欠账页于是谎报。
 *
 * 所以按确定性排序：成功/跳过 > 失败 > 占位；同一档才比时间（新的胜出）。
 * 「今天这一步做成了没有」由更确定的记录回答，失败与占位只作为这一次尝试的日志。
 */
const RANK: Record<string, number> = {
  succeeded: 3,
  skipped: 3,
  failed: 2,
  unknown: 2,
  blocked: 1,
  pending: 0,
};

export function mergeRunOutcomes(
  previous: LaneRun | undefined,
  next: LaneRun,
): LaneRun {
  if (!previous?.outcomes?.length) return next;
  const merged = new Map<string, StepOutcome>();
  const timestamped = (item: StepOutcome, run: LaneRun): StepOutcome => ({
    ...item,
    startedAt: item.startedAt ?? run.startedAt,
    finishedAt: item.finishedAt ?? run.finishedAt,
  });
  for (const item of previous.outcomes)
    merged.set(item.skill, timestamped(item, previous));
  for (const raw of next.outcomes) {
    const item = timestamped(raw, next);
    const existing = merged.get(item.skill);
    const incomingRank = RANK[completionState(item)] ?? 0;
    const existingRank = existing ? (RANK[completionState(existing)] ?? 0) : -1;
    if (
      !existing ||
      incomingRank > existingRank ||
      (incomingRank === existingRank &&
        Date.parse(item.finishedAt!) >= Date.parse(existing.finishedAt!))
    )
      merged.set(item.skill, item);
  }
  // 顺序以先出现的为准（新的技能追加在后面），别让同一技能在两次运行里都出现时把顺序打乱。
  const order = new Map<string, number>();
  let index = 0;
  for (const item of [...previous.outcomes, ...next.outcomes])
    if (!order.has(item.skill)) order.set(item.skill, index++);
  const outcomes = [...merged.values()].sort(
    (a, b) => (order.get(a.skill) ?? 0) - (order.get(b.skill) ?? 0),
  );
  return {
    ...previous,
    ...next,
    startedAt:
      previous.startedAt < next.startedAt ? previous.startedAt : next.startedAt,
    finishedAt: next.finishedAt,
    outcomes,
  };
}

export function summarizeRun(run: LaneRun): LaneSummary {
  const required = run.outcomes.filter((item) => item.required);
  return {
    done: run.outcomes.filter((item) => completionState(item) === "succeeded")
      .length,
    total: run.outcomes.length,
    missing: required
      .filter((item) => !isSettledOutcome(item))
      .map((item) => item.label),
    skipped: run.outcomes
      .filter((item) => completionState(item) === "skipped")
      .map((item) => item.label),
    unknown: run.outcomes
      .filter((item) => completionState(item) === "unknown")
      .map((item) => item.label),
  };
}

const ICON: Record<StepOutcome["status"], string> = {
  succeeded: "✅",
  skipped: "⏭️",
  failed: "❌",
  blocked: "⛔",
  unknown: "❓",
};

export function renderReport(
  date: string,
  runs: LaneRun[],
  notes: string[] = [],
  appRuns: AppRunOutcome[] = [],
): string {
  const lines: string[] = [`# 游戏模式日报 · ${date}`, ""];
  if (!runs.length && !appRuns.length) lines.push("（没有任何运行记录）", "");
  for (const run of runs) {
    const summary = summarizeRun(run);
    const gameName = run.game === "onmyoji" ? "阴阳师" : "明日方舟";
    lines.push(
      `## ${run.laneName}（${run.lane}）· ${gameName}`,
      "",
      `- 完成 **${summary.done}/${summary.total}** 步，必做欠账 ${summary.missing.length} 项` +
        (summary.skipped.length
          ? `，合理跳过 ${summary.skipped.length} 项`
          : "") +
        (summary.unknown.length
          ? `，待核对 ${summary.unknown.length} 项（不自动补跑）`
          : ""),
      `- 时间：${run.startedAt} → ${run.finishedAt}`,
      "",
      "| | 步骤 | 结果 | 说明 |",
      "|---|---|---|---|",
    );
    for (const item of run.outcomes) {
      const state = completionState(item);
      const detail =
        state === "succeeded"
          ? (item.summary ?? "完成")
          : item.failure
            ? `${item.failure.class}：${item.failure.message}`
            : (item.summary ?? "");
      lines.push(
        `| ${ICON[state]} | ${item.label}${item.required ? "" : "（可选）"} | ${state}${
          item.attempts > 1 ? ` · 尝试 ${item.attempts} 次` : ""
        } | ${detail.replace(/\|/g, "/")} |`,
      );
    }
    lines.push("");
    if (summary.missing.length)
      lines.push(
        `**欠账（必做未完成）**：${summary.missing.join("、")}`,
        "",
        "> 下一步：先看失败现场帧，定位是「读不到」还是「读错」，再决定修锚点还是修流程；" +
          "游戏侧限制造成的跳过不算欠账，会记进当天的说明里。",
        "",
      );
  }
  if (appRuns.length) {
    lines.push(
      "## App 方舟执行请求",
      "",
      "| 账号渠道 | 请求批次 | App 结果 | 说明 |",
      "|---|---|---|---|",
    );
    const cell = (value: string) =>
      value.replace(/[\r\n]+/g, " ").replace(/\|/g, "/");
    for (const run of appRuns)
      lines.push(
        `| ${cell(run.lane)} | ${cell(run.batchId)} | ${run.status} | ${cell(run.message ?? "")} |`,
      );
    lines.push(
      "",
      "以上状态来自本次 App 请求的持久回执；执行步骤和游戏内收益请在 App 中核对。",
      "",
    );
  }
  if (notes.length) {
    lines.push("## 说明", "");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}
