/**
 * 游戏模式 · 今日完成情况汇总（纯函数）。
 *
 * 监督回合最需要回答的一句话是"今天到底完成了什么、还差什么"。
 * 证据有两个来源，谁更新听谁的：
 *  - App 账本（定时日常的真实结果，控制桥 `report --json` 读出来）；
 *  - 游戏模式实跑（人工补跑/验收写下的 `artifacts/game-mode/<日期>/*.json`）。
 * 本模块只做合并与渲染，不发起任何操作。
 */
import type { GameId, GameModePlan } from "./plans";
import { summarizeRun, type LaneRun, type StepOutcome } from "./report";
import type { DeviceLane, SkillResult } from "../../packages/protocol";
import { completionState } from "./outcome";

export interface AppStep extends Omit<SkillResult, "status"> {
  stepId: string;
  status: string;
  text?: string;
  at?: string;
}

export interface AppRequest {
  requestId: string;
  laneId?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
  eventsRead?: boolean;
  /** 已经处置过的记录带这个字段（控制桥原样透传）；有它就不再是"未确认"。 */
  resolution?: { action: string; at: string } | null;
  games?: Record<string, { result?: string; steps?: AppStep[] } | undefined>;
}

export type CompletionState = "succeeded" | "skipped" | "failed" | "pending" | "unknown";

export interface CompletionItem {
  skill: string;
  label: string;
  required: boolean;
  state: CompletionState;
  source: "app" | "game-mode" | "none";
  detail: string;
  at?: string;
}

export interface LaneGameStatus {
  lane: string;
  laneName: string;
  game: GameId;
  items: CompletionItem[];
  done: number;
  missing: string[];
  /** 同一设备有未知/活动请求时，旧完成记录仍可展示，但不得自动补跑。 */
  catchupBlocked?: boolean;
}

function uncertainRequest(request: AppRequest): boolean {
  // 已经处置过的记录不再是"未确认"：处置意味着有人核对过现场并写下了依据。
  // 2026-10-16 修的：少了这一条，昨天处置掉的记录会天天被当成待核对，
  // 监督层于是既不敢补跑、也永远判不出"今天到底做完了没有"。
  if (request.resolution) return false;
  return request.status === "unknown" || request.eventsRead === false ||
    ["running", "queued", "stopping"].includes(request.status ?? "");
}

interface Evidence {
  state: CompletionState;
  detail: string;
  at: string;
  source: "app" | "game-mode";
}
interface StatusLane {
  id: string;
  name: string;
  enabled: Record<GameId, boolean>;
  legacyBinding?: DeviceLane["legacyBinding"];
}
function historyLaneIds(lane: StatusLane): string[] {
  return [lane.id, ...(lane.legacyBinding ? [lane.legacyBinding.laneId] : [])];
}
function requestBelongsToChannel(request: AppRequest, lane: StatusLane, game: GameId): boolean {
  if (!request.laneId) return true;
  if (!historyLaneIds(lane).includes(request.laneId)) return false;
  const declared = Object.keys(request.games ?? {});
  return !lane.legacyBinding || !declared.length || declared.includes(game);
}

function mapAppStatus(status: string): StepOutcome["status"] {
  if (status === "succeeded") return "succeeded";
  if (status === "skipped") return "skipped";
  if (status === "failed") return "failed";
  return "unknown";
}

function evidenceFromApp(
  lane: StatusLane,
  plan: GameModePlan,
  requests: AppRequest[],
): Map<string, Evidence> {
  const found = new Map<string, Evidence>();
  for (const request of requests) {
    if (!requestBelongsToChannel(request, lane, plan.game)) continue;
    const uncertain = uncertainRequest(request);
    if (!request.laneId && !uncertain) continue;
    const entry = request.games?.[plan.game];
    if (uncertain && (entry || !Object.keys(request.games ?? {}).length)) {
      const at = request.finishedAt ?? request.startedAt ?? "";
      for (const step of plan.steps) {
        if (entry?.steps?.some(item => item.stepId === step.skill)) continue;
        const previous = found.get(step.skill);
        // 2026-10-15：已经成功过的步骤不会被后来的未确认请求改写——
        // 20:00 次槽那次 arknights login 失败，曾把早上跑完的 6/6 全改成"待核对"。
        if (previous && successRank(previous.state) === 2) continue;
        if ((previous?.at ?? "") > at) continue;
        found.set(step.skill, {
          state: "unknown",
          detail: `请求 ${request.requestId} 结果未知或事件未读完整；本步需核对，不自动补跑`,
          at,
          source: "app",
        });
      }
    }
    if (!entry?.steps) continue;
    for (const step of entry.steps) {
      const at = step.at ?? request.finishedAt ?? request.startedAt ?? "";
      const previous = found.get(step.stepId);
      if (previous && successRank(previous.state) === 2) continue;
      const mapped = mapAppStatus(step.status);
      const state = completionState({
        ...step,
        skill: step.stepId,
        label: step.stepId,
        required: false,
        attempts: 1,
        status: uncertain && mapped === "failed" ? "unknown" : mapped,
        summary: step.summary ?? step.text,
        finishedAt: at,
      });
      // 2026-10-15：先把请求按新到旧遍历（桥就是这么给的），所以"时间更早"不能直接丢弃——
      // 20:00 的 unknown 先落盘，早上那条真正成功的记录反而被时间判据挡掉，
      // lane-b 方舟于是从 6/6 显示成 1/6。改成：确定性优先，同档才比时间。
      if (previous) {
        const previousRank = successRank(previous.state);
        const nextRank = successRank(state);
        if (previousRank > nextRank) continue;
        if (previousRank === nextRank && previous.at >= at) continue;
      }
      found.set(step.stepId, {
        state: state === "blocked" ? "failed" : state,
        detail: step.text ?? step.status,
        at,
        source: "app",
      });
    }
  }
  return found;
}

