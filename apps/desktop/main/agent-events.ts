import { AgentToolError, agentObject } from "../../../packages/protocol/agent";
import type {
  AgentEvent,
  AgentEventInput,
  AgentEventPage,
  AgentEventQuery,
  AgentEventStore,
} from "../../../packages/protocol/agent-events";
import { sanitizeAgentEventDetails } from "../../../packages/protocol/agent-events";

interface Dependencies {
  load?(): Promise<AgentEventStore | undefined>;
  save(view: AgentEventStore): Promise<void>;
  archive?(events: AgentEvent[]): Promise<void>;
  history?(query: {
    afterSeq: number;
    beforeSeq: number;
    requestId?: string;
    limit: number;
  }): Promise<AgentEvent[]>;
  verifyCoverage?(query: {
    afterSeq: number;
    beforeSeq: number;
  }): Promise<boolean>;
  maxEvents?: number;
}
const kinds = [
  "intent",
  "planner-state",
  "tool-requested",
  "tool-started",
  "tool-result",
  "model-attempt",
  "model-usage",
  "model-finished",
  "model-error",
  "game-step",
  "game-result",
  "correction",
  "command",
  "recovery",
];
const statuses = [
  "running",
  "succeeded",
  "failed",
  "unknown",
  "cancelled",
  "blocked",
];
const unavailable = () =>
  new AgentToolError(
    "AGENT_EVENT_STORE_UNAVAILABLE",
    "Agent事件记录无法可靠保存；请查看原任务记录，新的Agent执行已暂停。",
  );
