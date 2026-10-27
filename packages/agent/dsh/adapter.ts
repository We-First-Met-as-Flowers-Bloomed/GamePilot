import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentToolError } from "../../protocol/agent";
import { retryableRuntimeClose } from "../runtime-lifecycle";
import type { PlannerUsage } from "../../protocol/agent-planner";
import {
  withCompatibleHttp,
  type CompatibleConnection,
} from "../openai-compatible/http";
import {
  compatibleRequest,
  compatibleResponse,
  DSH_MODEL_REQUEST_BYTES,
  dshEndReasonError,
  publicDshEvents,
  publicHistoryEvents,
  record,
  type DshEvent,
  type DshHistoryEvent,
} from "./protocol";

export type { DshEvent } from "./protocol";
export const DSH_VERSION = "0.2.1-alpha.1";
export interface DshToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}
export interface DshRuntimeLocation {
  directory: string;
  nodePath?: string;
  home?: string;
}
export interface DshRuntimeOptions {
  connection: CompatibleConnection;
  tools: DshToolSpec[];
  callTool: (
    name: string,
    args: Record<string, unknown>,
    context: { callId: string; signal: AbortSignal },
  ) => Promise<unknown> | unknown;
  onEvent?: (event: DshEvent) => void;
  runtime?: DshRuntimeLocation;
  systemPrompt?: string;
  timeoutMs?: number;
}
export interface DshTurnOptions {
  prompt: string;
  at: string;
  signal?: AbortSignal;
  sessionId?: string;
  resume?: boolean;
}
export interface DshRunResult {
  finalText: string;
  model: string;
  events: DshEvent[];
  usage?: PlannerUsage;
  sessionId: string;
}
export interface DshRunOptions extends DshRuntimeOptions, DshTurnOptions {}
export interface DshHistory {
  sessionId: string;
  throughSeq: number;
  status: "running" | "idle" | "cold";
  events: DshHistoryEvent[];
}

const failure = (code: string, message: string) =>
  new AgentToolError(code, message);
const exists = async (path: string) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
function validSessionId(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(value))
    throw failure("INVALID_SESSION_ID", "DSH 会话标识无效");
}
function safeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
async function runtimeLocation(input?: DshRuntimeLocation) {
  const resources = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const directory = resolve(
    input?.directory ??
      (resources && (await exists(join(resources, "gamepilot-dsh-runtime")))
        ? join(resources, "gamepilot-dsh-runtime")
        : join(process.cwd(), "integrations/deepseek-harness/runtime")),
  );
  const nodePath =
    input?.nodePath ??
    join(
      directory,
      "node",
      process.platform === "win32" ? "node.exe" : "bin/node",
    );
  const home = resolve(
    input?.home ?? join(homedir(), ".gamepilot", "dsh-runtime"),
  );
  try {
    for (const name of ["dsh", "dsh-sdk-client"]) {
      const manifest = JSON.parse(
        await readFile(
          join(directory, "node_modules/@deepseek-ai", name, "package.json"),
          "utf8",
        ),
      );
      if (manifest.version !== DSH_VERSION)
        throw new Error("wrong fixed version");
    }
    const { stdout } = await promisify(execFile)(nodePath, ["--version"], {
      windowsHide: true,
      timeout: 5000,
    });
    const version = /^v(\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
    if (
      !version ||
      !(
        Number(version[1]) >= 24 ||
        (Number(version[1]) === 22 && Number(version[2]) >= 19)
      )
    )
      throw new Error("unsupported Node");
    await mkdir(home, { recursive: true });
  } catch {
    throw failure(
      "DSH_RUNTIME_UNAVAILABLE",
      "DSH 固定版本运行环境未就绪，请先运行 setup-dsh-runtime",
    );
  }
  return { directory, nodePath, home };
}
interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}
interface ActiveTurn {
  sessionId: string;
  controller: AbortController;
  events: DshEvent[];
  usage?: PlannerUsage;
  requests: number;
  toolNames: Map<string, string>;
  model: string;
  stop?: Promise<void>;
  stopped?: AgentToolError;
  rejectStop(error: unknown): void;
}
interface HistoryFollower {
  sessionId: string;
  cursor: number;
  buffering: boolean;
  buffer: unknown[];
  onEvent(event: DshHistoryEvent): void;
  close(): void;
}

