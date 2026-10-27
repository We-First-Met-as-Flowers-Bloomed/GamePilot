import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { replaceFile } from "./replace-file";
import type { SkillResult } from "../../../packages/protocol";
export interface ScheduleLedger {
  attemptDay?: string;
  completedDay?: string;
  lastStatus?: string;
  attempts?: string[];
  completions?: string[];
}
interface LedgerIO {
  read(): Promise<ScheduleLedger>;
  save(value: ScheduleLedger): Promise<void>;
}
export class ScheduleStore implements LedgerIO {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async read(): Promise<ScheduleLedger> {
    await this.writes;
    try {
      const v = JSON.parse(await readFile(this.file, "utf8"));
      if (
        !v ||
        typeof v !== "object" ||
        Array.isArray(v) ||
        Object.entries(v).some(([k, v]) =>
          ["attempts", "completions"].includes(k)
            ? !Array.isArray(v) ||
              v.length > 100 ||
              v.some((item) => typeof item !== "string")
            : !["attemptDay", "completedDay", "lastStatus"].includes(k) ||
              typeof v !== "string",
        )
      )
        throw Error("invalid ledger");
      return v;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("定时记录损坏，自动任务已停止，请检查 scheduler.json", {
        cause: error,
      });
    }
  }
  async save(value: ScheduleLedger) {
    const task = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + ".tmp", JSON.stringify(value));
      await replaceFile(this.file + ".tmp", this.file);
    });
    this.writes = task.catch(() => {});
    await task;
  }
}
export type DailySlot = "primary" | "secondary";
export interface DailyScheduleConfig {
  scheduleEnabled: boolean;
  scheduleTime: string;
  secondScheduleEnabled?: boolean;
  secondScheduleTime?: string;
  runOnLaunch: boolean;
  scope?: string;
}
export interface DailyOccurrence {
  slot: DailySlot;
  dueAt: Date;
}
export interface DailyRetryContext {
  now: Date;
  scope: string;
  key: string;
  attempts: number;
}
export interface DailyRetryDecision {
  allowed: boolean;
  status?: string;
  lastAttemptAt?: string;
  reason?: string;
}
/** Only catch up the latest due period; never queue all missed periods. */
export function dailyOccurrence(
  now: Date,
  config: DailyScheduleConfig,
  day: (date: Date) => string,
): DailyOccurrence | undefined {
  if (!config.scheduleEnabled) return;
  const candidates: [DailySlot, string][] = [["primary", config.scheduleTime]];
  if (config.secondScheduleEnabled)
    candidates.push(["secondary", config.secondScheduleTime ?? "20:00"]);
  for (const [slot, time] of candidates.reverse()) {
    const [hour, minute] = time.split(":").map(Number);
    const dueAt = new Date(now);
    dueAt.setHours(hour, minute, 0, 0);
    if (now >= dueAt && day(dueAt) === day(now)) return { slot, dueAt };
  }
}
export class DailyScheduler {
  private checking = false;
  /** 同一时段一天内允许的重试次数（首次尝试之外）。 */
  static readonly MAX_RETRIES = 2;
  /** 两次尝试之间的最小间隔，避免设备还没起来就 15 秒一轮地空转。 */
  static readonly RETRY_BACKOFF_MS = 3 * 60_000;
  /** 当进程仍在运行时，额外保留本次认领的退避下限。 */
  private retryNotBefore = new Map<string, number>();
  constructor(
    private store: LedgerIO,
    private day: (date: Date) => string,
    private execute: (occurrence: DailyOccurrence) => Promise<string>,
    /**
     * 宿主提供当前时段的持久证据；没有明确的未提交启动失败就不能重跑。
     */
    private canRetry: (
      occurrence: DailyOccurrence,
      context: DailyRetryContext,
    ) => DailyRetryDecision | Promise<DailyRetryDecision> = () => ({
      allowed: false,
      reason: "retry-proof-unavailable",
    }),
    /** Read-only admission check; rejection must not claim an execution attempt. */
    private preflight?: (occurrence: DailyOccurrence) => void | Promise<void>,
  ) {}
  private attemptsFor(ledger: ScheduleLedger, day: string) {
    return Math.max(
      (ledger.attempts ?? []).filter((entry) => entry === day).length,
      ledger.attemptDay === day ? 1 : 0,
    );
  }
  private async retryState(
    occurrence: DailyOccurrence,
    context: DailyRetryContext,
    fallbackStatus?: string,
  ) {
    const proof = await this.canRetry(occurrence, context);
    const lastStatus = proof.status ?? fallbackStatus ?? "unknown";
    const denied = (reason: string) => ({
      lastStatus,
      retryAllowed: false,
      retryNotBefore: null,
      retryReason: reason,
    });
    if (context.attempts > DailyScheduler.MAX_RETRIES)
      return denied("retry-limit-reached");
    if (proof.allowed !== true)
      return denied(proof.reason ?? "retry-denied");
    if (proof.status !== "failed")
      return denied(proof.reason ?? "retry-status-unconfirmed");
    const lastAttemptAt = Date.parse(proof.lastAttemptAt ?? "");
    if (
      !Number.isFinite(lastAttemptAt) ||
      lastAttemptAt < occurrence.dueAt.getTime() ||
      lastAttemptAt > context.now.getTime()
    )
      return denied("retry-attempt-time-invalid");
    return {
      lastStatus,
      retryAllowed: true,
      retryNotBefore: new Date(
        Math.max(
          lastAttemptAt + DailyScheduler.RETRY_BACKOFF_MS,
          this.retryNotBefore.get(context.key) ?? 0,
        ),
      ).toISOString(),
      retryReason: proof.reason ?? null,
    };
  }
  async complete(
    now: Date,
    scope = "",
    config?: DailyScheduleConfig,
    explicitSlot?: DailySlot,
  ) {
    const slot =
      explicitSlot ??
      (config ? dailyOccurrence(now, config, this.day)?.slot : undefined);
    await this.completeDay(this.key(now, scope, slot ?? "primary"));
  }
  private key(now: Date, scope: string, slot: DailySlot) {
    return (
      this.day(now) + "|" + scope + (slot === "secondary" ? "|secondary" : "")
    );
  }
  private async completeDay(day: string) {
    const previous = await this.store.read();
    await this.store.save({
      ...previous,
      completedDay: day,
      completions: [...new Set([...(previous.completions ?? []), day])].slice(
        -100,
      ),
      lastStatus: "succeeded",
    });
  }
  /**
   * 只读查询两个时段及其重试证据；running/unknown 中断记录必须可见。
   */
  async dailyState(now: Date, scope: string, config: DailyScheduleConfig) {
    const previous = await this.store.read();
    const state = async (slot: DailySlot) => {
      const key = this.key(now, scope, slot);
      const attempts = this.attemptsFor(previous, key);
      const completed =
        previous.completedDay === key ||
        Boolean(previous.completions?.includes(key));
      const [hour, minute] = (
        slot === "primary"
          ? config.scheduleTime
          : config.secondScheduleTime ?? "20:00"
      )
        .split(":")
        .map(Number);
      const dueAt = new Date(now);
      dueAt.setHours(hour, minute, 0, 0);
      const retry =
        attempts && !completed
          ? await this.retryState(
              { slot, dueAt },
              { now, scope, key, attempts },
              previous.attemptDay === key ? previous.lastStatus : undefined,
            )
          : {
              lastStatus: completed ? "succeeded" : null,
              retryAllowed: false,
              retryNotBefore: null,
              retryReason: completed ? "completed" : null,
            };
      return {
        slot,
        key,
        attempts,
        // 还剩几次重试机会（首次尝试之外）。0 表示失败后不会再自动重跑。
        retriesRemaining: Math.max(
          0,
          DailyScheduler.MAX_RETRIES - Math.max(0, attempts - 1),
        ),
        attempted: attempts > 0,
        completed,
        ...retry,
      };
    };
    return {
      day: this.day(now),
      lastStatus: previous.lastStatus ?? null,
      scheduleTime: config.scheduleTime,
      secondScheduleTime: config.secondScheduleTime ?? null,
      primary: await state("primary"),
      secondary: await state("secondary"),
    };
  }
  async tick(
    now: Date,
    config: DailyScheduleConfig,
    busy: boolean,
    trigger = "timer",
  ) {
    if (this.checking || busy) return;
    const occurrence =
      dailyOccurrence(now, config, this.day) ??
      (trigger === "startup" && config.runOnLaunch
        ? { slot: "primary" as const, dueAt: new Date(now) }
        : undefined);
    if (!occurrence) return;
    this.checking = true;
    try {
      const day = this.key(now, config.scope ?? "", occurrence.slot),
        previous = await this.store.read();
      if (
        previous.completedDay === day ||
        previous.completions?.includes(day)
      )
        return;
      const attempts = this.attemptsFor(previous, day);
      if (attempts) {
        if (attempts > DailyScheduler.MAX_RETRIES) return;
        const retry = await this.retryState(occurrence, {
          now,
          scope: config.scope ?? "",
          key: day,
          attempts,
        });
        if (
          !retry.retryAllowed ||
          now.getTime() < Date.parse(retry.retryNotBefore!)
        )
          return;
      }
      if (this.preflight) {
        const beforePreflight = JSON.stringify(previous);
        await this.preflight(occurrence);
        // A manual completion may arrive while admission reads the live ledgers.
        // Let the next tick re-evaluate any changed state instead of overwriting it.
        if (JSON.stringify(await this.store.read()) !== beforePreflight) return;
      }
      const previousAttempts = [...(previous.attempts ?? [])];
      if (
        previous.attemptDay &&
        !previousAttempts.includes(previous.attemptDay)
      )
        previousAttempts.push(previous.attemptDay);
      await this.store.save({
        ...previous,
        attemptDay: day,
        // 重试会重复写入同一个 day：这个重复就是重试计数，**不能**用 Set 去重。
        // 老版本读到这个账本仍然按 includes(day) 早退，所以回滚是安全的。
        attempts: [...previousAttempts, day].slice(-100),
        lastStatus: "running",
      });
      // 无论本次成败，下一次尝试都要至少等 RETRY_BACKOFF_MS。
      this.retryNotBefore.set(
        day,
        now.getTime() + DailyScheduler.RETRY_BACKOFF_MS,
      );
      try {
        const status = await this.execute(occurrence);
        if (status === "succeeded") await this.completeDay(day);
        else
          await this.store.save({
            ...(await this.store.read()),
            lastStatus: status,
          });
      } catch (error) {
        await this.store.save({
          ...(await this.store.read()),
          lastStatus:
            error instanceof Error && error.name === "AbortError"
              ? "cancelled"
              : "unknown",
        });
        throw error;
      }
    } finally {
      this.checking = false;
    }
  }
}

