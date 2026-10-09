/** Local review/confirmation only. These methods are never model tools. */
export interface AgentExecutionTarget {
  requestId: string;
  planHash: string;
}
export interface AgentExecutionConfirmation extends AgentExecutionTarget {
  reviewId: string;
}
export interface AgentExecutionView {
  revision: number;
  status:
    | "idle"
    | "checking"
    | "ready"
    | "blocked"
    | "starting"
    | "running"
    | "stopping"
    | "succeeded"
    | "cancelled"
    | "unknown";
  requestId?: string;
  planHash?: string;
  reviewId?: string;
  expiresAt?: string;
  batchId?: string;
  message: string;
  lanes: {
    laneId: string;
    name: string;
    instance: number;
    gameId?: string;
    games?: {
      gameId: string;
      skillIds: string[];
      parameters: Record<string, unknown>;
    }[];
    profileName: string;
    skillIds: string[];
    parameters: Record<string, unknown>;
    executionId?: string;
    status?: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  }[];
}
export const agentExecutionActive = (view: AgentExecutionView) =>
  ["checking", "starting", "running", "stopping"].includes(view.status);
