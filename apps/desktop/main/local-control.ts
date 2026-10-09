import { createServer, connect, type Socket } from "node:net";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, writeFile, unlink, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { boundedRead } from "../../../packages/agent/read-file";
import { canonical } from "../../../packages/acceptance/files";
import { AgentToolError } from "../../../packages/protocol/agent";
import {
  localControlMethods,
  validLocalControlParams,
  type LocalControlHandlers,
  type LocalControlMethod,
  type LocalControlResponse,
} from "../../../packages/protocol/local-control";

const maxRequestBytes = 64 * 1024;
const maxResponseBytes = 256 * 1024;
const maxConnections = 16;
const maxStops = 4;
const maxMutationRequests = 1024;
const reads = new Set<LocalControlMethod>(["status", "capabilities", "events"]);
const failure = (
  code: string,
  message: string,
  id?: string,
  outcomeUnknown?: true,
): LocalControlResponse => ({
  ...(id ? { id } : {}),
  ok: false,
  error: { code, message, ...(outcomeUnknown ? { outcomeUnknown } : {}) },
});

function publicFacts(value: unknown, depth = 0): unknown {
  if (depth > 16)
    throw new AgentToolError("RESPONSE_TOO_LARGE", "宿主响应超过限制");
  if (Array.isArray(value))
    return value.map((item) => publicFacts(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/uid|key|token|secret|password|credential|path|executable/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, publicFacts(item, depth + 1)]),
    );
  if (
    typeof value === "string" &&
    /(?:[A-Za-z]:[\\/]|\\\\[^ ]+\\|\/(?:home|Users|tmp)\/|Bearer\s+\S+|sk-[A-Za-z0-9_-]{12,})/.test(
      value,
    )
  )
    return "私密字段已隐藏";
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (["bigint", "function", "symbol"].includes(typeof value))
    throw new AgentToolError("INVALID_HOST_RESULT", "宿主回执格式无效");
  return value ?? null;
}
async function livePipe(pipe: string) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(pipe);
    const finish = (live: boolean) => {
      socket.destroy();
      resolve(live);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(true)); // Uncertain ownership never causes replacement.
  });
}

