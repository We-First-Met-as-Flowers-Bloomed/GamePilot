import type { ChatCommandSummary } from "./chat-commands";

/** A model reply, admission receipt and verified game outcome are separate facts. */
export type GoalStatus =
  | "preparing"
  | "running"
  | "waiting"
  | "recovering"
  | "needs-user"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "unknown";
export interface GoalOwner {
  sessionId: string;
  turnId?: string;
}
export interface GoalScope {
  laneId: string;
  gameId: string;
  skillIds: string[];
  /** Maximum permitted consumption. A missing resource never authorizes spending. */
  resources: Record<string, number>;
}
/** New grants require a reviewed local confirmation or a configured policy. */
export interface GoalExecutionGrant {
  id: string;
  source: "user-message" | "saved-policy" | "local-confirmation";
  planHash?: string;
  sessionId: string;
  turnId: string;
  issuedAt: string;
  expiresAt: string;
  maxRetries: 0 | 1 | 2;
  scopes: GoalScope[];
  policyId?: string;
  revokedAt?: string;
}
export interface GoalSelection {
  kind: "saved-daily" | "custom" | "continuation";
  dailyScope?: "saved" | "both";
  laneIds?: string[];
  plannerRequestId?: string;
  planHash?: string;
  parentRequestId?: string;
  parentFingerprint?: string;
}
export interface GoalFrozenPlanReference {
  kind: "saved-daily" | "custom" | "continuation";
  hash: string;
  plannerRequestId?: string;
  parentRequestId?: string;
}
export interface GoalReview {
  id: string;
  fingerprint: string;
  reviewedAt: string;
  expiresAt: string;
  frozenPlan: GoalFrozenPlanReference;
  scopes: GoalScope[];
  summary: ChatCommandSummary[];
}
export interface GoalReceipt {
  batchId: string;
  requestIds: string[];
}
export interface GoalSubmission extends GoalReceipt {
  attempt: number;
  acceptedAt: string;
  /** A consumed admission marker is saved before the host may operate a device. */
  state: "accepted" | "received" | "unknown";
  parentRequestId?: string;
}
export interface GoalSkillResult {
  skillId: string;
  gameId?: string;
  status: string;
  goalSatisfied: boolean | null;
  skipReason?: string;
  evidenceTimestamp?: string;
  evidenceReference?: string;
  summary: string;
  /** Validated business effects; these never imply that navigation/the whole flow completed. */
  effectEvidence?: {
    kind: string;
    observedAt: string;
    evidenceReference: string;
    summary: string;
  }[];
}
export interface GoalRequestResult {
  requestId: string;
  /** A continuation projection uses the actual latest leaf ID and preserves its root facts. */
  rootRequestId?: string;
  originalStatus?: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  laneId?: string;
  gameId?: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  flowComplete: boolean;
  goalSatisfied: boolean | null;
  skills: GoalSkillResult[];
}
/** Host-registered continuation only; arbitrary model text cannot become a retry. */
export interface GoalRecoveryReference extends GoalScope {
  requestId: string;
  reference: string;
  /** Remaining plans on the same original device, proven by the same failure boundary. */
  remainingScopes?: GoalScope[];
  safety: {
    kind: "native-not-submitted" | "bounded-navigation";
    fingerprint: string;
    observedAt: string;
    nativeSubmission: "not-submitted" | "known";
    /** Configured account bindings alone never mean the current UID was observed. */
    accountProof: "verified-current" | "login-gate-before-effects";
  };
}
export interface GoalObservation {
  requests: GoalRequestResult[];
  flowComplete: boolean;
  goalSatisfied: boolean | null;
  summary: string;
  recovery?: GoalRecoveryReference;
  /** Fresh host proof of worker exit; never rewrites a native operation's unknown outcome. */
  stopVerification?: GoalStopVerification;
}
export interface GoalStopVerification {
  verified: true;
  requestIds: string[];
  observedAt: string;
  evidenceReference: string;
}
export interface GoalAttempt {
  review: GoalReview;
  submission: GoalSubmission;
  receipt?: GoalReceipt;
}
export interface GoalRun {
  version: 1;
  id: string;
  revision: number;
  sessionId: string;
  turnId: string;
  /** Public original intent. Provider credentials and raw system prompts are excluded. */
  prompt: string;
  selection: GoalSelection;
  grant: GoalExecutionGrant;
  createdAt: string;
  updatedAt: string;
  status: GoalStatus;
  message: string;
  waitingReason?: string;
  originalReview?: GoalReview;
  review?: GoalReview;
  submission?: GoalSubmission;
  receipt?: GoalReceipt;
  attempts: GoalAttempt[];
  retryCount: number;
  requests: GoalRequestResult[];
  flowComplete: boolean;
  goalSatisfied: boolean | null;
  recovery?: GoalRecoveryReference;
  stopVerification?: GoalStopVerification;
  cancelledAt?: string;
  resultNotification?: {
    revision: number;
    state: "pending" | "delivering" | "delivered";
  };
  publicReply?: { text: string; at: string; model?: string };
}
export interface GoalStore {
  version: 1;
  revision: number;
  goals: GoalRun[];
  preferences?: GoalPreferences;
}
export interface GoalView {
  revision: number;
  goals: GoalRun[];
  error?: string;
  preferences?: GoalPreferences;
}
export interface GoalCreateInput {
  sessionId: string;
  turnId: string;
  prompt: string;
  selection: GoalSelection;
  grant: GoalExecutionGrant;
}
/** Structured preferences are facts, never an execution grant. */
export interface GoalPreferences {
  version: 1;
  revision: number;
  resourceLimits: Record<string, number>;
  excludedSkills: { gameId: string; skillIds: string[] }[];
}
export const goalExecutionTerminal = (goal: Pick<GoalRun, "status">) =>
  ["needs-user", "completed", "failed", "cancelled", "unknown"].includes(
    goal.status,
  );
