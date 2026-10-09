import { AgentToolError } from "../../../packages/protocol/agent";
import type { AgentIncident } from "../../../packages/protocol/agent-incident";
import type {
  ContinuationInput,
  ContinuationPreview,
} from "../../../packages/protocol/continuation";
import type {
  IncidentAgentView,
  IncidentAgentSession,
  IncidentAgentEvent,
  IncidentScreenEvidence,
  IncidentDiagnosis,
  IncidentSuccessorResult,
  IncidentRecoveryAction,
  IncidentRecoveryVerification,
} from "../../../packages/protocol/incident-agent";
import {
  incidentResultStatus,
  validIncidentSuccessorResult,
} from "../../../packages/protocol/incident-agent";
import { validateRequestId } from "../../../packages/protocol/execution";

export interface PreparedIncident {
  fingerprint: string;
  automaticAllowed: boolean;
  manualReason?: string;
  recovery?: IncidentRecoveryAction;
  screens: IncidentScreenEvidence[];
  bundle: {
    incident: AgentIncident;
    screens: IncidentScreenEvidence[];
    feedback?: string;
  };
  preview: ContinuationPreview;
}
interface Dependencies {
  prepare(id: string, signal: AbortSignal): Promise<PreparedIncident>;
  currentFingerprint(id: string): Promise<string>;
  diagnose(
    bundle: PreparedIncident["bundle"],
    signal: AbortSignal,
  ): Promise<{ diagnosis: IncidentDiagnosis; model: string }>;
  resume(
    input: ContinuationInput,
    signal: AbortSignal,
  ): Promise<{ requestId: string }>;
  available(): boolean;
  /** Historical evidence/model diagnosis has no device input and may use a separate lane. */
  canDiagnose?(id: string): boolean;
  /** Recovery still requires admission to the exact original target device. */
  canRecover?(id: string): boolean;
  /** Trusted host registration; navigation is deferred to Goal admission in resume(). */
  hostManagedRecovery?(id: string, prepared: PreparedIncident): boolean;
  recover?(
    id: string,
    action: IncidentRecoveryAction,
    signal: AbortSignal,
  ): Promise<IncidentRecoveryVerification>;
  save(view: IncidentAgentView): Promise<void>;
  load?(): Promise<IncidentAgentView | undefined>;
  successorResult?(id: string): IncidentSuccessorResult | undefined;
}
/** Model advice never controls the device directly. The host owns admission and continuation. */
export class IncidentAgentService {
  private sessions = new Map<string, IncidentAgentSession>();
  private prepared = new Map<string, PreparedIncident>();
  private active?: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  };
  private writes = Promise.resolve();
  private initialized: Promise<void>;
  private error?: string;
  private closed = false;
  constructor(private deps: Dependencies) {
    this.initialized = this.restore();
  }
  private async restore() {
    try {
      const v = await this.deps.load?.();
      if (!v) return;
      if (!Array.isArray(v.sessions) || v.sessions.length > 128)
        throw Error("invalid session store");
      for (const s of v.sessions) {
        validateRequestId(s.requestId);
        if (
          this.sessions.has(s.requestId) ||
          ![
            "queued",
            "running",
            "awaiting-user",
            "resumed",
            "cancelled",
            "failed",
          ].includes(s.status) ||
          !Array.isArray(s.events) ||
          s.events.length > 256 ||
          !Number.isFinite(Date.parse(s.startedAt)) ||
          !Number.isFinite(Date.parse(s.updatedAt)) ||
          s.events.some(
            (e, i) =>
              e.seq !== i + 1 ||
              !Number.isFinite(Date.parse(e.at)) ||
              typeof e.text !== "string" ||
              e.text.length > 4000 ||
              ![
                "running",
                "succeeded",
                "blocked",
                "failed",
                "unknown",
                "cancelled",
                "partial",
              ].includes(e.status) ||
              (e.result !== undefined &&
                (e.kind !== "result" ||
                  !validIncidentSuccessorResult(e.result))),
          )
        )
          throw Error("invalid session");
        const item = structuredClone(s);
        if (["queued", "running"].includes(item.status)) {
          item.status = "awaiting-user";
          this.event(
            item,
            "check",
            "blocked",
            "应用重启中断了诊断；请核对后重新诊断，不自动重放操作。",
          );
        }
        this.sessions.set(item.requestId, item);
      }
    } catch {
      this.error = "故障会话文件无法可靠读取，已停止自动处理；原文件保留。";
    }
  }
  snapshot(): IncidentAgentView {
    const view = structuredClone({
      sessions: [...this.sessions.values()],
      ...(this.error ? { error: this.error } : {}),
    });
    for (const session of view.sessions) this.projectResult(session, false);
    return view;
  }
  /** Refreshes only the diagnostic projection; the execution ledger remains immutable. */
  private projectResult(s: IncidentAgentSession, append: boolean): boolean {
    if (!s.successorId) return false;
    let result: IncidentSuccessorResult | undefined;
    try {
      result = this.deps.successorResult?.(s.successorId);
    } catch {
      return false;
    }
    if (!validIncidentSuccessorResult(result)) return false;
    result = structuredClone(result);
    const status = incidentResultStatus(result),
      text = `续跑结果：${result.summary}`;
    const events = s.events.filter(
      (e) => e.kind === "result" && e.status !== "running",
    );
    if (!events.length) {
      if (!append) return false;
      this.event(s, "result", status, text, result);
      return true;
    }
    let changed = false;
    for (const event of events) {
      if (
        event.status === status &&
        event.text === text &&
        JSON.stringify(event.result) === JSON.stringify(result)
      )
        continue;
      event.status = status;
      event.text = text;
      event.result = structuredClone(result);
      changed = true;
    }
    return changed;
  }
  private event(
    s: IncidentAgentSession,
    kind: IncidentAgentEvent["kind"],
    status: IncidentAgentEvent["status"],
    text: string,
    result?: IncidentSuccessorResult,
  ) {
    if (s.events.length >= 256)
      throw new AgentToolError("EVENT_BUDGET", "故障事件超过预算");
    s.updatedAt = new Date().toISOString();
    s.events.push({
      seq: s.events.length + 1,
      at: s.updatedAt,
      kind,
      status,
      text,
      ...(result ? { result } : {}),
    });
  }
  private async persist() {
    if (this.error)
      throw new AgentToolError("INCIDENT_STORE_UNAVAILABLE", this.error);
    const view = this.snapshot();
    const job = this.writes.then(() => this.deps.save(view));
    this.writes = job.catch(() => {});
    try {
      await job;
    } catch {
      this.error = "故障会话保存失败，已停止自动恢复。";
      throw new AgentToolError("INCIDENT_STORE_UNAVAILABLE", this.error);
    }
  }
  async enqueue(id: string, feedback?: string, automatic = true) {
    await this.initialized;
    validateRequestId(id);
    if (this.closed || this.error)
      throw new AgentToolError(
        "INCIDENT_UNAVAILABLE",
        this.error ?? "故障服务正在关闭",
      );
    const prior = this.sessions.get(id);
    if (
      prior &&
      (automatic || ["queued", "running", "resumed"].includes(prior.status))
    )
      return this.snapshot();
    if (
      feedback !== undefined &&
      (typeof feedback !== "string" ||
        !feedback.trim() ||
        feedback.length > 2000)
    )
      throw new AgentToolError("INVALID_INPUT", "纠正说明须为1至2000字符");
    if (!prior && this.sessions.size >= 128)
      throw new AgentToolError("INCIDENT_BUDGET", "故障会话数量超过预算");
    if (this.active?.id === id) this.active.controller.abort();
    const s = (prior ? structuredClone(prior) : undefined) ?? {
      requestId: id,
      status: "queued",
      automatic,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
    };
    s.status = "queued";
    s.automatic = automatic;
    s.feedback = feedback?.trim();
    s.error = undefined;
    s.diagnosis = undefined;
    this.prepared.delete(id);
    this.event(
      s,
      feedback ? "correction" : "queue",
      "running",
      feedback
        ? "已接收你的纠正说明，等待重新读取证据。"
        : "失败处理已排队，等待设备任务结束后读取证据。",
    );
    this.sessions.set(id, s);
    await this.persist();
    return this.snapshot();
  }
  async tick() {
    await this.initialized;
    if (this.closed || this.error) return;
    let resultChanged = false;
    for (const s of this.sessions.values())
      resultChanged = this.projectResult(s, true) || resultChanged;
    if (resultChanged) await this.persist();
    if (this.active) return;
    const s = [...this.sessions.values()].find(
      (s) =>
        s.status === "queued" &&
        (this.deps.canDiagnose?.(s.requestId) ?? this.deps.available()),
    );
    if (!s) return;
    const job = {
      id: s.requestId,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = job;
    job.done = this.run(s, job);
  }
  private async run(
    s: IncidentAgentSession,
    job: NonNullable<IncidentAgentService["active"]>,
  ) {
    const signal = job.controller.signal;
    try {
      s.status = "running";
      this.event(
        s,
        "evidence",
        "running",
        "读取原请求、对应设备失败截图与原计划剩余步骤。",
      );
      await this.persist();
      signal.throwIfAborted();
      const p = await this.deps.prepare(s.requestId, signal);
      signal.throwIfAborted();
      s.screens = p.screens;
      s.recovery = p.recovery;
      s.remaining = structuredClone(p.preview.defaults);
      this.prepared.set(s.requestId, p);
      this.event(
        s,
        "evidence",
        "succeeded",
        "已读取可靠关联的任务证据；图片仅本机OCR，发送已知页面类型与脱敏记录。",
      );
      this.event(s, "model", "running", "模型正在生成诊断依据摘要与恢复建议。");
      await this.persist();
      const result = await this.deps.diagnose(
        { ...p.bundle, ...(s.feedback ? { feedback: s.feedback } : {}) },
        signal,
      );
      signal.throwIfAborted();
      s.diagnosis = {
        ...result.diagnosis,
        ...(p.manualReason ? { action: "manual" as const } : {}),
      };
      s.model = result.model;
      this.event(s, "model", "succeeded", "模型诊断已返回。");
      this.event(s, "diagnosis", "succeeded", result.diagnosis.summary);
      s.status = "awaiting-user";
      await this.persist();
      this.assertCurrent(s, signal);
      const hostManaged =
        !!p.recovery && !!this.deps.hostManagedRecovery?.(s.requestId, p);
      if (
        s.automatic &&
        (p.automaticAllowed || hostManaged) &&
        (this.deps.canRecover?.(s.requestId) ?? this.deps.available()) &&
        s.diagnosis.action === "retry-remaining"
      )
        await this.resume(s, p, signal, hostManaged);
      else {
        this.event(
          s,
          "check",
          "blocked",
          p.manualReason ??
            "等待你核对诊断与截图；未知页面、资源结果或身份不能自动重做。",
        );
        await this.persist();
      }
    } catch (e) {
      // A cancelled turn must not rewrite a newer correction's queue or evidence.
      if (this.sessions.get(s.requestId) !== s) return;
      if (signal.aborted) {
        s.status = "cancelled";
        if (!s.events.some((e) => e.kind === "cancel"))
          this.event(s, "cancel", "succeeded", "本次Agent处理已停止。");
      } else {
        s.status = "failed";
        s.error =
          e instanceof AgentToolError
            ? e.message
            : "故障处理未完成，未确认恢复；请核对设备或模型连接。";
        this.event(s, "error", "failed", s.error);
      }
      await this.persist().catch(() => {});
    } finally {
      if (this.active === job) this.active = undefined;
    }
  }
  private async resume(
    s: IncidentAgentSession,
    p: PreparedIncident,
    signal: AbortSignal,
    hostManaged = !!p.recovery &&
      !!this.deps.hostManagedRecovery?.(s.requestId, p),
  ) {
    this.assertCurrent(s, signal);
    if (
      p.manualReason ||
      (hostManaged && !this.deps.hostManagedRecovery?.(s.requestId, p)) ||
      !(this.deps.canRecover?.(s.requestId) ?? this.deps.available()) ||
      (await this.deps.currentFingerprint(s.requestId)) !== p.fingerprint ||
      !p.preview.canContinue ||
      p.preview.reasons.length ||
      p.preview.successorId
    )
      throw new AgentToolError(
        "RECOVERY_CHANGED",
        "配置、记录或设备状态已变化，请重新诊断并核对续跑。",
      );
    this.assertCurrent(s, signal);
    s.status = "running";
    this.event(
      s,
      "check",
      "succeeded",
      "宿主核验通过；只续跑原计划未完成步骤，重新登录核对UID，保留原失败。",
    );
    await this.persist();
    this.assertCurrent(s, signal);
    if (p.recovery && hostManaged) {
      this.event(
        s,
        "check",
        "succeeded",
        "受限恢复已由原目标授权登记；目标接受记录保存后才执行导航，再重新登录核对UID。",
      );
    } else if (p.recovery) {
      if (!this.deps.recover)
        throw new AgentToolError(
          "RECOVERY_UNAVAILABLE",
          "受限导航工具未接入，不能假定已返回主页",
        );
      if (
        s.events.filter((e) => e.kind === "recovery" && e.status === "running")
          .length >= 2
      )
        throw new AgentToolError(
          "RECOVERY_BUDGET",
          "原请求已使用两次受限恢复机会，请人工处理；跨纠正不会重置预算",
        );
      this.event(
        s,
        "recovery",
        "running",
        "在原设备租约内复查新鲜双帧，仅使用已注册的受限返回主页动作。",
      );
      await this.persist();
      this.assertCurrent(s, signal);
      const started = Date.now(),
        verification = await this.deps.recover(s.requestId, p.recovery, signal);
      this.assertCurrent(s, signal);
      const at = Date.parse(verification.observedAt);
      if (
        !verification.verified ||
        !Number.isFinite(at) ||
        at < started ||
        at > Date.now() ||
        Date.now() - at > 15000 ||
        !Array.isArray(verification.evidenceRefs) ||
        !verification.evidenceRefs.length
      )
        throw new AgentToolError(
          "RECOVERY_UNVERIFIED",
          "导航缺少新鲜返回证明，不能提交续跑",
        );
      this.event(
        s,
        "recovery",
        "succeeded",
        "已以新鲜双帧确认返回主页；未重购、未重做任务，继续前仍重新核对UID。",
      );
      await this.persist();
      this.assertCurrent(s, signal);
      if (
        !(this.deps.canRecover?.(s.requestId) ?? this.deps.available()) ||
        (await this.deps.currentFingerprint(s.requestId)) !== p.fingerprint
      )
        throw new AgentToolError(
          "RECOVERY_CHANGED",
          "导航后目标设备或配置已变化，请重新核对",
        );
      this.assertCurrent(s, signal);
    }
    this.event(
      s,
      "resume",
      "running",
      "提交原计划续跑，实际执行仍由游戏执行器负责。",
    );
    await this.persist();
    this.assertCurrent(s, signal);
    if (hostManaged && !this.deps.hostManagedRecovery?.(s.requestId, p))
      throw new AgentToolError(
        "RECOVERY_CHANGED",
        "原目标授权或恢复登记已变化，请重新核对。",
      );
    const r = await this.deps.resume(
      {
        parentId: s.requestId,
        fingerprint: p.preview.fingerprint,
        selections: p.preview.defaults,
        acknowledgePartial: true,
      },
      signal,
    );
    s.successorId = r.requestId;
    s.status = "resumed";
    this.event(
      s,
      "resume",
      "succeeded",
      "宿主已接受续跑请求，尚不代表任务完成。",
    );
    this.event(s, "result", "running", "等待后续任务的实际执行结果。");
    await this.persist();
  }
  private assertCurrent(s: IncidentAgentSession, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.sessions.get(s.requestId) !== s)
      throw new AgentToolError(
        "INCIDENT_REPLACED",
        "此诊断已被新的用户纠正取代",
      );
  }
  async confirm(id: string) {
    await this.initialized;
    validateRequestId(id);
    const s = this.sessions.get(id),
      p = this.prepared.get(id);
    if (
      this.active ||
      !s ||
      s.status !== "awaiting-user" ||
      !p ||
      s.diagnosis?.action !== "retry-remaining"
    )
      throw new AgentToolError(
        "RECOVERY_UNAVAILABLE",
        "请先诊断并核对原计划，或使用任务的手动续跑入口",
      );
    const job = {
      id,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = job;
    job.done = (async () => {
      try {
        await this.resume(s, p, job.controller.signal);
      } catch (e) {
        s.status = job.controller.signal.aborted
          ? "cancelled"
          : "awaiting-user";
        s.error =
          e instanceof AgentToolError ? e.message : "续跑提交失败，请重新核对";
        this.event(s, "check", "blocked", s.error);
        await this.persist().catch(() => {});
      } finally {
        if (this.active === job) this.active = undefined;
      }
    })();
    await job.done;
    return this.snapshot();
  }
  async cancel(id: string) {
    await this.initialized;
    validateRequestId(id);
    const s = this.sessions.get(id);
    if (!s || s.status === "resumed") return this.snapshot();
    if (this.active?.id === id) this.active.controller.abort();
    s.status = "cancelled";
    this.event(
      s,
      "cancel",
      "succeeded",
      "用户停止了本次Agent处理，未将原失败改为成功。",
    );
    await this.persist();
    return this.snapshot();
  }
  async idle() {
    await this.active?.done;
    await this.writes;
  }
  async close() {
    this.closed = true;
    if (this.active) await this.cancel(this.active.id);
    await this.idle();
  }
}
