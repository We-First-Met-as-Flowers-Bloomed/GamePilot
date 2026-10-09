import { utilityProcess, type UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { RunEvent } from "../../../packages/protocol";
import { ConnectionUnavailableError } from "../../../packages/protocol/failure";
import type { FaultCode } from "../../../packages/protocol/fault";
import { executionBudget } from "../../../games/execution-budget";
import {
  nativeWaitLimits,
  validNativeWait,
  type NativeWait,
} from "../../../packages/protocol/native-wait";

export class WorkerClient extends EventEmitter {
  private child?: UtilityProcess;
  private activeRun?: string;
  private activeGame?: string;
  private runTimer?: ReturnType<typeof setTimeout>;
  private stepTimer?: ReturnType<typeof setTimeout>;
  private activeSkill?: string;
  private stepBudgets?: Record<string, number>;
  private startedSteps = new Set<string>();
  private terminating = false;
  private nativeWaits = new Map<
    string,
    { operation: NativeWait["operation"]; timer: ReturnType<typeof setTimeout> }
  >();
  private arknightsRunTimeout = 120 * 60_000 + 90_000;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private file: string,
    private dataDir: string,
    private runTimeout?: number,
  ) {
    super();
  }
  /** A termination request is not proof that native control has stopped. */
  get exitPending(): boolean {
    return this.terminating && Boolean(this.child);
  }
  private launch(): UtilityProcess {
    if (this.terminating)
      throw new Error("执行器正在终止，请等待退出后重新连接");
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.file, [], {
      serviceName: "GamePilot Engine",
      env: { ...process.env, GAMEPILOT_DATA: this.dataDir },
      stdio: "pipe",
    });
    this.child = child;
    child.stderr?.on("data", () => {
      /* Native detailed logs are stored by Maa in userData. */
    });
    child.stdout?.on("data", () => {});
    child.on(
      "message",
      (message: {
        id?: string;
        result?: unknown;
        error?: string;
        errorCode?: string;
        event?: RunEvent;
        nativeWait?: unknown;
      }) => {
        if (this.child !== child || this.terminating) return;
        if (message.nativeWait !== undefined) {
          if (validNativeWait(message.nativeWait))
            this.nativeWait(child, message.nativeWait);
          return;
        }
        if (message.event) {
          const event = message.event;
          // Late events from another run must not clear or renew the active deadline.
          if (this.activeRun && event.runId !== this.activeRun) return;
          if (event.type === "status") {
            if (
              ["queued", "running", "stopping"].includes(event.status ?? "")
            ) {
              this.activeRun = event.runId;
              this.activeGame = event.gameId;
              if (!this.runTimer) {
                const budget =
                  this.runTimeout === undefined
                    ? executionBudget(event.plan)
                    : undefined;
                this.stepBudgets = budget?.steps;
                this.startedSteps.clear();
                this.runTimer = setTimeout(
                  () =>
                    this.terminate(
                      child,
                      "任务执行超时，已请求终止执行器；结果未知，请检查游戏状态",
                      "worker-run-timeout",
                    ),
                  this.activeGame === "arknights"
                    ? this.arknightsRunTimeout
                    : (this.runTimeout ?? budget?.totalMs ?? 12 * 60_000),
                );
              }
            } else {
              this.activeRun = undefined;
              this.clearDeadlines();
            }
          }
          if (
            event.type === "step" &&
            event.skillId &&
            this.activeRun === event.runId
          ) {
            if (
              event.stepStatus === "running" &&
              !this.startedSteps.has(event.skillId)
            ) {
              this.startedSteps.add(event.skillId);
              this.activeSkill = event.skillId;
              clearTimeout(this.stepTimer);
              const limit = this.stepBudgets?.[event.skillId];
              this.stepTimer = limit
                ? setTimeout(
                    () =>
                      this.terminate(
                        child,
                        `步骤 ${event.skillId} 执行超过 ${limit / 60_000} 分钟，已请求终止执行器；结果未知，请核对游戏状态`,
                        "worker-run-timeout",
                      ),
                    limit,
                  )
                : undefined;
            } else if (
              event.stepStatus !== "running" &&
              this.activeSkill === event.skillId
            ) {
              clearTimeout(this.stepTimer);
              this.stepTimer = undefined;
              this.activeSkill = undefined;
            }
          }
          this.emit("event", event);
          return;
        }
        const pending = message.id ? this.pending.get(message.id) : undefined;
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id!);
        if (message.error)
          pending.reject(
            message.errorCode === "connection-unavailable"
              ? new ConnectionUnavailableError(message.error)
              : new Error(message.error),
          );
        else pending.resolve(message.result);
      },
    );
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.terminating = false;
      this.clearNativeWaits();
      this.rejectAll(
        new Error(`执行进程已退出（${code}），可以重新连接后重试`),
      );
      this.failRun(
        "执行进程已退出，任务结果未知；重新连接后请先检查游戏状态",
        "worker-exited",
      );
      this.emit("exit");
    });
    return child;
  }
  request<T>(method: string, payload?: unknown, timeout = 45000): Promise<T> {
    const child = this.launch(),
      id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.terminate(
          child,
          "执行器响应超时，已请求终止执行进程；结果未知，请重新连接设备",
          "worker-rpc-timeout",
        );
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          if (method === "arknights-config") {
            const minutes = (payload as { maxRunMinutes?: number })
              ?.maxRunMinutes;
            if (Number.isInteger(minutes) && minutes! >= 5 && minutes! <= 360)
              this.arknightsRunTimeout = minutes! * 60_000 + 90_000;
          }
          resolve(value as T);
        },
        reject,
        timer,
      });
      try {
        child.postMessage({ id, method, payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private failRun(message: string, code: FaultCode) {
    const skillId = this.activeSkill;
    this.clearDeadlines();
    if (!this.activeRun) return;
    const at = new Date().toISOString();
    this.emit("event", {
      runId: this.activeRun,
      gameId: this.activeGame,
      type: "status",
      status: "failed",
      resultUncertain: true,
      message,
      at,
      fault: {
        version: 1,
        source: "watchdog",
        runId: this.activeRun,
        skillId,
        code,
        observedAt: at,
        capture: { status: "not-attempted" },
      },
    } satisfies RunEvent);
    this.activeRun = undefined;
  }
  private terminate(child: UtilityProcess, message: string, code: FaultCode) {
    if (this.child !== child || this.terminating) return;
    this.terminating = true;
    this.emit("terminating");
    this.clearNativeWaits();
    this.rejectAll(new Error(message));
    this.failRun(message, code);
    // Keep the process slot occupied until exit: an old native job must not
    // overlap a replacement worker on the same device.
    this.kill(child);
  }
  private nativeWait(child: UtilityProcess, wait: NativeWait) {
    const current = this.nativeWaits.get(wait.id);
    if (wait.phase === "end") {
      if (current?.operation === wait.operation) {
        clearTimeout(current.timer);
        this.nativeWaits.delete(wait.id);
      }
      return;
    }
    // A duplicate begin cannot extend an in-flight operation's deadline.
    if (current) return;
    const limit = nativeWaitLimits[wait.operation];
    this.nativeWaits.set(wait.id, {
      operation: wait.operation,
      timer: setTimeout(() => {
        this.terminate(
          child,
          `${limit.label}等待超过 ${limit.timeoutMs / 1000} 秒，已请求终止执行器；退出前设备仍被占用，任务结果未知`,
          "worker-native-timeout",
        );
      }, limit.timeoutMs),
    });
  }
  private clearNativeWaits() {
    for (const wait of this.nativeWaits.values()) clearTimeout(wait.timer);
    this.nativeWaits.clear();
  }
  private kill(child: UtilityProcess) {
    try {
      child.kill();
    } catch {
      // Failed kill is not an exit. Keep the slot quarantined until the exit event.
    }
  }
  private rejectAll(error: Error) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  private clearDeadlines() {
    clearTimeout(this.runTimer);
    clearTimeout(this.stepTimer);
    this.runTimer = this.stepTimer = undefined;
    this.activeSkill = undefined;
    this.stepBudgets = undefined;
    this.startedSteps.clear();
  }
  close() {
    this.clearDeadlines();
    this.clearNativeWaits();
    this.activeRun = undefined;
    this.rejectAll(new Error("应用正在关闭"));
    const child = this.child;
    if (!child || this.terminating) return;
    this.terminating = true;
    this.emit("terminating");
    this.kill(child);
  }
  /** Disposal used before returning a device lease: requesting kill is not proof of exit. */
  async closeAndWait(timeout = 30000) {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", finish);
        reject(new Error("执行器退出未确认，设备暂不可重新使用"));
      }, timeout);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      child.once("exit", finish);
    });
    this.close();
    await exited;
  }
}
