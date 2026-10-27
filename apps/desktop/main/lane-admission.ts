import { freemem } from "node:os";

export interface LaneAdmissionOptions {
  maxConcurrent?: number;
  availableMemory?: () => number;
  minFreeMemoryBytes?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
}

type Release = () => void;
interface Waiter {
  grant(release: Release): void;
}

/** Bounded, cancellable admission. Never stops workers or emulator instances. */
export class LaneAdmission {
  private active = 0;
  private queue: Waiter[] = [];
  private retry?: ReturnType<typeof setTimeout>;
  private limit: number;
  private minimum: number;
  private timeout: number;
  private interval: number;

  constructor(private options: LaneAdmissionOptions = {}) {
    this.limit = options.maxConcurrent ?? Infinity;
    this.minimum = options.minFreeMemoryBytes ?? 0;
    this.timeout = options.waitTimeoutMs ?? 30 * 60_000;
    this.interval = options.pollIntervalMs ?? 1000;
    if (
      (this.limit !== Infinity &&
        (!Number.isInteger(this.limit) || this.limit < 1)) ||
      !Number.isFinite(this.minimum) ||
      this.minimum < 0 ||
      !Number.isFinite(this.timeout) ||
      this.timeout <= 0 ||
      !Number.isFinite(this.interval) ||
      this.interval <= 0
    )
      throw new Error("执行资源排队配置无效");
  }

  private available(): boolean {
    if (this.active >= this.limit) return false;
    if (!this.minimum) return true;
    try {
      const memory = (this.options.availableMemory ?? freemem)();
      return Number.isFinite(memory) && memory >= this.minimum;
    } catch {
      return false;
    }
  }

  private reserve(): Release {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain() {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    while (this.queue.length && this.available())
      this.queue.shift()!.grant(this.reserve());
    if (this.queue.length)
      this.retry = setTimeout(() => this.drain(), this.interval);
  }

  acquire(signal: AbortSignal): Release | Promise<Release> {
    signal.throwIfAborted();
    if (!this.queue.length && this.available()) return this.reserve();
    return new Promise<Release>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const remove = (error: unknown) => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        cleanup();
        reject(error);
        this.drain();
      };
      const abort = () => remove(signal.reason);
      const waiter: Waiter = {
        grant: (release) => {
          cleanup();
          resolve(release);
        },
      };
      this.queue.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => remove(new Error("等待执行资源超时，请稍后重试")),
        this.timeout,
      );
      this.drain();
    });
  }
}
