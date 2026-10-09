export type IncidentScreen =
  | "network-error"
  | "client-update-required"
  | "sdk-login"
  | "phone-login"
  | "verification-code"
  | "identity-input"
  | "payment"
  | "unknown-confirmation"
  | "onmyoji-courtyard"
  | "onmyoji-courtyard-reward"
  | "onmyoji-chore-reward"
  | "onmyoji-sign-reward"
  | "onmyoji-mailbox"
  | "onmyoji-mail-reward"
  | "onmyoji-illustration-reward"
  | "onmyoji-shop"
  | "onmyoji-gift-house"
  | "onmyoji-daily-gift-list"
  | "onmyoji-gift-reward"
  | "onmyoji-hana-promotion"
  | "home"
  | "profile"
  | "friends-list"
  | "credit-shop"
  | "unknown"
  | "missing"
  | "unavailable";
export const incidentScreenLabels: Record<IncidentScreen, string> = {
  "network-error": "识别到网络异常提示",
  "client-update-required":
    "失败截图显示明日方舟客户端版本过时，需要更新客户端",
  "sdk-login": "B服SDK账号登录，需要你完成身份输入",
  "phone-login": "B服SDK手机登录，需要你完成身份输入",
  "verification-code": "登录验证码或安全验证，需要你处理",
  "identity-input": "账号、密码或实名输入，需要你处理",
  payment: "付款或资源消耗确认，已停止",
  "unknown-confirmation": "未识别的确认或战斗恢复弹窗，已停止",
  "onmyoji-courtyard": "识别到阴阳师庭院；角色身份未核验",
  "onmyoji-courtyard-reward": "识别到阴阳师庭院奖励",
  "onmyoji-chore-reward": "识别到庭院事务奖励；领取效果另行核验",
  "onmyoji-sign-reward": "识别到每日一签卷轴",
  "onmyoji-mailbox": "识别到阴阳师邮箱",
  "onmyoji-mail-reward": "识别到邮件奖励",
  "onmyoji-illustration-reward": "识别到插画奖励",
  "onmyoji-shop": "识别到阴阳师商店；未授权购买",
  "onmyoji-gift-house": "识别到礼包屋；领取效果另行核验",
  "onmyoji-daily-gift-list": "识别到每日礼包列表；领取效果另行核验",
  "onmyoji-gift-reward": "识别到每日礼包奖励",
  "onmyoji-hana-promotion": "识别到花合战月度宣传页",
  home: "识别到主页",
  profile: "识别到个人名片",
  "friends-list": "识别到好友列表",
  "credit-shop": "识别到信用商店",
  unknown: "页面未确认",
  missing: "截图已缺失",
  unavailable: "截图识别不可用",
};
export interface IncidentScreenEvidence {
  id: string;
  runId: string;
  gameId: string;
  observedAt: string;
  page: IncidentScreen;
  imageSent: false;
}
export interface IncidentDiagnosis {
  summary: string;
  basis: string[];
  action: "retry-remaining" | "manual";
}
/** A host-created proposal for the existing bounded worker tool, never model coordinates. */
export interface IncidentRecoveryAction {
  kind: "return-arknights-home";
  gameId: "arknights";
  runId: string;
  fromPage: "home" | "profile" | "friends-list" | "credit-shop";
}
export interface IncidentRecoveryVerification {
  verified: true;
  observedAt: string;
  evidenceRefs: string[];
}
/** Facts from the associated execution ledger, never inferred from model text. */
export interface IncidentSuccessorResult {
  outcome: "succeeded" | "failed" | "unknown" | "cancelled" | "partial";
  wholePlanComplete: boolean;
  summary: string;
  evidenceRefs: string[];
}
export function validIncidentSuccessorResult(
  input: unknown,
): input is IncidentSuccessorResult {
  const result = input as IncidentSuccessorResult | undefined;
  return Boolean(
    result &&
    ["succeeded", "failed", "unknown", "cancelled", "partial"].includes(
      result.outcome,
    ) &&
    typeof result.wholePlanComplete === "boolean" &&
    typeof result.summary === "string" &&
    result.summary.trim() &&
    result.summary.length <= 3800 &&
    Array.isArray(result.evidenceRefs) &&
    result.evidenceRefs.length > 0 &&
    result.evidenceRefs.length <= 64 &&
    result.evidenceRefs.every(
      (ref) => typeof ref === "string" && ref.length > 0 && ref.length <= 200,
    ),
  );
}
export function incidentResultStatus(
  result: IncidentSuccessorResult,
): IncidentAgentEvent["status"] {
  return result.outcome === "succeeded"
    ? result.wholePlanComplete
      ? "succeeded"
      : "partial"
    : result.outcome;
}
export interface IncidentAgentEvent {
  seq: number;
  at: string;
  kind:
    | "queue"
    | "evidence"
    | "model"
    | "diagnosis"
    | "check"
    | "recovery"
    | "resume"
    | "result"
    | "correction"
    | "cancel"
    | "error";
  status:
    | "running"
    | "succeeded"
    | "blocked"
    | "failed"
    | "unknown"
    | "cancelled"
    | "partial";
  text: string;
  result?: IncidentSuccessorResult;
}
export interface IncidentAgentSession {
  requestId: string;
  status:
    "queued" | "running" | "awaiting-user" | "resumed" | "cancelled" | "failed";
  startedAt: string;
  updatedAt: string;
  automatic: boolean;
  events: IncidentAgentEvent[];
  screens?: IncidentScreenEvidence[];
  diagnosis?: IncidentDiagnosis;
  successorId?: string;
  feedback?: string;
  error?: string;
  model?: string;
  remaining?: import("./continuation").ContinuationSelection[];
  recovery?: IncidentRecoveryAction;
}
export interface IncidentAgentInput {
  requestId: string;
  feedback?: string;
}
export interface IncidentAgentView {
  sessions: IncidentAgentSession[];
  error?: string;
}
