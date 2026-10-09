import {
  agentBeijingTime,
  type AgentRunSummary,
} from "../packages/protocol/agent";
import { games } from "./registry";
import type { DailyQueryScope } from "./recorded-daily-query";

type Observation = {
  record: AgentRunSummary;
  gameId?: string;
  time?: number;
};
const requestStatus: Record<string, string> = {
  succeeded: "原请求记录成功",
  failed: "原请求失败",
  cancelled: "原请求已取消",
  unknown: "原请求结果未知",
  running: "原请求记录为运行中",
  queued: "原请求记录为排队中",
  stopping: "原请求记录为停止中",
};
const stepStatus: Record<string, string> = {
  succeeded: "流程完成",
  skipped: "跳过",
  failed: "失败",
  "not-run": "未执行",
  cancelled: "取消",
  excluded: "未选续跑",
  running: "记录为运行中",
  pending: "记录为待执行",
  unknown: "未知",
};
const boundary =
  "以上仅为已读取的历史记录，非当前现场。流程完成不代表当天全部日常或具体奖励已完成；记录缺失表示未知，不表示未执行，也不授权重跑。";
function label(value: string): string {
  const account = /^lane-([a-h])$/.exec(value);
  if (account)
    return `账号${"一二三四五六七八"[account[1].charCodeAt(0) - 97]}`;
  return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 64);
}
function compare(a: Observation, b: Observation): number {
  return (
    (b.time ?? -Infinity) - (a.time ?? -Infinity) ||
    a.record.requestId.localeCompare(b.record.requestId) ||
    (a.gameId ?? "").localeCompare(b.gameId ?? "")
  );
}
function associatedProgress(observation: Observation) {
  const { record } = observation;
  const progress = record.recordedProgress;
  return progress?.requestId === record.requestId &&
    progress.laneId === record.laneId
    ? progress
    : undefined;
}
function gameTasks(observation: Observation) {
  return observation.record.tasks.filter(
    (task) => task.gameId === observation.gameId,
  );
}
function completeGameRecord(observation: Observation): boolean {
  const tasks = gameTasks(observation);
  return (
    observation.time !== undefined &&
    observation.record.complete &&
    observation.record.warnings.length === 0 &&
    tasks.length === 1 &&
    tasks[0].mode === "live" &&
    tasks[0].steps.length > 0 &&
    new Set(tasks[0].steps.map((step) => step.skillId)).size ===
      tasks[0].steps.length
  );
}
function observationText(observation: Observation, title: string): string {
  const { record, gameId } = observation;
  const start = agentBeijingTime(record.startedAt);
  const recordedEnd = agentBeijingTime(record.finishedAt);
  const end =
    start &&
    recordedEnd &&
    Date.parse(record.finishedAt!) >= Date.parse(record.startedAt!)
      ? recordedEnd
      : undefined;
  const tasks = gameTasks(observation);
  const task = tasks.length === 1 ? tasks[0] : undefined;
  const progress = associatedProgress(observation);
  const planned =
    progress?.steps.filter((step) => step.gameId === gameId) ?? [];
  const rawSteps = planned.length
    ? planned
    : tasks.flatMap((entry) => entry.steps);
  const ids = [...new Set(rawSteps.map((step) => step.skillId))];
  const game = games.find((entry) => entry.id === gameId);
  const skillLabel = (id: string) =>
    game?.skills.find((skill) => skill.id === id)?.title ?? label(id);
  const lines = [
    `${title}：${start ? `${start}${end ? ` → ${end}` : record.finishedAt ? "（结束时间不可核对）" : "（结束时间未知）"}（北京时间）` : "记录时间未知，无法确定先后"}；${requestStatus[record.recordedStatus] ?? "原请求结果未知"}（${label(record.requestId)}）`,
  ];
  const flags: string[] = [];
  if (record.requestSource === "maintenance") flags.push("维护请求");
  if (task?.mode === "rehearsal") flags.push("演练记录");
  else if (task && task.mode !== "live") flags.push("执行模式未知");
  if (!record.complete || record.warnings.length) flags.push("记录关联不完整");
  if (progress?.warnings.length) flags.push("关联进度不完整");
  if (tasks.length === 0) flags.push("游戏任务记录缺失，结果未知");
  if (tasks.length > 1) flags.push("游戏任务记录重复，结果未知");
  if (task?.status === "failed") flags.push("游戏记录失败");
  if (record.resolution?.action === "abandoned")
    flags.push("已结束后续处理，原结果保留");
  if (planned.some((step) => step.continued))
    flags.push("含关联续跑记录，原请求结果保留");
  if (task?.gameDay) {
    flags.push(`游戏日 ${label(task.gameDay)}`);
    if (task.finishedGameDay && task.finishedGameDay !== task.gameDay)
      flags.push(
        `结束游戏日 ${label(task.finishedGameDay)}，不可合并为单日完成`,
      );
  }
  if (flags.length) lines.push(flags.join("；") + "。");
  if (!ids.length) {
    lines.push("原范围未知；结果未知。");
    return lines.join("\n");
  }
  const visible = ids.slice(0, 12);
  const scope =
    progress && progress.rootId !== record.requestId
      ? `关联原计划范围（${label(progress.rootId)}）`
      : "原范围";
  lines.push(
    `${scope}：${visible.map(skillLabel).join("、")}${ids.length > visible.length ? `等 ${ids.length} 项（其余范围见原记录）` : ""}。`,
  );
  const states = new Map<string, string[]>();
  for (const id of ids) {
    const matching = rawSteps.filter((step) => step.skillId === id);
    // Ambiguous associations are never resolved by preferring a successful row.
    const state =
      tasks.length > 1 || matching.length !== 1
        ? "unknown"
        : matching[0].status;
    const stateLabel =
      state === "succeeded" && task?.mode === "rehearsal"
        ? "演练流程完成"
        : (stepStatus[state] ?? "未知");
    const existing = states.get(stateLabel) ?? [];
    existing.push(skillLabel(id));
    states.set(stateLabel, existing);
  }
  for (const [state, skills] of states)
    lines.push(
      `${state}：${skills.slice(0, 8).join("、")}${skills.length > 8 ? `等 ${skills.length} 项` : ""}。`,
    );
  return lines.join("\n");
}

