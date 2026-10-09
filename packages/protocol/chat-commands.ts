export interface ChatCommandSummary {
  laneName: string;
  games: { gameId: string; title: string; steps: string[] }[];
}
export interface ChatCommandView {
  reviewId: string;
  sessionId: string;
  revision: number;
  kind: "saved-daily" | "continue";
  text: string;
  parentId?: string;
  /** Host-owned link to the current model turn; never supplied as a command override. */
  origin?: { turnId: string; plannerRequestId: string };
  createdAt: string;
  expiresAt: string;
  status: "review" | "submitted" | "blocked" | "unknown";
  fingerprint: string;
  sessionContext?: string;
  needsAcknowledgement?: boolean;
  summary: ChatCommandSummary[];
  confirmedRevision?: number;
  receipt?: { batchId: string; requestIds: string[] };
  message?: string;
}
export interface ChatCommandReviewInput {
  sessionId: string;
  text: string;
  requestId?: string;
}
export interface ChatIntentReviewInput {
  sessionId: string;
  turnId: string;
  requestId: string;
}
export interface ChatCommandConfirmation {
  sessionId: string;
  reviewId: string;
  revision: number;
  acknowledgePartial?: boolean;
}
export interface ChatCommandStore {
  version: 1;
  entries: ChatCommandView[];
}
