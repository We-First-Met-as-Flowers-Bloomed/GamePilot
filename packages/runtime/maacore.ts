import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { ConnectionUnavailableError } from "../protocol/failure";
import { deriveMumuConnection } from "./mumu-connection";
import { readActivityNavigation } from "./maa-activity-resource";

export class MaaCoreClient {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private dead?: Error;
  private processEnded = false;
  private closing?: Promise<void>;
  private ready?: Promise<{ version: string }>;
  private logger?: (message: string) => void;
  private pending = new Map<
    number,
    {
      resolve(value: any): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private exePath: string,
    private coreDir: string,
    private logDir: string,
    private connectionOptions: { clientType?: string } = {},
  ) {}
  private fail(error: Error) {
    this.dead = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  private requestTermination() {
    try {
      this.child?.kill();
    } catch {
      // A kill request is never exit proof; close still requires an exit event.
    }
  }
  private request(
    method: string,
    args: Record<string, unknown> = {},
    timeout = 120_000,
  ): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    if (this.closing && method !== "close")
      return Promise.reject(new Error("MaaCore bridge is closing"));
    if (!this.child) {
      this.child = spawn(this.exePath, ["--parent-pid", String(process.pid)], {
        windowsHide: true,
        stdio: "pipe",
      });
      this.child.on("error", (error) => {
        // A post-spawn error can mean kill/send failed; it is not exit proof.
        if (this.child?.pid === undefined) this.processEnded = true;
        this.fail(error);
      });
      this.child.on("close", () => {
        this.processEnded = true;
      });
      this.child.on("exit", (code, signal) => {
        this.processEnded = true;
        this.fail(new Error(`MaaCore bridge exited (${code ?? signal})`));
      });
      this.child.stdin.on("error", (error) => this.fail(error));
      this.child.stderr.on("data", (data) =>
        this.logger?.(String(data).slice(0, 4000)),
      );
      createInterface({ input: this.child.stdout }).on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.event === "callback") {
            this.logger?.(`MAA ${message.message}: ${message.details}`);
            return;
          }
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.ok) request.resolve(message.result);
          else request.reject(new Error(message.error || "MaaCore failed"));
        } catch {
          this.fail(new Error("Invalid MaaCore bridge protocol"));
          this.requestTermination();
        }
      });
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`MaaCore ${method} timed out`));
        this.requestTermination();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, ...args }) + "\n");
    });
  }
  info(): Promise<{ version: string }> {
    return (this.ready ??= this.initialize());
  }
  private async initialize():Promise<{version:string}> {
    const root=process.env.GAMEPILOT_MAA_ACTIVITY_ROOT;
    const navigation=root?await readActivityNavigation(root):undefined;
    return this.request("init", {coreDir:this.coreDir,logDir:this.logDir,
      ...(navigation?{activityDirectory:navigation.directory,activitySha256:navigation.sha256}:{})});
  }
  async connect(adbPath: string, address: string): Promise<void> {
    const mumu = deriveMumuConnection(adbPath, address);
    await this.info();
    try {
      await this.request("connect", {
        adbPath, address,
        ...(mumu ? {mumu: {...mumu, clientType: this.connectionOptions.clientType ?? "Official"}} : {}),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "MaaCore connection failed" ||
          error.message === "MaaCore connect timed out")
      )
        throw new ConnectionUnavailableError(error.message, { cause: error });
      throw error;
    }
  }
  async validateTask(
    type: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.info();
    await this.request("validateTask", { type, params }, 30_000);
  }
  async runTask(
    type: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    log: (message: string) => void,
    timeoutMs = 120 * 60_000 + 60_000,
  ): Promise<void> {
    if (signal.aborted) throw new Error("MAA task cancelled");
    // Allow the configured run budget (up to six hours) plus stop grace.
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 360 * 60_000 + 60_000
    )
      throw new Error("Invalid MaaCore task timeout");
    await this.info();
    if (signal.aborted) throw new Error("MAA task cancelled");
    if (this.logger) throw new Error("MaaCore task already running");
    this.logger = log;
    let stopping: Promise<unknown> | undefined;
    const abort = () => {
      stopping ??= this.request("stop", {}, 30_000);
      void stopping.catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.request("runTask", { type, params }, timeoutMs);
    } finally {
      signal.removeEventListener("abort", abort);
      try {
        if (stopping) await stopping;
      } finally {
        this.logger = undefined;
      }
    }
    if (signal.aborted) throw new Error("MAA task cancelled");
  }
  close(): Promise<void> {
    if (
      !this.child ||
      this.processEnded ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return Promise.resolve();
    return (this.closing ??= this.closeBridge());
  }
  private async closeBridge(): Promise<void> {
    const child = this.child!;
    if (!this.dead) {
      try {
        await this.request("close", {}, 30_000);
      } catch {
        /* exit also releases native state */
      }
    }
    if (
      !this.processEnded &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(killTimer);
          clearTimeout(deadline);
          child.removeListener("exit", finish);
          child.removeListener("close", finish);
        };
        const finish = () => {
          cleanup();
          resolve();
        };
        const killTimer = setTimeout(() => {
          this.requestTermination();
        }, 1000);
        const deadline = setTimeout(() => {
          cleanup();
          const error = new Error("MaaCore bridge exit unconfirmed");
          this.fail(error);
          reject(error);
        }, 5000);
        child.once("exit", finish);
        child.once("close", finish);
      });
    }
  }
}
