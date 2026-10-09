import type { AgentToolName, CompiledDraft, AgentRunSummary } from "./agent";
import type { AgentEventDetails } from "./agent-events";
import type { AgentRuntimeToolName } from "./agent-runtime";
export type PlannerSource = "fixture" | "configured" | "recorded";

/** Provider reported counts. Input includes cached tokens; absent counts stay absent. */
export interface PlannerUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}
export type PlannerStreamEvent =
  | { kind: "answer-delta"; text: string }
  | {
      kind: "tool-requested" | "tool-started";
      callId: string;
      tool: AgentRuntimeToolName | "submit_result";
      details?: AgentEventDetails;
    }
  | {
      kind: "tool-result";
      callId: string;
      tool: AgentRuntimeToolName | "submit_result";
      success: boolean;
      details?: AgentEventDetails;
      code?: string;
    }
  | { kind: "usage"; usage: PlannerUsage }
  | {
      kind: "attempt";
      attempt: number;
      status: "started" | "completed" | "failed" | "cancelled";
      code?: string;
    }
  | { kind: "finished" }
  | { kind: "error"; code: string; message: string };

export interface PlannerProgress {
  phase: "discovering" | "connecting" | "checking" | "thinking" | "tool";
  tool?: AgentToolName;
}
export interface PlannerResult {
  historyAssessment?: import("./agent").AgentHistoryAssessment;
  formatRepairs?: 0 | 1;
  transport?: "codex" | "compatible" | "dsh";
  status:
    | "draft"
    | "question"
    | "answer"
    | "blocked"
    | "saved-daily"
    | "saved-both-games";
  modelText: string;
  source: PlannerSource;
  execution: "not-started" | "managed-by-goal";
  goalIds?: string[];
  configurationChangedByHost?: true;
  canExecute: false;
  draft?: CompiledDraft;
  records?: AgentRunSummary[];
  incidents?: import("./agent-incident").AgentIncident[];
  trace: {
    callId: string;
    tool: AgentToolName;
    success: boolean;
    code?: string;
    planHash?: string;
  }[];
  model: string;
  codexVersion: string;
  elapsedMs: number;
}
export interface PlannerViewState {
  provider?: "codex" | "compatible";
  source?: PlannerSource;
  revision: number;
  status:
    "idle" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  requestId?: string;
  prompt?: string;
  at?: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: PlannerProgress;
  result?: PlannerResult;
  error?: { code: string; message: string };
}
export interface PlannerInput {
  source?: PlannerSource;
  prompt: string;
  at: string;
}
export const plannerActive = (state: PlannerViewState) =>
  state.status === "running" || state.status === "cancelling";
