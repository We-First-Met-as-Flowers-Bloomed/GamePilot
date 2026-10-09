import type { ExecutionRecord } from "../../packages/protocol/execution";
import {
  validateTaskRecord,
  type TaskRecord,
} from "../../packages/protocol/task-record";
import {
  taskFor,
  validateArknightsConfig,
  type ArknightsConfig,
} from "./config";
import { validArknightsEvidence } from "./evidence";
import { arknightsGameDay } from "./result-policy";

export interface ArknightsResumePreview {
  state: "blocked" | "needs-inspection";
  retained: string[];
  candidates: string[];
  blocked: string[];
  reasons: string[];
}
/** A proposal only. It grants no device lease, skips no steps and starts no task. */
export function previewArknightsResume(
  record: ExecutionRecord,
  task: TaskRecord | undefined,
  appVersion: string,
  now: Date,
): ArknightsResumePreview {
  const preview: ArknightsResumePreview = {
    state: "blocked",
    retained: [],
    candidates: [],
    blocked: [],
    reasons: [],
  };
  const reasons = preview.reasons;
  if (
    record.source !== "single" ||
    record.snapshot.onmyojiPlan ||
    record.snapshot.arknightsPlan
  )
    reasons.push("首版预检只支持独立明日方舟日常请求，双游戏交接尚未适配");
  if (record.status !== "failed" && record.status !== "cancelled")
    reasons.push(
      "仅明确结束的失败或取消请求可预检；进程中断或结果未知不能续跑",
    );
  if (record.resolution) reasons.push("此请求已结束处理");
  if (record.snapshot.appVersion !== appVersion)
    reasons.push("应用版本变化，原证据不能直接用于续跑");
  let config: ArknightsConfig | undefined;
  try {
    config = validateArknightsConfig(record.snapshot.arknights);
    if (!config.expectedUid) reasons.push("原请求尚未绑定核验 UID");
  } catch {
    reasons.push("原请求的明日方舟配置不完整");
  }
  if (!task) {
    reasons.push("没有唯一关联的明日方舟步骤账本");
    return preview;
  }
  try {
    validateTaskRecord(task);
  } catch {
    reasons.push("步骤证据格式无效");
    return preview;
  }
  if (
    !["failed", "cancelled"].includes(task.status) ||
    task.plan.mode !== "live"
  )
    reasons.push("步骤账本不是已明确结束的实机失败/取消记录");
  if (arknightsGameDay(new Date(task.startedAt)) !== arknightsGameDay(now))
    reasons.push("已经跨游戏日，不能沿用原日常进度");
  if (task.plan.skillIds[0] !== "login")
    reasons.push("原计划缺少首步登录与身份核验");
  let suffix = false;
  for (const step of task.steps) {
    const evidence = step.result?.arknights;
    const known = [
      "login",
      "fight",
      "recruit",
      "infrastructure",
      "friends",
      "award",
    ].includes(step.skillId);
    let nativeType: string | undefined;
    try {
      nativeType =
        config && known ? taskFor(step.skillId, config).type : undefined;
    } catch {
      preview.blocked.push(step.skillId);
      reasons.push("原请求的技能参数无法通过当前校验");
      continue;
    }
    const within = (at: string) =>
      Boolean(
        step.startedAt &&
        step.finishedAt &&
        Date.parse(at) >= Date.parse(step.startedAt) &&
        Date.parse(at) <= Date.parse(step.finishedAt),
      );
    const valid =
      validArknightsEvidence(evidence) &&
      evidence.taskType === nativeType &&
      within(evidence.observedAt);
    if (!known) {
      preview.blocked.push(step.skillId);
      continue;
    }
    if (
      step.status === "succeeded" &&
      valid &&
      evidence.completion === "native-confirmed"
    ) {
      if (suffix) {
        reasons.push("步骤顺序不是已结束前缀与未提交后缀，不能拼接续跑");
        preview.blocked.push(step.skillId);
        continue;
      }
      if (
        step.skillId === "login" &&
        (!evidence.login ||
          evidence.login.expectedUid !== config?.expectedUid ||
          !within(evidence.login.observedAt))
      ) {
        preview.blocked.push(step.skillId);
        continue;
      }
      preview.retained.push(step.skillId);
    } else if (
      (step.status === "not-run" && !step.startedAt && !step.result) ||
      (["failed", "cancelled"].includes(step.status) &&
        valid &&
        evidence.submission === "not-submitted" &&
        evidence.completion === "not-started")
    ) {
      suffix = true;
      preview.candidates.push(step.skillId);
    } else {
      suffix = true;
      preview.blocked.push(step.skillId);
    }
  }
  if (preview.blocked.length)
    reasons.push("存在缺少可信完成证据或已提交但结果未知的步骤，禁止重做");
  if (!preview.candidates.length) reasons.push("没有明确未执行的剩余步骤");
  if (!reasons.length) preview.state = "needs-inspection";
  return preview;
}