/** A thin transport over the running App's existing services. No executor or model provider is created. */
export async function createLocalControlServer(options: {
  profileDir: string;
  handlers: LocalControlHandlers;
  requestTimeoutMs?: number;
}) {
  const directory = resolve(options.profileDir);
  const connectionFile = join(directory, "agent-control.json");
  const hostId = randomUUID();
  const profileHash = createHash("sha256")
    .update(directory.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\gamepilot-control-${profileHash}-${hostId}`
      : join(directory, `agent-control-${hostId}.sock`);
  const token = randomBytes(32).toString("hex");
  const requestTimeoutMs = options.requestTimeoutMs ?? 5000;
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 20 ||
    requestTimeoutMs > 10000
  )
    throw new AgentToolError("INVALID_TIMEOUT", "本机控制超时设置无效");
  await mkdir(directory, { recursive: true });
  let previous: string | undefined;
  try {
    previous = await boundedRead(connectionFile, 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new AgentToolError("INVALID_DISCOVERY", "本机控制连接文件无效");
  }
  if (previous !== undefined) {
    let old: {
      version?: unknown;
      pipe?: unknown;
      hostId?: unknown;
      token?: unknown;
    };
    try {
      old = JSON.parse(previous);
    } catch {
      throw new AgentToolError("INVALID_DISCOVERY", "本机控制连接文件无效");
    }
    const oldPipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\gamepilot-control-${profileHash}-${old.hostId}`
        : join(directory, `agent-control-${old.hostId}.sock`);
    if (
      old.version !== 1 ||
      typeof old.hostId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(old.hostId) ||
      typeof old.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(old.token) ||
      old.pipe !== oldPipe
    )
      throw new AgentToolError("INVALID_DISCOVERY", "本机控制连接文件无效");
    if (await livePipe(oldPipe))
      throw new AgentToolError(
        "HOST_ALREADY_RUNNING",
        "该App已经提供本机控制服务",
      );
    if ((await boundedRead(connectionFile, 4096)) !== previous)
      throw new AgentToolError("HOST_ALREADY_RUNNING", "App连接信息已更新");
    await unlink(connectionFile);
  }
  const sockets = new Set<Socket>();
  const mutations = new Map<
    string,
    { fingerprint: string; response?: LocalControlResponse }
  >();
  const stops = new Map<
    string,
    { fingerprint: string; response?: LocalControlResponse }
  >();
  let closed = false;
  let activeHandlers = 0;
  let activeStops = 0;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    if (closed || sockets.size >= maxConnections + maxStops) {
      socket.end(
        JSON.stringify(failure("BUSY", "本机控制连接超过限制")) + "\n",
        () => socket.destroy(),
      );
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let processed = false;
    let finished = false;
    let id: string | undefined;
    let uncertain = false;
    const respond = (response: LocalControlResponse) => {
      if (finished || socket.destroyed) return;
      const text = JSON.stringify(response);
      finished = true;
      clearTimeout(timer);
      socket.end(
        (Buffer.byteLength(text) + 1 <= maxResponseBytes
          ? text
          : JSON.stringify(
              failure(
                "RESPONSE_TOO_LARGE",
                "宿主响应超过限制",
                id,
                uncertain ? true : undefined,
              ),
            )) + "\n",
      );
    };
    const timer = setTimeout(
      () =>
        respond(
          failure(
            "TIMEOUT",
            "本机控制请求超时，请在App核对请求状态",
            id,
            uncertain ? true : undefined,
          ),
        ),
      requestTimeoutMs,
    );
    socket.once("close", () => clearTimeout(timer));
    socket.on("data", (chunk) => {
      if (processed) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxRequestBytes) {
        processed = true;
        respond(failure("FRAME_TOO_LARGE", "本机控制请求超过大小限制"));
        return;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      processed = true;
      if (
        buffer
          .subarray(end + 1)
          .toString()
          .trim()
      ) {
        respond(failure("PROTOCOL_ERROR", "每次连接只允许一个请求"));
        return;
      }
      void (async () => {
        let frame: Record<string, unknown>;
        try {
          const raw = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, end),
            ),
          );
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error();
          frame = raw;
        } catch {
          respond(failure("PROTOCOL_ERROR", "本机控制请求格式无效"));
          return;
        }
        if (
          typeof frame.id === "string" &&
          /^[A-Za-z0-9_:-]{1,200}$/.test(frame.id)
        )
          id = frame.id;
        if (
          typeof frame.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(frame.token) ||
          !timingSafeEqual(Buffer.from(frame.token), Buffer.from(token))
        ) {
          respond(failure("AUTH_FAILED", "本机控制身份验证失败", id));
          return;
        }
        if (
          !id ||
          Object.keys(frame).some(
            (key) => !["id", "token", "method", "params"].includes(key),
          )
        ) {
          respond(failure("PROTOCOL_ERROR", "本机控制请求格式无效", id));
          return;
        }
        if (!localControlMethods.includes(frame.method as LocalControlMethod)) {
          respond(failure("METHOD_FORBIDDEN", "不支持该本机控制方法", id));
          return;
        }
        const method = frame.method as LocalControlMethod;
        if (!validLocalControlParams(method, frame.params)) {
          respond(failure("INVALID_PARAMS", "本机控制参数不符合约定", id));
          return;
        }
        const handler = options.handlers[method];
        if (!handler) {
          respond(failure("NOT_AVAILABLE", "运行中的App尚未提供该能力", id));
          return;
        }
        const mutation = !reads.has(method);
        const isStop = method === "stop";
        const receipts = isStop ? stops : mutations;
        const fingerprint = canonical({ method, params: frame.params });
        const prior = mutations.get(id) ?? stops.get(id);
        if (prior) {
          respond(
            prior.fingerprint !== fingerprint
              ? failure("REQUEST_ID_CONFLICT", "相同请求编号不能修改参数", id)
              : (prior.response ??
                  failure(
                    "REQUEST_IN_PROGRESS",
                    "App已受理请求，结果尚未知；不得重新提交",
                    id,
                    true,
                  )),
          );
          return;
        }
        if (
          (isStop
            ? activeStops >= maxStops
            : activeHandlers >= maxConnections) ||
          (mutation && receipts.size >= maxMutationRequests)
        ) {
          respond(
            failure("REQUEST_BUDGET", "本机控制请求超过预算，请在App操作", id),
          );
          return;
        }
        const entry: { fingerprint: string; response?: LocalControlResponse } =
          { fingerprint };
        if (mutation) {
          receipts.set(id, entry);
          uncertain = true;
        }
        if (isStop) activeStops++;
        else activeHandlers++;
        try {
          const result = publicFacts(await handler(frame.params));
          entry.response = { id, ok: true, result };
          if (
            Buffer.byteLength(JSON.stringify(entry.response)) + 1 >
            maxResponseBytes
          )
            throw new AgentToolError("RESPONSE_TOO_LARGE", "宿主响应超过限制");
        } catch (error) {
          const code = (error as { code?: unknown } | undefined)?.code;
          // These preview handlers never launch a game. A typed same-day
          // admission refusal is definite; confirmation/transport failures are not.
          const refusedPreview =
            ["command-review", "resume-review"].includes(method) &&
            error instanceof AgentToolError &&
            code === "SAME_DAY_EXECUTION";
          entry.response = failure(
            typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)
              ? code
              : "HOST_REJECTED",
            "App拒绝本机控制请求，请在App查看状态",
            id,
            mutation && !refusedPreview ? true : undefined,
          );
        } finally {
          if (isStop) activeStops--;
          else activeHandlers--;
        }
        respond(entry.response);
      })().catch(() =>
        respond(
          failure(
            "HOST_REJECTED",
            "本机控制请求未完成",
            id,
            uncertain ? true : undefined,
          ),
        ),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  server.on("error", () => {});
  if (process.platform !== "win32") await chmod(pipe, 0o600);
  try {
    await writeFile(
      connectionFile,
      JSON.stringify({ version: 1, hostId, pipe, token, pid: process.pid }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new AgentToolError(
      "DISCOVERY_WRITE_FAILED",
      "无法保存本机控制连接信息",
    );
  }
  return {
    connectionFile,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const current = JSON.parse(await boundedRead(connectionFile, 4096));
        if (current.hostId === hostId) await unlink(connectionFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AgentToolError(
            "DISCOVERY_CLEANUP_FAILED",
            "无法清理本机控制连接信息",
          );
      }
    },
  };
}