export interface IntervalLedger {
  blockedAt?: string;
  scope?: string;
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  lastStatus?: string;
  nextRunAt?: string;
}

interface IntervalLedgerIO {
  read(): Promise<IntervalLedger>;
  save(value: IntervalLedger): Promise<void>;
}

export class IntervalScheduleStore implements IntervalLedgerIO {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async read(): Promise<IntervalLedger> {
    await this.writes;
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([key, item]) =>
            ![
              "scope",
              "blockedAt",
              "lastAttemptAt",
              "lastCompletedAt",
              "lastStatus",
              "nextRunAt",
            ].includes(key) || typeof item !== "string",
        )
      )
        throw new Error("invalid interval ledger");
      for (const key of [
        "blockedAt",
        "lastAttemptAt",
        "lastCompletedAt",
        "nextRunAt",
      ] as const)
        if (value[key] && !Number.isFinite(Date.parse(value[key])))
          throw new Error("invalid interval timestamp");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error(
        "结界定时记录损坏，六小时寄养已停止，请检查 foster-scheduler.json",
        { cause: error },
      );
    }
  }
  async save(value: IntervalLedger) {
    const task = this.writes.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file + ".tmp", JSON.stringify(value));
      await replaceFile(this.file + ".tmp", this.file);
    });
    this.writes = task.catch(() => {});
    await task;
  }
}

