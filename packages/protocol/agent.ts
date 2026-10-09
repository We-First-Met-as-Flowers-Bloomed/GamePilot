import type { DeviceLanes, Plan } from "./index";
import type { ArknightsProfiles } from "../../games/arknights/config";
import type { ExecutionRecord } from "./execution";
import type { TaskRecord } from "./task-record";

export const agentToolNames = [
  "list_capabilities",
  "read_skill",
  "get_environment",
  "compile_plan",
  "get_run",
  "get_incident",
] as const;
export type AgentToolName = (typeof agentToolNames)[number];
/** Builtin content explains existing capabilities; it never grants execution. */
export interface AgentSkillPermissions {
  tools: AgentToolName[];
  canExecute: false;
  deviceControl: false;
  externalLoading: false;
}
export interface AgentBuiltinSkill {
  id: string;
  version: number;
  title: string;
  description: string;
  gameIds: string[];
  source: { kind: "builtin"; module: "games/agent-skills.ts" };
  permissions: AgentSkillPermissions;
  body: string;
}
export interface AgentCapabilityEffect {
  id: string;
  label: string;
  boundTo: string;
  kind: "navigation" | "consume" | "claim" | "configure" | "read";
  resource?: string;
  parameter?: string;
  enabled?: boolean;
}
/** Scope of knowledge, not a daily outcome inferred by the model. */
export interface AgentHistoryAssessment {
  scope: "bounded-ledger" | "not-read";
  dailyCompletion: "unknown";
  missingRecordMeans: "unknown";
  canInferNotRun: false;
  canAuthorizeReplay: false;
}
export interface AgentRunSummary {
  recordedProgress?: import("./execution-progress").ExecutionProgress;
  resolution?: { action: "abandoned"; at: string };
  startupFault?: import("./startup-fault").StartupFault;
  requestId: string;
  laneId?: string;
  requestSource: "single" | "daily" | "maintenance";
  recordedStatus: string;
  recordedConclusion: string;
  startedAt?: string;
  finishedAt?: string;
  /** Host-derived modern Beijing civil time, not a separate execution observation. */
  recordedTime?: {
    timeZone: "Asia/Shanghai";
    startedAt?: string;
    finishedAt?: string;
  };
  complete: boolean;
  inGameCompletion: "not-verified";
  tasks: {
    resultSummary?: import("./task-result-summary").TaskResultSummary;
    runId: string;
    gameId: string;
    gameDay?: string;
    finishedGameDay?: string;
    mode: string;
    status: string;
    recordedLogin?: {
      status: "matched-at-recorded-time";
      observedAt: string;
      currentIdentity: "not-inspected";
    };
    steps: { skillId: string; status: string }[];
  }[];
  warnings: string[];
  notes: string[];
}
export interface AgentSnapshot {
  /** Host-derived, validated and deidentified facts; never raw result/log content. */
  recordedResults?: {
    requestId: string;
    runId: string;
    summary: import("./task-result-summary").TaskResultSummary;
  }[];
  recordedProgress?: import("./execution-progress").ExecutionProgress[];
  /** Validated before UID is removed; never proves the current device identity. */
  recordedLogins?: { requestId: string; runId: string; observedAt: string }[];
  incidentSignals?: import("./agent-incident").IncidentSignal[];
  incidentFaults?: import("./agent-incident").IncidentFault[];
  source: "fixture" | "disk" | "configured" | "recorded";
  history?: {
    unassociatedRequests: number;
    incompleteRequests: string[];
    scope: "bounded-ledger";
    identity: "not-verified";
  };
  historyAvailable?: boolean;
  uidConfigured?: Record<string, boolean>;
  capturedAt: string;
  lanes?: DeviceLanes;
  profiles?: ArknightsProfiles;
  requests: ExecutionRecord[];
  tasks: TaskRecord[];
  errors: string[];
}
export interface GameDraftInput {
  gameId: string;
  skillIds?: string[];
  parameters?: Record<string, unknown>;
}
export interface CompilePlanInput {
  catalogRevision: string;
  environmentRevision: string;
  at: string;
  lanes: { laneId: string; games: GameDraftInput[] }[];
}
export interface CompiledGameDraft {
  plan: Plan;
  parameters: Record<string, unknown>;
  excluded: string[];
  notes: string[];
  effects?: AgentCapabilityEffect[];
}
export interface CompiledDraft {
  status: "valid" | "blocked";
  canExecute: false;
  catalogRevision: string;
  /** Absent in legacy saved drafts; those drafts cannot pass new admission. */
  compilerVersion?: number;
  skillRevision?: string;
  environmentRevision: string;
  at: string;
  planHash?: string;
  lanes: { laneId: string; instance: number; games: CompiledGameDraft[] }[];
  reasons: string[];
  preconditions: string[];
}
export class AgentToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function agentObject(input: unknown, keys: readonly string[]) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw new AgentToolError(
      "INVALID_INPUT",
      "输入必须是对象，且不能包含未支持的字段",
    );
  return input as Record<string, unknown>;
}
export function agentString(input: unknown, label: string, max = 160): string {
  if (
    typeof input !== "string" ||
    !input.length ||
    input.length > max ||
    /[\x00-\x1f]/.test(input)
  )
    throw new AgentToolError("INVALID_INPUT", `${label}无效`);
  return input;
}
export function agentDate(input: unknown): string {
  const value = agentString(input, "计划时间", 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new AgentToolError(
      "INVALID_INPUT",
      "计划时间必须为带时区的 ISO 时间",
    );
  // Date.parse normalizes impossible dates (e.g. February 30); reject them.
  const calendar = value.slice(0, 10);
  const date = new Date(calendar + "T00:00:00Z");
  if (
    date.toISOString().slice(0, 10) !== calendar ||
    Number(value.slice(11, 13)) > 23
  )
    throw new AgentToolError("INVALID_INPUT", "计划日期或小时无效");
  return new Date(value).toISOString();
}
/** Strict ISO evidence only; shared UTC+08:00 projection never uses a machine timezone. */
export function agentBeijingTime(input: unknown): string | undefined {
  try {
    const iso = agentDate(input);
    const local = new Date(Date.parse(iso) + 8 * 3600000).toISOString();
    return /^\d{4}-\d{2}-\d{2}T/.test(local)
      ? local.slice(0, 19).replace("T", " ")
      : undefined;
  } catch {
    return undefined;
  }
}
export function validateCompilePlan(input: unknown): CompilePlanInput {
  const v = agentObject(input, [
    "catalogRevision",
    "environmentRevision",
    "at",
    "lanes",
  ]);
  if (!Array.isArray(v.lanes) || v.lanes.length < 1 || v.lanes.length > 8)
    throw new AgentToolError("INVALID_INPUT", "请选择1至8个明确的设备槽位");
  const lanes = v.lanes.map((raw) => {
    const lane = agentObject(raw, ["laneId", "games"]);
    const laneId = agentString(lane.laneId, "设备槽位", 64);
    if (
      !Array.isArray(lane.games) ||
      lane.games.length < 1 ||
      lane.games.length > 2
    )
      throw new AgentToolError("INVALID_INPUT", "每个槽位请选择1至2个游戏");
    const games = lane.games.map((rawGame) => {
      const g = agentObject(rawGame, ["gameId", "skillIds", "parameters"]);
      const gameId = agentString(g.gameId, "游戏编号", 64);
      let skillIds: string[] | undefined;
      if (g.skillIds !== undefined) {
        if (
          !Array.isArray(g.skillIds) ||
          g.skillIds.length < 1 ||
          g.skillIds.length > 32
        )
          throw new AgentToolError("INVALID_INPUT", "请选择1至32项技能");
        skillIds = g.skillIds.map((id) => agentString(id, "技能编号", 64));
        if (new Set(skillIds).size !== skillIds.length)
          throw new AgentToolError("INVALID_INPUT", "技能不能重复");
      }
      if (
        g.parameters !== undefined &&
        (!g.parameters ||
          typeof g.parameters !== "object" ||
          Array.isArray(g.parameters))
      )
        throw new AgentToolError("INVALID_INPUT", "技能参数必须是对象");
      return {
        gameId,
        ...(skillIds ? { skillIds } : {}),
        ...(g.parameters === undefined
          ? {}
          : {
              parameters: structuredClone(g.parameters) as Record<
                string,
                unknown
              >,
            }),
      };
    });
    if (new Set(games.map((g) => g.gameId)).size !== games.length)
      throw new AgentToolError("INVALID_INPUT", "游戏不能重复");
    return { laneId, games };
  });
  if (new Set(lanes.map((l) => l.laneId)).size !== lanes.length)
    throw new AgentToolError("INVALID_INPUT", "设备槽位不能重复");
  return {
    catalogRevision: agentString(v.catalogRevision, "能力版本"),
    environmentRevision: agentString(v.environmentRevision, "环境版本"),
    at: agentDate(v.at),
    lanes,
  };
}
