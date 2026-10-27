import type {
  TaskRecord,
  TaskStepRecord,
} from "../packages/protocol/task-record";
import type { TaskResultSummary } from "../packages/protocol/task-result-summary";
import {
  validArknightsEvidence,
  isLegacyCopilotEvidence,
} from "./arknights/evidence";
import { historyStepStatus } from "./agent-history";
import { games } from "./registry";

const stateText = {
  pending: "等待执行",
  running: "执行中",
  succeeded: "执行流程完成",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已停止",
  unknown: "结果未知",
  "not-run": "未执行",
};

/** Receives a uniquely associated, validated record; never reads logs or combines requests. */
export function summarizeTaskResult(record: TaskRecord): TaskResultSummary {
  const counts: TaskResultSummary["counts"] = {
    completed: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    notRun: 0,
    running: 0,
    pending: 0,
    cancelled: 0,
  };
  const countKey = {
    succeeded: "completed",
    skipped: "skipped",
    failed: "failed",
    unknown: "unknown",
    "not-run": "notRun",
    running: "running",
    pending: "pending",
    cancelled: "cancelled",
  } as const;
  const issues: TaskResultSummary["issues"] = [];
  for (const step of record.steps) {
    const status = historyStepStatus(step);
    counts[countKey[status]]++;
    if (["failed", "unknown", "cancelled"].includes(status))
      issues.push({
        skillId: step.skillId,
        message: isLegacyCopilotEvidence(step.result?.arknights)
          ? "旧版作业只记录任务链结束，缺少冻结关卡、逐场三星及前后账号/主页证明；结果仍需核对。"
          : status !== step.status
            ? "原生完成状态未确认"
            : step.message,
      });
    if (["pending", "not-run"].includes(status) && step.result?.arknights)
      issues.push({
        skillId: step.skillId,
        message: "未执行状态与原生结果存在证据冲突，未展示该步骤的数量。",
      });
  }
  if (
    ["failed", "unknown", "cancelled"].includes(record.status) &&
    !issues.length
  )
    issues.push({ skillId: "$run", message: record.message });
  const summary: TaskResultSummary = {
    version: 1,
    mode: record.plan.mode,
    counts,
    items: [],
    issues,
    scopeNote:
      record.plan.mode === "rehearsal"
        ? "演练记录，未操作游戏。"
        : "仅汇总本次请求的游戏记录，不合并其他请求；后续单项成功不会改写原日常失败。",
  };
  if (record.plan.mode === "rehearsal") return summary;
  if (record.gameId !== "arknights") {
    const game = games.find((g) => g.id === record.gameId);
    summary.items = record.steps.map((step) => {
      const status = historyStepStatus(step);
      const confirmedResult = ["succeeded", "skipped"].includes(status);
      return {
        id: step.skillId,
        label:
          game?.skills.find((s) => s.id === step.skillId)?.title ??
          step.skillId,
        value:
          confirmedResult && step.result?.summary
            ? step.result.summary
            : stateText[status],
        status,
        ...(!step.result?.summary && status === "succeeded"
          ? { note: "流程已返回；未记录具体领取数量。" }
          : {}),
      };
    });
    return summary;
  }
  const find = (id: string) => record.steps.find((s) => s.skillId === id);
  const evidence = (step: TaskStepRecord, type: string) => {
    if (["pending", "not-run"].includes(step.status)) return undefined;
    const e = step.result?.arknights;
    return validArknightsEvidence(e) && e.taskType === type ? e : undefined;
  };
  const add = (
    step: TaskStepRecord,
    id: string,
    label: string,
    value: string,
    note?: string,
  ) => {
    const status = historyStepStatus(step);
    const partial = ["failed", "unknown", "cancelled"].includes(status);
    summary.items.push({
      id,
      label,
      value,
      status,
      ...(partial || note
        ? {
            note: `${partial ? "部分观测，任务未确认完成。" : ""}${note ?? ""}`,
          }
        : {}),
    });
  };
  const fight = find("fight");
  if (fight) {
    const e = evidence(fight, "Fight"),
      stats = e?.statistics?.fight;
    add(
      fight,
      "fight-runs",
      "作战次数",
      stats?.completedRunsObserved === undefined
        ? "未记录"
        : `已记录 ${stats.completedRunsObserved} 次`,
      "截至最近一次次数报告，可能未覆盖最后一批；不将末批结算相加。",
    );
    if (e?.lastSettlement) {
      const last = e.lastSettlement;
      add(
        fight,
        "fight-last",
        "最近结算",
        `${last.stage} · ${last.stars} 星${last.batchRuns === undefined ? "" : ` · 本批 ${last.batchRuns} 次`}`,
        "只表示最近一批结算，不是整轮累计。",
      );
    }
    const first = stats?.firstSanity,
      last = stats?.latestSanity;
    const delta =
      first !== undefined && last !== undefined ? last - first : undefined;
    add(
      fight,
      "sanity",
      "理智观测",
      first !== undefined && last !== undefined
        ? `${first} → ${last}`
        : last !== undefined
          ? `最近 ${last}`
          : first !== undefined
            ? `首次 ${first}`
            : "未记录",
      delta === undefined
        ? "未记录完整前后观测，不估算消耗。"
        : `净变化 ${delta > 0 ? "+" : ""}${delta}；这是首次与最近观测，不是精确消耗，也不保证为结束时余额。`,
    );
  }
  const friends = find("friends");
  if (friends) {
    const stats = evidence(friends, "Mall")?.statistics?.mall;
    const shoppingNotes = [
      "按购买与奖励确认配对计数，不代表物品数量；未记录商品名称。",
    ];
    if (stats?.discountOnlyStoppedAtCredit !== undefined)
      shoppingNotes.push(
        `原生识别结果触发仅折扣策略停止，信用观测 ${stats.discountOnlyStoppedAtCredit}；不能确认商店没有折扣商品，也不保证为最终余额。`,
      );
    if (stats?.shoppingErrorObserved)
      shoppingNotes.push(
        "购物分支报告未成功，可能为无候选或识别失败；整条任务链结束不等于购买成功。",
      );
    if (stats?.finalCredit !== undefined)
      shoppingNotes.push(
        `购物后双帧核对余额 ${stats.finalCredit}，${stats.finalCredit > 300 ? "仍超过300，需处理。" : "未超过次日保留上限。"}`,
      );
    add(
      friends,
      "shopping",
      "信用购物",
      !stats
        ? "未记录"
        : stats.purchaseConfirmations === 0
          ? "未观察到购买确认"
          : `购买确认 ${stats.purchaseConfirmations} 次`,
      shoppingNotes.join(""),
    );
  }
  const infrastructure = find("infrastructure");
  if (infrastructure) {
    const reception = evidence(infrastructure, "Infrast")?.statistics
      ?.infrastructure?.reception;
    const nodes = new Set(reception?.observedNodes ?? []);
    const operations = [
      {
        id: "message-board",
        label: "留言板状态",
        observed: nodes.has("InfrastReceptionMessageBoard-Received"),
        value: nodes.has("InfrastReceptionMessageBoard-CouldReceive")
          ? "已观察到本次收取动作及已收取状态"
          : "已观察到已收取状态",
        note: "已收取状态可能来自此前领取，不据此累计本次奖励。",
      },
      {
        id: "self-clue",
        label: "自产线索领取",
        observed: nodes.has("GetSelfClue"),
        value: "已观察到领取动作",
      },
      {
        id: "insert",
        label: "线索放入",
        observed: false,
        value: nodes.has("InfrastClueQuickInsert")
          ? "已识别快捷放入入口，结果未核验"
          : "未记录完成证据",
        note: "入口识别回调发生在实际放入之前，不能证明放入成功。",
      },
      {
        id: "send",
        label: "重复线索赠送",
        observed: nodes.has("InfrastClueQuickSendDuplicates"),
        value: "已观察到赠送动作",
      },
      {
        id: "exchange",
        label: "结束交流收尾",
        observed: nodes.has("EndOfClueExchangeClose"),
        value: "已观察到交流弹窗收尾",
        note: "弹窗收尾不等于本次奖励数量已核验。",
      },
    ];
    for (const operation of operations) {
      add(
        infrastructure,
        `reception-${operation.id}`,
        `会客室 · ${operation.label}`,
        operation.observed || operation.id === "insert"
          ? operation.value
          : "未记录完成证据",
        operation.note ??
          (operation.observed
            ? "原生动作回调，不代表奖励到账数量。"
            : "可能未启用或本轮没有可处理内容；不能仅凭基建结束推断该项完成。"),
      );
      if (!operation.observed) summary.items.at(-1)!.status = "unknown";
    }
    if (reception?.errorObserved)
      summary.issues.push({
        skillId: "infrastructure",
        message: "会客室子任务报告异常，已观察的动作保留，其余结果待核对。",
      });
  }
  const award = find("award");
  if (award) {
    const stats = evidence(award, "Award")?.statistics?.award;
    add(
      award,
      "awards",
      "任务领奖",
      !stats
        ? "未记录"
        : stats.claimActions === 0
          ? "未观察到领奖确认"
          : `领奖确认 ${stats.claimActions} 次`,
      "这是领奖按钮完成动作次数，不是物品数量，不等同全部奖励已到账。",
    );
    add(
      award,
      "mail",
      "邮件附件",
      stats?.mail === "empty"
        ? "已核对，无待领附件"
        : stats?.mail === "claim-confirmed"
          ? "已观察到领取确认"
          : "未记录核验结果",
    );
  }
  return summary;
}
