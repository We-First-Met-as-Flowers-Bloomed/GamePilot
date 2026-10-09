import type { PlannerResult } from "../../protocol/agent-planner";
export interface ExpectedGame {
  gameId: string;
  skills: string[];
  optionalSkills?: string[];
  parameters?: Record<string, unknown>;
}
export interface EvaluationCase {
  diagnostic?: {
    scenario:
      | "startup"
      | "native"
      | "foster"
      | "watchdog"
      | "legacy"
      | "mixed"
      | "incomplete"
      | "pressure";
    requests: string[];
    incidentRequests?: string[];
  };
  id: string;
  mode: "live" | "fault-injection";
  prompt: string;
  at: string;
  statuses: PlannerResult["status"][];
  lanes?: string[];
  games?: ExpectedGame[];
  tools?: string[];
  rubric: string;
}
export interface Verdict {
  status: "needs-review" | "passed" | "failed";
  failures: string[];
}
export interface Review {
  digest: string;
  reviewer: string;
  decision: "pass" | "fail";
  note: string;
}
