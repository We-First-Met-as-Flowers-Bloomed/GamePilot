import type { GoalRun, GoalSkillResult } from "../packages/protocol/agent-goal";
import { games } from "./registry";
import { onmyojiEffectLabels } from "./onmyoji/evidence";

type ResultState = "completed" | "failed" | "unknown" | "cancelled" | "pending";
export interface GoalResultReport {
  outcome: GoalRun["status"];
  counts: Record<ResultState | "total", number>;
  text: string;
}
const active = new Set([
  "preparing",
  "running",
  "waiting",
  "recovering",
  "cancelling",
]);
function evidenceTime(value: string | undefined, goal: GoalRun): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return false;
  const observed = Date.parse(value);
  return (
    Number.isFinite(observed) &&
    observed >= Date.parse(goal.createdAt) &&
    observed <= Date.parse(goal.updatedAt)
  );
}
function skillState(
  skill: GoalSkillResult | undefined,
  goal: GoalRun,
): ResultState {
  if (!skill) return active.has(goal.status) ? "pending" : "unknown";
  if (
    ["failed", "cancelled", "excluded", "not-run", "unknown"].includes(
      skill.status,
    )
  )
    return skill.status === "failed"
      ? "failed"
      : ["cancelled", "excluded"].includes(skill.status)
        ? "cancelled"
        : "unknown";
  if (
    skill.goalSatisfied === true &&
    ["succeeded", "skipped"].includes(skill.status) &&
    evidenceTime(skill.evidenceTimestamp, goal) &&
    !!skill.evidenceReference?.trim()
  )
    return "completed";
  if (["pending", "running"].includes(skill.status)) return "pending";
  return "unknown";
}

function accountLabel(laneId: string): string {
  const index = /^lane-([a-h])$/.exec(laneId)?.[1].charCodeAt(0);
  return index === undefined
    ? `账号（${laneId.replace(/[\r\n\x00-\x1f]/g, "").slice(0, 80)}）`
    : `账号${["一", "二", "三", "四", "五", "六", "七", "八"][index - 97]}`;
}

/** A completed flow alone does not distinguish a claim from an empty reward page. */
function completedDetail(
  skill: GoalSkillResult,
  gameId: string,
  goal: GoalRun,
): string {
  if (gameId === "onmyoji" && skill.skillId === "login")
    return (
      (skill.evidenceReference === "onmyoji:login:two-frames"
        ? "已确认进入游戏"
        : "登录步骤已核验完成") + "；当前角色身份未作独立核验"
    );
  if (gameId === "onmyoji" && ["mail", "hana-claim"].includes(skill.skillId)) {
    const mail = skill.skillId === "mail";
    const effect =
      skill.effectEvidence?.length === 1 ? skill.effectEvidence[0] : undefined;
    const verified =
      effect &&
      effect.kind === (mail ? "mail-claim" : "hana-claim") &&
      effect.evidenceReference === `onmyoji:${skill.skillId}:effect:1` &&
      evidenceTime(effect.observedAt, goal) &&
      Date.parse(effect.observedAt) <= Date.parse(skill.evidenceTimestamp!);
    if (
      verified &&
      skill.status === "succeeded" &&
      skill.skipReason === undefined &&
      skill.evidenceReference ===
        (mail
          ? "onmyoji:mail:reward-and-empty-mailbox"
          : "onmyoji:hana-claim:verified-no-pending-reward")
    )
      return mail
        ? "本次已领取邮件附件，已核对无剩余待领取附件"
        : "本次已领取花合战奖励，已核对无剩余待领取奖励";
    if (
      verified &&
      skill.status === "skipped" &&
      skill.skipReason === "nothing-to-claim" &&
      skill.evidenceReference ===
        (mail
          ? "onmyoji:mail:verified-empty"
          : "onmyoji:hana-claim:verified-no-pending-reward")
    )
      return mail
        ? "本次检查无待领取附件，未执行领取"
        : "本次检查无待领取奖励，未执行领取";
    return "步骤已核验完成；本次具体领取情况未单独确认";
  }
  if (skill.status === "skipped") {
    if (skill.skipReason === "already-completed")
      return "已核对此前完成，本次跳过";
    if (skill.skipReason === "not-open") return "本时段未开放，已跳过";
    return "已核验跳过";
  }
  return "已核验完成";
}