const identifier = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_:.-]{1,240}$/.test(v);
function validInput(v: AgentEventInput) {
  try {
    sanitizeAgentEventDetails(v?.details);
  } catch {
    return false;
  }
  return (
    !!v &&
    Object.keys(v).every((key) =>
      [
        "requestId",
        "parentRequestId",
        "sessionId",
        "turnId",
        "callId",
        "runId",
        "laneId",
        "gameId",
        "stepId",
        "tool",
        "kind",
        "status",
        "text",
        "usage",
        "details",
        "seq",
        "at",
      ].includes(key),
    ) &&
    identifier(v.requestId) &&
    kinds.includes(v.kind) &&
    statuses.includes(v.status) &&
    typeof v.text === "string" &&
    v.text.length <= 4000 &&
    [
      v.parentRequestId,
      v.sessionId,
      v.turnId,
      v.callId,
      v.runId,
      v.laneId,
      v.gameId,
      v.stepId,
      v.tool,
    ].every((x) => x === undefined || identifier(x)) &&
    (v.usage === undefined ||
      (!!v.usage &&
        typeof v.usage === "object" &&
        !Array.isArray(v.usage) &&
        Object.entries(v.usage).every(
          ([key, n]) =>
            [
              "inputTokens",
              "outputTokens",
              "totalTokens",
              "cachedInputTokens",
              "reasoningOutputTokens",
            ].includes(key) &&
            Number.isSafeInteger(n) &&
            n >= 0,
        )))
  );
}
function validEvent(v: AgentEvent) {
  return (
    validInput(v) &&
    Number.isSafeInteger(v.seq) &&
    v.seq > 0 &&
    typeof v.at === "string" &&
    v.at.length <= 50 &&
    Number.isFinite(Date.parse(v.at))
  );
}
/** Append-only semantic history. Its replay is data, never a device command. */
export class AgentEventJournal {
  private view: AgentEventStore = { version: 1, nextSeq: 1, events: [] };
  private error?: string;
  private writes = Promise.resolve();
  private initialized: Promise<void>;
  private listeners = new Set<(event: AgentEvent) => void>();
  constructor(private deps: Dependencies) {
    if (
      deps.maxEvents !== undefined &&
      (!Number.isInteger(deps.maxEvents) ||
        deps.maxEvents < 1 ||
        deps.maxEvents > 2048)
    )
      throw new Error("Agent事件预算无效");
    this.initialized = this.restore();
  }
  private async restore() {
    try {
      const v = await this.deps.load?.();
      if (!v) return;
      if (
        v.version !== 1 ||
        !Number.isSafeInteger(v.nextSeq) ||
        v.nextSeq < 1 ||
        !Array.isArray(v.events) ||
        v.events.length > (this.deps.maxEvents ?? 2048) ||
        v.events.some(
          (e, i) =>
            !validEvent(e) || (i > 0 && e.seq !== v.events[i - 1].seq + 1),
        ) ||
        (v.events.length && v.events.at(-1)!.seq + 1 !== v.nextSeq)
      )
        throw unavailable();
      this.view = {
        ...structuredClone(v),
        events: v.events.map(publicEvent),
      };
    } catch {
      this.error = unavailable().message;
    }
  }
  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async assertReady() {
    await this.initialized;
    await this.writes;
    if (this.error) throw unavailable();
  }
  append(input: AgentEventInput): Promise<AgentEvent> {
    if (!validInput(input) || "seq" in input || "at" in input)
      return Promise.reject(
        new AgentToolError("INVALID_AGENT_EVENT", "Agent事件字段无效"),
      );
    const captured: AgentEventInput = {
      ...structuredClone(input),
      ...(input.details === undefined
        ? {}
        : {
            details: sanitizeAgentEventDetails(input.details),
          }),
    };
    const job = this.writes.then(async () => {
      await this.initialized;
      if (this.error) throw unavailable();
      const event: AgentEvent = {
        ...captured,
        seq: this.view.nextSeq,
        at: new Date().toISOString(),
      };
      let events = this.view.events;
      try {
        if (events.length >= (this.deps.maxEvents ?? 2048)) {
          if (!this.deps.archive) throw unavailable();
          // Deterministic archive names make retry after an incomplete rotation harmless.
          await this.deps.archive(structuredClone(events));
          events = [];
        }
        const next: AgentEventStore = {
          version: 1,
          nextSeq: event.seq + 1,
          events: [...events, event],
        };
        await this.deps.save(next);
        this.view = next;
      } catch {
        this.error = unavailable().message;
        throw unavailable();
      }
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(event));
        } catch {
          /* An observer cannot alter the committed history. */
        }
      }
      return structuredClone(event);
    });
    this.writes = job.then(
      () => {},
      () => {},
    );
    return job;
  }
  async page(query: AgentEventQuery = {}): Promise<AgentEventPage> {
    agentObject(query, ["afterSeq", "requestId", "limit"]);
    const afterSeq = query.afterSeq ?? 0,
      limit = query.limit ?? 128;
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 512 ||
      (query.requestId !== undefined && !identifier(query.requestId))
    )
      throw new AgentToolError(
        "INVALID_EVENT_CURSOR",
        "事件游标或分页参数无效",
      );
    await this.initialized;
    await this.writes;
    const cut = structuredClone(this.view);
    const first = cut.events[0]?.seq ?? cut.nextSeq;
    let prior: AgentEvent[] = [];
    let historyGap = false;
    try {
      if (afterSeq < first - 1 && this.deps.history) {
        historyGap = this.deps.verifyCoverage
          ? !(await this.deps.verifyCoverage({ afterSeq, beforeSeq: first }))
          : !query.requestId
            ? false
            : true;
        prior = await this.deps.history({
          afterSeq,
          beforeSeq: first,
          requestId: query.requestId,
          limit: limit + 1,
        });
        if (
          prior.some(
            (e) =>
              !validEvent(e) ||
              e.seq <= afterSeq ||
              e.seq >= first ||
              (query.requestId &&
                e.requestId !== query.requestId &&
                e.parentRequestId !== query.requestId),
          )
        )
          throw unavailable();
      }
    } catch {
      this.error = unavailable().message;
    }
    const matches = [
      ...prior,
      ...cut.events.filter(
        (e) =>
          e.seq > afterSeq &&
          (!query.requestId ||
            e.requestId === query.requestId ||
            e.parentRequestId === query.requestId),
      ),
    ]
      .sort((a, b) => a.seq - b.seq)
      .filter((e, i, a) => i === 0 || e.seq !== a[i - 1].seq);
    const events = matches.slice(0, limit).map(publicEvent);
    return {
      version: 1,
      events,
      cursor: events.at(-1)?.seq ?? afterSeq,
      latestSeq: cut.nextSeq - 1,
      hasMore: matches.length > limit,
      ...(historyGap ||
      (!query.requestId && events.length && events[0].seq > afterSeq + 1)
        ? { gap: true }
        : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  async close() {
    await this.initialized;
    await this.writes;
    this.listeners.clear();
  }
}
function publicEvent(event: AgentEvent): AgentEvent {
  return {
    ...structuredClone(event),
    ...(event.details === undefined
      ? {}
      : {
          details: sanitizeAgentEventDetails(event.details),
        }),
  };
}
