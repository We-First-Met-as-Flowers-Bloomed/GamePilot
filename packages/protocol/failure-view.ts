import type { FailureEvidence } from "./fault";
export interface FailureEvidenceTarget {
  requestId: string;
  runId: string;
}
export interface FailureEvidenceSummary {
  runId: string;
  gameId: string;
  skillId?: string;
  code: FailureEvidence["code"];
  source: FailureEvidence["source"];
  observedAt: string;
  captureStatus: FailureEvidence["capture"]["status"];
}
export type FailureImageView =
  | { status: "available"; image: string }
  | { status: "missing" | "not-captured" };
export const failureLabels: Record<FailureEvidence["code"], string> = {
  "skill-exception": "任务步骤异常",
  "native-completion-missing": "原生任务完成未确认",
  "foster-return-failed": "寄养后返回庭院失败",
  "foster-scan-limit": "寄养列表扫描达到上限",
  "worker-run-timeout": "执行任务超时",
  "worker-rpc-timeout": "执行器响应超时",
  "worker-native-timeout": "原生设备操作超时",
  "worker-exited": "执行器意外退出",
};
