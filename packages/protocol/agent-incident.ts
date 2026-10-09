import type { AgentRunSummary } from "./agent";
import type { FailureEvidence } from "./fault";
export interface IncidentFault {
  requestId: string;
  runId: string;
  skillId?: string;
  code: FailureEvidence["code"];
  source: FailureEvidence["source"];
  observedAt: string;
  captureStatus: FailureEvidence["capture"]["status"];
  imageSent: false;
}

export const incidentCodes = [
  "launch-response-failed",
  "task-timeout",
  "ark-announcement",
  "foster-list-progress",
  "foster-return",
  "native-unconfirmed",
  "foster-recheck-recorded",
] as const;
export type IncidentCode = (typeof incidentCodes)[number];
export interface IncidentSignal {
  requestId: string;
  runId?: string;
  skillId?: string;
  code: IncidentCode;
  basis: "log-pattern" | "structured-record";
}
export interface AgentIncident {
  version: 1;
  environmentRevision: string;
  bundleHash: string;
  capturedAt?: string;
  source: "recorded";
  run: AgentRunSummary;
  signals: (IncidentSignal & { evidenceId: string; description: string })[];
  faults: (IncidentFault & { evidenceId: string })[];
  omittedSignals: number;
  gaps: string[];
  recoverySkills: [];
  canExecute: false;
  execution: "not-started";
}