/** Public conclusions are reconstructed from accepted original-scope facts, never model prose. */
export function goalResultReport(goal: GoalRun): GoalResultReport {
  const latest = new Map<string, string>();
  for (const attempt of goal.attempts) {
    for (const scope of attempt.review.scopes) {
      const id = `${attempt.submission.batchId}:${scope.laneId}`;
      if (attempt.submission.requestIds.includes(id))
        latest.set(scope.laneId, id);
    }
  }
  const scopes = goal.originalReview?.scopes ?? goal.grant.scopes;
  const counts: GoalResultReport["counts"] = {
    total: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
    cancelled: 0,
    pending: 0,
  };
  const issues: string[] = [],
    effects: string[] = [],
    completed: string[] = [];
  for (const scope of scopes) {
    const request = goal.requests.find(
      (r) =>
        r.requestId === latest.get(scope.laneId) && r.laneId === scope.laneId,
    );
    const game = games.find((g) => g.id === scope.gameId);
    for (const skillId of scope.skillIds) {
      const matches =
        request?.skills.filter(
          (s) =>
            s.skillId === skillId &&
            (s.gameId ?? request.gameId) === scope.gameId,
        ) ?? [];
      const skill = matches.length === 1 ? matches[0] : undefined;
      const state = skillState(skill, goal);
      counts.total++;
      counts[state]++;
      const label = `${accountLabel(scope.laneId)} · ${game?.name ?? "所选游戏"} · ${game?.skills.find((s) => s.id === skillId)?.title ?? "所选任务"}`;
      if (state === "completed" && skill)
        completed.push(
          `${label}：${completedDetail(skill, scope.gameId, goal)}`,
        );
      if (["failed", "unknown", "cancelled"].includes(state))
        issues.push(
          `${label}：${state === "failed" ? "失败" : state === "cancelled" ? "已取消或未选续跑" : "未确认"}`,
        );
      for (const effect of skill?.effectEvidence ?? []) {
        const observedLabel =
          scope.gameId === "onmyoji" &&
          Object.hasOwn(onmyojiEffectLabels, effect.kind)
            ? onmyojiEffectLabels[
                effect.kind as keyof typeof onmyojiEffectLabels
              ]
            : undefined;
        if (
          observedLabel &&
          evidenceTime(effect.observedAt, goal) &&
          effect.evidenceReference?.trim()
        )
          effects.push(`${label}：${observedLabel}`);
      }
    }
  }
  const required = [...latest.values()].map((id) =>
    goal.requests.find((r) => r.requestId === id),
  );
  const complete =
    counts.total > 0 &&
    counts.completed === counts.total &&
    goal.status === "completed" &&
    goal.goalSatisfied === true &&
    goal.flowComplete &&
    required.length > 0 &&
    required.every(
      (r) =>
        r?.status === "succeeded" && r.goalSatisfied === true && r.flowComplete,
    );
  const acceptedIds = new Set(
    goal.attempts.flatMap((attempt) => attempt.submission.requestIds),
  );
  const stop = goal.stopVerification;
  const stopped =
    acceptedIds.size === 0 ||
    (!!stop?.verified &&
      evidenceTime(stop.observedAt, goal) &&
      !!stop.evidenceReference?.trim() &&
      stop.requestIds.length === acceptedIds.size &&
      new Set(stop.requestIds).size === acceptedIds.size &&
      stop.requestIds.every((id) => acceptedIds.has(id))) ||
    [...acceptedIds].every((id) =>
      goal.requests.some(
        (r) => r.requestId === id && !["running", "unknown"].includes(r.status),
      ),
    );
  const outcome =
    (goal.status === "completed" && !complete) ||
    (goal.status === "cancelled" && !stopped)
      ? "unknown"
      : goal.status;
  let text: string;
  if (complete)
    text = `宿主根据实际结果核验：本次交办的 ${counts.total} 项任务已核验完成。`;
  else if (active.has(outcome))
    text =
      outcome === "cancelling"
        ? "停止请求已发出，等待执行器确认；当前还不能认定已停止。"
        : latest.size
          ? "任务已受理，正在等待实际执行与结果核验。"
          : "任务正在检查执行条件，尚未确认受理。";
  else if (outcome === "cancelled")
    text = "任务已停止或取消，本次交办未完整完成。";
  else if (outcome === "needs-user" || outcome === "failed")
    text = "任务需要处理，本次交办未完整完成。";
  else
    text =
      goal.status === "cancelled" && !stopped
        ? "停止结果未确认，不能认定执行器已经停止。"
        : "结果未完整确认，不会据此重复提交任务。";
  if (!complete)
    text += `\n已核验完成 ${counts.completed}/${counts.total} 项；失败 ${counts.failed} 项，未确认 ${counts.unknown} 项，取消 ${counts.cancelled} 项，待执行 ${counts.pending} 项。`;
  if (completed.length) {
    text += "\n" + completed.slice(0, 32).join("\n");
    if (completed.length > 32)
      text += `\n另有 ${completed.length - 32} 项已核验明细，请查看任务详情。`;
  }
  if (issues.length) text += "\n" + issues.slice(0, 8).join("\n");
  if (effects.length && !complete)
    text +=
      "\n业务效果已确认（流程仍未完成）：\n" +
      [...new Set(effects)].slice(0, 8).join("\n") +
      "\n不能据此重复领取或提交。";
  if (outcome === "needs-user" || outcome === "failed")
    text +=
      "\n请查看任务详情中的失败画面和处理入口。已完成进度保留；仅在允许续跑时继续剩余任务。";
  if (goal.selection.kind === "continuation") {
    const accounts =
      goal.originalReview?.summary.map((row) => row.laneName).join("、") ||
      "所选账号";
    text += `\n本次只接管 ${accounts} 的原日常剩余任务；其他账号的原记录保留，未在本次启动或核验。`;
  }
  return { outcome, counts, text: text.slice(0, 8000) };
}
