import type { PlannerSource, PlannerViewState } from "./agent-planner";

export interface ChatTurn {
  id: string;
  prompt: string;
  source: PlannerSource;
  at: string;
  createdAt: string;
  /** Historical display only; execution always checks the current live planner. */
  planner: PlannerViewState;
}
export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: ChatTurn[];
  summary?: ChatSessionSummary;
}
export interface ChatSessionSummary {
  version: 1;
  scope: "historical-tools-only";
  currentState: "unknown";
  canAuthorizeExecution: false;
  objectives: {
    turnId: string;
    source: PlannerSource;
    at: string;
    text: string;
    truncated: boolean;
  }[];
  facts: {
    turnId: string;
    source: PlannerSource;
    at: string;
    kind: "recorded-run" | "compiled-draft";
    originTool: "get_run" | "get_incident" | "compile_plan";
    requestId?: string;
    recordedStatus?: string;
    recordedConclusion?: string;
    inGameCompletion?: "not-verified";
    wholePlanComplete?: boolean;
    outcome?: string;
    planHash?: string;
    catalogRevision?: string;
    environmentRevision?: string;
  }[];
}
export interface ChatArchivedSession {
  version: 1;
  id: string;
  archivedAt: string;
  session: ChatSession;
}
export interface ChatArchiveEntry {
  version: 1;
  id: string;
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string;
  turnCount: number;
  sources: PlannerSource[];
}
export interface ChatArchiveInput {
  sessionId: string;
}
export interface ChatArchivePageInput {
  cursor?: string;
  limit?: number;
}
export interface ChatArchiveLoadInput extends ChatArchivePageInput {
  archiveId: string;
}
export interface ChatArchivePage {
  entries: ChatArchiveEntry[];
  nextCursor?: string;
  scope: "historical-only";
  canExecute: false;
}
export interface ChatArchiveTurnsPage {
  archive: ChatArchiveEntry;
  session: Omit<ChatSession, "turns">;
  turns: ChatTurn[];
  nextCursor?: string;
  scope: "historical-only";
  canExecute: false;
}
export interface ChatView {
  revision: number;
  selectedSessionId?: string;
  sessions: ChatSession[];
  error?: string;
}
export interface ChatInput {
  sessionId: string;
  prompt: string;
  source: PlannerSource;
  at: string;
}
export interface ChatTurnTarget {
  sessionId: string;
  turnId: string;
}