function evidenceFromRuns(
  lane: StatusLane,
  game: GameId,
  runs: LaneRun[],
): Map<string, Evidence> {
  const found = new Map<string, Evidence>();
  for (const run of runs) {
    if (!historyLaneIds(lane).includes(run.lane) || run.game !== game) continue;
    for (const outcome of run.outcomes as StepOutcome[]) {
      const at = outcome.finishedAt ?? outcome.evidenceTimestamp ?? run.finishedAt;
      const previous = found.get(outcome.skill);
      if (previous && previous.at >= at) continue;
      const state = completionState(outcome);
      found.set(outcome.skill, {
        state: state === "blocked" ? "failed" : state,
        detail:
          outcome.summary ??
          (outcome.failure
            ? `${outcome.failure.class}：${outcome.failure.message}`
            : outcome.status),
        at,
        source: "game-mode",
      });
    }
  }
  return found;
}

/**
 * 证据的"确定性"排序：**有明确结论的证据优先于"未确认"**。
 *
 * 同一天里同一步骤会被跑好几次（主槽 + 次槽 + 受监督补跑），合并时：
 *  - `unknown` / `pending` 只是"没读到"，**不能覆盖任何明确结论**——
 *    2026-10-15 就是它把早上已经成功的 6/6 显示成 1/6（见下）；
 *  - 成功与失败都是明确结论，**同级按时间**决胜：更晚的真实失败要如实显示为失败
 *    （`tests/game-mode-completion.test.ts` 钉住了这条，别改成"成功永远赢"）。
 */
function successRank(state: CompletionState | "blocked"): number {
  return state === "unknown" || state === "pending" ? 1 : 2;
}

export function mergeStatus(input: {
  plans: readonly GameModePlan[];
  lanes: StatusLane[];
  requests: AppRequest[];
  runs: LaneRun[];
  evidenceReadError?: string;
}): LaneGameStatus[] {
  const result: LaneGameStatus[] = [];
  for (const lane of input.lanes) {
    for (const plan of input.plans) {
      if (!lane.enabled[plan.game]) continue;
      const blockingRequest = input.requests.find(request =>
        requestBelongsToChannel(request, lane, plan.game) && uncertainRequest(request));
      const app = evidenceFromApp(lane, plan, input.requests);
      const mode = evidenceFromRuns(lane, plan.game, input.runs);
      const items: CompletionItem[] = plan.steps.map((step) => {
        if (input.evidenceReadError)
          return {
            skill: step.skill,
            label: step.label,
            required: step.required,
            state: "unknown",
            source: "none",
            detail: `证据读取失败：${input.evidenceReadError}；先核对，不自动补跑`,
          };
        const picked = [app.get(step.skill), mode.get(step.skill)]
          .filter((item): item is Evidence => Boolean(item))
          .sort(
            (a, b) =>
              // 2026-10-15：晚到的失败/未知不得抹掉当天早些时候的成功——
              // 20:00 次槽那次 arknights login 失败，曾把早上已经跑完的 6/6 显示成 0/6，
              // 差一点让监督去重跑一个已经完成的日常。
              // 成功/跳过永远优先（成功是粘的）；同一档内才比时间，新的胜出。
              successRank(b.state) - successRank(a.state) ||
              (a.at < b.at ? 1 : -1),
          )[0];
        if (!picked)
          return {
            skill: step.skill,
            label: step.label,
            required: step.required,
            state: blockingRequest ? "unknown" : "pending",
            source: blockingRequest ? "app" : "none",
            detail: blockingRequest
              ? `设备存在未知或活动请求 ${blockingRequest.requestId}，本步先核对，不自动补跑`
              : step.maintenance ? "维护类，按周期执行" : "今天还没有记录",
          };
        return {
          skill: step.skill,
          label: step.label,
          required: step.required,
          state: picked.state,
          source: picked.source,
          detail: picked.detail,
          at: picked.at,
        };
      });
      result.push({
        lane: lane.id,
        laneName: lane.name,
        game: plan.game,
        items,
        catchupBlocked: Boolean(blockingRequest || input.evidenceReadError),
        done: items.filter((item) => item.state === "succeeded").length,
        missing: items
          .filter((item) => item.required && item.state !== "succeeded" && item.state !== "skipped")
          .map((item) => item.label),
      });
    }
  }
  return result;
}

