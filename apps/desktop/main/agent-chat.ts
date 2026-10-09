import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../../../packages/acceptance/files";
import {
  AgentToolError,
  agentDate,
  agentObject,
  agentToolNames,
  type AgentRunSummary,
} from "../../../packages/protocol/agent";
import {
  plannerActive,
  type PlannerViewState,
  type PlannerSource,
} from "../../../packages/protocol/agent-planner";
import type {
  ChatView,
  ChatSession,
  ChatTurn,
  ChatTurnTarget,
  ChatSessionSummary,
  ChatArchivedSession,
  ChatArchiveEntry,
  ChatArchivePage,
  ChatArchiveTurnsPage,
} from "../../../packages/protocol/agent-chat";
import type { PlannerService, PlannerConversationTurn } from "./agent-planner";
import type { TaskResultSummary } from "../../../packages/protocol/task-result-summary";
import type { ExecutionProgress } from "../../../packages/protocol/execution-progress";
import { validStartupFault } from "../../../packages/protocol/startup-fault";
import type { ChatCommandView } from "../../../packages/protocol/chat-commands";
import {
  chatCommandContext,
  unavailableChatCommandContext,
} from "./chat-command-context";

interface Dependencies {
  planner: Pick<
    PlannerService,
    | "snapshot"
    | "verifiedSnapshot"
    | "startConversation"
    | "cancel"
    | "subscribe"
  >;
  save(view: ChatView): Promise<void>;
  load?(): Promise<ChatView | undefined>;
  available?(): boolean;
  archive?(record: ChatArchivedSession): Promise<void>;
  list?(): Promise<ChatArchiveEntry[]>;
  loadArchive?(id: string): Promise<ChatArchivedSession | undefined>;
  canArchive?(sessionId: string): boolean;
  readCommands?(sessionId: string): Promise<ChatCommandView[]>;
}
const sources = ["fixture", "configured", "recorded"];
const statuses = [
  "idle",
  "running",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
];
const maxBytes = 8 * 1024 * 1024 - 128;
const stepStatuses = [
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
  "unknown",
  "not-run",
];
const requestStatuses = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
];
const storeError = () =>
  new AgentToolError(
    "CHAT_STORE_UNAVAILABLE",
    "会话记录无法可靠保存或读取；已停止发送，原文件保留。",
  );