export function createDshRuntime(options: DshRuntimeOptions) {
  const tools = new Map<string, DshToolSpec>();
  for (const tool of options.tools) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(tool.name) ||
      tools.has(tool.name) ||
      typeof tool.description !== "string" ||
      !tool.description.trim()
    )
      throw failure("INVALID_TOOL", "DSH 工具清单无效");
    tools.set(tool.name, { ...tool, inputSchema: record(tool.inputSchema) });
  }
  let closed = false;
  let child: ChildProcessWithoutNullStreams | undefined;
  let childExited: Promise<void> | undefined;
  let bridge: ReturnType<typeof createServer> | undefined;
  let starting: Promise<void> | undefined;
  let active: ActiveTurn | undefined;
  let serial = 0;
  const requests = new Map<number, PendingRequest>();
  const knownSessions = new Set<string>();
  const followers = new Set<HistoryFollower>();
  const token = randomBytes(32).toString("hex");

  function emit(event: DshEvent) {
    active?.events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      /* an observer never changes execution */
    }
  }
  function deliverHistory(follower: HistoryFollower, value: unknown) {
    const raw = record(value);
    if (typeof raw.seq !== "number" || raw.seq <= follower.cursor) return;
    follower.cursor = raw.seq;
    for (const event of publicHistoryEvents([value]))
      try {
        follower.onEvent(event);
      } catch {}
  }
  function request(
    method: string,
    params: object,
    timeoutMs = 35000,
  ): Promise<unknown> {
    if (!child || child.exitCode !== null || child.killed)
      return Promise.reject(
        failure("DSH_RUNTIME_FAILED", "DSH 后台进程已退出"),
      );
    const id = ++serial;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        rejectRequest(failure("DSH_CONTROL_TIMEOUT", "DSH 控制请求超时"));
      }, timeoutMs);
      requests.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });
      child!.stdin.write(
        JSON.stringify({ id, method, params }) + "\n",
        (error) => {
          if (error) {
            clearTimeout(timer);
            requests.delete(id);
            rejectRequest(failure("DSH_RUNTIME_FAILED", "DSH 后台通信中断"));
          }
        },
      );
    });
  }
  async function bodyOf(input: IncomingMessage) {
    let size = 0;
    const chunks: Buffer[] = [];
    const model = input.url === "/model";
    const limit = model ? DSH_MODEL_REQUEST_BYTES : 1024 * 1024;
    // Preserve the socket long enough to deliver a structured limit error.
    // The default async iterator destroys it when the loop throws early.
    for await (const value of input.iterator({ destroyOnReturn: false })) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > limit)
        throw failure(
          model ? "DSH_CONTEXT_TOO_LARGE" : "RESPONSE_TOO_LARGE",
          model ? "DSH 会话上下文超过 4 MiB 桥接上限" : "DSH 桥接请求过大",
        );
      chunks.push(chunk);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  }
  async function hostRequest(input: IncomingMessage, output: ServerResponse) {
    const received = Buffer.from(input.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      input.method !== "POST" ||
      input.headers.origin ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      output.writeHead(403);
      output.end();
      return;
    }
    const respond = (value: unknown, status = 200) => {
      if (!output.destroyed) {
        output.writeHead(status, { "Content-Type": "application/json" });
        output.end(JSON.stringify(value));
      }
    };
    try {
      const body = await bodyOf(input);
      if (input.url === "/metadata") {
        respond({
          model: options.connection.model,
          tools: [...tools.values()],
        });
        return;
      }
      const turn = active;
      if (
        !turn ||
        body.sessionId !== turn.sessionId ||
        turn.controller.signal.aborted
      )
        throw failure("CANCELLED", "DSH 模型轮次已取消");
      const controller = new AbortController();
      const abort = () => controller.abort();
      turn.controller.signal.addEventListener("abort", abort, { once: true });
      output.once("close", abort);
      try {
        if (input.url === "/model") {
          if (++turn.requests > 16)
            throw failure("ROUND_BUDGET", "DSH 模型轮次超过预算");
          const result = await withCompatibleHttp(
            options.connection,
            120000,
            controller.signal,
            async (http) =>
              compatibleResponse(await http.request(compatibleRequest(body))),
            (event) => {
              if (event.kind === "finished" || event.kind === "error") return;
              if (event.kind === "usage") {
                turn.usage ??= {};
                for (const [key, count] of Object.entries(event.usage))
                  turn.usage[key as keyof PlannerUsage] =
                    (turn.usage[key as keyof PlannerUsage] ?? 0) + count!;
              }
              if (event.kind === "attempt")
                emit({ ...event, attempt: turn.requests });
              else emit(event as DshEvent);
            },
            {
              "User-Agent": `deepseek-harness/${DSH_VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`,
            },
          );
          turn.model = result.model;
          respond(result);
        } else if (input.url === "/tool") {
          if (
            typeof body.name !== "string" ||
            !tools.has(body.name) ||
            typeof body.callId !== "string" ||
            !body.callId
          )
            throw failure("TOOL_FORBIDDEN", "拒绝未注册 DSH 工具");
          const args = record(body.args);
          if (!turn.toolNames.has(body.callId))
            emit({
              kind: "tool-requested",
              callId: body.callId,
              tool: body.name,
            });
          turn.toolNames.set(body.callId, body.name);
          emit({ kind: "tool-started", callId: body.callId, tool: body.name });
          const value = await options.callTool(body.name, args, {
            callId: body.callId,
            signal: controller.signal,
          });
          if (controller.signal.aborted)
            throw failure("CANCELLED", "DSH 工具请求已取消");
          // Validate the transport and DSH output as a JSON value before acknowledgement.
          const encoded = JSON.stringify(value);
          if (encoded === undefined || Buffer.byteLength(encoded) > 1024 * 1024)
            throw failure("INVALID_TOOL_OUTPUT", "DSH 工具结果无效或过大");
          respond(JSON.parse(encoded));
        } else throw failure("TOOL_FORBIDDEN", "DSH 桥接路径未注册");
      } finally {
        turn.controller.signal.removeEventListener("abort", abort);
        output.removeListener("close", abort);
      }
    } catch (error) {
      // Discard any unread bytes without retaining them or dispatching a tool.
      input.resume();
      const safe =
        error instanceof AgentToolError
          ? error
          : failure("DSH_BRIDGE_FAILED", "DSH 宿主操作未完成");
      respond({ code: safe.code, message: safe.message }, 400);
    }
  }
  async function disposeChild() {
    const owned = child;
    if (!owned) return;
    try {
      await request("close", {}, 7500);
    } catch {}
    if (owned.exitCode === null) {
      if (process.platform === "win32" && owned.pid)
        await promisify(execFile)(
          "taskkill.exe",
          ["/PID", String(owned.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5000 },
        ).catch(() => {});
      else owned.kill("SIGKILL");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        childExited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                failure(
                  "DSH_REAP_FAILED",
                  "DSH 后台退出尚未确认，禁止启动重叠进程",
                ),
              ),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    child = undefined;
    starting = undefined;
  }
  async function ensureStarted() {
    if (closed) throw failure("DSH_CLOSED", "DSH 运行服务已关闭");
    if (starting) return starting;
    starting = (async () => {
      const location = await runtimeLocation(options.runtime);
      if (closed) throw failure("DSH_CLOSED", "DSH 运行服务已关闭");
      bridge = createServer((input, output) => {
        void hostRequest(input, output);
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        bridge!.once("error", rejectListen);
        bridge!.listen(0, "127.0.0.1", () => {
          bridge!.removeListener("error", rejectListen);
          resolveListen();
        });
      });
      const address = bridge.address() as import("node:net").AddressInfo;
      if (closed) {
        await disposeBridge();
        throw failure("DSH_CLOSED", "DSH 运行服务已关闭");
      }
      child = spawn(
        location.nodePath,
        [join(location.directory, "launcher.mjs")],
        {
          cwd: location.directory,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...safeEnvironment(),
            GAMEPILOT_DSH_BRIDGE: `http://127.0.0.1:${address.port}`,
            GAMEPILOT_DSH_TOKEN: token,
            DSH_HOME: location.home,
          },
        },
      );
      const owned = child;
      childExited = new Promise<void>((resolveExit) => {
        const end = () => {
          for (const pending of requests.values()) {
            clearTimeout(pending.timer);
            pending.reject(failure("DSH_RUNTIME_FAILED", "DSH 后台进程已退出"));
          }
          requests.clear();
          resolveExit();
        };
        owned.once("exit", end);
        owned.once("error", end);
      });
      // Never store or surface arbitrary upstream stderr; diagnostics can include private context.
      owned.stderr.resume();
      const lines = createInterface({
        input: owned.stdout,
        crlfDelay: Infinity,
      });
      lines.on("line", (line) => {
        try {
          if (line.length > 4 * 1024 * 1024) throw new Error("large frame");
          const message = record(JSON.parse(line));
          if (message.notification === "session.event") {
            for (const follower of followers)
              if (message.sessionId === follower.sessionId) {
                if (follower.buffering) follower.buffer.push(message.event);
                else deliverHistory(follower, message.event);
              }
            if (active && message.sessionId === active.sessionId)
              for (const event of publicDshEvents(
                message.event,
                active.toolNames,
              )) {
                if (event.kind === "tool-requested") {
                  if (active.toolNames.has(event.callId)) continue;
                  active.toolNames.set(event.callId, event.tool);
                }
                // Provider streaming already published public answer text exactly once.
                if (event.kind !== "answer-delta") emit(event);
              }
          } else {
            const pending = requests.get(message.id as number);
            if (!pending) return;
            requests.delete(message.id as number);
            clearTimeout(pending.timer);
            if (message.error)
              pending.reject(
                failure("DSH_RUNTIME_FAILED", "DSH 后台控制请求失败"),
              );
            else pending.resolve(message.result);
          }
        } catch {
          for (const pending of requests.values()) {
            clearTimeout(pending.timer);
            pending.reject(failure("PROTOCOL_ERROR", "DSH 后台通信格式无效"));
          }
          requests.clear();
          void disposeChild().catch(() => {});
        }
      });
      try {
        await request("initialize", {
          home: location.home,
          cwd: location.directory,
          model: options.connection.model,
          systemPrompt:
            options.systemPrompt ??
            "You are GamePilot's game agent. Use only the registered host tools. Host authorization, execution records and result verification are authoritative. Model idle is not game completion. Never invent execution or completion evidence.",
        });
      } catch (error) {
        await disposeChild();
        await disposeBridge();
        throw error;
      }
    })();
    try {
      await starting;
    } catch (error) {
      starting = undefined;
      throw error;
    }
  }
  async function disposeBridge() {
    const owned = bridge;
    bridge = undefined;
    if (!owned) return;
    owned.closeAllConnections();
    await new Promise<void>((done) => owned.close(() => done()));
  }
  async function stopTurn(turn: ActiveTurn, error: AgentToolError) {
    turn.stop ??= (async () => {
      turn.stopped = error;
      turn.controller.abort();
      try {
        if (child && starting)
          await request("cancel", { sessionId: turn.sessionId }, 5000);
      } catch {
        try {
          await disposeChild();
          await disposeBridge();
        } catch (reap) {
          turn.stopped =
            reap instanceof AgentToolError
              ? reap
              : failure(
                  "DSH_REAP_FAILED",
                  "DSH 后台退出尚未确认，禁止启动重叠进程",
                );
        }
      }
      turn.rejectStop(turn.stopped);
    })();
    await turn.stop;
  }
  async function run(input: DshTurnOptions): Promise<DshRunResult> {
    if (closed) throw failure("DSH_CLOSED", "DSH 运行服务已关闭");
    if (active) throw failure("DSH_BUSY", "DSH 正在处理上一轮需求");
    if (
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      input.prompt.length > 30000 ||
      !Number.isFinite(Date.parse(input.at))
    )
      throw failure("INVALID_PROMPT", "DSH 需求或时间无效");
    if (input.signal?.aborted) throw failure("CANCELLED", "DSH 模型轮次已取消");
    const sessionId = input.sessionId ?? randomUUID();
    validSessionId(sessionId);
    let rejectStop!: (error: unknown) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    // Attach a handler before startup so cancellation never becomes an unhandled rejection.
    void stopped.catch(() => {});
    const turn: ActiveTurn = {
      sessionId,
      controller: new AbortController(),
      events: [],
      requests: 0,
      toolNames: new Map(),
      model: options.connection.model,
      rejectStop,
    };
    active = turn;
    const cancel = () => {
      void stopTurn(turn, failure("CANCELLED", "DSH 模型轮次已取消"));
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      void stopTurn(turn, failure("TIMEOUT", "DSH 模型轮次超时"));
    }, options.timeoutMs ?? 120000);
    try {
      await ensureStarted();
      if (turn.stopped) throw turn.stopped;
      const result = record(
        await Promise.race([
          request(
            "run",
            {
              sessionId,
              prompt: input.prompt,
              resume: input.resume === true || knownSessions.has(sessionId),
            },
            (options.timeoutMs ?? 120000) + 10000,
          ),
          stopped,
        ]),
      );
      knownSessions.add(sessionId);
      const reason = record(result.endReason ?? {});
      if (turn.stopped) throw turn.stopped;
      if (reason.kind === "aborted")
        throw failure("CANCELLED", "DSH 模型轮次已取消");
      if (reason.kind !== "completed") throw dshEndReasonError(reason);
      if (typeof result.finalText !== "string")
        throw failure("PROTOCOL_ERROR", "DSH 最终回复格式无效");
      emit({ kind: "finished" });
      return {
        sessionId,
        finalText: result.finalText,
        model: turn.model,
        events: turn.events,
        ...(turn.usage ? { usage: turn.usage } : {}),
      };
    } catch (error) {
      const safe =
        error instanceof AgentToolError
          ? error
          : failure("DSH_RUNTIME_FAILED", "DSH 模型运行未完成");
      if (
        [
          "DSH_RUNTIME_FAILED",
          "DSH_CONTROL_TIMEOUT",
          "PROTOCOL_ERROR",
        ].includes(safe.code)
      ) {
        turn.controller.abort();
        await disposeChild();
        await disposeBridge();
      }
      emit({ kind: "error", code: safe.code, message: safe.message });
      throw safe;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      await turn.stop;
      active = undefined;
    }
  }
  return {
    run,
    async cancel(sessionId: string) {
      validSessionId(sessionId);
      if (active?.sessionId === sessionId)
        await stopTurn(active, failure("CANCELLED", "DSH 模型轮次已取消"));
      else {
        await ensureStarted();
        await request("cancel", { sessionId }, 5000);
      }
    },
    async history(input: {
      sessionId: string;
      afterSeq?: number;
    }): Promise<DshHistory> {
      validSessionId(input.sessionId);
      await ensureStarted();
      const result = record(await request("history", input));
      return {
        sessionId: input.sessionId,
        throughSeq: result.throughSeq as number,
        status: result.status as DshHistory["status"],
        events: publicHistoryEvents(result.events),
      };
    },
    async follow(input: {
      sessionId: string;
      afterSeq?: number;
      signal?: AbortSignal;
      onEvent: (event: DshHistoryEvent) => void;
    }): Promise<{ throughSeq: number; close(): void }> {
      validSessionId(input.sessionId);
      if (
        input.afterSeq !== undefined &&
        (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < -1)
      )
        throw failure("INVALID_CURSOR", "DSH 历史游标无效");
      await ensureStarted();
      let follower!: HistoryFollower;
      const close = () => {
        followers.delete(follower);
        input.signal?.removeEventListener("abort", close);
      };
      follower = {
        sessionId: input.sessionId,
        cursor: input.afterSeq ?? -1,
        buffering: true,
        buffer: [],
        onEvent: input.onEvent,
        close,
      };
      followers.add(follower);
      input.signal?.addEventListener("abort", close, { once: true });
      if (input.signal?.aborted) close();
      try {
        const snapshot = record(
          await request("history", {
            sessionId: input.sessionId,
            afterSeq: input.afterSeq,
          }),
        );
        if (followers.has(follower)) {
          if (!Array.isArray(snapshot.events))
            throw failure("PROTOCOL_ERROR", "DSH 历史格式无效");
          for (const event of snapshot.events) deliverHistory(follower, event);
          follower.buffering = false;
          for (const event of follower.buffer) deliverHistory(follower, event);
          follower.buffer.length = 0;
        }
        return { throughSeq: snapshot.throughSeq as number, close };
      } catch (error) {
        close();
        throw error;
      }
    },
    close: retryableRuntimeClose(async () => {
      closed = true;
      for (const follower of followers) follower.close();
      if (active)
        await stopTurn(active, failure("CANCELLED", "DSH 模型轮次已取消"));
      await starting?.catch(() => {});
      await disposeChild();
      await disposeBridge();
    }),
  };
}

export async function runWithDsh(
  options: DshRunOptions,
): Promise<DshRunResult> {
  const runtime = createDshRuntime(options);
  try {
    return await runtime.run(options);
  } finally {
    await runtime.close();
  }
}
