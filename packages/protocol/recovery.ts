import type { Plan } from "./index";
import type { ExecutionRecord } from "./execution";
import type { StepStatus, TaskRecord } from "./task-record";
import {
  previewArknightsResume,
  type ArknightsResumePreview,
} from "../../games/arknights/recovery";

export interface RecoveryGame {
  gameId: string;
  mode: Plan["mode"];
  runId?: string;
  steps: {
    skillId: string;
    status: StepStatus | "unrecorded";
    message: string;
  }[];
}
export interface RecoveryAssessment {
  resumePreview?: ArknightsResumePreview;
  requestId: string;
  canResume: false;
  reasons: string[];
  games: RecoveryGame[];
}
export interface DeviceInspection {
  observedAt: string;
  address: string;
  foregroundPackage?: string;
  /**
   * 这张截图所属的逻辑显示号（2026-10-16 加）。
   *
   * MuMu 15 是**多标签/多显示**形态：桌面在 display 0、阴阳师在 2、方舟在 3，
   * 而 `adb shell input` 默认只打 display 0 —— 不带上它，点击会落在桌面上
   * （"识别得到主页、却打不开个人名片"就是这么来的）。读取时带上它，
   * 点击时用 `input -d <displayId>` 回到同一块显示。
   */
  displayId?: number;
  image: string;
  accountVerified: boolean;
  pageVerified: boolean;
  arknights?: import("../../games/arknights/inspection").ArknightsInspection;
  recognitionError?: string;
}
function isPlan(value: unknown): value is Plan {
  const plan = value as Plan | undefined;
  return (
    !!plan &&
    typeof plan.gameId === "string" &&
    ["live", "rehearsal"].includes(plan.mode) &&
    Array.isArray(plan.skillIds) &&
    plan.skillIds.length > 0 &&
    plan.skillIds.every((s) => typeof s === "string")
  );
}
export function assessExecution(
  record: ExecutionRecord,
  tasks: TaskRecord[],
  appVersion: string,
  now = new Date(),
): RecoveryAssessment {
  const reasons: string[] = [];
  if (record.status === "running") reasons.push("请求尚未结束，请先停止任务");
  if (record.resolution) reasons.push("本次待处理事项已结束，原始结果保持不变");
  if (record.snapshot.appVersion !== appVersion)
    reasons.push("应用版本与原请求不同，不能直接沿用旧执行现场");
  const plans = [
    record.snapshot.plan,
    record.snapshot.arknightsPlan,
    record.snapshot.onmyojiPlan,
  ].filter(isPlan);
  if (!plans.length) reasons.push("原始执行计划缺失或格式不完整");
  const games = plans.map((plan) => {
    const candidates = tasks.filter(
      (t) =>
        t.executionId === record.id &&
        t.laneId === record.laneId &&
        t.batchId === record.batchId &&
        t.gameId === plan.gameId,
    );
    const task =
      candidates.length === 1 &&
      candidates[0]!.plan.mode === plan.mode &&
      JSON.stringify(candidates[0]!.plan.skillIds) ===
        JSON.stringify(plan.skillIds)
        ? candidates[0]
        : undefined;
    if (!task)
      reasons.push(
        `${plan.gameId} 缺少唯一、可靠关联的步骤记录；不能据此认定尚未开始`,
      );
    if (
      task?.steps.some(
        (s) => !["succeeded", "skipped", "not-run"].includes(s.status),
      )
    )
      reasons.push(`${plan.gameId} 存在未确认结果的步骤，需要核对现场`);
    return {
      gameId: plan.gameId,
      mode: plan.mode,
      runId: task?.runId,
      steps: plan.skillIds.map((skillId) => {
        const step = task?.steps.find((s) => s.skillId === skillId);
        return {
          skillId,
          status: step?.status ?? ("unrecorded" as const),
          message: step?.message ?? "缺少可靠记录，是否执行过尚不确定",
        };
      }),
    };
  });
  reasons.push(
    "现场核对不会自动执行；请通过‘继续未完成任务’重新检查账号和设备绑定",
  );
  reasons.push(
    "原请求保留原始结果；续跑将创建关联的新请求，重新登录核验后执行所选步骤",
  );
  const ark = games.find((g) => g.gameId === "arknights");
  const resumePreview = ark
    ? previewArknightsResume(
        record,
        ark.runId
          ? tasks.find(
              (t) =>
                t.runId === ark.runId &&
                t.executionId === record.id &&
                t.laneId === record.laneId &&
                t.batchId === record.batchId,
            )
          : undefined,
        appVersion,
        now,
      )
    : undefined;
  return {
    requestId: record.id,
    canResume: false,
    reasons,
    games,
    ...(resumePreview ? { resumePreview } : {}),
  };
}