const ICON: Record<CompletionState, string> = {
  succeeded: "✅",
  skipped: "⏭️",
  failed: "❌",
  pending: "⏳",
  unknown: "❓",
};

export function renderStatus(day: string, statuses: LaneGameStatus[]): string {
  const lines = [`# 今日完成情况 · ${day}`, ""];
  const owed = statuses.flatMap((item) =>
    item.missing.map((label) => `${item.laneName}/${label}`),
  );
  const unknown = statuses.flatMap(status => status.items
    .filter(item => item.required && item.state === "unknown")
    .map(item => `${status.laneName}/${item.label}`));
  lines.push(
    owed.length
      ? unknown.length === owed.length
        ? `**必做待核对 ${unknown.length} 项**：${unknown.join("、")}（不自动补跑）`
        : `**必做欠账 ${owed.length} 项**：${owed.join("、")}` +
          (unknown.length ? `；其中待核对 ${unknown.length} 项，不自动补跑` : "")
      : statuses.some(status => status.items.some(item => item.state === "skipped"))
        ? "**必做项已完成或合理跳过**（跳过保留原始原因）"
        : "**必做项全部完成**（游戏侧限制造成的跳过不计入欠账）",
    "",
  );
  for (const status of statuses) {
    const gameName = status.game === "onmyoji" ? "阴阳师" : "明日方舟";
    lines.push(
      `## ${status.laneName}（${status.lane}）· ${gameName}`,
      "",
      `完成 **${status.done}/${status.items.length}** 步` +
        (status.missing.length ? `，待完成或核对：${status.missing.join("、")}` : ""),
      "",
      ...(status.catchupBlocked ? ["设备存在未知/活动请求或证据读取问题，本组合不自动补跑。", ""] : []),
      "| | 步骤 | 来源 | 说明 |",
      "|---|---|---|---|",
    );
    for (const item of status.items)
      lines.push(
        `| ${ICON[item.state]} | ${item.label}${item.required ? "" : "（可选）"} | ${item.source} | ${item.detail.replace(/\|/g, "/")} |`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 当日总报告（监督回合与大人看的那一份）：完成情况 + 实跑明细 + 说明。
 *
 * 为什么单独一份：以前是 status.md（合并视图）与 report.md（只有实跑记录）两个文件，
 * 读的人要先自己想清楚哪个是结论。现在 `daily-report.md` 就是结论，
 * 实跑明细与来源都列在同一份里。
 */
export function renderDailyReport(input: {
  day: string;
  statuses: LaneGameStatus[];
  runs: LaneRun[];
  notes?: string[];
}): string {
  const lines = [renderStatus(input.day, input.statuses).trimEnd(), ""];
  const owed = input.statuses.flatMap((item) =>
    item.missing.map((label) => `${item.laneName}/${label}`),
  );
  lines.push("## 今天做过什么（实跑明细）", "");
  if (!input.runs.length) lines.push("- 今天没有游戏模式实跑记录（结果全部来自 App 账本）", "");
  for (const run of input.runs) {
    const gameName = run.game === "onmyoji" ? "阴阳师" : "明日方舟";
    const done = summarizeRun(run).done;
    lines.push(
      `- ${run.laneName}（${run.lane}）· ${gameName}：${done}/${run.outcomes.length} 步 · ${run.startedAt} → ${run.finishedAt}`,
    );
  }
  lines.push("");
  if (owed.length) {
    lines.push(
      "## 下一步",
      "",
      "1. 先看失败现场帧（`lanes/<lane>/engine-logs/last-screen.png`），用 `npm run ocr:probe -- <png>` 判断是「读不到」还是「读错」；",
      "2. 结果未知的步骤先人工核对，不自动补跑、不重复点击；仅对确认未执行且设备空闲的步骤按监督流程补跑；",
      "3. 改锚点/流程 → 加用例 → `npm run verify` → 提交；需要实机复验就出补丁包并切包（`npm run daily:preflight -- --fix` 会重指引用）；",
      "4. 攻略与已知失败模式见 `docs/game-guides/`。",
      "",
    );
  }
  const notes = [
    ...(input.notes ?? []),
    "数据来源：App 账本（控制桥 report --json，定时日常的真实结果）＋ 游戏模式实跑记录（人工补跑/验收），同一技能取更新的那条。",
  ];
  lines.push("## 说明", "");
  for (const note of notes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}
