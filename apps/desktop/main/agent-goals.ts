import { randomUUID } from "node:crypto";
import { AgentToolError } from "../../../packages/protocol/agent";
import {
  goalExecutionTerminal,
  type GoalCreateInput,
  type GoalFrozenPlanReference,
  type GoalObservation,
  type GoalOwner,
  type GoalReceipt,
  type GoalRecoveryReference,
  type GoalReview,
  type GoalRun,
  type GoalScope,
  type GoalSelection,
  type GoalStore,
  type GoalView,
  type GoalPreferences,
  type GoalStopVerification,
} from "../../../packages/protocol/agent-goal";
import type { ChatCommandSummary } from "../../../packages/protocol/chat-commands";
import { goalResultReport } from "../../../games/goal-report";

export interface PreparedGoal {
  fingerprint: string;
  summary: ChatCommandSummary[];
  /** Host-owned frozen launch payload, held in memory only. */
  payload: unknown;
  frozenPlan: GoalFrozenPlanReference;
  scopes: GoalScope[];
  expiresAt?: string;
}
export interface GoalServiceDependencies {
  load?(): Promise<GoalStore | undefined>;
  save(store: GoalStore): Promise<void>;
  prepare(
    goal: GoalRun,
    selection: GoalSelection,
    signal?: AbortSignal,
  ): Promise<PreparedGoal>;
  /** Must honor the durably reserved batch/request IDs and the supplied abort signal. */
  submit(
    goal: GoalRun,
    prepared: PreparedGoal,
    signal?: AbortSignal,
  ): Promise<GoalReceipt>;
  observe(goal: GoalRun): Promise<GoalObservation>;
  stop(goal: GoalRun): Promise<GoalObservation>;
  recover?(
    goal: GoalRun,
    recovery: GoalRecoveryReference,
  ): Promise<PreparedGoal>;
  now?: () => Date;
  onTerminal?(goal: GoalRun): void | Promise<void>;
}
const statuses = [
  "preparing",
  "running",
  "waiting",
  "recovering",
  "needs-user",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
  "unknown",
];
const identifier = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_:.-]{1,240}$/.test(v);
const timestamp = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 50 && Number.isFinite(Date.parse(v));
const textValue = (v: unknown, max = 12000): v is string =>
  typeof v === "string" && v.length <= max;
