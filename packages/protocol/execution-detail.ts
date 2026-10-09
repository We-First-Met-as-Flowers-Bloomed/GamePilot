import type { Plan } from "./index";
import type { ExecutionRecord } from "./execution";
import type { TaskRecord } from "./task-record";
import type { TaskResultSummary } from "./task-result-summary";

/** Read-only projection of a persisted request and its uniquely associated runs. */
export interface ExecutionDetail {
  request: Pick<
    ExecutionRecord,
    | "id"
    | "source"
    | "status"
    | "startedAt"
    | "finishedAt"
    | "message"
    | "resolution"
    | "laneId"
    | "batchId"
  > & {
    laneName?: string;
    instance?: number;
    profileName?: string;
    agentRequestId?: string;
    continuation?: import("./continuation").ContinuationLink;
  };
  games: {
    plan: Plan;
    record?: TaskRecord;
    summary?: TaskResultSummary;
    issue?: string;
  }[];
  warnings: string[];
}
