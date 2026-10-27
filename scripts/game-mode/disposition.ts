/**
 * 未处置记录的**策略化处置**（P1c，纯函数）。
 *
 * 背景：`launchLane` 的准入有三道闸门，其中第二道
 * （`assertAgentScheduleClear`）**只要该设备存在任何未处置记录，就阻止任何新的准入**，
 * 与游戏无关。所以"方舟失败 → 阴阳师当天也跑不了"的真正卡点在这里，而不是在于
 * 记录按不按游戏拆分。
 *
 * 处置（`resolution: abandoned` + 如实说明）能做的是：把**结论明确**的失败记录标记为
 * 已核对完毕，于是另一款游戏的准入不再被它挡住；而它自己的同日门禁照旧生效
 * （记录还在，同日判定仍按游戏），因此不会被重复挑战。
 *
 * 允许自动处置的边界（写死，别放宽）：
 *  - 只处置 `failed` / `cancelled`：**`unknown` 一律不处置**（结果未确认 = 可能已经动过
 *    游戏，必须现场核对；与 `game:catchup` 的"未知结果不自动补跑"同一条规矩）；
 *  - 任务证据必须**完整且自洽**（步骤状态与任务状态不矛盾、且都已是终态）；
 *  - 处置理由必须写清依据；不删除、不改写历史，只追加处置。
 */
import type { LaneGameStatus } from "./status";
import type { AppRequest } from "./status";

export interface DispositionRequest {
  id: string;
  laneId?: string;
  status?: string;
  source?: string;
  startedAt?: string;
  message?: string;
  resolution?: { action: "abandoned"; at: string; note: string };
}

export interface DispositionTask {
  executionId?: string;
  gameId?: string;
  status?: string;
  steps?: { skillId?: string; status?: string }[];
}

export interface DispositionCandidate {
  requestId: string;
  gameId?: string;
  note: string;
  reason: string;
}

/** 任务证据是否完整自洽：状态与步骤不矛盾，且步骤都到终态。 */
export function taskEvidenceIsTerminal(task: DispositionTask): boolean {
  const steps = task.steps ?? [];
  if (!steps.length) return false;
  const terminal = (status?: string) =>
    !!status &&
    ["succeeded", "skipped", "failed", "cancelled"].includes(status);
  if (!terminal(task.status)) return false;
  if (task.status === "succeeded")
    return steps.every(
      (step) => step.status === "succeeded" || step.status === "skipped",
    );
  return steps.every((step) => terminal(step.status));
}

/**
 * 找出**可以安全自动处置**的记录。
 *
 * 只挑这种：状态 failed/cancelled、关联任务证据完整自洽、且该槽位**还有别的游戏**
 * 因为这道闸门而跑不起来（即状态里存在必做的 pending 步骤）。没有任何别的东西可救时，
 * 处置它没有意义——留给监督回合按正常流程核对。
 */
export function planDisposition(input: {
  statuses: LaneGameStatus[];
  requests: DispositionRequest[];
  tasks: DispositionTask[];
  now?: Date;
}): DispositionCandidate[] {
  const now = input.now ?? new Date();
  const candidates: DispositionCandidate[] = [];
  const pendingLanes = new Set(
    input.statuses
      .filter((status) =>
        status.items.some((item) => item.required && item.state === "pending"),
      )
      .map((status) => status.lane),
  );
  for (const request of input.requests) {
    if (!request.laneId || !pendingLanes.has(request.laneId)) continue;
    if (request.resolution) continue;
    if (request.status !== "failed" && request.status !== "cancelled") continue;
    const linked = input.tasks.filter(
      (task) => task.executionId === request.id,
    );
    if (!linked.length) continue;
    if (!linked.every((task) => taskEvidenceIsTerminal(task))) continue;
    const games = [
      ...new Set(linked.map((task) => task.gameId).filter(Boolean)),
    ] as string[];
    if (!games.length || linked.some((task) => !task.gameId)) continue;
    if (
      !input.statuses.some(
        (status) =>
          status.lane === request.laneId &&
          !games.includes(status.game) &&
          status.items.some(
            (item) => item.required && item.state === "pending",
          ),
      )
    )
      continue;
    candidates.push({
      requestId: request.id,
      gameId: games.length === 1 ? games[0] : undefined,
      reason:
        request.status === "cancelled"
          ? "该次执行已被取消且步骤均已到终态"
          : "该次执行以失败告终且步骤均已到终态",
      note: `监督策略处置：${request.status === "cancelled" ? "已取消" : "失败"}于 ${request.startedAt ?? "未知时间"}${
        games.length ? `，涉及 ${games.join("、")}` : ""
      }；步骤终态完整且无未知，仅结束核对以放行另一游戏；原记录保留，已成功步骤不重放，不宣称全程未生效。处置时间 ${now.toISOString()}。`,
    });
  }
  return candidates;
}

export function renderDisposition(candidates: DispositionCandidate[]): string {
  if (!candidates.length) return "没有可自动处置的记录。";
  const lines = [
    `可自动处置 ${candidates.length} 条（结论明确、证据自洽）：`,
    "",
  ];
  for (const candidate of candidates)
    lines.push(
      `- ${candidate.requestId}${candidate.gameId ? `（${candidate.gameId}）` : ""}：${candidate.reason}`,
    );
  return lines.join("\n");
}

/** Only complete host event reports can feed automatic disposition. */
export function dispositionsFromReport(
  statuses: LaneGameStatus[],
  reports: (AppRequest & {
    attention?: { kind?: string; status?: string }[];
  })[],
): DispositionCandidate[] {
  const requests: DispositionRequest[] = [];
  const tasks: DispositionTask[] = [];
  for (const report of reports) {
    if (
      report.eventsRead !== true ||
      !Number.isFinite(Date.parse(report.finishedAt ?? "")) ||
      report.attention?.some(
        (item) =>
          ["paging", "events"].includes(item.kind ?? "") ||
          ["unknown", "truncated", "stalled"].includes(item.status ?? ""),
      )
    )
      continue;
    const games = Object.entries(report.games ?? {});
    if (
      !games.length ||
      games.some(
        ([gameId, game]) =>
          !["arknights", "onmyoji"].includes(gameId) ||
          !game?.result ||
          !game.steps?.length ||
          game.steps.some((step) => !step.stepId),
      )
    )
      continue;
    requests.push({
      ...report,
      id: report.requestId,
      resolution: report.resolution
        ? { ...report.resolution, action: "abandoned", note: "已有处置" }
        : undefined,
    });
    for (const [gameId, game] of games)
      tasks.push({
        executionId: report.requestId,
        gameId,
        status: game!.result,
        steps: game!.steps!.map((step) => ({
          skillId: step.stepId,
          status: step.status,
        })),
      });
  }
  return planDisposition({ statuses, requests, tasks });
}