/** Host ledger presentation only: preserves original request scope and status. */
export function recordedQueryReport(
  records: readonly AgentRunSummary[],
): string {
  if (!records.length)
    return `尚未读取到可核对的历史记录，结果未知。\n${boundary}`;
  const groups = new Map<string, Observation[]>();
  for (const record of records) {
    const progress = associatedProgress({ record });
    const gameIds = [
      ...new Set([
        ...record.tasks.map((task) => task.gameId),
        ...(progress?.steps.map((step) => step.gameId) ?? []),
      ]),
    ];
    const time = agentBeijingTime(record.startedAt)
      ? Date.parse(record.startedAt!)
      : undefined;
    for (const gameId of gameIds.length ? gameIds : [undefined]) {
      // Missing account identity does not merge unrelated requests into one account.
      const key = JSON.stringify([
        record.laneId ?? `unknown:${record.requestId}`,
        gameId ?? "",
      ]);
      const observations = groups.get(key) ?? [];
      observations.push({ record, gameId, time });
      groups.set(key, observations);
    }
  }
  const ordered = [...groups.values()]
    .map((observations) => observations.sort(compare))
    .sort((a, b) => compare(a[0], b[0]));
  const sections: string[] = [];
  for (const observations of ordered.slice(0, 8)) {
    const latest = observations[0];
    const undated = observations.find((entry) => entry.time === undefined);
    const earlier = !completeGameRecord(latest)
      ? observations.slice(1).find(completeGameRecord)
      : undefined;
    const extra = undated !== latest ? (undated ?? earlier) : earlier;
    const game = games.find((entry) => entry.id === latest.gameId);
    const heading = `${latest.record.laneId ? label(latest.record.laneId) : `账号未知（${label(latest.record.requestId)}）`} · ${game?.name ?? (latest.gameId ? label(latest.gameId) : "游戏未知")}`;
    let section = `${heading}\n${observationText(latest, undated && latest.time !== undefined ? "最近有时间的记录" : "最近记录")}`;
    if (extra)
      section += `\n${observationText(extra, extra.time === undefined ? "另有时间未知记录" : "较早记录（不改写最近请求）")}`;
    sections.push(
      section.length > 900
        ? section.slice(0, 850) + "\n其余详情请查看原记录。"
        : section,
    );
  }
  const omitted = ordered.length - sections.length;
  return [
    "已核对的历史记录（每账号、游戏列出最近请求，必要时附较早的完整游戏记录）：",
    ...sections,
    ...(omitted ? [`另有 ${omitted} 组记录未展开，请查看原记录。`] : []),
    boundary,
  ].join("\n\n");
}