const uniqueIds = (v: unknown, max = 64): v is string[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= max &&
  v.every(identifier) &&
  new Set(v).size === v.length;
const resources = (v: unknown): v is Record<string, number> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length <= 32 &&
  Object.entries(v).every(
    ([k, n]) => identifier(k) && Number.isSafeInteger(n) && n >= 0,
  );
const validScope = (v: GoalScope) =>
  !!v &&
  identifier(v.laneId) &&
  identifier(v.gameId) &&
  uniqueIds(v.skillIds) &&
  resources(v.resources);
const validScopes = (v: unknown): v is GoalScope[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= 16 &&
  v.every(validScope) &&
  new Set(v.map((s) => `${s.laneId}:${s.gameId}`)).size === v.length;
const safeText = (v: string, max = 12000) =>
  v
    .slice(0, max)
    .replace(/\bBearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{12,}/g, "[已隐藏]")
    .replace(
      /((?:api[_ -]?key|password|secret|token|密码|密钥)\s*[:=]\s*)[^\s,;，；]+/gi,
      "$1[已隐藏]",
    );
const unavailable = () =>
  new AgentToolError(
    "GOAL_STORE_UNAVAILABLE",
    "目标记录无法可靠保存；请核对原请求，新的目标动作已暂停。",
  );
function validReference(v: GoalFrozenPlanReference) {
  return (
    !!v &&
    ["saved-daily", "custom", "continuation"].includes(v.kind) &&
    textValue(v.hash, 200) &&
    !!v.hash &&
    (v.plannerRequestId === undefined || identifier(v.plannerRequestId)) &&
    (v.parentRequestId === undefined || identifier(v.parentRequestId))
  );
}
function validReceipt(v: GoalReceipt) {
  return !!v && identifier(v.batchId) && uniqueIds(v.requestIds, 16);
}
function validReview(v: GoalReview) {
  return (
    !!v &&
    identifier(v.id) &&
    textValue(v.fingerprint, 200) &&
    !!v.fingerprint &&
    timestamp(v.reviewedAt) &&
    timestamp(v.expiresAt) &&
    validReference(v.frozenPlan) &&
    validScopes(v.scopes) &&
    Array.isArray(v.summary) &&
    v.summary.length <= 16 &&
    v.summary.every(
      (s) =>
        !!s &&
        textValue(s.laneName, 200) &&
        Array.isArray(s.games) &&
        s.games.length <= 8 &&
        s.games.every(
          (g) =>
            identifier(g.gameId) &&
            textValue(g.title, 200) &&
            Array.isArray(g.steps) &&
            g.steps.length <= 64 &&
            g.steps.every((step) => textValue(step, 200)),
        ),
    )
  );
}
function validSelection(v: GoalSelection) {
  return (
    !!v &&
    ["saved-daily", "custom", "continuation"].includes(v.kind) &&
    (v.laneIds === undefined || uniqueIds(v.laneIds, 8)) &&
    (v.dailyScope === undefined ||
      (v.kind === "saved-daily" && ["saved", "both"].includes(v.dailyScope))) &&
    (v.plannerRequestId === undefined || identifier(v.plannerRequestId)) &&
    (v.planHash === undefined ||
      (textValue(v.planHash, 200) && !!v.planHash)) &&
    (v.kind !== "custom" || (identifier(v.plannerRequestId) && !!v.planHash)) &&
    (v.kind === "continuation"
      ? identifier(v.parentRequestId) &&
        typeof v.parentFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(v.parentFingerprint) &&
        v.laneIds?.length === 1 &&
        v.planHash === undefined &&
        v.plannerRequestId === undefined
      : v.parentRequestId === undefined && v.parentFingerprint === undefined)
  );
}
function validGrant(v: GoalRun["grant"]) {
  return (
    !!v &&
    identifier(v.id) &&
    ["user-message", "saved-policy", "local-confirmation"].includes(v.source) &&
    (v.source !== "local-confirmation" ||
      (textValue(v.planHash, 200) && !!v.planHash)) &&
    identifier(v.sessionId) &&
    identifier(v.turnId) &&
    timestamp(v.issuedAt) &&
    timestamp(v.expiresAt) &&
    Date.parse(v.expiresAt) > Date.parse(v.issuedAt) &&
    [0, 1, 2].includes(v.maxRetries) &&
    validScopes(v.scopes) &&
    (v.revokedAt === undefined || timestamp(v.revokedAt)) &&
    (v.policyId === undefined || identifier(v.policyId)) &&
    (v.source !== "saved-policy" || identifier(v.policyId))
  );
}
function validObservation(v: GoalObservation) {
  return (
    !!v &&
    Array.isArray(v.requests) &&
    v.requests.length <= 128 &&
    typeof v.flowComplete === "boolean" &&
    [true, false, null].includes(v.goalSatisfied) &&
    textValue(v.summary, 4000) &&
    v.requests.every(
      (r) =>
        !!r &&
        identifier(r.requestId) &&
        ["running", "succeeded", "failed", "cancelled", "unknown"].includes(
          r.status,
        ) &&
        (r.rootRequestId === undefined || identifier(r.rootRequestId)) &&
        (r.originalStatus === undefined ||
          ["running", "succeeded", "failed", "cancelled", "unknown"].includes(
            r.originalStatus,
          )) &&
        (r.laneId === undefined || identifier(r.laneId)) &&
        (r.gameId === undefined || identifier(r.gameId)) &&
        typeof r.flowComplete === "boolean" &&
        [true, false, null].includes(r.goalSatisfied) &&
        Array.isArray(r.skills) &&
        r.skills.length <= 64 &&
        r.skills.every(
          (s) =>
            identifier(s.skillId) &&
            (s.gameId === undefined || identifier(s.gameId)) &&
            textValue(s.status, 100) &&
            [true, false, null].includes(s.goalSatisfied) &&
            textValue(s.summary, 1000) &&
            (s.skipReason === undefined || textValue(s.skipReason, 200)) &&
            (s.evidenceTimestamp === undefined ||
              timestamp(s.evidenceTimestamp)) &&
            (s.evidenceReference === undefined ||
              textValue(s.evidenceReference, 500)) &&
            (s.effectEvidence === undefined ||
              (Array.isArray(s.effectEvidence) &&
                s.effectEvidence.length <= 32 &&
                s.effectEvidence.every(
                  (effect) =>
                    !!effect &&
                    identifier(effect.kind) &&
                    timestamp(effect.observedAt) &&
                    textValue(effect.evidenceReference, 500) &&
                    !!effect.evidenceReference.trim() &&
                    textValue(effect.summary, 1000) &&
                    !!effect.summary.trim(),
                ))),
        ),
    ) &&
    (v.recovery === undefined || validRecovery(v.recovery)) &&
    (v.stopVerification === undefined ||
      validStopVerification(v.stopVerification))
  );
}
function validStopVerification(v: GoalStopVerification) {
  return (
    !!v &&
    v.verified === true &&
    uniqueIds(v.requestIds, 48) &&
    timestamp(v.observedAt) &&
    textValue(v.evidenceReference, 500) &&
    !!v.evidenceReference.trim()
  );
}
function validRecovery(v: GoalRecoveryReference) {
  if (
    !v ||
    !validScope(v) ||
    !identifier(v.requestId) ||
    !identifier(v.reference) ||
    !v.safety ||
    !textValue(v.safety.fingerprint, 200) ||
    !v.safety.fingerprint ||
    !timestamp(v.safety.observedAt)
  )
    return false;
  const remaining = v.remainingScopes ?? [v];
  if (
    !validScopes(remaining) ||
    remaining.some((scope) => scope.laneId !== v.laneId) ||
    !remaining.some(
      (scope) =>
        scope.gameId === v.gameId &&
        scope.skillIds.every((id) => v.skillIds.includes(id)) &&
        v.skillIds.every((id) => scope.skillIds.includes(id)),
    )
  )
    return false;
  const proof = v.safety;
  return (
    (proof.kind === "native-not-submitted" &&
      proof.nativeSubmission === "not-submitted" &&
      (proof.accountProof === "verified-current" ||
        (proof.accountProof === "login-gate-before-effects" &&
          remaining.every((scope) => scope.skillIds[0] === "login")))) ||
    (proof.kind === "bounded-navigation" &&
      proof.nativeSubmission === "known" &&
      (proof.accountProof === "verified-current" ||
        (proof.accountProof === "login-gate-before-effects" &&
          remaining.every((scope) => scope.skillIds[0] === "login"))))
  );
}
function validPreferences(v: GoalPreferences) {
  return (
    !!v &&
    v.version === 1 &&
    Number.isSafeInteger(v.revision) &&
    v.revision >= 0 &&
    resources(v.resourceLimits) &&
    Array.isArray(v.excludedSkills) &&
    v.excludedSkills.length <= 16 &&
    v.excludedSkills.every(
      (entry) => identifier(entry.gameId) && uniqueIds(entry.skillIds),
    ) &&
    new Set(v.excludedSkills.map((entry) => entry.gameId)).size ===
      v.excludedSkills.length
  );
}
function validGoal(v: GoalRun) {
  return (
    !!v &&
    v.version === 1 &&
    identifier(v.id) &&
    Number.isSafeInteger(v.revision) &&
    v.revision > 0 &&
    identifier(v.sessionId) &&
    identifier(v.turnId) &&
    textValue(v.prompt) &&
    !!v.prompt &&
    validSelection(v.selection) &&
    validGrant(v.grant) &&
    v.grant.sessionId === v.sessionId &&
    v.grant.turnId === v.turnId &&
    timestamp(v.createdAt) &&
    timestamp(v.updatedAt) &&
    statuses.includes(v.status) &&
    textValue(v.message, 4000) &&
    Number.isInteger(v.retryCount) &&
    v.retryCount >= 0 &&
    v.retryCount <= v.grant.maxRetries &&
    Array.isArray(v.attempts) &&
    v.attempts.length <= 3 &&
    v.attempts.every(
      (a, i) =>
        validReview(a.review) &&
        validReceipt(a.submission) &&
        a.submission.attempt === i &&
        timestamp(a.submission.acceptedAt) &&
        ["accepted", "received", "unknown"].includes(a.submission.state) &&
        (a.receipt === undefined || validReceipt(a.receipt)),
    ) &&
    (v.originalReview === undefined || validReview(v.originalReview)) &&
    (v.review === undefined || validReview(v.review)) &&
    (v.submission === undefined ||
      (validReceipt(v.submission) &&
        Number.isInteger(v.submission.attempt) &&
        v.submission.attempt >= 0 &&
        v.submission.attempt <= 2 &&
        timestamp(v.submission.acceptedAt) &&
        ["accepted", "received", "unknown"].includes(v.submission.state))) &&
    (v.receipt === undefined || validReceipt(v.receipt)) &&
    validObservation({
      requests: v.requests,
      flowComplete: v.flowComplete,
      goalSatisfied: v.goalSatisfied,
      summary: v.message,
      recovery: v.recovery,
      stopVerification: v.stopVerification,
    }) &&
    (v.resultNotification === undefined ||
      (Number.isSafeInteger(v.resultNotification.revision) &&
        v.resultNotification.revision > 0 &&
        v.resultNotification.revision <= v.revision &&
        ["pending", "delivering", "delivered"].includes(
          v.resultNotification.state,
        ))) &&
    (v.publicReply === undefined ||
      (textValue(v.publicReply.text) &&
        timestamp(v.publicReply.at) &&
        (v.publicReply.model === undefined ||
          textValue(v.publicReply.model, 200))))
  );
}
function assertSubset(scopes: GoalScope[], allowed: GoalScope[]) {
  if (!validScopes(scopes))
    throw new AgentToolError(
      "GOAL_SCOPE_INVALID",
      "冻结计划缺少可核对的账号、游戏、技能或资源范围。",
    );
  for (const scope of scopes) {
    const authority = allowed.find(
      (s) => s.laneId === scope.laneId && s.gameId === scope.gameId,
    );
    if (
      !authority ||
      scope.skillIds.some((s) => !authority.skillIds.includes(s)) ||
      Object.entries(scope.resources).some(
        ([k, n]) => n > (authority.resources[k] ?? 0),
      )
    )
      throw new AgentToolError(
        "GOAL_SCOPE_EXCEEDED",
        "本次计划超出已授权的账号、游戏、技能或资源范围，需要当前用户处理。",
      );
  }
}
/** Each original lane remains an obligation when a different lane receives a continuation. */
function requiredRequests(goal: GoalRun) {
  const lanes = new Map<string, string>();
  for (const attempt of goal.attempts) {
    for (const laneId of new Set(
      attempt.review.scopes.map((scope) => scope.laneId),
    )) {
      const requestId = attempt.submission.requestIds.find(
        (id) => id === `${attempt.submission.batchId}:${laneId}`,
      );
      if (requestId) lanes.set(laneId, requestId);
    }
  }
  return [...lanes.values()];
}

/** Persistent host lifecycle. It observes the one executor and never replays accepted actions. */
export class GoalService {
  private view: GoalStore = { version: 1, revision: 0, goals: [] };
  private error?: string;
  private initialized: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private operations = new Map<string, Promise<GoalRun>>();
  private controllers = new Map<string, AbortController>();
  private cancelRequested = new Set<string>();
  private restored = new Set<string>();
  private listeners = new Set<(view: GoalView) => void>();
  private terminalListeners = new Set<(goal: GoalRun) => void>();
  private notified = new Set<string>();
  private observationVersions = new Map<string, number>();
  private now: () => Date;
  constructor(private deps: GoalServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.initialized = this.restore();
  }
  private async restore() {
    try {
      const store = await this.deps.load?.();
      if (!store) return;
      if (
        store.version !== 1 ||
        !Number.isSafeInteger(store.revision) ||
        store.revision < 0 ||
        !Array.isArray(store.goals) ||
        store.goals.length > 256 ||
        store.goals.some((g) => !validGoal(g)) ||
        (store.preferences && !validPreferences(store.preferences)) ||
        new Set(store.goals.map((g) => g.id)).size !== store.goals.length ||
        new Set(store.goals.map((g) => `${g.sessionId}:${g.turnId}`)).size !==
          store.goals.length
      )
        throw unavailable();
      this.view = structuredClone(store);
      store.goals.forEach((g) => {
        this.restored.add(g.id);
        if (g.cancelledAt) this.cancelRequested.add(g.id);
      });
    } catch {
      this.error = unavailable().message;
    }
  }
  async ready() {
    await this.initialized;
    if (this.error) throw unavailable();
  }
  async flush() {
    await this.initialized;
    await this.writes;
    if (this.error) throw unavailable();
  }
  snapshot(sessionId?: string): GoalView {
    return structuredClone({
      revision: this.view.revision,
      goals: this.view.goals.filter(
        (g) => !sessionId || g.sessionId === sessionId,
      ),
      ...(this.view.preferences ? { preferences: this.view.preferences } : {}),
      ...(this.error ? { error: this.error } : {}),
    });
  }
  preferences(): GoalPreferences {
    return structuredClone(
      this.view.preferences ?? {
        version: 1,
        revision: 0,
        resourceLimits: {},
        excludedSkills: [],
      },
    );
  }
  /** Local preferences narrow future admission and recovery; they never create an execution grant. */
  async setPreferences(
    input: Pick<GoalPreferences, "resourceLimits" | "excludedSkills">,
  ): Promise<GoalPreferences> {
    await this.ready();
    const next = { version: 1 as const, revision: 0, ...input };
    if (!validPreferences(next))
      throw new AgentToolError(
        "INVALID_GOAL_PREFERENCES",
        "资源上限和排除技能偏好字段无效。",
      );
    await this.commit((view) => {
      view.preferences = {
        version: 1,
        revision: (view.preferences?.revision ?? 0) + 1,
        resourceLimits: structuredClone(input.resourceLimits),
        excludedSkills: structuredClone(input.excludedSkills),
      };
    });
    return this.preferences();
  }
  get(goalId: string, owner: GoalOwner): GoalRun {
    const g = this.view.goals.find((goal) => goal.id === goalId);
    if (!g || g.sessionId !== owner.sessionId)
      throw new AgentToolError("GOAL_OWNER_MISMATCH", "目标不属于当前会话。");
    return structuredClone(g);
  }
  private assertOwner(goalId: string, owner: GoalOwner, originalTurn = false) {
    const goal = this.get(goalId, owner);
    if (originalTurn && goal.turnId !== owner.turnId)
      throw new AgentToolError(
        "GOAL_TURN_MISMATCH",
        "新的执行只能使用原目标当前授权，旧聊天不能授权新动作。",
      );
    return goal;
  }
  subscribe(listener: (view: GoalView) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeTerminal(listener: (goal: GoalRun) => void) {
    this.terminalListeners.add(listener);
    void this.initialized.then(() => this.notify());
    return () => this.terminalListeners.delete(listener);
  }
  private notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* An observer cannot change durable facts. */
      }
    }
    for (const goal of this.view.goals) {
      const key = `${goal.id}:${goal.resultNotification?.revision}`;
      if (
        !goalExecutionTerminal(goal) ||
        goal.resultNotification?.state !== "pending" ||
        this.notified.has(key) ||
        (!this.terminalListeners.size && !this.deps.onTerminal)
      )
        continue;
      this.notified.add(key);
      for (const listener of this.terminalListeners) {
        try {
          listener(structuredClone(goal));
        } catch {
          /* Delivery can be acknowledged separately. */
        }
      }
      try {
        void Promise.resolve(
          this.deps.onTerminal?.(structuredClone(goal)),
        ).catch(() => {});
      } catch {
        /* Retain the pending delivery marker. */
      }
    }
  }
  private commit(
    change: (view: GoalStore) => void,
    onCommitted?: () => void,
  ): Promise<void> {
    const job = this.writes.then(async () => {
      await this.ready();
      const next = structuredClone(this.view);
      change(next);
      next.revision++;
      try {
        await this.deps.save(structuredClone(next));
      } catch {
        this.error = unavailable().message;
        this.view.goals = this.view.goals.map((g) =>
          goalExecutionTerminal(g) &&
          !["unknown", "needs-user"].includes(g.status)
            ? g
            : {
                ...g,
                status: "unknown",
                message: this.error!,
                goalSatisfied: null,
              },
        );
        this.notify();
        throw unavailable();
      }
      this.view = next;
      onCommitted?.();
      this.notify();
    });
    this.writes = job.catch(() => {});
    return job;
  }
  private update(
    goalId: string,
    mutate: (goal: GoalRun) => void,
    onCommitted?: () => void,
  ) {
    return this.commit((view) => {
      const goal = view.goals.find((g) => g.id === goalId)!;
      const priorStatus = goal.status;
      mutate(goal);
      goal.revision++;
      goal.updatedAt = this.now().toISOString();
      if (goalExecutionTerminal(goal) && goal.status !== priorStatus)
        goal.resultNotification = { revision: goal.revision, state: "pending" };
    }, onCommitted);
  }
  async create(input: GoalCreateInput): Promise<GoalRun> {
    await this.ready();
    if (
      !identifier(input.sessionId) ||
      !identifier(input.turnId) ||
      !textValue(input.prompt) ||
      !input.prompt.trim() ||
      !validSelection(input.selection) ||
      !validGrant(input.grant) ||
      input.grant.sessionId !== input.sessionId ||
      input.grant.turnId !== input.turnId
    )
      throw new AgentToolError(
        "INVALID_GOAL",
        "目标需要当前会话、原始消息与宿主授权范围。",
      );
    let goalId = "";
    await this.commit((view) => {
      const existing = view.goals.find(
        (g) => g.sessionId === input.sessionId && g.turnId === input.turnId,
      );
      if (existing) {
        goalId = existing.id;
        return;
      }
      if (view.goals.length >= 256)
        throw new AgentToolError(
          "GOAL_BUDGET_EXCEEDED",
          "目标记录已达到预算，请先整理历史目标。",
        );
      const stamp = this.now().toISOString();
      goalId = `goal-${randomUUID()}`;
      view.goals.push({
        version: 1,
        id: goalId,
        revision: 1,
        sessionId: input.sessionId,
        turnId: input.turnId,
        prompt: safeText(input.prompt),
        selection: structuredClone(input.selection),
        grant: structuredClone(input.grant),
        createdAt: stamp,
        updatedAt: stamp,
        status: "preparing",
        message: "正在准备目标，尚未提交游戏动作。",
        attempts: [],
        retryCount: 0,
        requests: [],
        flowComplete: false,
        goalSatisfied: null,
      });
    });
    return this.get(goalId, input);
  }
  private async withOperation(
    goalId: string,
    operation: () => Promise<GoalRun>,
  ) {
    const existing = this.operations.get(goalId);
    if (existing) return existing;
    const job = operation();
    this.operations.set(goalId, job);
    try {
      return await job;
    } finally {
      if (this.operations.get(goalId) === job) this.operations.delete(goalId);
    }
  }
  private authorized(
    goal: GoalRun,
    prepared: PreparedGoal,
    recovery?: GoalRecoveryReference,
  ) {
    const now = this.now().getTime();
    if (
      goal.grant.revokedAt ||
      this.cancelRequested.has(goal.id) ||
      now < Date.parse(goal.grant.issuedAt) - 60_000 ||
      now >= Date.parse(goal.grant.expiresAt)
    )
      throw new AgentToolError(
        "GOAL_GRANT_EXPIRED",
        "本次目标授权已撤销或过期，需要当前用户重新处理。",
      );
    if (
      !textValue(prepared.fingerprint, 200) ||
      !prepared.fingerprint ||
      !validReference(prepared.frozenPlan)
    )
      throw new AgentToolError(
        "GOAL_REVIEW_INVALID",
        "冻结计划的检查指纹或引用无法核对。",
      );
    if (
      prepared.expiresAt !== undefined &&
      (!timestamp(prepared.expiresAt) || now >= Date.parse(prepared.expiresAt))
    )
      throw new AgentToolError("GOAL_REVIEW_EXPIRED", "冻结计划检查已过期。");
    assertSubset(prepared.scopes, goal.grant.scopes);
    if (
      !recovery &&
      goal.grant.source === "local-confirmation" &&
      prepared.fingerprint !== goal.grant.planHash
    )
      throw new AgentToolError(
        "GOAL_PLAN_CHANGED",
        "账号或配置与本地确认的指纹不一致，请重新检查并确认。",
      );
    const preferences = this.preferences();
    if (
      prepared.scopes.some(
        (scope) =>
          scope.skillIds.some((skillId) =>
            preferences.excludedSkills.some(
              (entry) =>
                entry.gameId === scope.gameId &&
                entry.skillIds.includes(skillId),
            ),
          ) ||
          Object.entries(scope.resources).some(
            ([resource, count]) =>
              preferences.resourceLimits[resource] !== undefined &&
              count > preferences.resourceLimits[resource],
          ),
      )
    )
      throw new AgentToolError(
        "GOAL_PREFERENCE_EXCEEDED",
        "本次冻结计划包含已排除技能或超出保存的资源上限，需要重新检查计划。",
      );
    if (
      goal.selection.laneIds &&
      prepared.scopes.some((s) => !goal.selection.laneIds!.includes(s.laneId))
    )
      throw new AgentToolError(
        "GOAL_SELECTION_CHANGED",
        "冻结计划超出本次选择的账号。",
      );
    if (
      !recovery &&
      (prepared.frozenPlan.kind !== goal.selection.kind ||
        (goal.selection.planHash &&
          goal.selection.planHash !== prepared.frozenPlan.hash) ||
        (goal.selection.plannerRequestId &&
          goal.selection.plannerRequestId !==
            prepared.frozenPlan.plannerRequestId) ||
        (goal.selection.kind === "continuation" &&
          (goal.selection.parentRequestId !==
            prepared.frozenPlan.parentRequestId ||
            goal.selection.parentFingerprint !== prepared.frozenPlan.hash)))
    )
      throw new AgentToolError(
        "GOAL_PLAN_CHANGED",
        "冻结计划与原始目标引用不一致。",
      );
    if (recovery) {
      assertSubset(prepared.scopes, goal.originalReview!.scopes);
      assertSubset(prepared.scopes, recovery.remainingScopes ?? [recovery]);
      if (
        prepared.frozenPlan.kind !== "continuation" ||
        prepared.frozenPlan.parentRequestId !== recovery.requestId
      )
        throw new AgentToolError(
          "GOAL_RECOVERY_CHANGED",
          "恢复计划必须引用原失败请求的已登记续跑。",
        );
      if (
        recovery.safety.accountProof === "login-gate-before-effects" &&
        prepared.scopes.some((scope) => scope.skillIds[0] !== "login")
      )
        throw new AgentToolError(
          "GOAL_LOGIN_GATE_REQUIRED",
          "登录前恢复必须先通过原账号身份检查，再执行后续步骤。",
        );
    }
  }
  private recoveryEligible(goal: GoalRun, recovery?: GoalRecoveryReference) {
    if (
      !recovery ||
      !validRecovery(recovery) ||
      !goal.originalReview ||
      !this.deps.recover ||
      goal.cancelledAt ||
      goal.grant.revokedAt ||
      goal.retryCount >= Math.min(2, goal.grant.maxRetries)
    )
      return false;
    const now = this.now().getTime(),
      observedAt = Date.parse(recovery.safety.observedAt);
    if (
      now >= Date.parse(goal.grant.expiresAt) ||
      observedAt > now + 60_000 ||
      now - observedAt > 15 * 60_000
    )
      return false;
    const failed = goal.requests.find(
      (result) => result.requestId === recovery.requestId,
    );
    if (!failed || !["failed", "unknown"].includes(failed.status)) return false;
    try {
      assertSubset(recovery.remainingScopes ?? [recovery], goal.grant.scopes);
      assertSubset(
        recovery.remainingScopes ?? [recovery],
        goal.originalReview.scopes,
      );
    } catch {
      return false;
    }
    return true;
  }
  /** The host turn may revoke initial admission only until its marker is durable. */
  async submit(
    goalId: string,
    owner: GoalOwner,
    preAdmissionSignal?: AbortSignal,
  ): Promise<GoalRun> {
    await this.ready();
    const original = this.assertOwner(goalId, owner, true);
    if (
      original.submission ||
      goalExecutionTerminal(original) ||
      this.restored.has(goalId)
    )
      return original;
    return this.withOperation(goalId, async () => {
      const controller = new AbortController();
      this.controllers.set(goalId, controller);
      const abortBeforeAdmission = () =>
        controller.abort(preAdmissionSignal?.reason);
      const detach = () =>
        preAdmissionSignal?.removeEventListener("abort", abortBeforeAdmission);
      preAdmissionSignal?.addEventListener("abort", abortBeforeAdmission, {
        once: true,
      });
      if (preAdmissionSignal?.aborted) abortBeforeAdmission();
      try {
        if (controller.signal.aborted)
          return await this.cancelBeforeDispatch(goalId, owner);
        const goal = this.get(goalId, owner);
        const prepared = await this.deps.prepare(
          goal,
          goal.selection,
          controller.signal,
        );
        if (this.cancelRequested.has(goalId)) return this.get(goalId, owner);
        if (controller.signal.aborted)
          return await this.cancelBeforeDispatch(goalId, owner);
        return await this.admit(
          goalId,
          owner,
          prepared,
          controller,
          undefined,
          detach,
        );
      } catch (error) {
        if (
          !this.error &&
          controller.signal.aborted &&
          !this.cancelRequested.has(goalId)
        )
          return await this.cancelBeforeDispatch(goalId, owner);
        return this.handleOperationError(goalId, owner, error);
      } finally {
        detach();
        this.controllers.delete(goalId);
      }
    });
  }
  private async cancelBeforeDispatch(goalId: string, owner: GoalOwner) {
    this.cancelRequested.add(goalId);
    await this.update(goalId, (goal) => {
      const stamp = this.now().toISOString();
      goal.cancelledAt = stamp;
      goal.grant.revokedAt = stamp;
      goal.status = "cancelled";
      goal.waitingReason = "aborted-before-dispatch";
      goal.message = "模型回合在派发前停止，未提交游戏动作。";
      goal.flowComplete = false;
      goal.goalSatisfied = null;
    });
    return this.get(goalId, owner);
  }
  private async admit(
    goalId: string,
    owner: GoalOwner,
    prepared: PreparedGoal,
    controller: AbortController,
    recovery?: GoalRecoveryReference,
    onDurableAdmission?: () => void,
  ) {
    let accepted = false;
    await this.update(
      goalId,
      (goal) => {
        if (
          this.cancelRequested.has(goalId) ||
          controller.signal.aborted ||
          goal.status === "cancelled" ||
          goal.status === "cancelling"
        )
          return;
        this.authorized(goal, prepared, recovery);
        const reviewedAt = this.now().toISOString();
        const review: GoalReview = {
          id: `review-${randomUUID()}`,
          fingerprint: prepared.fingerprint,
          reviewedAt,
          expiresAt: prepared.expiresAt ?? goal.grant.expiresAt,
          frozenPlan: structuredClone(prepared.frozenPlan),
          scopes: structuredClone(prepared.scopes),
          summary: structuredClone(prepared.summary),
        };
        if (!validReview(review))
          throw new AgentToolError(
            "GOAL_REVIEW_INVALID",
            "冻结计划清单无法核对。",
          );
        const attempt = goal.attempts.length;
        const batchId = `goal-${goal.id.replace(/^goal-/, "")}-attempt-${attempt}`;
        const submission = {
          batchId,
          requestIds: [...new Set(prepared.scopes.map((s) => s.laneId))].map(
            (id) => `${batchId}:${id}`,
          ),
          attempt,
          acceptedAt: reviewedAt,
          state: "accepted" as const,
          ...(recovery
            ? { parentRequestId: recovery.requestId }
            : goal.selection.kind === "continuation"
              ? { parentRequestId: goal.selection.parentRequestId }
              : {}),
        };
        goal.originalReview ??= review;
        goal.review = review;
        goal.submission = submission;
        goal.receipt = undefined;
        goal.attempts.push({ review, submission });
        if (recovery) goal.retryCount++;
        goal.status = recovery ? "recovering" : "running";
        goal.message = "已持久保存本次受理标记，正在提交原冻结计划。";
        goal.recovery = undefined;
        goal.flowComplete = false;
        goal.goalSatisfied = null;
        accepted = true;
      },
      () => {
        if (accepted) onDurableAdmission?.();
      },
    );
    if (this.cancelRequested.has(goalId)) return this.get(goalId, owner);
    if (controller.signal.aborted)
      return this.cancelBeforeDispatch(goalId, owner);
    if (!accepted) return this.get(goalId, owner);
    this.authorized(this.get(goalId, owner), prepared, recovery);
    const receipt = await this.deps.submit(
      this.get(goalId, owner),
      prepared,
      controller.signal,
    );
    const current = this.get(goalId, owner);
    if (
      !validReceipt(receipt) ||
      receipt.batchId !== current.submission!.batchId ||
      JSON.stringify(receipt.requestIds) !==
        JSON.stringify(current.submission!.requestIds)
    )
      throw new AgentToolError(
        "GOAL_RECEIPT_MISMATCH",
        "受理回执与原冻结请求不一致，不能确认动作结果。",
      );
    await this.update(goalId, (goal) => {
      goal.receipt = structuredClone(receipt);
      goal.submission!.state = "received";
      const attempt = goal.attempts.at(-1)!;
      attempt.submission.state = "received";
      attempt.receipt = structuredClone(receipt);
      if (!this.cancelRequested.has(goalId) && !goalExecutionTerminal(goal)) {
        goal.status = "waiting";
        goal.waitingReason = "executor-results";
        goal.message = "游戏执行器已受理；等待实际请求结果与目标判据。";
      }
    });
    if (this.cancelRequested.has(goalId))
      return this.stopAccepted(goalId, owner);
    return this.get(goalId, owner);
  }
  private async handleOperationError(
    goalId: string,
    owner: GoalOwner,
    error: unknown,
  ): Promise<GoalRun> {
    if (this.error) throw unavailable();
    const current = this.get(goalId, owner);
    if (this.cancelRequested.has(goalId)) {
      if (current.submission) return this.stopAccepted(goalId, owner);
      return current;
    }
    await this.update(goalId, (goal) => {
      goal.status = goal.submission ? "unknown" : "needs-user";
      goal.message = goal.submission
        ? "受理结果无法确认；保留原请求编号，先对账，不会重复提交。"
        : error instanceof AgentToolError
          ? safeText(error.message, 4000)
          : "执行条件无法完整核对，需要检查原目标与当前账号。";
      if (goal.submission) {
        goal.submission.state = "unknown";
        goal.attempts.at(-1)!.submission.state = "unknown";
      }
      goal.goalSatisfied = null;
    });
    return this.get(goalId, owner);
  }
  private nextObservation(goalId: string) {
    const version = (this.observationVersions.get(goalId) ?? 0) + 1;
    this.observationVersions.set(goalId, version);
    return version;
  }
  private async applyObservation(
    goalId: string,
    observation: GoalObservation,
    version?: number,
  ) {
    if (
      version !== undefined &&
      this.observationVersions.get(goalId) !== version
    )
      return;
    if (!validObservation(observation))
      throw new AgentToolError(
        "GOAL_RESULT_INVALID",
        "实际请求结果字段无法核对。",
      );
    await this.update(goalId, (goal) => {
      if (
        version !== undefined &&
        this.observationVersions.get(goalId) !== version
      )
        return;
      const acceptedIds = new Set(
        goal.attempts.flatMap((a) => a.submission.requestIds),
      );
      if (
        observation.requests.some((r) => !acceptedIds.has(r.requestId)) ||
        (observation.recovery &&
          !acceptedIds.has(observation.recovery.requestId))
      )
        throw new AgentToolError(
          "GOAL_RESULT_MISMATCH",
          "实际结果不属于原目标请求。",
        );
      const observed = new Map(
        observation.requests.map((r) => [r.requestId, r]),
      );
      const prior = new Map(goal.requests.map((r) => [r.requestId, r]));
      for (const [id, result] of observed)
        prior.set(id, {
          ...structuredClone(result),
          skills: result.skills.map((s) => ({
            ...s,
            summary: safeText(s.summary, 1000),
            ...(s.effectEvidence
              ? {
                  effectEvidence: s.effectEvidence.map((effect) => ({
                    ...effect,
                    summary: safeText(effect.summary, 1000),
                  })),
                }
              : {}),
          })),
        });
      goal.requests = [...prior.values()];
      const latest = requiredRequests(goal).map((id) => prior.get(id));
      const allKnown = !!latest?.length && latest.every((r) => !!r);
      const running = latest.some((r) => r?.status === "running");
      const scopeVerified = !!goal.originalReview?.scopes.every((scope) =>
        scope.skillIds.every((skillId) =>
          latest.some(
            (request) =>
              request?.laneId === scope.laneId &&
              request.skills.some(
                (skill) =>
                  skill.skillId === skillId &&
                  (skill.gameId ?? request.gameId) === scope.gameId &&
                  skill.goalSatisfied === true &&
                  timestamp(skill.evidenceTimestamp) &&
                  !!skill.evidenceReference,
              ),
          ),
        ),
      );
      goal.message = safeText(observation.summary, 4000);
      goal.flowComplete =
        observation.flowComplete &&
        allKnown &&
        latest!.every((r) => r!.status !== "running" && r!.flowComplete);
      goal.goalSatisfied = observation.goalSatisfied;
      goal.recovery = observation.recovery;
      if (this.cancelRequested.has(goalId)) {
        const proof = observation.stopVerification;
        const proofAt = proof && Date.parse(proof.observedAt);
        const latestAcceptedAt = Math.max(
          ...goal.attempts.map((a) => Date.parse(a.submission.acceptedAt)),
        );
        const now = this.now().getTime();
        const verifiedStop =
          !!proof &&
          acceptedIds.size > 0 &&
          proof.requestIds.length === acceptedIds.size &&
          proof.requestIds.every((id) => acceptedIds.has(id)) &&
          proofAt! >= latestAcceptedAt &&
          proofAt! <= now &&
          now - proofAt! <= 60_000;
        if (verifiedStop) goal.stopVerification = structuredClone(proof);
        // Terminal request receipts do not prove that a timed-out native worker exited.
        goal.status = verifiedStop
          ? "cancelled"
          : running
            ? "cancelling"
            : "unknown";
        goal.goalSatisfied = null;
        goal.waitingReason = verifiedStop ? undefined : "stop-not-verified";
        if (!verifiedStop)
          goal.message = "停止已请求，但原请求或设备停止结果尚无法确认。";
      } else if (running) {
        goal.status = "waiting";
        goal.waitingReason = "executor-results";
      } else if (this.recoveryEligible(goal, observation.recovery)) {
        goal.status = "recovering";
        goal.waitingReason = "registered-recovery";
      } else if (latest.some((r) => r?.status === "failed")) {
        goal.status = "needs-user";
        goal.waitingReason = "failed-request";
      } else if (
        !allKnown ||
        latest!.some((r) => r!.status === "unknown") ||
        !goal.flowComplete
      ) {
        goal.status = "unknown";
        goal.goalSatisfied = null;
        goal.waitingReason = "request-outcome-not-verified";
      } else if (
        observation.goalSatisfied === true &&
        scopeVerified &&
        latest!.every(
          (r) => r!.status === "succeeded" && r!.goalSatisfied === true,
        )
      ) {
        goal.status = "completed";
        goal.waitingReason = undefined;
      } else if (latest!.some((r) => r!.status === "cancelled")) {
        goal.status = "unknown";
        goal.goalSatisfied = null;
        goal.waitingReason = "stop-not-verified";
        goal.message = "请求已取消，但执行器停止尚未核实；原任务结果保留。";
      } else if (observation.goalSatisfied === false) {
        goal.status = "failed";
        goal.waitingReason = "goal-predicate-not-satisfied";
      } else {
        goal.status = "unknown";
        goal.goalSatisfied = null;
        goal.waitingReason = "goal-predicate-not-verified";
      }
    });
  }
  async refresh(goalId?: string): Promise<GoalRun[]> {
    await this.ready();
    const targets = this.view.goals.filter(
      (g) =>
        (!goalId || g.id === goalId) &&
        g.submission &&
        g.status !== "completed" &&
        g.status !== "cancelled",
    );
    await Promise.all(
      targets.map(async (goal) => {
        const version = this.nextObservation(goal.id);
        try {
          await this.applyObservation(
            goal.id,
            await this.deps.observe(structuredClone(goal)),
            version,
          );
        } catch (error) {
          if (this.error) throw error;
          if (this.observationVersions.get(goal.id) !== version) return;
          await this.update(goal.id, (g) => {
            g.status = "unknown";
            g.goalSatisfied = null;
            g.message = "原执行请求暂时无法可靠对账；不会重发游戏动作。";
          });
        }
      }),
    );
    return this.snapshot().goals.filter((g) => !goalId || g.id === goalId);
  }
  async reconcile() {
    await this.ready();
    for (const goal of [...this.view.goals]) {
      if (
        !this.restored.has(goal.id) ||
        (goalExecutionTerminal(goal) &&
          !["unknown", "needs-user"].includes(goal.status))
      )
        continue;
      if (!goal.submission) {
        await this.update(goal.id, (g) => {
          g.status = "unknown";
          g.goalSatisfied = null;
          g.waitingReason = "interrupted-before-admission";
          g.message =
            "上次目标准备被中断；先核对原消息与执行记录，不会自动启动。";
        });
      } else if (goal.cancelledAt) {
        await this.stopAccepted(goal.id, { sessionId: goal.sessionId });
      } else await this.refresh(goal.id);
    }
    this.notify();
  }
  async recover(goalId: string, owner: GoalOwner): Promise<GoalRun> {
    await this.ready();
    this.assertOwner(goalId, owner, true);
    return this.withOperation(goalId, async () => {
      const goal = this.get(goalId, owner);
      const recovery = goal.recovery;
      if (!this.recoveryEligible(goal, recovery)) {
        if (!this.cancelRequested.has(goalId))
          await this.update(goalId, (g) => {
            g.status = "needs-user";
            g.message = "没有可核对的授权续跑，或本次恢复额度已耗尽。";
          });
        return this.get(goalId, owner);
      }
      const controller = new AbortController();
      this.controllers.set(goalId, controller);
      try {
        assertSubset(
          recovery!.remainingScopes ?? [recovery!],
          goal.grant.scopes,
        );
        assertSubset(
          recovery!.remainingScopes ?? [recovery!],
          goal.originalReview!.scopes,
        );
        const prepared = await this.deps.recover!(goal, recovery!);
        if (this.cancelRequested.has(goalId)) return this.get(goalId, owner);
        return await this.admit(goalId, owner, prepared, controller, recovery);
      } catch (error) {
        return this.handleOperationError(goalId, owner, error);
      } finally {
        this.controllers.delete(goalId);
      }
    });
  }
  private async stopAccepted(goalId: string, owner: GoalOwner) {
    const version = this.nextObservation(goalId);
    try {
      await this.applyObservation(
        goalId,
        await this.deps.stop(this.get(goalId, owner)),
        version,
      );
    } catch (error) {
      if (this.error) throw error;
      if (this.observationVersions.get(goalId) !== version)
        return this.get(goalId, owner);
      await this.update(goalId, (g) => {
        g.status = "unknown";
        g.goalSatisfied = null;
        g.waitingReason = "stop-not-verified";
        g.message = "停止已请求，但原请求或设备停止结果尚无法确认。";
      });
    }
    return this.get(goalId, owner);
  }
  async cancel(goalId: string, owner: GoalOwner): Promise<GoalRun> {
    await this.ready();
    const initial = this.assertOwner(goalId, owner);
    if (["cancelled", "completed"].includes(initial.status)) return initial;
    this.cancelRequested.add(goalId);
    this.controllers.get(goalId)?.abort();
    await this.update(goalId, (goal) => {
      const stamp = this.now().toISOString();
      goal.cancelledAt = stamp;
      goal.grant.revokedAt = stamp;
      goal.status = goal.submission ? "cancelling" : "cancelled";
      goal.message = goal.submission
        ? "已撤销待提交动作，正在核对并停止原目标请求。"
        : "目标已取消，没有提交游戏动作。";
      goal.goalSatisfied = null;
    });
    return this.get(goalId, owner).submission
      ? this.stopAccepted(goalId, owner)
      : this.get(goalId, owner);
  }
  async wait(
    goalId: string,
    owner: GoalOwner,
    options: { timeoutMs?: number; afterRevision?: number } = {},
  ): Promise<GoalRun> {
    await this.ready();
    const timeoutMs = options.timeoutMs ?? 1000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 10_000 ||
      (options.afterRevision !== undefined &&
        (!Number.isSafeInteger(options.afterRevision) ||
          options.afterRevision < 0))
    )
      throw new AgentToolError(
        "INVALID_GOAL_WAIT",
        "目标等待必须限定在0到10000毫秒并使用有效版本号。",
      );
    const current = this.assertOwner(goalId, owner);
    if (
      goalExecutionTerminal(current) ||
      (options.afterRevision !== undefined &&
        current.revision > options.afterRevision) ||
      timeoutMs === 0
    )
      return current;
    return new Promise((resolve) => {
      const dispose = this.subscribe(() => {
        const goal = this.get(goalId, owner);
        if (
          goalExecutionTerminal(goal) ||
          goal.revision > (options.afterRevision ?? current.revision)
        ) {
          clearTimeout(timer);
          dispose();
          resolve(goal);
        }
      });
      const timer = setTimeout(() => {
        dispose();
        resolve(this.get(goalId, owner));
      }, timeoutMs);
    });
  }
  async beginResultNotification(
    goalId: string,
    owner: GoalOwner,
    expectedRevision?: number,
  ) {
    await this.ready();
    this.assertOwner(goalId, owner);
    let claimed = false;
    await this.update(goalId, (goal) => {
      if (
        goal.resultNotification?.state === "pending" &&
        (expectedRevision === undefined ||
          goal.resultNotification.revision === expectedRevision)
      ) {
        goal.resultNotification.state = "delivering";
        claimed = true;
      }
    });
    return claimed;
  }
  async setReply(
    goalId: string,
    owner: GoalOwner,
    reply: {
      text: string;
      at?: string;
      model?: string;
      notificationRevision?: number;
    },
  ): Promise<GoalRun> {
    await this.ready();
    this.assertOwner(goalId, owner);
    if (
      !textValue(reply.text) ||
      (reply.notificationRevision !== undefined &&
        (!Number.isSafeInteger(reply.notificationRevision) ||
          reply.notificationRevision < 1)) ||
      (reply.at !== undefined && !timestamp(reply.at)) ||
      (reply.model !== undefined && !textValue(reply.model, 200))
    )
      throw new AgentToolError("INVALID_GOAL_REPLY", "目标公开答复字段无效。");
    await this.update(goalId, (goal) => {
      if (
        reply.notificationRevision !== undefined &&
        goal.resultNotification?.revision !== reply.notificationRevision
      )
        return;
      goal.publicReply = {
        // Models may explain plans, but a persisted completion reply is always
        // derived from the current accepted scope and actual result evidence.
        text: goalResultReport(goal).text,
        at: reply.at ?? this.now().toISOString(),
        ...(reply.model ? { model: safeText(reply.model, 200) } : {}),
      };
      if (goal.resultNotification) goal.resultNotification.state = "delivered";
    });
    return this.get(goalId, owner);
  }
}