function text(v: unknown, max: number, empty = false): v is string {
  return typeof v === "string" && (empty || !!v.trim()) && v.length <= max;
}
function id(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
}
function date(v: unknown): v is string {
  return (
    typeof v === "string" && v.length <= 50 && Number.isFinite(Date.parse(v))
  );
}
function strings(v: unknown, max = 4000): v is string[] {
  return Array.isArray(v) && v.every((value) => text(value, max, true));
}
function counts(v: unknown, keys: string[]) {
  if (!v || typeof v !== "object") return false;
  const value = v as Record<string, unknown>;
  return keys.every(
    (key) =>
      typeof value[key] === "number" &&
      Number.isSafeInteger(value[key]) &&
      (value[key] as number) >= 0,
  );
}
function summaryValid(s: TaskResultSummary) {
  return (
    s &&
    s.version === 1 &&
    ["live", "rehearsal"].includes(s.mode) &&
    counts(s.counts, [
      "completed",
      "skipped",
      "failed",
      "unknown",
      "notRun",
      "running",
      "pending",
      "cancelled",
    ]) &&
    Array.isArray(s.items) &&
    s.items.every(
      (item) =>
        item &&
        text(item.id, 200) &&
        text(item.label, 1000) &&
        text(item.value, 4000, true) &&
        (item.note === undefined || text(item.note, 4000, true)) &&
        (item.status === undefined || stepStatuses.includes(item.status)),
    ) &&
    Array.isArray(s.issues) &&
    s.issues.every(
      (issue) => issue && text(issue.skillId, 64) && text(issue.message, 4000),
    ) &&
    text(s.scopeNote, 4000)
  );
}
function progressValid(p: ExecutionProgress) {
  return (
    p &&
    p.version === 1 &&
    text(p.requestId, 240) &&
    text(p.rootId, 240) &&
    text(p.latestId, 240) &&
    (p.laneId === undefined || text(p.laneId, 64)) &&
    ["daily", "single", "maintenance"].includes(p.source) &&
    typeof p.wholePlanComplete === "boolean" &&
    requestStatuses.includes(p.originalStatus) &&
    date(p.startedAt) &&
    [
      "complete",
      "recovered",
      "partial",
      "running",
      "incomplete",
      "unconfirmed",
    ].includes(p.outcome) &&
    counts(p.counts, [
      "total",
      "completed",
      "skipped",
      "excluded",
      "remaining",
    ]) &&
    strings(p.warnings) &&
    Array.isArray(p.steps) &&
    p.steps.every(
      (step) =>
        step &&
        text(step.gameId, 64) &&
        text(step.skillId, 64) &&
        (stepStatuses.includes(step.status) || step.status === "excluded") &&
        text(step.sourceId, 240) &&
        typeof step.continued === "boolean",
    ) &&
    Array.isArray(p.requests) &&
    p.requests.every(
      (request) =>
        request &&
        text(request.id, 240) &&
        requestStatuses.includes(request.status) &&
        date(request.startedAt) &&
        (request.finishedAt === undefined || date(request.finishedAt)) &&
        (request.appVersion === undefined || text(request.appVersion, 100)),
    )
  );
}
function recordValid(r: AgentRunSummary) {
  return (
    r &&
    text(r.requestId, 240) &&
    (r.laneId === undefined || text(r.laneId, 64)) &&
    ["single", "daily", "maintenance"].includes(r.requestSource) &&
    text(r.recordedStatus, 64) &&
    text(r.recordedConclusion, 64) &&
    typeof r.complete === "boolean" &&
    r.inGameCompletion === "not-verified" &&
    (r.startedAt === undefined || date(r.startedAt)) &&
    (r.startupFault === undefined || validStartupFault(r.startupFault)) &&
    strings(r.warnings) &&
    strings(r.notes) &&
    Array.isArray(r.tasks) &&
    r.tasks.every(
      (task) =>
        task &&
        text(task.runId, 240) &&
        text(task.gameId, 64) &&
        (task.gameDay === undefined || text(task.gameDay, 64)) &&
        (task.finishedGameDay === undefined ||
          text(task.finishedGameDay, 64)) &&
        text(task.mode, 64) &&
        text(task.status, 64) &&
        Array.isArray(task.steps) &&
        task.steps.every(
          (step) => step && text(step.skillId, 64) && text(step.status, 64),
        ) &&
        (task.resultSummary === undefined ||
          summaryValid(task.resultSummary)) &&
        (task.recordedLogin === undefined ||
          (date(task.recordedLogin.observedAt) &&
            task.recordedLogin.status === "matched-at-recorded-time" &&
            task.recordedLogin.currentIdentity === "not-inspected")),
    ) &&
    (r.recordedProgress === undefined || progressValid(r.recordedProgress)) &&
    (r.resolution === undefined ||
      (r.resolution.action === "abandoned" && date(r.resolution.at)))
  );
}
function plannerValid(p: PlannerViewState, t: ChatTurn) {
  if (
    !p ||
    typeof p !== "object" ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 0 ||
    !statuses.includes(p.status) ||
    p.source !== t.source ||
    p.prompt !== t.prompt ||
    p.at !== t.at ||
    (p.requestId !== undefined && !id(p.requestId)) ||
    (p.startedAt !== undefined && !date(p.startedAt)) ||
    (p.finishedAt !== undefined && !date(p.finishedAt)) ||
    (p.provider !== undefined &&
      !["codex", "compatible"].includes(p.provider)) ||
    (p.error !== undefined &&
      (!text(p.error.code, 100) || !text(p.error.message, 4000)))
  )
    return false;
  if (
    p.progress &&
    (!["discovering", "connecting", "checking", "thinking", "tool"].includes(
      p.progress.phase,
    ) ||
      (p.progress.tool !== undefined &&
        !agentToolNames.includes(p.progress.tool)))
  )
    return false;
  const r = p.result;
  if (!r) return true;
  if (
    p.status !== "completed" ||
    r.source !== t.source ||
    !["not-started", "managed-by-goal"].includes(r.execution) ||
    (r.execution === "managed-by-goal" &&
      (!Array.isArray(r.goalIds) ||
        r.goalIds.length < 1 ||
        r.goalIds.length > 8 ||
        !r.goalIds.every(id))) ||
    (r.goalIds !== undefined &&
      (!Array.isArray(r.goalIds) ||
        r.goalIds.length > 8 ||
        !r.goalIds.every(id))) ||
    (r.configurationChangedByHost !== undefined &&
      (r.configurationChangedByHost !== true ||
        r.draft !== undefined ||
        r.status !== "answer")) ||
    r.canExecute !== false ||
    ![
      "draft",
      "question",
      "answer",
      "blocked",
      "saved-daily",
      "saved-both-games",
    ].includes(r.status) ||
    (["saved-daily", "saved-both-games"].includes(r.status) &&
      r.draft !== undefined) ||
    !text(r.modelText, 8000) ||
    !text(r.model, 200) ||
    !text(r.codexVersion, 200, true) ||
    !Number.isFinite(r.elapsedMs) ||
    r.elapsedMs < 0 ||
    !Array.isArray(r.trace) ||
    r.trace.length > 12 ||
    r.trace.some(
      (item) =>
        !item ||
        !text(item.callId, 240) ||
        !agentToolNames.includes(item.tool) ||
        typeof item.success !== "boolean" ||
        (item.code !== undefined && !text(item.code, 100)) ||
        (item.planHash !== undefined && !text(item.planHash, 100)),
    )
  )
    return false;
  if (
    (r.transport !== undefined &&
      !["codex", "compatible", "dsh"].includes(r.transport)) ||
    (r.formatRepairs !== undefined &&
      r.formatRepairs !== 0 &&
      r.formatRepairs !== 1)
  )
    return false;
  if (
    r.historyAssessment &&
    (!["not-read", "bounded-ledger"].includes(r.historyAssessment.scope) ||
      r.historyAssessment.dailyCompletion !== "unknown" ||
      r.historyAssessment.missingRecordMeans !== "unknown" ||
      r.historyAssessment.canInferNotRun !== false ||
      r.historyAssessment.canAuthorizeReplay !== false)
  )
    return false;
  // Result payloads are inert historical data. Reject malformed containers before
  // components render them; executable admission still uses the live planner.
  if (
    r.draft &&
    (!Array.isArray(r.draft.lanes) ||
      (r.draft.planHash !== undefined && !text(r.draft.planHash, 100)) ||
      !["valid", "blocked"].includes(r.draft.status) ||
      r.draft.canExecute !== false ||
      !text(r.draft.catalogRevision, 240) ||
      !text(r.draft.environmentRevision, 240) ||
      (r.draft.compilerVersion !== undefined &&
        (!Number.isSafeInteger(r.draft.compilerVersion) ||
          r.draft.compilerVersion < 1)) ||
      (r.draft.skillRevision !== undefined &&
        (typeof r.draft.skillRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(r.draft.skillRevision))) ||
      !date(r.draft.at) ||
      !strings(r.draft.reasons) ||
      !strings(r.draft.preconditions) ||
      r.draft.lanes.some(
        (lane) =>
          !lane ||
          !id(lane.laneId) ||
          !Number.isSafeInteger(lane.instance) ||
          lane.instance < 0 ||
          !Array.isArray(lane.games) ||
          lane.games.some(
            (g) =>
              !g ||
              !g.plan ||
              !text(g.plan.gameId, 64) ||
              !strings(g.plan.skillIds, 64) ||
              !["live", "rehearsal"].includes(g.plan.mode) ||
              !g.parameters ||
              typeof g.parameters !== "object" ||
              Array.isArray(g.parameters) ||
              !strings(g.excluded, 64) ||
              !strings(g.notes) ||
              (g.effects !== undefined &&
                (!Array.isArray(g.effects) ||
                  g.effects.some(
                    (effect) =>
                      !effect ||
                      !text(effect.id, 64) ||
                      !text(effect.label, 1000) ||
                      !text(effect.boundTo, 64) ||
                      !g.plan.skillIds.includes(effect.boundTo) ||
                      ![
                        "navigation",
                        "consume",
                        "claim",
                        "configure",
                        "read",
                      ].includes(effect.kind) ||
                      typeof effect.enabled !== "boolean" ||
                      (effect.resource !== undefined &&
                        !text(effect.resource, 1000)) ||
                      (effect.parameter !== undefined &&
                        !text(effect.parameter, 64)),
                  ))),
          ),
      ))
  )
    return false;
  if (
    r.records !== undefined &&
    (!Array.isArray(r.records) || !r.records.every(recordValid))
  )
    return false;
  if (
    r.incidents !== undefined &&
    (!Array.isArray(r.incidents) ||
      r.incidents.some(
        (incident) =>
          !incident ||
          incident.version !== 1 ||
          incident.source !== "recorded" ||
          incident.execution !== "not-started" ||
          incident.canExecute !== false ||
          !text(incident.environmentRevision, 240) ||
          !text(incident.bundleHash, 240) ||
          (incident.capturedAt !== undefined && !date(incident.capturedAt)) ||
          !Number.isSafeInteger(incident.omittedSignals) ||
          incident.omittedSignals < 0 ||
          !recordValid(incident.run) ||
          !Array.isArray(incident.signals) ||
          incident.signals.some(
            (s) =>
              !s ||
              !text(s.requestId, 240) ||
              !text(s.evidenceId, 240) ||
              !text(s.description, 4000) ||
              !text(s.code, 100) ||
              !["log-pattern", "structured-record"].includes(s.basis) ||
              (s.runId !== undefined && !text(s.runId, 240)) ||
              (s.skillId !== undefined && !text(s.skillId, 64)),
          ) ||
          !Array.isArray(incident.faults) ||
          incident.faults.some(
            (f) =>
              !f ||
              !text(f.requestId, 240) ||
              !text(f.runId, 240) ||
              !text(f.evidenceId, 240) ||
              !text(f.code, 100) ||
              !text(f.source, 100) ||
              !text(f.captureStatus, 100) ||
              !date(f.observedAt) ||
              f.imageSent !== false ||
              (f.skillId !== undefined && !text(f.skillId, 64)),
          ) ||
          !strings(incident.gaps) ||
          !Array.isArray(incident.recoverySkills) ||
          incident.recoverySkills.length !== 0,
      ))
  )
    return false;
  return true;
}
export function validateStore(v: ChatView) {
  if (
    !v ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    !Array.isArray(v.sessions) ||
    v.sessions.length > 32 ||
    (v.error !== undefined && !text(v.error, 4000)) ||
    Buffer.byteLength(JSON.stringify(v), "utf8") > maxBytes
  )
    throw storeError();
  const sessionIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const s of v.sessions) {
    if (
      !s ||
      !id(s.id) ||
      sessionIds.has(s.id) ||
      !text(s.title, 80) ||
      !date(s.createdAt) ||
      !date(s.updatedAt) ||
      !Array.isArray(s.turns) ||
      s.turns.length > 64
    )
      throw storeError();
    sessionIds.add(s.id);
    if (
      s.summary !== undefined &&
      canonical(s.summary) !== canonical(summarizeChatSession(s))
    )
      throw storeError();
    for (const t of s.turns) {
      if (
        !t ||
        !id(t.id) ||
        turnIds.has(t.id) ||
        !text(t.prompt, 12000) ||
        !sources.includes(t.source) ||
        !date(t.at) ||
        !date(t.createdAt) ||
        !plannerValid(t.planner, t)
      )
        throw storeError();
      turnIds.add(t.id);
    }
  }
  if (v.selectedSessionId !== undefined && !sessionIds.has(v.selectedSessionId))
    throw storeError();
}
/** Projection of original intent and host tool receipts, never of model prose. */
export function summarizeChatSession(session: ChatSession): ChatSessionSummary {
  const facts: ChatSessionSummary["facts"] = [];
  for (const turn of session.turns) {
    const result =
      turn.planner.status === "completed" ? turn.planner.result : undefined;
    if (!result) continue;
    const originTool = result.trace.some(
      (item) => item.success && item.tool === "get_run",
    )
      ? "get_run"
      : result.trace.some(
            (item) => item.success && item.tool === "get_incident",
          )
        ? "get_incident"
        : undefined;
    if (originTool)
      for (const record of result.records ?? [])
        facts.push({
          turnId: turn.id,
          source: turn.source,
          at: turn.at,
          kind: "recorded-run",
          originTool,
          requestId: record.requestId,
          recordedStatus: record.recordedStatus,
          recordedConclusion: record.recordedConclusion,
          inGameCompletion: record.inGameCompletion,
          ...(record.recordedProgress
            ? {
                wholePlanComplete: record.recordedProgress.wholePlanComplete,
                outcome: record.recordedProgress.outcome,
              }
            : {}),
        });
    const draft = result.draft;
    if (
      draft &&
      result.trace.some(
        (item) =>
          item.success &&
          item.tool === "compile_plan" &&
          item.planHash === draft.planHash,
      )
    )
      facts.push({
        turnId: turn.id,
        source: turn.source,
        at: turn.at,
        kind: "compiled-draft",
        originTool: "compile_plan",
        planHash: draft.planHash,
        catalogRevision: draft.catalogRevision,
        environmentRevision: draft.environmentRevision,
      });
  }
  return {
    version: 1,
    scope: "historical-tools-only",
    currentState: "unknown",
    canAuthorizeExecution: false,
    objectives: session.turns.map((turn) => ({
      turnId: turn.id,
      source: turn.source,
      at: turn.at,
      text: turn.prompt.slice(0, 1000),
      truncated: turn.prompt.length > 1000,
    })),
    facts: facts.slice(-64),
  };
}
const archiveError = () =>
  new AgentToolError(
    "CHAT_ARCHIVE_UNAVAILABLE",
    "归档记录无法可靠保存或读取；原会话和归档文件保留。",
  );