/** Current game-day coverage is scoped separately from older goals and login checks. */
export function recordedDailyQueryReport(
  records: readonly AgentRunSummary[],
  scopes: DailyQueryScope[],
  at: string,
  incomplete = false,
): string {
  const sections = scopes.slice(0, 16).map((scope) => {
    const game = games.find((entry) => entry.id === scope.gameId);
    const heading = `${scope.account} · ${game?.name ?? scope.gameId}（游戏日 ${scope.gameDay}）`;
    const record = records.find(
      (entry) =>
        entry.requestId === scope.requestIds[0] &&
        entry.laneId === scope.laneId,
    );
    if (!record)
      return `${heading}\n今日记录未核对完整，日常完成状态未知；旧日期记录不能代替今天。`;
    const tasks = record.tasks.filter((task) => task.gameId === scope.gameId);
    const task = tasks.length === 1 ? tasks[0] : undefined;
    const progress = associatedProgress({ record });
    const planned =
      progress?.steps.filter((step) => step.gameId === scope.gameId) ?? [];
    const steps = task?.steps ?? planned;
    const validDay =
      task?.gameDay === scope.gameDay && task.finishedGameDay === scope.gameDay;
    const reliable =
      !!task &&
      validDay &&
      task.mode === "live" &&
      record.complete &&
      !record.warnings.length &&
      !!record.finishedAt &&
      Date.parse(record.finishedAt) <= Date.parse(at) &&
      Date.parse(record.finishedAt) >= Date.parse(record.startedAt ?? "");
    const expected = [
      ...new Set([...scope.skillIds, ...steps.map((step) => step.skillId)]),
    ];
    const states = expected.map((skillId) => {
      const matches = steps.filter((step) => step.skillId === skillId);
      return {
        skillId,
        status:
          matches.length === 1 && tasks.length <= 1
            ? matches[0].status
            : "unknown",
      };
    });
    const complete =
      reliable &&
      task?.status === "succeeded" &&
      scope.skillIds.some((id) => id !== "login") &&
      states.length > 1 &&
      states.every((step) => step.status === "succeeded");
    const lines = [
      heading,
      complete
        ? "今日所列任务流程已完成（仅覆盖所列原请求范围）。"
        : steps.length && steps.every((step) => step.skillId === "login")
          ? "仅有登录记录，不能确认今日日常完成。"
          : "今日日常尚未全部确认完成。",
    ];
    if (!reliable)
      lines.push(
        "日期、关联或完成证据不完整，保留未知；不据此推断今天未执行。",
      );
    // Parent-chain coverage is separate from this request's independently validated task.
    if (progress?.warnings.length)
      lines.push(
        "关联原计划是否补齐仍未确认；本段只报告所列请求，不改写原计划结果。",
      );
    for (const status of [...new Set(states.map((step) => step.status))]) {
      const labels = states
        .filter((step) => step.status === status)
        .map(
          (step) =>
            game?.skills.find((skill) => skill.id === step.skillId)?.title ??
            label(step.skillId),
        );
      lines.push(
        `${status === "succeeded" && !reliable ? "记录流程完成（尚需核对）" : (stepStatus[status] ?? "未知")}：${labels.join("、")}。`,
      );
    }
    if (states.some((step) => step.status === "skipped"))
      lines.push("跳过项不能据此视为已领取或已完成。");
    lines.push(
      `依据：${label(record.requestId)}；${agentBeijingTime(record.startedAt) ?? "时间未知"}（北京时间）。`,
    );
    return lines.join("\n");
  });
  return [
    "今日结果按账号、游戏分别核对：",
    ...sections,
    ...(incomplete ? ["本轮部分记录未能读取，未核对的范围保留未知。"] : []),
    "仅依据已采集账本；所列原请求不代表保存日常配置的全部次数均已执行，流程完成不证明所有奖励到账。缺记录是未知，不授权补跑；本轮未启动任务。",
  ]
    .join("\n\n")
    .slice(0, 8000);
}
