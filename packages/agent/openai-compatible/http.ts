import { AgentToolError } from "../../protocol/agent";
import type { PlannerStreamEvent } from "../../protocol/agent-planner";
import { CompatibleStream, compatibleUsage } from "./stream";

export interface CompatibleConnection {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const maxResponseBytes = 1024 * 1024;
const invalidConnection = () =>
  new AgentToolError("INVALID_CONNECTION", "请检查模型地址、模型名称和密钥");

function endpoint(connection: CompatibleConnection) {
  let url: URL;
  try {
    url = new URL(connection.baseUrl);
  } catch {
    throw invalidConnection();
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[?#]/.test(connection.baseUrl) ||
    typeof connection.model !== "string" ||
    !connection.model.trim() ||
    connection.model.length > 200 ||
    /[\r\n\0]/.test(connection.model) ||
    typeof connection.apiKey !== "string" ||
    !connection.apiKey.trim() ||
    connection.apiKey.length > 8192 ||
    /[\r\n\0]/.test(connection.apiKey)
  )
    throw invalidConnection();
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

export interface CompatibleHttp {
  request(body: Record<string, unknown>): Promise<unknown>;
  check(): void;
}

/** One deadline covers all requests and body reads in an operation. */
export async function withCompatibleHttp<T>(
  connection: CompatibleConnection,
  timeoutMs: 20000 | 120000,
  signal: AbortSignal | undefined,
  run: (http: CompatibleHttp) => Promise<T>,
  onEvent?: (event: PlannerStreamEvent) => void,
  requestHeaders?: Record<string, string>,
): Promise<T> {
  const url = endpoint(connection);
  const controller = new AbortController();
  let stopped: AgentToolError | undefined;
  let attempts = 0;
  let activeAttempt: number | undefined;
  const endAttempt = (
    attempt: number,
    status: "completed" | "failed" | "cancelled",
    code?: string,
  ) => {
    if (activeAttempt !== attempt) return;
    activeAttempt = undefined;
    onEvent?.({ kind: "attempt", attempt, status, ...(code ? { code } : {}) });
  };
  let rejectStopped!: (error: AgentToolError) => void;
  const stoppedPromise = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  const stop = (error: AgentToolError) => {
    if (stopped) return;
    stopped = error;
    controller.abort();
    rejectStopped(error);
  };
  const cancel = () =>
    stop(
      new AgentToolError(
        "CANCELLED",
        "模型请求已取消；游戏状态以目标和原执行记录为准",
      ),
    );
  const check = () => {
    if (stopped) throw stopped;
  };
  const timer = setTimeout(
    () =>
      stop(
        new AgentToolError(
          "TIMEOUT",
          "模型请求超时；游戏状态以目标和原执行记录为准",
        ),
      ),
    timeoutMs,
  );
  signal?.addEventListener("abort", cancel, { once: true });
  // Attach the race before running callbacks so synchronous cancellation is handled.
  const operation = Promise.resolve().then(async () => {
    if (signal?.aborted) cancel();
    check();
    return run({
      check,
      request: async (body) => {
        const attempt = ++attempts;
        activeAttempt = attempt;
        onEvent?.({ kind: "attempt", attempt, status: "started" });
        try {
          check();
          let response: Response;
          try {
            response = await fetch(url, {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                ...(requestHeaders ?? {}),
                "Content-Type": "application/json",
                Authorization: `Bearer ${connection.apiKey}`,
              },
              body: JSON.stringify({
                ...body,
                model: connection.model,
                stream: body.stream === true,
                ...(body.stream === true
                  ? { stream_options: { include_usage: true } }
                  : {}),
                ...(url.hostname === "api.deepseek.com"
                  ? { thinking: { type: "disabled" } }
                  : {}),
              }),
            });
          } catch {
            check();
            throw new AgentToolError(
              "NETWORK_FAILED",
              "无法连接模型服务，请检查地址和网络",
            );
          }
          check();
          const discard = () => {
            void response.body?.cancel().catch(() => {});
          };
          if (!response.ok) {
            discard();
            if (response.status === 401 || response.status === 403)
              throw new AgentToolError(
                "AUTH_FAILED",
                "模型服务鉴权失败，请检查密钥和权限",
              );
            if (response.status === 429)
              throw new AgentToolError(
                "QUOTA_EXCEEDED",
                "模型服务限流或额度不足，请稍后重试",
              );
            throw new AgentToolError(
              "MODEL_FAILED",
              "模型服务未完成请求，请稍后重试",
            );
          }
          if (
            Number(response.headers.get("content-length")) > maxResponseBytes
          ) {
            discard();
            throw new AgentToolError(
              "RESPONSE_TOO_LARGE",
              "模型响应超过大小限制",
            );
          }
          if (!response.body)
            throw new AgentToolError("PROTOCOL_ERROR", "模型服务响应格式无效");
          const reader = response.body.getReader();
          const cancelReader = () => {
            void reader.cancel().catch(() => {});
          };
          controller.signal.addEventListener("abort", cancelReader, {
            once: true,
          });
          const chunks: Uint8Array[] = [];
          const streaming =
            response.headers.get("content-type")?.split(";")[0].trim() ===
            "text/event-stream";
          const stream = streaming ? new CompatibleStream(onEvent) : undefined;
          const decoder = new TextDecoder("utf-8", { fatal: true });
          let size = 0;
          try {
            for (;;) {
              check();
              const chunk = await reader.read();
              check();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > maxResponseBytes)
                throw new AgentToolError(
                  "RESPONSE_TOO_LARGE",
                  "模型响应超过大小限制",
                );
              if (stream)
                stream.push(decoder.decode(chunk.value, { stream: true }));
              else chunks.push(chunk.value);
            }
          } catch (error) {
            void reader.cancel().catch(() => {});
            check();
            if (error instanceof AgentToolError) throw error;
            throw new AgentToolError(
              "NETWORK_FAILED",
              "读取模型响应失败，请稍后重试",
            );
          } finally {
            controller.signal.removeEventListener("abort", cancelReader);
            reader.releaseLock();
          }
          if (stream) {
            let result: ReturnType<CompatibleStream["finish"]>;
            try {
              stream.push(decoder.decode());
              result = stream.finish();
            } catch (error) {
              if (error instanceof AgentToolError) throw error;
              throw new AgentToolError(
                "PROTOCOL_ERROR",
                "模型服务响应格式无效",
              );
            }
            if (result.usage) onEvent?.({ kind: "usage", usage: result.usage });
            check();
            endAttempt(attempt, "completed");
            return result;
          }
          try {
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const result = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            ) as {
              usage?: unknown;
              choices?: { message?: { content?: unknown } }[];
            };
            const usage = compatibleUsage(result.usage);
            if (usage) onEvent?.({ kind: "usage", usage });
            const text = result.choices?.[0]?.message?.content;
            if (typeof text === "string" && text)
              onEvent?.({ kind: "answer-delta", text });
            check();
            endAttempt(attempt, "completed");
            return result;
          } catch (error) {
            if (error instanceof AgentToolError) throw error;
            throw new AgentToolError("PROTOCOL_ERROR", "模型服务响应格式无效");
          }
        } catch (failure) {
          const error =
            failure instanceof AgentToolError
              ? failure
              : new AgentToolError(
                  "MODEL_FAILED",
                  "模型请求未完成；游戏状态以目标和原执行记录为准",
                );
          try {
            endAttempt(
              attempt,
              error.code === "CANCELLED" ? "cancelled" : "failed",
              error.code,
            );
          } catch {}
          throw error;
        }
      },
    });
  });
  try {
    const result = await Promise.race([operation, stoppedPromise]);
    onEvent?.({ kind: "finished" });
    return result;
  } catch (error) {
    const failure =
      error instanceof AgentToolError
        ? error
        : new AgentToolError(
            "MODEL_FAILED",
            "模型说明未完成；游戏状态以目标和原执行记录为准",
          );
    if (activeAttempt !== undefined)
      try {
        endAttempt(
          activeAttempt,
          failure.code === "CANCELLED" ? "cancelled" : "failed",
          failure.code,
        );
      } catch {}
    try {
      onEvent?.({
        kind: "error",
        code: failure.code,
        message: failure.message,
      });
    } catch {}
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