export function validateChatArchive(record: ChatArchivedSession) {
  if (
    !record ||
    record.version !== 1 ||
    !id(record.id) ||
    record.id !== record.session?.id ||
    !date(record.archivedAt) ||
    Buffer.byteLength(JSON.stringify(record), "utf8") > maxBytes
  )
    throw archiveError();
  validateStore({ revision: 0, sessions: [record.session] });
  if (
    record.session.turns.some(
      (turn) => plannerActive(turn.planner) || turn.planner.status === "idle",
    )
  )
    throw archiveError();
}
export function chatArchiveEntry(
  record: ChatArchivedSession,
): ChatArchiveEntry {
  const s = record.session;
  return {
    version: 1,
    id: record.id,
    sessionId: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: record.archivedAt,
    turnCount: s.turns.length,
    sources: [...new Set(s.turns.map((turn) => turn.source))],
  };
}
function validArchiveEntry(entry: ChatArchiveEntry) {
  return (
    entry &&
    entry.version === 1 &&
    id(entry.id) &&
    entry.sessionId === entry.id &&
    text(entry.title, 80) &&
    date(entry.createdAt) &&
    date(entry.updatedAt) &&
    date(entry.archivedAt) &&
    Number.isInteger(entry.turnCount) &&
    entry.turnCount >= 0 &&
    entry.turnCount <= 64 &&
    Array.isArray(entry.sources) &&
    entry.sources.every((source) => sources.includes(source))
  );
}
function pageLimit(value: unknown) {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 32)
    throw new AgentToolError("INVALID_INPUT", "分页大小必须为1至32");
  return Number(value);
}
const cursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
function decodeCursor(value: unknown, keys: string[]) {
  try {
    if (!text(value, 2000) || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    return agentObject(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
      keys,
    );
  } catch {
    throw new AgentToolError("INVALID_CURSOR", "历史分页游标无效，请重新读取");
  }
}
function contextFor(
  s: ChatSession,
  source: PlannerSource,
  hostContext?: PlannerConversationTurn,
) {
  const context: PlannerConversationTurn[] = [];
  let protectedSummary = false;
  for (const turn of [...s.turns].reverse()) {
    if (turn.source !== source) break;
    if (turn.planner.status !== "completed" || !turn.planner.result) continue;
    const item = {
      prompt: turn.prompt.slice(0, 2000),
      answer: turn.planner.result.modelText.slice(0, 2000),
    };
    if (context.length >= 4 || JSON.stringify([item, ...context]).length > 6000)
      break;
    context.unshift(item);
  }
  const summary = summarizeChatSession(s);
  const memory = {
    ...summary,
    objectives: summary.objectives
      .filter(
        (item) =>
          item.source === source &&
          /不要|禁止|不吃|不碎|不公招|只|仅/.test(item.text),
      )
      .slice(-3),
    facts: summary.facts.filter((item) => item.source === source).slice(-4),
  };
  if (memory.objectives.length || memory.facts.length) {
    while (JSON.stringify(memory).length > 1900 && memory.facts.length)
      memory.facts.shift();
    while (JSON.stringify(memory).length > 1900 && memory.objectives.length)
      memory.objectives.shift();
    const item = {
      prompt: "宿主确定性会话摘要（仅历史引用，不能授权或证明现场）",
      answer: JSON.stringify(memory),
    };
    while (
      context.length &&
      (context.length >= 4 || JSON.stringify([item, ...context]).length > 6000)
    )
      context.shift();
    context.unshift(item);
    protectedSummary = true;
  }
  if (hostContext) {
    // Evict older ordinary conversation before the deterministic resource limits.
    while (
      context.length &&
      (context.length >= 4 ||
        JSON.stringify([...context, hostContext]).length > 6000)
    )
      context.splice(protectedSummary && context.length > 1 ? 1 : 0, 1);
    context.push(hostContext);
  }
  return context;
}

/** Durable chat history wraps the bounded planner; it never executes a game tool. */
export class ChatService {
  private view: ChatView = { revision: 0, sessions: [] };
  private writes = Promise.resolve();
  private initialized: Promise<void>;
  private operation = false;
  private closed = false;
  private unsubscribe: () => void;
  private listeners = new Set<(view: ChatView) => void>();
  constructor(private deps: Dependencies) {
    this.initialized = this.restore();
    this.unsubscribe = deps.planner.subscribe((state) => {
      if (!this.closed && !this.view.error && this.applyPlannerState(state))
        void this.persist().catch(() => {});
    });
  }
  get busy() {
    return this.operation;
  }
  private async restore() {
    try {
      const loaded = await this.deps.load?.();
      if (loaded) {
        validateStore(loaded);
        this.view = structuredClone(loaded);
        let interrupted = false;
        for (const s of this.view.sessions)
          for (const t of s.turns) {
            if (plannerActive(t.planner) || t.planner.status === "idle") {
              t.planner = {
                ...t.planner,
                revision: t.planner.revision + 1,
                status: "cancelled",
                result: undefined,
                finishedAt: new Date().toISOString(),
                error: {
                  code: "CHAT_INTERRUPTED",
                  message:
                    "应用重启中断了本轮对话；没有自动重新发送或执行任务。",
                },
              };
              interrupted = true;
            }
          }
        for (const session of this.view.sessions)
          session.summary = summarizeChatSession(session);
        if (interrupted) {
          this.touch();
          await this.persist();
        }
      } else {
        this.addSession();
        await this.persist();
      }
    } catch {
      this.view.error = storeError().message;
      this.touch();
    }
  }
  private touch() {
    this.view.revision++;
  }
  private addSession() {
    if (this.view.sessions.length >= 32)
      throw new AgentToolError(
        "CHAT_BUDGET",
        "已达到 32 个会话的记录预算，请手动归档已结束会话后继续。",
      );
    const at = new Date().toISOString();
    const s: ChatSession = {
      id: randomUUID(),
      title: "新会话",
      createdAt: at,
      updatedAt: at,
      turns: [],
    };
    this.view.sessions.push(s);
    this.view.selectedSessionId = s.id;
    this.touch();
    return s;
  }
  private async persist() {
    if (this.view.error) throw storeError();
    for (const session of this.view.sessions)
      session.summary = summarizeChatSession(session);
    try {
      validateStore(this.view);
    } catch {
      this.view.error = storeError().message;
      this.touch();
      throw storeError();
    }
    const next = structuredClone(this.view);
    const job = this.writes.then(() => this.deps.save(next));
    this.writes = job.catch(() => {});
    try {
      await job;
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(next));
        } catch {
          /* Observers cannot interrupt a committed write. */
        }
      }
    } catch {
      this.view.error = storeError().message;
      this.touch();
      throw storeError();
    }
  }
  private session(v: unknown) {
    if (!id(v))
      throw new AgentToolError("CHAT_SESSION_MISMATCH", "会话编号无效");
    const s = this.view.sessions.find((s) => s.id === v);
    if (!s)
      throw new AgentToolError(
        "CHAT_SESSION_MISMATCH",
        "会话不存在，请重新选择",
      );
    return s;
  }
  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.operation)
      throw new AgentToolError(
        "CHAT_BUSY",
        "正在处理另一条会话请求，请等待状态更新",
      );
    this.operation = true;
    try {
      await this.initialized;
      if (this.closed)
        throw new AgentToolError("CHAT_CLOSED", "会话服务正在关闭");
      if (this.view.error) throw storeError();
      return await action();
    } finally {
      this.operation = false;
    }
  }
  private applyPlannerState(p: PlannerViewState): boolean {
    if (!p.requestId) return false;
    const s = this.view.sessions.find((s) =>
      s.turns.some((t) => t.planner.requestId === p.requestId),
    );
    const t = s?.turns.find((t) => t.planner.requestId === p.requestId);
    if (!s || !t || p.revision <= t.planner.revision) return false;
    // Revalidation revokes live execution eligibility, not the historical reply.
    if (
      t.planner.status === "completed" &&
      t.planner.result &&
      p.status === "failed" &&
      ["CONFIGURATION_CHANGED", "MODEL_CONFIG_CHANGED"].includes(
        p.error?.code ?? "",
      )
    )
      return false;
    const terminal = !plannerActive(p);
    // Request ID is authoritative; a late snapshot never replaces another turn.
    t.planner = {
      ...structuredClone(p),
      prompt: t.prompt,
      source: t.source,
      at: t.at,
    };
    s.updatedAt = p.finishedAt ?? p.startedAt ?? s.updatedAt;
    this.touch();
    return terminal;
  }
  private async reconcile() {
    if (this.view.error) return;
    const p = await this.deps.planner.verifiedSnapshot();
    if (this.applyPlannerState(p)) await this.persist();
  }
  async snapshot(): Promise<ChatView> {
    await this.initialized;
    await this.reconcile().catch(() => {});
    await this.writes;
    return structuredClone(this.view);
  }
  /** Only durable snapshots are published; observers never receive mutable state. */
  subscribe(listener: (view: ChatView) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  requestTarget(requestId: string): ChatTurnTarget | undefined {
    const matches = this.view.sessions.flatMap((session) =>
      session.turns
        .filter((turn) => turn.planner.requestId === requestId)
        .map((turn) => ({ sessionId: session.id, turnId: turn.id })),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  archive(input: unknown) {
    return this.mutate(async () => {
      const value = agentObject(input, ["sessionId"]);
      await this.reconcile();
      const session = this.session(value.sessionId);
      if (
        session.turns.some(
          (turn) =>
            plannerActive(turn.planner) || turn.planner.status === "idle",
        ) ||
        this.deps.canArchive?.(session.id) === false
      )
        throw new AgentToolError(
          "CHAT_SESSION_ACTIVE",
          "本会话仍有模型或执行任务活动，请结束后手动归档",
        );
      if (!this.deps.archive) throw archiveError();
      const record: ChatArchivedSession = {
        version: 1,
        id: session.id,
        archivedAt: new Date().toISOString(),
        session: structuredClone(session),
      };
      try {
        validateChatArchive(record);
        await this.deps.archive(record);
      } catch (error) {
        if (
          error instanceof AgentToolError &&
          error.code === "CHAT_ARCHIVE_BUDGET"
        )
          throw error;
        throw archiveError();
      }
      const before = structuredClone(this.view);
      this.view.sessions = this.view.sessions.filter(
        (item) => item.id !== session.id,
      );
      if (this.view.selectedSessionId === session.id)
        this.view.selectedSessionId = this.view.sessions.at(-1)?.id;
      this.touch();
      if (!this.view.sessions.length) this.addSession();
      try {
        await this.persist();
      } catch (error) {
        this.view = {
          ...before,
          revision: this.view.revision,
          error: storeError().message,
        };
        throw error;
      }
      return structuredClone(this.view);
    });
  }
  async listArchived(input: unknown = {}): Promise<ChatArchivePage> {
    await this.initialized;
    const value = agentObject(input, ["cursor", "limit"]);
    const limit = pageLimit(value.limit);
    const after =
      value.cursor === undefined
        ? undefined
        : decodeCursor(value.cursor, [
            "version",
            "cutAt",
            "cutId",
            "afterAt",
            "afterId",
          ]);
    if (
      after &&
      (after.version !== 1 ||
        !date(after.cutAt) ||
        !id(after.cutId) ||
        !date(after.afterAt) ||
        !id(after.afterId))
    )
      throw new AgentToolError("INVALID_CURSOR", "归档列表游标无效");
    if (!this.deps.list) throw archiveError();
    let entries: ChatArchiveEntry[];
    try {
      entries = await this.deps.list();
      if (
        !Array.isArray(entries) ||
        entries.some((entry) => !validArchiveEntry(entry)) ||
        new Set(entries.map((entry) => entry.id)).size !== entries.length
      )
        throw archiveError();
    } catch {
      throw archiveError();
    }
    const compare = (
      a: { archivedAt: string; id: string },
      b: { archivedAt: string; id: string },
    ) =>
      Date.parse(a.archivedAt) - Date.parse(b.archivedAt) ||
      a.id.localeCompare(b.id);
    entries.sort((a, b) => compare(b, a));
    const cut = after
      ? { archivedAt: after.cutAt as string, id: after.cutId as string }
      : entries[0];
    if (after)
      entries = entries.filter(
        (entry) =>
          compare(entry, cut) <= 0 &&
          compare(entry, {
            archivedAt: after.afterAt as string,
            id: after.afterId as string,
          }) < 0,
      );
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return structuredClone({
      entries: page,
      ...(entries.length > limit && last
        ? {
            nextCursor: cursor({
              version: 1,
              cutAt: cut.archivedAt,
              cutId: cut.id,
              afterAt: last.archivedAt,
              afterId: last.id,
            }),
          }
        : {}),
      scope: "historical-only" as const,
      canExecute: false as const,
    });
  }
  async loadArchived(input: unknown): Promise<ChatArchiveTurnsPage> {
    await this.initialized;
    const value = agentObject(input, ["archiveId", "cursor", "limit"]);
    if (!id(value.archiveId))
      throw new AgentToolError("INVALID_INPUT", "归档编号无效");
    const limit = pageLimit(value.limit);
    const after =
      value.cursor === undefined
        ? undefined
        : decodeCursor(value.cursor, [
            "version",
            "archiveId",
            "digest",
            "offset",
          ]);
    if (
      after &&
      (after.version !== 1 ||
        after.archiveId !== value.archiveId ||
        typeof after.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(after.digest) ||
        !Number.isInteger(after.offset) ||
        Number(after.offset) < 1 ||
        Number(after.offset) > 64)
    )
      throw new AgentToolError("INVALID_CURSOR", "归档轮次游标无效");
    if (!this.deps.loadArchive) throw archiveError();
    let record: ChatArchivedSession | undefined;
    try {
      record = await this.deps.loadArchive(value.archiveId);
      if (record) {
        validateChatArchive(record);
        if (record.id !== value.archiveId) throw archiveError();
      }
    } catch {
      throw archiveError();
    }
    if (!record)
      throw new AgentToolError("CHAT_ARCHIVE_NOT_FOUND", "归档会话不存在");
    const digest = createHash("sha256").update(canonical(record)).digest("hex");
    if (after && after.digest !== digest)
      throw new AgentToolError("INVALID_CURSOR", "归档内容已变化，请重新读取");
    const offset = after ? Number(after.offset) : 0;
    if (offset > record.session.turns.length)
      throw new AgentToolError("INVALID_CURSOR", "归档轮次游标超出范围");
    const { turns, ...session } = record.session;
    const page = turns.slice(offset, offset + limit);
    return structuredClone({
      archive: chatArchiveEntry(record),
      session,
      turns: page,
      ...(offset + page.length < turns.length
        ? {
            nextCursor: cursor({
              version: 1,
              archiveId: record.id,
              digest,
              offset: offset + page.length,
            }),
          }
        : {}),
      scope: "historical-only" as const,
      canExecute: false as const,
    });
  }
  newChat() {
    return this.mutate(async () => {
      await this.reconcile();
      const selected = this.view.sessions.find(
        (s) => s.id === this.view.selectedSessionId,
      );
      if (!selected || selected.turns.length) {
        this.addSession();
        await this.persist();
      }
      return structuredClone(this.view);
    });
  }
  select(input: unknown) {
    return this.mutate(async () => {
      const s = this.session(input);
      if (this.view.selectedSessionId !== s.id) {
        this.view.selectedSessionId = s.id;
        this.touch();
        await this.persist();
      }
      return structuredClone(this.view);
    });
  }
  send(input: unknown) {
    return this.mutate(async () => {
      const v = agentObject(input, ["sessionId", "prompt", "source", "at"]);
      const s = this.session(v.sessionId);
      if (!text(v.prompt, 12000))
        throw new AgentToolError(
          "INVALID_PROMPT",
          "请输入 1 至 12000 字符的需求",
        );
      if (typeof v.source !== "string" || !sources.includes(v.source))
        throw new AgentToolError("INVALID_INPUT", "不支持的对话数据来源");
      const at = agentDate(v.at);
      await this.reconcile();
      if (plannerActive(this.deps.planner.snapshot()))
        throw new AgentToolError(
          "PLANNER_BUSY",
          "已有对话正在处理，请等待完成或取消",
        );
      if (s.turns.length >= 64)
        throw new AgentToolError(
          "CHAT_BUDGET",
          "本会话已有 64 条需求，请手动归档后新建会话继续",
        );
      const source = v.source as PlannerSource;
      const prompt = v.prompt.trim();
      let hostContext: PlannerConversationTurn | undefined;
      if (source !== "fixture" && this.deps.readCommands) {
        try {
          hostContext = chatCommandContext(
            s,
            source,
            await this.deps.readCommands(s.id),
          );
        } catch {
          hostContext = unavailableChatCommandContext();
        }
      }
      const context = contextFor(s, source, hostContext);
      const t: ChatTurn = {
        id: randomUUID(),
        prompt,
        source,
        at,
        createdAt: new Date().toISOString(),
        planner: { revision: 0, status: "idle", prompt, source, at },
      };
      const candidate = structuredClone(this.view);
      const candidateSession = candidate.sessions.find(
        (item) => item.id === s.id,
      )!;
      candidateSession.turns.push(t);
      candidateSession.summary = summarizeChatSession(candidateSession);
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes)
        throw new AgentToolError(
          "CHAT_BUDGET",
          "会话记录已达到存储预算，请手动归档已结束会话后继续",
        );
      s.turns.push(t);
      if (s.turns.length === 1)
        s.title = prompt.replace(/\s+/g, " ").slice(0, 48);
      s.updatedAt = t.createdAt;
      this.view.selectedSessionId = s.id;
      this.touch();
      // Persist intent before sending it to a model. A restart never replays this admission.
      await this.persist();
      try {
        if (this.deps.available && !this.deps.available())
          throw new AgentToolError(
            "CHAT_BUSY",
            "模型配置或已确认任务正在处理，请稍后发送需求",
          );
        t.planner = this.deps.planner.startConversation(
          { prompt, source, at },
          context,
          { sessionId: s.id, turnId: t.id, prompt },
        );
        this.touch();
        await this.persist();
      } catch (error) {
        if (t.planner.requestId && plannerActive(t.planner))
          this.deps.planner.cancel(t.planner.requestId);
        if (!this.view.error) {
          t.planner = {
            ...t.planner,
            revision: t.planner.revision + 1,
            status: "failed",
            result: undefined,
            error: {
              code:
                error instanceof AgentToolError
                  ? error.code
                  : "CHAT_SEND_FAILED",
              message:
                error instanceof AgentToolError
                  ? error.message
                  : "需求未发送，请检查对话状态后重试。",
            },
          };
          this.touch();
          await this.persist();
        }
        throw error;
      }
      await this.reconcile();
      return structuredClone(this.view);
    });
  }
  cancel(input: unknown) {
    return this.mutate(async () => {
      const v = agentObject(input, ["sessionId", "turnId"]);
      const s = this.session(v.sessionId);
      const t = s.turns.find((turn) => turn.id === v.turnId);
      if (!t)
        throw new AgentToolError("CHAT_TURN_MISMATCH", "本会话没有对应轮次");
      await this.reconcile();
      if (!plannerActive(t.planner)) return structuredClone(this.view);
      const live = this.deps.planner.snapshot();
      if (!t.planner.requestId || live.requestId !== t.planner.requestId)
        throw new AgentToolError(
          "CHAT_TURN_MISMATCH",
          "当前模型请求已变化，不能取消其他轮次",
        );
      t.planner = this.deps.planner.cancel(t.planner.requestId);
      this.touch();
      await this.persist();
      return structuredClone(this.view);
    });
  }
  async close() {
    this.closed = true;
    this.unsubscribe();
    this.listeners.clear();
    await this.initialized;
    await this.reconcile().catch(() => {});
    await this.writes;
  }
}
