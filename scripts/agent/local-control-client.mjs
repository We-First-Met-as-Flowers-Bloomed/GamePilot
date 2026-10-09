import { connect } from "node:net";
import { open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import schemas from "../../packages/protocol/local-control-schema.json" with { type: "json" };

export class LocalControlError extends Error {
  constructor(code, message, outcomeUnknown = false) {
    super(message);
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}
export const localControlMethods = Object.keys(schemas);
export const localControlSchemas = schemas;
export function publicError(error) {
  const known = error instanceof LocalControlError;
  return {
    ok: false,
    error: {
      code: known ? error.code : "CONTROL_FAILED",
      message: known ? error.message : "本机控制请求未完成",
      ...(known && error.outcomeUnknown ? { outcomeUnknown: true } : {}),
    },
  };
}
export async function boundedJson(path, maximum = 65536) {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum)
      throw new LocalControlError(
        "INVALID_INPUT",
        "输入文件无效或超过大小限制",
      );
    const bytes = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        size,
        bytes.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maximum)
      throw new LocalControlError("INVALID_INPUT", "输入文件超过大小限制");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
      );
    } catch {
      throw new LocalControlError("INVALID_INPUT", "输入文件不是有效JSON");
    }
  } finally {
    await handle.close();
  }
}
export function parseProfileArgs(args, allowedFlags = []) {
  let profileDir = join(homedir(), ".gamepilot");
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile-dir") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new LocalControlError(
          "INVALID_ARGUMENTS",
          "--profile-dir需要一个本机App配置目录",
        );
      profileDir = resolve(args[++i]);
    } else if (args[i].startsWith("--") && !allowedFlags.includes(args[i]))
      throw new LocalControlError("INVALID_ARGUMENTS", "不支持该控制参数");
    else rest.push(args[i]);
  }
  return { profileDir: resolve(profileDir), rest };
}
export async function requestLocalControl(
  profileDir,
  method,
  params = {},
  { requestId = randomUUID(), signal, timeoutMs = 6000 } = {},
) {
  if (!localControlMethods.includes(method))
    throw new LocalControlError("METHOD_FORBIDDEN", "不支持该本机控制方法");
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9_:-]{1,200}$/.test(requestId)
  )
    throw new LocalControlError("INVALID_ARGUMENTS", "请求编号格式无效");
  const directory = resolve(profileDir);
  let discovery;
  try {
    discovery = await boundedJson(join(directory, "agent-control.json"), 4096);
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new LocalControlError(
        "APP_NOT_RUNNING",
        "请先启动同一配置目录的GamePilot App",
      );
    throw new LocalControlError(
      "INVALID_DISCOVERY",
      "App连接信息无效，请在App检查本机控制服务",
    );
  }
  const profileHash = createHash("sha256")
    .update(directory.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  if (
    discovery?.version !== 1 ||
    typeof discovery.hostId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(discovery.hostId) ||
    typeof discovery.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(discovery.token)
  )
    throw new LocalControlError("INVALID_DISCOVERY", "App连接信息无效");
  const expectedPipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\gamepilot-control-${profileHash}-${discovery.hostId}`
      : join(directory, `agent-control-${discovery.hostId}.sock`);
  if (discovery.pipe !== expectedPipe)
    throw new LocalControlError(
      "INVALID_DISCOVERY",
      "App连接不属于所选本机配置目录",
    );
  const frame =
    JSON.stringify({ id: requestId, token: discovery.token, method, params }) +
    "\n";
  if (Buffer.byteLength(frame) > 65536)
    throw new LocalControlError("FRAME_TOO_LARGE", "本机控制请求超过大小限制");
  return new Promise((resolve, reject) => {
    let sent = false;
    let settled = false;
    let buffer = Buffer.alloc(0);
    const mutation = !["status", "capabilities", "events"].includes(method);
    const socket = connect(discovery.pipe);
    const complete = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () =>
      complete(
        new LocalControlError(
          "CANCELLED",
          "已停止等待本机控制回执；已受理的操作请在App核对",
          sent && mutation,
        ),
      );
    const timer = setTimeout(
      () =>
        complete(
          new LocalControlError(
            "TIMEOUT",
            "等待App回执超时，请在App核对；不会自动重新提交",
            sent && mutation,
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    socket.once("connect", () => {
      if (!settled) {
        sent = true;
        socket.write(frame);
      }
    });
    socket.on("error", () =>
      complete(
        new LocalControlError(
          "CONNECTION_FAILED",
          "无法连接运行中的App；不会自动重新提交",
          sent && mutation,
        ),
      ),
    );
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 262144) {
        complete(
          new LocalControlError(
            "RESPONSE_TOO_LARGE",
            "App回执超过大小限制",
            sent && mutation,
          ),
        );
        return;
      }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        const value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            buffer.subarray(0, end),
          ),
        );
        if (
          buffer
            .subarray(end + 1)
            .toString()
            .trim() ||
          value?.id !== requestId ||
          typeof value.ok !== "boolean" ||
          (!value.ok && (!value.error || typeof value.error.code !== "string"))
        )
          throw new Error();
        complete(undefined, value);
      } catch {
        complete(
          new LocalControlError(
            "PROTOCOL_ERROR",
            "App回执格式无效",
            sent && mutation,
          ),
        );
      }
    });
    socket.once("end", () => {
      if (!settled)
        complete(
          new LocalControlError(
            "CONNECTION_CLOSED",
            "App连接在完整回执前关闭；请核对请求状态",
            sent && mutation,
          ),
        );
    });
  });
}
