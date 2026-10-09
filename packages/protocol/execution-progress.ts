import type { ExecutionStatus } from "./execution";
import type { StepStatus } from "./task-record";

/** Read-only original-plan coverage, never an execution permission or a rewritten result. */
export interface ExecutionProgress {
  version: 1;
  requestId: string;
  rootId: string;
  latestId: string;
  laneId?: string;
  source: "daily" | "single" | "maintenance";
  originalStatus: ExecutionStatus;
  outcome:
    | "complete"
    | "recovered"
    | "partial"
    | "running"
    | "incomplete"
    | "unconfirmed";
  wholePlanComplete: boolean;
  startedAt: string;
  requests: {
    id: string;
    status: ExecutionStatus;
    startedAt: string;
    finishedAt?: string;
    appVersion?: string;
  }[];
  steps: {
    gameId: string;
    skillId: string;
    status: StepStatus | "excluded";
    sourceId: string;
    continued: boolean;
  }[];
  counts: {
    total: number;
    completed: number;
    skipped: number;
    excluded: number;
    remaining: number;
  };
  warnings: string[];
}
