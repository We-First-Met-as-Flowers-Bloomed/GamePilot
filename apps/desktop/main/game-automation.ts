import { randomUUID } from "node:crypto";
import {
  type AutomationConfig,
  type AutomationJob,
  type RunAutomationJobInput,
} from "../../../packages/protocol/automation";
import { AtomicJsonStore } from "./atomic-json-store";
import { validateRequestId } from "../../../packages/protocol/execution";

export interface AutomationSpec<S extends string> {
  namespace: "ark" | "yys";
  skipPastOnFirstEnable?: boolean;
  validate(input: unknown): AutomationConfig<S>;
}

export interface AutomationOutcome {
  status: "succeeded" | "failed" | "cancelled" | "unknown";
  message?: string;
}

export interface AutomationRun {
  requestId: string;
  jobId: string;
  laneId: string;
  /** The local calendar date at admission, independent of later time edits. */
  date: string;
  dueAt: string;
  source: "scheduled" | "manual";
  status: AutomationOutcome["status"] | "running" | "skipped";
  startedAt: string;
  finishedAt?: string;
  batchId?: string;
  message?: string;
}

export interface AutomationDocument<S extends string = string> {
  version: 1;
  config: AutomationConfig<S>;
  runs: AutomationRun[];
}

export interface AutomationLedger<S extends string = string> {
  read(): Promise<AutomationDocument<S>>;
  save(document: AutomationDocument<S>): Promise<unknown>;
}

export interface AutomationAdmission {
  batchId: string;
  completion: Promise<AutomationOutcome>;
}

export interface AutomationOptions<S extends string = string> {
  store: AutomationLedger<S>;
  run(
    job: AutomationJob<S>,
    dueAt: Date,
    signal: AbortSignal,
    requestId: string,
  ): AutomationAdmission | Promise<AutomationAdmission>;
  now?: () => Date;
  /** Groups due claims by the actual physical device before durable admission. */
  resourceKey?(job: AutomationJob<S>): string | Promise<string>;
  isBusy?: () => boolean;
  /** A disabled/missing account is ineligible, not an attempted game execution. */
  canRunJob?(
    job: AutomationJob<S>,
    signal: AbortSignal,
  ): boolean | Promise<boolean>;
  onError?: (error: unknown) => void;
}

type Receipt = { batchId: string };
type ActiveRun = {
  controller: AbortController;
  laneId: string;
  admission: Promise<Receipt>;
  resolve: (receipt: Receipt) => void;
  reject: (error: unknown) => void;
  started: boolean;
};

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const statuses = [
  "running",
  "skipped",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
];

function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function dateCopy(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw Error("自动任务时间无效");
  return new Date(value);
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const midnight = `${value}T00:00:00.000Z`;
  return validTimestamp(midnight);
}

function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw Error("自动任务账本格式无效");
  return input as Record<string, unknown>;
}

function validateDocument<S extends string>(
  input: unknown,
  spec: AutomationSpec<S>,
): AutomationDocument<S> {
  const value = object(input, ["version", "config", "runs"]);
  if (value.version !== 1 || !Array.isArray(value.runs))
    throw Error("自动任务账本格式无效");
  const config = spec.validate(value.config);
  const requestIds = new Set<string>();
  const scheduled = new Set<string>();
  const runs = value.runs.map((inputRun) => {
    const run = object(inputRun, [
      "requestId",
      "jobId",
      "laneId",
      "date",
      "dueAt",
      "source",
      "status",
      "startedAt",
      "finishedAt",
      "batchId",
      "message",
    ]);
    if (
      typeof run.requestId !== "string" ||
      !requestPattern.test(run.requestId) ||
      typeof run.jobId !== "string" ||
      !idPattern.test(run.jobId) ||
      typeof run.laneId !== "string" ||
      !idPattern.test(run.laneId) ||
      !validCalendarDate(run.date) ||
      !validTimestamp(run.dueAt) ||
      !validTimestamp(run.startedAt) ||
      (run.source !== "scheduled" && run.source !== "manual") ||
      typeof run.status !== "string" ||
      !statuses.includes(run.status) ||
      (run.finishedAt !== undefined && !validTimestamp(run.finishedAt)) ||
      (run.batchId !== undefined &&
        (typeof run.batchId !== "string" ||
          !run.batchId.trim() ||
          run.batchId.length > 256)) ||
      (run.message !== undefined &&
        (typeof run.message !== "string" || run.message.length > 2000)) ||
      (run.status !== "running" && !run.finishedAt) ||
      (run.status === "running" && run.finishedAt !== undefined) ||
      (["succeeded", "failed", "cancelled"].includes(run.status) &&
        run.batchId === undefined) ||
      (run.source === "scheduled" &&
        run.requestId !== `${spec.namespace}-auto-${run.jobId}-${run.date}`) ||
      (run.source === "manual" &&
        run.requestId.startsWith(`${spec.namespace}-auto-`)) ||
      (run.status === "skipped" &&
        (run.source !== "scheduled" || run.batchId !== undefined))
    )
      throw Error("自动任务回执格式无效");
    if (requestIds.has(run.requestId)) throw Error("自动任务请求编号重复");
    requestIds.add(run.requestId);
    if (run.source === "scheduled") {
      const key = `${run.jobId}|${run.date}`;
      if (scheduled.has(key)) throw Error("自动任务时段回执重复");
      scheduled.add(key);
    }
    return { ...run } as unknown as AutomationRun;
  });
  return { version: 1, config, runs };
}

