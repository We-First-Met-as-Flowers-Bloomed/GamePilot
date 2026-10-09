import type { StepStatus } from "./task-record";

/** Read-only presentation facts for one validated game run, never an execution grant. */
export interface TaskResultSummary {
  version: 1;
  mode: "live" | "rehearsal";
  counts: {
    completed: number;
    skipped: number;
    failed: number;
    unknown: number;
    notRun: number;
    running: number;
    pending: number;
    cancelled: number;
  };
  items: {
    id: string;
    label: string;
    value: string;
    note?: string;
    status?: StepStatus;
  }[];
  issues: { skillId: string; message: string }[];
  scopeNote: string;
}
