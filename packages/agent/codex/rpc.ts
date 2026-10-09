import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { AgentToolError } from "../../protocol/agent";

export interface RpcEvent {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}
export interface PlannerRpc {
  request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  next(): Promise<RpcEvent>;
  respond(id: string | number, result: unknown): void;
}

/** Newline JSON-RPC, bounded queues; raw stderr/server errors never enter reports. */
export class StdioRpc implements PlannerRpc {
  private child: ChildProcessWithoutNullStreams;
  private serial = 0;
  private buffer = "";
  private queue: RpcEvent[] = [];
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private waiter?: {
    resolve: (event: RpcEvent) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;
  private exited: Promise<void>;
  constructor(executable: string, args: string[], cwd: string) {
    this.child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: "pipe",
      shell: false,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        this.stop(new AgentToolError("CODEX_EXITED", "Codex 进程已退出"));
        resolve();
      });
      this.child.once("error", () => {
        this.stop(
          new AgentToolError("CODEX_START_FAILED", "Codex 进程无法启动"),
        );
        resolve();
      });
    });
    this.child.stdin.on("error", () =>
      this.stop(new AgentToolError("CODEX_PIPE_CLOSED", "Codex 连接已断开")),
    );
    this.child.stderr.resume();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 1024 * 1024)
        return this.stop(
          new AgentToolError("FRAME_LIMIT", "Codex 消息超过大小限制"),
        );
      let end: number;
      while (!this.failure && (end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try {
          this.accept(JSON.parse(line));
        } catch {
          this.stop(new AgentToolError("PROTOCOL_ERROR", "Codex 协议消息无效"));
        }
      }
    });
  }
  private accept(message: Record<string, unknown>) {
    if (!message || typeof message !== "object" || Array.isArray(message))
      throw new Error();
    if (typeof message.method === "string") {
      const event = message as unknown as RpcEvent;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = undefined;
        w.resolve(event);
      } else if (this.queue.length < 1024) this.queue.push(event);
      else throw new Error();
    } else {
      const pending = this.pending.get(message.id as number);
      if (!pending) throw new Error();
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new AgentToolError(
            "CODEX_RPC_ERROR",
            "Codex 拒绝请求；请检查认证、配额或协议兼容性",
          ),
        );
      else if ("result" in message) pending.resolve(message.result);
      else {
        pending.reject(
          new AgentToolError("PROTOCOL_ERROR", "Codex 响应缺少结果"),
        );
        throw new Error();
      }
    }
  }
  private send(message: unknown) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }
  notify(method: string, params?: unknown) {
    this.send({ method, params });
  }
  respond(id: string | number, result: unknown) {
    this.send({ id, result });
  }
  request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30000,
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.stop(
            new AgentToolError("TIMEOUT", "Codex 请求超时，未执行游戏任务"),
          ),
        timeoutMs,
      );
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.stop(error as Error);
      }
    });
  }
  next(): Promise<RpcEvent> {
    if (this.failure) return Promise.reject(this.failure);
    const event = this.queue.shift();
    if (event) return Promise.resolve(event);
    if (this.waiter)
      return Promise.reject(new Error("Only one event consumer is supported"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  stop(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.waiter?.reject(error);
    this.waiter = undefined;
    this.queue = [];
    this.buffer = "";
    this.child.kill();
  }
  async close() {
    this.stop(new AgentToolError("CLOSED", "规划会话已关闭"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AgentToolError(
                  "SHUTDOWN_FAILED",
                  "未能确认 Codex 进程退出",
                ),
              ),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