/** Config and evidence share one fsynced replacement; corrupt evidence never falls back to an empty ledger. */
export class AutomationStore<S extends string> implements AutomationLedger<S> {
  private readonly json: AtomicJsonStore<AutomationDocument<S>>;
  private readonly defaults: AutomationConfig<S>;

  constructor(
    file: string,
    defaults: AutomationConfig<S> = {
      version: 1,
      enabled: false,
      jobs: [],
    },
    private readonly spec: AutomationSpec<S>,
  ) {
    this.defaults = spec.validate(defaults);
    this.json = new AtomicJsonStore(file, {
      validate: (value) => validateDocument(value, spec),
      onCorrupt(error) {
        throw new Error("自动任务账本损坏，请保留原文件并检查", {
          cause: error,
        });
      },
    });
  }

  async read(): Promise<AutomationDocument<S>> {
    return (
      (await this.json.load()) ?? {
        version: 1,
        config: structuredClone(this.defaults),
        runs: [],
      }
    );
  }

  async save(input: AutomationDocument<S>): Promise<AutomationDocument<S>> {
    const value = validateDocument(input, this.spec);
    await this.json.save(value);
    return structuredClone(value);
  }
}

export class AutomationService<S extends string> {
  private document?: AutomationDocument<S>;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, ActiveRun>();
  private ticking = false;
  private stopped = false;
  private stopping?: Promise<void>;
  private cancellation = 0;
  private allCancelledAt = 0;
  private readonly laneCancelledAt = new Map<string, number>();
  private readonly checking = new Map<AbortController, string>();

  constructor(
    private readonly options: AutomationOptions<S>,
    private readonly spec: AutomationSpec<S>,
  ) {}

  private now(): Date {
    return dateCopy(this.options.now?.() ?? new Date());
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(operation);
    this.writes = pending.catch(() => {});
    return pending;
  }

  private async load(): Promise<AutomationDocument<S>> {
    if (this.document) return this.document;
    const value = validateDocument(await this.options.store.read(), this.spec);
    const interrupted = value.runs.filter((run) => run.status === "running");
    if (interrupted.length) {
      for (const run of interrupted) {
        run.status = "unknown";
        run.finishedAt = this.now().toISOString();
        run.message = "应用重启，原执行结果尚未确认";
      }
      await this.options.store.save(structuredClone(value));
    }
    this.document = value;
    return value;
  }