export class IntervalScheduler {
  private checking = false;
  private updates: Promise<unknown> = Promise.resolve();
  private calibrationRevision = 0;
  constructor(
    private store: IntervalLedgerIO,
    private intervalMs: number,
    private failureCooldownMs: number,
    private execute: () => Promise<string>,
  ) {
    if (intervalMs < 60_000 || failureCooldownMs < 60_000)
      throw new Error("周期调度间隔无效");
  }
  private update<T>(
    action: (previous: IntervalLedger) => Promise<T>,
  ): Promise<T> {
    const task = this.updates.then(async () => action(await this.store.read()));
    this.updates = task.catch(() => {});
    return task;
  }
  async calibrate(result: SkillResult, scope: string, now = new Date()) {
    const observedAt = Date.parse(result.observedAt ?? "");
    const nextRunAt = Date.parse(result.nextRunAt ?? "");
    if (
      !Number.isFinite(observedAt) ||
      !Number.isFinite(nextRunAt) ||
      Math.abs(now.getTime() - observedAt) > 5 * 60_000 ||
      nextRunAt <= observedAt ||
      nextRunAt - observedAt > this.intervalMs + 5_000
    )
      // 报错必须带上实际数值：2026-10-15 08:29 实机出现过“落账值全部通过校验、
      // 但事件传进来的值不同”的情况，原文案无法定位，只能靠复现。
      throw new Error(
        `周期任务结果时间无效（观察 ${String(result.observedAt ?? "无")}，下次 ${String(result.nextRunAt ?? "无")}，核对时刻 ${now.toISOString()}，间隔上限 ${this.intervalMs} 毫秒）`,
      );
    await this.update(async (previous) => {
      const sameScope = previous.scope === scope;
      if (
        sameScope &&
        previous.blockedAt &&
        observedAt <= Date.parse(previous.blockedAt)
      )
        return;
      if (sameScope && Date.parse(previous.lastCompletedAt ?? "") > observedAt)
        return;
      await this.store.save({
        ...(sameScope ? previous : {}),
        scope,
        lastCompletedAt: new Date(observedAt).toISOString(),
        nextRunAt: new Date(nextRunAt).toISOString(),
        lastStatus:
          sameScope &&
          previous.lastStatus === "cancelled" &&
          Date.parse(previous.lastAttemptAt ?? "") >= observedAt
            ? "cancelled"
            : "succeeded",
        blockedAt: undefined,
      });
      this.calibrationRevision++;
    });
  }
  async complete(now: Date, scope: string) {
    await this.update(async (previous) =>
      this.store.save({
        ...(previous.scope === scope ? previous : {}),
        scope,
        lastCompletedAt: now.toISOString(),
        nextRunAt: new Date(now.getTime() + this.intervalMs).toISOString(),
        lastStatus: "succeeded",
        blockedAt: undefined,
      }),
    );
  }
  async defer(now: Date, scope: string) {
    await this.update(async (previous) =>
      this.store.save({
        ...(previous.scope === scope ? previous : {}),
        scope,
        lastAttemptAt: now.toISOString(),
        lastStatus: "cancelled",
      }),
    );
  }
  /**
   * 只读查询六小时维护是否被闸门挡住。
   *
   * 早期版本闸门命中时直接 `return false`，界面上没有任何提示，
   * 用户只能看到“每 6 小时检查寄养”仍然开着、却再也不运行。
   */
  async gateState(scope: string) {
    const previous = await this.store.read();
    if (previous.scope !== scope)
      return { blocked: false, blockedAt: null, lastStatus: null };
    return {
      blocked:
        Boolean(previous.blockedAt) ||
        ["unknown", "failed", "running"].includes(previous.lastStatus ?? ""),
      blockedAt: previous.blockedAt ?? null,
      lastStatus: previous.lastStatus ?? null,
    };
  }
  /**
   * 人工核对游戏现场后解除暂停。
   *
   * 这是**唯一**不依赖“新的寄养观测”的出口：日常流程已不含 foster
   * （`compileDailyPlan` 会过滤 maintenanceOnly 技能），所以 `calibrate()`
   * 可能永远等不到观测，闸门一旦落下就是永久死锁。
   *
   * 调用方必须先确认现场。解除时把未确认状态改写为 `cancelled`：
   * 这是一次已知的人工结论，不再冒充“结果未知”，也让下面的退避分支按
   * cancelled 语义放行。保留 `lastAttemptAt` 原值，避免刚解除又排到 6 小时后。
   */
  async clearBlocked(scope: string) {
    await this.update(async (previous) => {
      if (previous.scope !== scope) return;
      if (
        !previous.blockedAt &&
        !["unknown", "failed", "running"].includes(previous.lastStatus ?? "")
      )
        return;
      await this.store.save({
        ...previous,
        lastStatus:
          previous.lastStatus === "succeeded" ? "succeeded" : "cancelled",
        blockedAt: undefined,
      });
    });
  }
  async tick(now: Date, enabled: boolean, busy: boolean, scope: string) {
    if (!enabled || busy || this.checking) return;
    this.checking = true;
    try {
      const claimed = await this.update(async (previous) => {
        const sameScope = previous.scope === scope;
        // 结果未确认/中断/失败的一律不自动重跑：那次运行可能已经改动了游戏现场。
        // 这条闸门是刻意设计的（见 tests/scheduler.test.ts 的
        // "does not retry unknown, interrupted or legacy failed maintenance"），
        // 不能靠时间放行，只能靠“新的寄养观测”或人工核对解除。
        if (
          sameScope &&
          (previous.blockedAt ||
            ["unknown", "failed", "running"].includes(
              previous.lastStatus ?? "",
            ))
        ) {
          // 早期版本的记录可能只有状态、没有时刻。补登一次，
          // 让 gateState 能报出"从什么时候开始暂停"、clearBlocked 也有据可依。
          if (!previous.blockedAt)
            await this.store.save({
              ...previous,
              blockedAt: previous.lastAttemptAt ?? now.toISOString(),
            });
          return false;
        }
        const completedAt = sameScope
          ? Date.parse(previous.lastCompletedAt ?? "")
          : Number.NaN;
        const attemptedAt = sameScope
          ? Date.parse(previous.lastAttemptAt ?? "")
          : Number.NaN;
        const nextRunAt = sameScope
          ? Date.parse(previous.nextRunAt ?? "")
          : Number.NaN;
        if (
          Number.isFinite(nextRunAt)
            ? now.getTime() < nextRunAt
            : Number.isFinite(completedAt) &&
              now.getTime() - completedAt < this.intervalMs
        )
          return false;
        if (
          ["failed", "cancelled", "running"].includes(
            previous.lastStatus ?? "",
          ) &&
          Number.isFinite(attemptedAt) &&
          now.getTime() - attemptedAt <
            (previous.lastStatus === "cancelled"
              ? this.intervalMs
              : this.failureCooldownMs)
        )
          return false;
        await this.store.save({
          ...(sameScope ? previous : {}),
          scope,
          lastAttemptAt: now.toISOString(),
          lastStatus: "running",
        });
        return true;
      });
      if (!claimed) return;
      const revision = this.calibrationRevision;
      try {
        const status = await this.execute();
        await this.update(async (previous) => {
          if (previous.scope !== scope) return;
          await this.store.save({
            ...previous,
            ...(status === "succeeded" && revision === this.calibrationRevision
              ? {
                  lastCompletedAt: now.toISOString(),
                  nextRunAt: new Date(
                    now.getTime() + this.intervalMs,
                  ).toISOString(),
                }
              : {}),
            lastStatus: status,
            ...(!["succeeded", "cancelled"].includes(status)
              ? { blockedAt: new Date().toISOString() }
              : {}),
          });
        });
      } catch (error) {
        await this.update(async (previous) => {
          if (previous.scope !== scope) return;
          await this.store.save({
            ...previous,
            lastStatus:
              error instanceof Error && error.name === "AbortError"
                ? "cancelled"
                : "unknown",
            ...(error instanceof Error && error.name === "AbortError"
              ? {}
              : { blockedAt: new Date().toISOString() }),
          });
        });
        throw error;
      }
    } finally {
      this.checking = false;
    }
  }
}
