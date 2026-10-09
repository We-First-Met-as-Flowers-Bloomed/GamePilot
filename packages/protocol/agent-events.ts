import type { PlannerUsage } from "./agent-planner";
import { agentDate } from "./agent";

export type AgentEventKind =
  | "intent"
  | "planner-state"
  | "tool-requested"
  | "tool-started"
  | "tool-result"
  | "model-attempt"
  | "model-usage"
  | "model-finished"
  | "model-error"
  | "game-step"
  | "game-result"
  | "correction"
  | "command"
  | "recovery";
/** Public JSON summaries, never raw skill bodies, provider errors or credentials. */
export interface AgentEventDetails {
  arguments?: string;
  result?: string;
  durationMs?: number;
}
export const maxAgentDetailLength = 4000;
const detailFields = new Set([
  "version",
  "revision",
  "source",
  "complete",
  "capturedAt",
  "catalogRevision",
  "environmentRevision",
  "compilerVersion",
  "skillRevision",
  "planHash",
  "at",
  "laneId",
  "lanes",
  "id",
  "instance",
  "enabled",
  "games",
  "gameId",
  "gameIds",
  "skillId",
  "skillIds",
  "skills",
  "entries",
  "permissions",
  "canExecute",
  "deviceControl",
  "externalLoading",
  "parameters",
  "stage",
  "mail",
  "medicine",
  "stone",
  "expiringMedicine",
  "count",
  "directoryRevision",
  "bundleHash",
  "run",
  "requestId",
  "requestSource",
  "recordedStatus",
  "recordedConclusion",
  "startedAt",
  "finishedAt",
  "recordedTime",
  "timeZone",
  "inGameCompletion",
  "tasks",
  "runId",
  "gameDay",
  "finishedGameDay",
  "mode",
  "status",
  "steps",
  "recordedProgress",
  "rootId",
  "latestId",
  "outcome",
  "wholePlanComplete",
  "resolution",
  "action",
  "observedAt",
  "currentIdentity",
  "recordedLogin",
  "signals",
  "faults",
  "code",
  "basis",
  "evidenceId",
  "captureStatus",
  "imageSent",
  "omittedSignals",
  "recoverySkills",
  "execution",
  "error",
  "summaryOnly",
  "omitted",
  "reasonCount",
  "warningCount",
  "gapCount",
  "excluded",
  "historyAvailable",
  "recordedRequestCount",
  "taskCount",
  "skillCount",
  "gameCount",
  "bodyByteLength",
  "historyAssessment",
  "scope",
  "dailyCompletion",
  "missingRecordMeans",
  "canInferNotRun",
  "canAuthorizeReplay",
  "goalId",
  "goalIds",
  "batchId",
  "requestIds",
  "flowComplete",
  "goalSatisfied",
  "retryCount",
  "waitingReason",
  "skipReason",
  "evidenceTimestamp",
  "evidenceReference",
  "scopeGameIds",
  "kind",
  "reason",
  "page",
  "pageVerified",
  "accountVerified",
  "account",
  "foregroundPackage",
  "changedLaneIds",
  "shopping",
  "taskAward",
  "scopes",
  "resources",
]);
const privateDetail =
  /uid|key|token|secret|password|credential|path|executable|bearer/i;
function publicDetailValue(value: unknown, depth = 0, field = ""): unknown {
  if (depth > 8) return undefined;
  if (field === "timeZone")
    return value === "Asia/Shanghai" ? value : undefined;
  if (field === "recordedTime") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const input = value as Record<string, unknown>;
    if (input.timeZone !== "Asia/Shanghai") return undefined;
    const times: Record<string, string> = {};
    for (const name of ["startedAt", "finishedAt"]) {
      const timestamp = input[name];
      if (
        typeof timestamp !== "string" ||
        !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)
      )
        continue;
      try {
        agentDate(timestamp.replace(" ", "T") + "+08:00");
        times[name] = timestamp;
      } catch {
        /* No arbitrary date text enters public traces. */
      }
    }
    return Object.keys(times).length
      ? { timeZone: "Asia/Shanghai", ...times }
      : undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string")
    return value.length <= 200 &&
      (field === "stage"
        ? /^[A-Za-z0-9@_-]{1,80}$/.test(value)
        : /^[A-Za-z0-9_:.,+ -]+$/.test(value)) &&
      !privateDetail.test(value) &&
      !/sk-[A-Za-z0-9_-]{12,}/.test(value)
      ? value
      : undefined;
  if (Array.isArray(value))
    return value
      .slice(0, 32)
      .map((item) => publicDetailValue(item, depth + 1, field))
      .filter((item) => item !== undefined);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => detailFields.has(key) && !privateDetail.test(key))
        .map(([key, item]) => [key, publicDetailValue(item, depth + 1, key)])
        .filter(([, item]) => item !== undefined),
    );
  return undefined;
}
export function publicAgentDetailJson(value: unknown): string {
  const json = JSON.stringify(publicDetailValue(value) ?? {});
  return json.length <= maxAgentDetailLength
    ? json
    : '{"summaryOnly":true,"omitted":true}';
}
export function sanitizeAgentEventDetails(
  value: unknown,
): AgentEventDetails | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["arguments", "result", "durationMs"].includes(key),
    )
  )
    throw new Error("Invalid call details");
  const input = value as Record<string, unknown>;
  const output: AgentEventDetails = {};
  for (const key of ["arguments", "result"] as const) {
    if (input[key] === undefined) continue;
    if (
      typeof input[key] !== "string" ||
      input[key].length > maxAgentDetailLength
    )
      throw new Error("Invalid call summary");
    const parsed: unknown = JSON.parse(input[key]);
    if (!parsed || typeof parsed !== "object")
      throw new Error("Invalid call summary");
    output[key] = publicAgentDetailJson(parsed);
  }
  if (input.durationMs !== undefined) {
    if (
      typeof input.durationMs !== "number" ||
      !Number.isFinite(input.durationMs) ||
      input.durationMs < 0
    )
      throw new Error("Invalid call duration");
    output.durationMs = input.durationMs;
  }
  return output;
}
export interface AgentEventInput {
  requestId: string;
  parentRequestId?: string;
  sessionId?: string;
  turnId?: string;
  callId?: string;
  runId?: string;
  laneId?: string;
  gameId?: string;
  stepId?: string;
  tool?: string;
  kind: AgentEventKind;
  status:
    "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "blocked";
  text: string;
  usage?: PlannerUsage;
  details?: AgentEventDetails;
}
export interface AgentEvent extends AgentEventInput {
  seq: number;
  at: string;
}
export interface AgentEventStore {
  version: 1;
  nextSeq: number;
  events: AgentEvent[];
}
export interface AgentEventQuery {
  afterSeq?: number;
  requestId?: string;
  limit?: number;
}
export interface AgentEventPage {
  version: 1;
  events: AgentEvent[];
  cursor: number;
  latestSeq: number;
  hasMore: boolean;
  gap?: boolean;
  error?: string;
}