  private async persist(value: AutomationDocument<S>): Promise<void> {
    await this.options.store.save(structuredClone(value));
    this.document = value;
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      /* An observer cannot break ledger updates. */
    }
  }

  async read(): Promise<AutomationConfig<S>> {
    return this.serial(async () => structuredClone((await this.load()).config));
  }

  async state(): Promise<AutomationDocument<S>> {
    return this.serial(async () => structuredClone(await this.load()));
  }

  async save(input: unknown): Promise<AutomationConfig<S>> {
    const config = this.spec.validate(input);
    return this.serial(async () => {
      if (this.stopped) throw Error("自动任务服务已停止");
      const value = await this.load();
      if (this.active.size || this.options.isBusy?.())
        throw Error("任务正在执行，暂时不能修改自动任务");
      const document =
        this.spec.skipPastOnFirstEnable &&
        !value.config.enabled &&
        config.enabled &&
        !value.runs.length
          ? this.cutover(value, config)
          : { ...value, config };
      await this.persist(document);
      return structuredClone(config);
    });
  }

  private wasCancelled(laneId: string, preparedAt: number): boolean {
    return (
      this.stopped ||
      this.allCancelledAt > preparedAt ||
      (this.laneCancelledAt.get(laneId) ?? 0) > preparedAt
    );
  }

  /** One atomic cutover: old due periods are skipped, never claimed as game success. */
  async enableWithCutover(): Promise<AutomationConfig<S>> {
    return this.serial(async () => {
      if (this.stopped || this.active.size || this.options.isBusy?.())
        throw Error("任务正在执行或服务已停止，不能迁移计划");
      const value = await this.load();
      if (value.config.enabled) return structuredClone(value.config);
      const config = { ...value.config, enabled: true };
      await this.persist(this.cutover(value, config));
      return structuredClone(config);
    });
  }

  private cutover(
    value: AutomationDocument<S>,
    config: AutomationConfig<S>,
  ): AutomationDocument<S> {
    const now = this.now();
    const date = localDate(now);
    const runs = [...value.runs];
    for (const job of config.jobs) {
      if (!job.enabled || !job.weekdays.includes(now.getDay())) continue;
      const [hours, minutes] = job.time.split(":").map(Number);
      const dueAt = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hours,
        minutes,
      );
      if (
        dueAt > now ||
        runs.some(
          (run) =>
            run.source === "scheduled" &&
            run.jobId === job.id &&
            run.date === date,
        )
      )
        continue;
      runs.push({
        ...this.makeRun(
          job,
          dueAt,
          now,
          "scheduled",
          `${this.spec.namespace}-auto-${job.id}-${date}`,
        ),
        status: "skipped",
        finishedAt: now.toISOString(),
        message: "迁移前的时段由旧入口管理；本入口未执行，不补跑",
      });
    }
    return { ...value, config, runs };
  }

  private async eligible(
    job: AutomationJob<S>,
    preparedAt: number,
  ): Promise<boolean> {
    if (this.wasCancelled(job.laneId, preparedAt)) return false;
    if (!this.options.canRunJob) return true;
    const controller = new AbortController();
    let abort!: () => void;
    const cancelled = new Promise<boolean>((resolve) => {
      abort = () => resolve(false);
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    this.checking.set(controller, job.laneId);
    try {
      const checking = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return this.options.canRunJob!(
            structuredClone(job),
            controller.signal,
          );
        })
        .then((value) => value === true)
        .catch((error) => {
          if (!controller.signal.aborted) this.report(error);
          return false;
        });
      return (
        (await Promise.race([checking, cancelled])) &&
        !this.wasCancelled(job.laneId, preparedAt)
      );
    } finally {
      this.checking.delete(controller);
      controller.signal.removeEventListener("abort", abort);
    }
  }

  private activate(
    requestId: string,
    laneId: string,
    preparedAt: number,
  ): ActiveRun {
    let resolve!: ActiveRun["resolve"];
    let reject!: ActiveRun["reject"];
    const admission = new Promise<Receipt>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Scheduled admissions also use this promise; their failures are observed by tick.
    void admission.catch(() => {});
    const active = {
      controller: new AbortController(),
      laneId,
      admission,
      resolve,
      reject,
      started: false,
    };
    if (this.wasCancelled(laneId, preparedAt)) active.controller.abort();
    this.active.set(requestId, active);
    return active;
  }

  private makeRun(
    job: AutomationJob<S>,
    dueAt: Date,
    now: Date,
    source: AutomationRun["source"],
    requestId: string,
  ): AutomationRun {
    return {
      requestId,
      jobId: job.id,
      laneId: job.laneId,
      date: localDate(dueAt),
      dueAt: dueAt.toISOString(),
      source,
      status: "running",
      startedAt: now.toISOString(),
    };
  }

  /** Returns after batch admission, never after game completion. Explicit requests ignore schedule switches. */
  async runNow(input: RunAutomationJobInput): Promise<Receipt> {
    const raw = object(input, ["jobId", "requestId"]);
    if (
      typeof raw.jobId !== "string" ||
      !idPattern.test(raw.jobId) ||
      (raw.requestId !== undefined &&
        (typeof raw.requestId !== "string" ||
          !requestPattern.test(raw.requestId) ||
          raw.requestId.startsWith(`${this.spec.namespace}-auto-`)))
    )
      throw Error("自动任务请求编号无效");
    const jobId = raw.jobId;
    const requestId =
      (raw.requestId as string | undefined) ??
      `${this.spec.namespace}-manual-${randomUUID()}`;
    const preparedAt = this.cancellation;
    const prepared = await this.serial(async () => {
      if (this.stopped) throw Error("自动任务服务已停止");
      const value = await this.load();
      const previous = value.runs.find((run) => run.requestId === requestId);
      if (previous) {
        if (previous.source !== "manual" || previous.jobId !== jobId)
          throw Error("请求编号已用于其他任务");
        if (previous.batchId) return { receipt: { batchId: previous.batchId } };
        const active = this.active.get(requestId);
        if (active) return { active };
        throw Error("原任务结果未知，不能重复执行");
      }
      const job = value.config.jobs.find((item) => item.id === jobId);
      if (!job) throw Error("自动任务不存在");
      validateRequestId(`${requestId}:${job.laneId}`);
      if (
        this.options.isBusy?.() ||
        [...this.active.values()].some((active) => active.laneId === job.laneId)
      )
        throw Error("该渠道已有任务正在执行");
      if (!(await this.eligible(job, preparedAt))) {
        if (this.wasCancelled(job.laneId, preparedAt))
          throw new DOMException("已停止此任务", "AbortError");
        throw Error("计划绑定的账号渠道未启用或暂不可执行");
      }
      if (this.options.isBusy?.()) throw Error("已有任务或设置操作正在进行");
      const dueAt = this.now();
      const run = this.makeRun(job, dueAt, dueAt, "manual", requestId);
      await this.persist({ ...value, runs: [...value.runs, run] });
      return {
        active: this.activate(requestId, job.laneId, preparedAt),
        job: structuredClone(job),
        dueAt,
      };
    });
    if (prepared.receipt) return prepared.receipt;
    if (prepared.job && prepared.dueAt)
      this.launch(requestId, prepared.job, prepared.dueAt, prepared.active);
    return prepared.active.admission;
  }

  /** Only today's latest due slot per lane can catch up. Every claim is durable before engine admission. */
  async tick(at: Date = this.now()): Promise<Receipt[]> {
    if (this.stopped || this.ticking) return [];
    const now = dateCopy(at);
    const preparedAt = this.cancellation;
    this.ticking = true;
    try {
      const claimed = await this.serial(async () => {
        const value = await this.load();
        if (this.stopped || !value.config.enabled || this.options.isBusy?.())
          return [];
        const date = localDate(now);
        const candidates = value.config.jobs
          .filter((job) => job.enabled && job.weekdays.includes(now.getDay()))
          .map((job) => {
            const [hours, minutes] = job.time.split(":").map(Number);
            const dueAt = new Date(
              now.getFullYear(),
              now.getMonth(),
              now.getDate(),
              hours,
              minutes,
            );
            return { job, dueAt };
          })
          .filter(({ dueAt }) => dueAt <= now)
          .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
        const due: typeof candidates = [];
        for (const item of candidates)
          if (await this.eligible(item.job, preparedAt)) due.push(item);
        if (this.stopped || this.options.isBusy?.()) return [];
        const latest = new Map(due.map((item) => [item.job.laneId, item]));
        const runs = [...value.runs];
        const selected: typeof due = [];
        const selectedResources = new Set<string>();
        for (const item of due) {
          const { job, dueAt } = item;
          if (this.wasCancelled(job.laneId, preparedAt)) continue;
          if (
            runs.some(
              (run) =>
                run.source === "scheduled" &&
                run.jobId === job.id &&
                run.date === date,
            )
          )
            continue;
          const outdated =
            latest.get(job.laneId) !== item ||
            (!job.catchUp && now.getTime() - dueAt.getTime() >= 60_000);
          if (
            !outdated &&
            [...this.active.values()].some(
              (active) => active.laneId === job.laneId,
            )
          )
            continue;
          if (!outdated && this.options.resourceKey) {
            const resource = await this.options.resourceKey(
              structuredClone(job),
            );
            if (selectedResources.has(resource)) continue;
            selectedResources.add(resource);
          }
          const run = this.makeRun(
            job,
            dueAt,
            now,
            "scheduled",
            `${this.spec.namespace}-auto-${job.id}-${date}`,
          );
          if (outdated) {
            run.status = "skipped";
            run.finishedAt = now.toISOString();
            run.message = "错过执行时段或已有更新的时段";
          } else selected.push(item);
          runs.push(run);
        }
        if (runs.length !== value.runs.length)
          await this.persist({ ...value, runs });
        return selected.map(({ job, dueAt }) => {
          const requestId = `${this.spec.namespace}-auto-${job.id}-${date}`;
          return {
            job: structuredClone(job),
            dueAt,
            requestId,
            active: this.activate(requestId, job.laneId, preparedAt),
          };
        });
      });
      const outcomes = await Promise.allSettled(
        claimed.map(({ requestId, job, dueAt, active }) =>
          this.launch(requestId, job, dueAt, active),
        ),
      );
      return outcomes.flatMap((outcome) =>
        outcome.status === "fulfilled" ? [outcome.value] : [],
      );
    } finally {
      this.ticking = false;
    }
  }

  private launch(
    requestId: string,
    job: AutomationJob<S>,
    dueAt: Date,
    active: ActiveRun,
  ): Promise<Receipt> {
    if (!active.started) {
      active.started = true;
      void this.admit(requestId, job, dueAt, active).then(
        active.resolve,
        active.reject,
      );
    }
    return active.admission;
  }

  private async admit(
    requestId: string,
    job: AutomationJob<S>,
    dueAt: Date,
    active: ActiveRun,
  ): Promise<Receipt> {
    let admitted = false;
    try {
      if (this.stopped || active.controller.signal.aborted)
        throw Error("自动任务服务已停止");
      const result = await this.options.run(
        structuredClone(job),
        dateCopy(dueAt),
        active.controller.signal,
        requestId,
      );
      if (
        !result ||
        typeof result.batchId !== "string" ||
        !result.batchId.trim() ||
        result.batchId.length > 256 ||
        !result.completion ||
        typeof result.completion.then !== "function"
      )
        throw Error("任务执行回执无效，结果未知");
      admitted = true;
      // Attach rejection handling before persistence, since completion may already have rejected.
      const completion = result.completion.then(
        (outcome) => outcome,
        (error: unknown): AutomationOutcome => {
          this.report(error);
          return { status: "unknown", message: errorMessage(error) };
        },
      );
      try {
        await this.serial(async () => {
          const value = await this.load();
          const runs = value.runs.map((run) =>
            run.requestId === requestId
              ? { ...run, batchId: result.batchId }
              : run,
          );
          await this.persist({ ...value, runs });
        });
      } finally {
        void completion
          .then((outcome) => this.finish(requestId, outcome, true))
          .catch((error: unknown) => this.report(error));
      }
      return { batchId: result.batchId };
    } catch (error) {
      this.report(error);
      await this.finish(
        requestId,
        { status: "unknown", message: errorMessage(error) },
        !admitted,
      ).catch((failure: unknown) => this.report(failure));
      throw error;
    }
  }

  private async finish(
    requestId: string,
    outcome: AutomationOutcome,
    release: boolean,
  ): Promise<void> {
    try {
      await this.serial(async () => {
        const value = await this.load();
        const run = value.runs.find((item) => item.requestId === requestId);
        if (!run || run.status !== "running") return;
        const valid =
          outcome &&
          ["succeeded", "failed", "cancelled", "unknown"].includes(
            outcome.status,
          );
        const terminal: AutomationRun = {
          ...run,
          status: valid && !this.stopped ? outcome.status : "unknown",
          finishedAt: this.now().toISOString(),
        };
        if (this.stopped) terminal.message = "应用正在退出，执行结果尚未确认";
        else if (typeof outcome?.message === "string")
          terminal.message = outcome.message.slice(0, 2000);
        const runs = value.runs.map((item) => (item === run ? terminal : item));
        await this.persist({ ...value, runs });
      });
    } finally {
      if (release) this.active.delete(requestId);
    }
  }

  /** Abort current admissions synchronously; only actual execution evidence confirms their outcome. */
  cancelActive(laneIds?: string[]): void {
    const at = ++this.cancellation;
    if (laneIds) for (const id of laneIds) this.laneCancelledAt.set(id, at);
    else this.allCancelledAt = at;
    for (const active of this.active.values())
      if (!laneIds || laneIds.includes(active.laneId))
        active.controller.abort();
    for (const [controller, laneId] of this.checking)
      if (!laneIds || laneIds.includes(laneId)) controller.abort();
  }

  /** App shutdown only. Ordinary task cancellation is a completion outcome and leaves future scheduling enabled. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.cancelActive();
    this.stopping = this.serial(async () => {
      const value = await this.load();
      const runs = value.runs.map((run): AutomationRun =>
        run.status === "running"
          ? {
              ...run,
              status: "unknown",
              finishedAt: this.now().toISOString(),
              message: "应用正在退出，执行结果尚未确认",
            }
          : run,
      );
      if (runs.some((run, index) => run !== value.runs[index]))
        await this.persist({ ...value, runs });
      for (const active of this.active.values()) active.controller.abort();
      this.active.clear();
    });
    return this.stopping;
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2000,
  );
}
