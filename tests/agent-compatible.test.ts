import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import {
  planWithCompatible,
  testCompatibleConnection,
} from "../packages/agent/openai-compatible/adapter";

const connection = {
  baseUrl: "https://api.deepseek.com/v1/",
  model: "deepseek-flash",
  apiKey: "test-secret-never-echo",
};
const at = "2026-09-26T00:00:00.000Z";
const answer = JSON.stringify({
  kind: "answer",
  text: "尚未执行",
  planHash: null,
});
function completion(content: string | null = answer, calls?: unknown[]) {
  return {
    model: "test-model",
    choices: [
      {
        index: 0,
        finish_reason: calls ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content,
          ...(calls ? { tool_calls: calls } : {}),
        },
      },
    ],
  };
}
function call(id: string, name = "get_environment", args: unknown = {}) {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function fixture() {
  const tools = createAgentTools(createFixtureSnapshot());
  return {
    tools,
    input: {
      catalogRevision: tools.call("list_capabilities").revision,
      environmentRevision: tools.call("get_environment").revision,
      at,
      lanes: [
        {
          laneId: "lane-a",
          games: [
            { gameId: "arknights", parameters: { stage: "LS-6", mail: true } },
          ],
        },
      ],
    },
  };
}
function plan() {
  return planWithCompatible(fixture().tools, {
    connection,
    prompt: "查询配置",
    at,
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("compatible authenticated transport", () => {
  it("preserves the base path, authenticates, disables DeepSeek thinking and returns only test metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(completion("OK")));
    vi.stubGlobal("fetch", fetch);
    const result = await testCompatibleConnection(connection);
    expect(result).toEqual({
      model: "test-model",
      elapsedMs: expect.any(Number),
      checkedAt: expect.any(String),
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${connection.apiKey}` },
    });
    expect(JSON.parse(init.body)).toMatchObject({
      model: "deepseek-flash",
      stream: false,
      thinking: { type: "disabled" },
    });
    expect(init.body).not.toContain(connection.apiKey);
    expect(JSON.parse(init.body).tools).toBeUndefined();
  });
  it("does not send DeepSeek settings to another host", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(completion("OK")));
    vi.stubGlobal("fetch", fetch);
    await testCompatibleConnection({
      ...connection,
      baseUrl: "https://api.deepseek.com.other.example/custom",
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body).thinking).toBeUndefined();
  });
  it.each([
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com?key=secret",
    "https://example.com#secret",
    "file:///secret",
    "not-a-url",
  ])("rejects unsafe endpoint %s without network access", async (baseUrl) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      testCompatibleConnection({ ...connection, baseUrl }),
    ).rejects.toMatchObject({ code: "INVALID_CONNECTION" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 429, 500])("sanitizes HTTP %s error bodies", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(reply({ error: connection.apiKey }, status)),
    );
    const error = await testCompatibleConnection(connection).catch((e) => e);
    expect(error.code).toBe(
      status === 401
        ? "AUTH_FAILED"
        : status === 429
          ? "QUOTA_EXCEEDED"
          : "MODEL_FAILED",
    );
    expect(String(error)).not.toContain(connection.apiKey);
  });
  it("sanitizes network and JSON parsing failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(connection.apiKey)),
    );
    await expect(testCompatibleConnection(connection)).rejects.toMatchObject({
      code: "NETWORK_FAILED",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(connection.apiKey)),
    );
    await expect(testCompatibleConnection(connection)).rejects.toMatchObject({
      code: "PROTOCOL_ERROR",
    });
  });
  it("bounds the streamed response even with no content-length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1))),
    );
    await expect(testCompatibleConnection(connection)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
  });
  it("rejects oversized declared bodies without waiting to read them", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { "content-length": String(1024 * 1024 + 1) },
        }),
      ),
    );
    await expect(testCompatibleConnection(connection)).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(cancel).toHaveBeenCalled();
  });
  it("stops a stalled response body at the deadline and releases its stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel }))),
    );
    const pending = testCompatibleConnection(connection);
    const check = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20000);
    await check;
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects malformed or incomplete authenticated completions", async () => {
    for (const value of [
      {},
      { choices: [] },
      completion(null),
      {
        ...completion("OK"),
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: "OK" },
          },
        ],
      },
    ]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(value)));
      await expect(testCompatibleConnection(connection)).rejects.toMatchObject({
        code: "PROTOCOL_ERROR",
      });
    }
  });
  it("cancels immediately without exposing abort reasons", async () => {
    const controller = new AbortController();
    controller.abort(connection.apiKey);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      testCompatibleConnection(connection, controller.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels a pending request and imposes a 20-second connection deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const cancelled = testCompatibleConnection(connection, controller.signal);
    const cancelledCheck = expect(cancelled).rejects.toMatchObject({
      code: "CANCELLED",
    });
    controller.abort(connection.apiKey);
    await cancelledCheck;
    const timed = testCompatibleConnection(connection);
    const timedCheck = expect(timed).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20000);
    await timedCheck;
    expect(fetch.mock.calls.at(-1)?.[1].signal.aborted).toBe(true);
  });
  it("never forwards credentials to a redirect destination", async () => {
    const received: string[] = [];
    const destination = createServer((req, res) => {
      received.push(req.headers.authorization ?? "");
      res.end(JSON.stringify(completion("OK")));
    });
    const listen = async (server: Server) => {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      return (server.address() as { port: number }).port;
    };
    const port = await listen(destination);
    const origin = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}` });
      res.end();
    });
    const sourcePort = await listen(origin);
    try {
      await expect(
        testCompatibleConnection({
          ...connection,
          baseUrl: `http://127.0.0.1:${sourcePort}/v1`,
        }),
      ).rejects.toMatchObject({ code: "NETWORK_FAILED" });
      expect(received).toEqual([]);
    } finally {
      await Promise.all(
        [origin, destination].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    }
  });
});

function sse(frames: unknown[], done = true) {
  const text =
    frames.map((frame) => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") +
    (done ? "data: [DONE]\r\n\r\n" : "");
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split UTF-8 code points and SSE frame boundaries, not just JSON tokens.
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function delta(value: unknown, finish: string | null = null) {
  return {
    id: "response-a",
    model: "test-model",
    choices: [{ index: 0, delta: value, finish_reason: finish }],
  };
}
describe("compatible semantic streaming", () => {
  it("keeps host tools behind the terminator across a real local HTTP SSE response", async () => {
    const { tools } = fixture();
    const executed = vi.spyOn(tools, "call");
    let rounds = 0;
    const beforeTerminator: number[] = [];
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      bodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (++rounds === 1) {
        response.write(
          `data: ${JSON.stringify(delta({ tool_calls: [{ index: 0, ...call("local-call") }] }))}\n\n`,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        beforeTerminator.push(
          executed.mock.calls.filter(
            ([name, args]) => name === "get_environment" && args !== undefined,
          ).length,
        );
        response.write(`data: ${JSON.stringify(delta({}, "tool_calls"))}\n\n`);
        await new Promise<void>((resolve) => setImmediate(resolve));
        beforeTerminator.push(
          executed.mock.calls.filter(
            ([name, args]) => name === "get_environment" && args !== undefined,
          ).length,
        );
      } else {
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify(delta({ content: answer }, "stop"))}\n\n`,
        );
        for (let i = 0; i < bytes.length; i += 5)
          response.write(bytes.slice(i, i + 5));
      }
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as { port: number };
      const result = await planWithCompatible(tools, {
        connection: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "fixture",
          apiKey: "fixture",
        },
        prompt: "查询",
        at,
      });
      expect(beforeTerminator).toEqual([0, 0]);
      expect(bodies.every((body) => body.stream === true)).toBe(true);
      expect(result.trace).toHaveLength(1);
      expect(result.status).toBe("answer");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("assembles fragmented SSE tool JSON and publishes host start/result only for real uncached calls", async () => {
    const tools = fixture().tools;
    const events: Record<string, unknown>[] = [];
    const executed = vi.spyOn(tools, "call");
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      expect(JSON.parse(init.body)).toMatchObject({
        stream: true,
        thinking: { type: "disabled" },
        stream_options: { include_usage: true },
      });
      if (fetch.mock.calls.length < 3)
        return sse([
          delta({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "same",
                type: "function",
                function: { name: "get_environment", arguments: "{" },
              },
            ],
          }),
          delta({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }),
          delta({}, "tool_calls"),
        ]);
      return sse([
        delta({ role: "assistant", content: answer.slice(0, 13) }),
        delta({ content: answer.slice(13) }),
        delta({}, "stop"),
        {
          id: "response-a",
          model: "test-model",
          choices: [],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 7,
            total_tokens: 27,
            prompt_cache_hit_tokens: 8,
          },
        },
      ]);
    });
    vi.stubGlobal("fetch", fetch);
    const result = await planWithCompatible(tools, {
      connection,
      prompt: "查询配置",
      at,
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe("answer");
    expect(result.trace).toHaveLength(1);
    expect(
      events.filter((event) => event.kind === "tool-started"),
    ).toMatchObject([
      {
        kind: "tool-started",
        callId: "same",
        tool: "get_environment",
        details: { arguments: "{}" },
      },
    ]);
    expect(
      events.filter((event) => event.kind === "tool-result"),
    ).toMatchObject([
      {
        kind: "tool-result",
        callId: "same",
        tool: "get_environment",
        success: true,
        details: { result: expect.any(String), durationMs: expect.any(Number) },
      },
    ]);
    expect(
      events
        .filter((event) => event.kind === "answer-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe(answer);
    expect(events.filter((event) => event.kind === "usage")).toEqual([
      {
        kind: "usage",
        usage: {
          inputTokens: 20,
          outputTokens: 7,
          totalTokens: 27,
          cachedInputTokens: 8,
        },
      },
    ]);
    expect(events.at(-1)).toEqual({ kind: "finished" });
    expect(
      executed.mock.calls.filter(([name]) => name === "get_environment"),
    ).toHaveLength(2); // snapshot construction + one execution
  });
  it("never executes a complete tool JSON from a stream missing the transport terminator", async () => {
    const tools = fixture().tools;
    const events: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          sse(
            [
              delta({ tool_calls: [{ index: 0, ...call("partial") }] }),
              delta({}, "tool_calls"),
            ],
            false,
          ),
        ),
    );
    await expect(
      planWithCompatible(tools, {
        connection,
        prompt: "查询",
        at,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(events.some((event) => event.kind === "tool-started")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      kind: "error",
      code: "PROTOCOL_ERROR",
    });
  });
  it("cancels a stalled partial stream without executing or completing it", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const events: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(output) {
              output.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(delta({ content: "部分" }))}\n\n`,
                ),
              );
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );
    const pending = planWithCompatible(fixture().tools, {
      connection,
      prompt: "查询",
      at,
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "answer-delta") controller.abort();
      },
    });
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(cancel).toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "attempt",
      attempt: 1,
      status: "cancelled",
      code: "CANCELLED",
    });
    expect(events.some((event) => event.kind === "finished")).toBe(false);
  });
  it("records cancellation even when the transport ignores its abort signal", async () => {
    const controller = new AbortController();
    const events: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const pending = planWithCompatible(fixture().tools, {
      connection,
      prompt: "查询",
      at,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        kind: "attempt",
        attempt: 1,
        status: "started",
      }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(events).toContainEqual({
      kind: "attempt",
      attempt: 1,
      status: "cancelled",
      code: "CANCELLED",
    });
  });
  it("pairs host failures with real start/result events and keeps absent usage absent", async () => {
    const events: Record<string, unknown>[] = [];
    const { tools } = fixture();
    const executed = vi.spyOn(tools, "call");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        reply(
          completion(null, [
            call("bad-host", "get_environment", { extra: true }),
          ]),
        ),
      )
      .mockResolvedValueOnce(reply(completion()));
    vi.stubGlobal("fetch", fetch);
    await planWithCompatible(tools, {
      connection,
      prompt: "查询",
      at,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "tool-started")
          expect(
            executed.mock.calls.filter(
              ([name, args]) =>
                name === "get_environment" && args !== undefined,
            ),
          ).toHaveLength(0);
      },
    });
    expect(events).toContainEqual({
      kind: "tool-requested",
      callId: "bad-host",
      tool: "get_environment",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool-result",
        callId: "bad-host",
        tool: "get_environment",
        success: false,
        code: "INVALID_INPUT",
        details: {
          result: '{"error":{"code":"INVALID_INPUT"}}',
          durationMs: expect.any(Number),
        },
      }),
    );
    expect(events.some((event) => event.kind === "usage")).toBe(false);
  });
});

describe("compatible read-only planner", () => {
  it("accepts a schema-bound result tool without pretending it is a game capability", async () => {
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(
        body.tools.find((t: any) => t.function.name === "submit_result")
          .function.parameters.required,
      ).toEqual(["kind", "text", "planHash"]);
      return reply(
        completion(null, [
          call("final", "submit_result", {
            kind: "answer",
            text: "没有执行",
            planHash: null,
          }),
        ]),
      );
    });
    vi.stubGlobal("fetch", fetch);
    expect(await plan()).toMatchObject({
      status: "answer",
      execution: "not-started",
      canExecute: false,
      trace: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects result submission mixed with other tools and uncompiled result references", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        reply(
          completion(null, [
            call("env"),
            call("final", "submit_result", {
              kind: "answer",
              text: "说明",
              planHash: null,
            }),
          ]),
        ),
      ),
    );
    await expect(plan()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        reply(
          completion(null, [
            call("final", "submit_result", {
              kind: "draft",
              text: "编造",
              planHash: "fake",
            }),
          ]),
        ),
      ),
    );
    await expect(plan()).rejects.toMatchObject({ code: "UNVERIFIED_DRAFT" });
  });
  it.each([
    "说明文字",
    JSON.stringify({ kind: "answer", text: "查询", planHash: "null" }),
  ])(
    "repairs final formatting once without further tool execution",
    async (initial) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(reply(completion(initial)))
        .mockImplementationOnce(async (_url, init) => {
          const body = JSON.parse(init.body);
          expect(body.tools.map((t: any) => t.function.name)).toEqual([
            "submit_result",
          ]);
          expect(body.tool_choice).toEqual({
            type: "function",
            function: { name: "submit_result" },
          });
          expect(body.messages.at(-1).content).toContain("禁止调用工具");
          return reply(
            completion(null, [
              call("final", "submit_result", JSON.parse(answer)),
            ]),
          );
        });
      vi.stubGlobal("fetch", fetch);
      expect(await plan()).toMatchObject({
        status: "answer",
        canExecute: false,
        trace: [],
        formatRepairs: 1,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it("refuses a tool call in the final-format repair response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(completion("not JSON")))
      .mockResolvedValueOnce(
        reply(completion(null, [call("repair", "get_environment")])),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(plan()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requests JSON output for DeepSeek planning without changing the connection probe", async () => {
    const fetch = vi.fn().mockImplementation(async () => reply(completion()));
    vi.stubGlobal("fetch", fetch);
    await plan();
    expect(JSON.parse(fetch.mock.calls[0][1].body).response_format).toEqual({
      type: "json_object",
    });
    await testCompatibleConnection(connection);
    expect(
      JSON.parse(fetch.mock.calls[1][1].body).response_format,
    ).toBeUndefined();
  });
  it("does not impose DeepSeek JSON settings on other compatible providers", async () => {
    const fetch = vi.fn().mockResolvedValue(reply(completion()));
    vi.stubGlobal("fetch", fetch);
    await planWithCompatible(fixture().tools, {
      connection: {
        ...connection,
        baseUrl: "https://api.deepseek.com.other.example/v1",
      },
      prompt: "查询",
      at,
    });
    expect(
      JSON.parse(fetch.mock.calls[0][1].body).response_format,
    ).toBeUndefined();
  });
  it.each([
    ["```json\n" + answer + "\n```", "Markdown"],
    ["private malformed output", "合法 JSON"],
    [
      JSON.stringify({
        kind: "answer",
        text: "private",
        planHash: null,
        extra: true,
      }),
      "字段",
    ],
  ])("reports only the invalid output category", async (content, category) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => reply(completion(content))),
    );
    const error = await plan().catch((e) => e);
    expect(error.code).toBe("INVALID_OUTPUT");
    expect(error.message).toContain(category);
    expect(error.message).not.toContain("private");
    expect(error.message).not.toContain(connection.apiKey);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
  it("compiles through multiple tool rounds and returns only host-verified drafts", async () => {
    const { tools, input } = fixture();
    const progress: unknown[] = [];
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (fetch.mock.calls.length === 1) {
        expect(
          body.tools.every(
            (tool: { type: string; function: { parameters: unknown } }) =>
              tool.type === "function" && tool.function.parameters,
          ),
        ).toBe(true);
        expect(body.messages[0].content).toContain(at);
        return reply(
          completion(null, [
            call("catalog", "list_capabilities"),
            call("environment"),
          ]),
        );
      }
      if (fetch.mock.calls.length === 2)
        return reply(
          completion(null, [call("compile", "compile_plan", input)]),
        );
      const draft = JSON.parse(body.messages.at(-1).content);
      expect(body.messages.at(-1).tool_call_id).toBe("compile");
      return reply(
        completion(
          JSON.stringify({
            kind: "draft",
            text: "草稿等待检查",
            planHash: draft.planHash,
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetch);
    const result = await planWithCompatible(tools, {
      connection,
      prompt: "为第一个账号制定草稿",
      at,
      onProgress: (p) => progress.push(p),
    });
    expect(result).toMatchObject({
      status: "draft",
      canExecute: false,
      execution: "not-started",
      draft: { at, status: "valid" },
      codexVersion: "",
      model: "test-model",
    });
    expect(result.trace).toHaveLength(3);
    expect(progress).toContainEqual({ phase: "tool", tool: "compile_plan" });
  });
  it("rejects fabricated plan hashes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        reply(
          completion(
            JSON.stringify({
              kind: "draft",
              text: "已执行",
              planHash: "fake",
            }),
          ),
        ),
      ),
    );
    await expect(plan()).rejects.toMatchObject({ code: "UNVERIFIED_DRAFT" });
  });
  it.each([
    call("x", "shell"),
    { ...call("x"), id: "" },
    { ...call("x"), type: "custom" },
    { ...call("x"), function: { name: "get_environment", arguments: "{" } },
    { ...call("x"), function: { name: "get_environment", arguments: "[]" } },
  ])(
    "rejects forbidden/malformed calls before executing them",
    async (tool) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(reply(completion(null, [tool]))),
      );
      await expect(plan()).rejects.toHaveProperty(
        "code",
        tool.function.name === "shell" ? "TOOL_FORBIDDEN" : "PROTOCOL_ERROR",
      );
    },
  );
  it("enforces the session 12-call budget", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          reply(completion(null, [call(String(++n))])),
        ),
    );
    await expect(plan()).rejects.toMatchObject({ code: "TOOL_BUDGET" });
    expect(n).toBe(13);
  });
  it("bounds rounds even when a provider repeats the same deduplicated call", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () => reply(completion(null, [call("same")])));
    vi.stubGlobal("fetch", fetch);
    await expect(plan()).rejects.toMatchObject({ code: "ROUND_BUDGET" });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(16);
  });
  it("uses one 120-second deadline for the whole planner", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    const pending = plan();
    const check = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(120000);
    await check;
  });
  it("does not reset the total deadline after a successful round", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve(reply(completion(null, [call("same")]))),
              70000,
            ),
          ),
      );
    vi.stubGlobal("fetch", fetch);
    const pending = plan();
    const check = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(120000);
    await check;
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects conflicting call IDs instead of replacing an earlier tool result", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(completion(null, [call("same")])))
      .mockResolvedValueOnce(
        reply(completion(null, [call("same", "list_capabilities")])),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(plan()).rejects.toMatchObject({ code: "CALL_ID_CONFLICT" });
  });
  it("does not accept a forged draft object in final model output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        reply(
          completion(
            JSON.stringify({
              kind: "answer",
              text: "执行",
              planHash: null,
              draft: { canExecute: true },
            }),
          ),
        ),
      ),
    );
    await expect(plan()).rejects.toMatchObject({ code: "INVALID_OUTPUT" });
  });
  it("keeps the original deadline and rejects invented hashes during formatting repair", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply(completion("not JSON")))
      .mockResolvedValueOnce(
        reply(
          completion(
            JSON.stringify({ kind: "draft", text: "伪造", planHash: "fake" }),
          ),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(plan()).rejects.toMatchObject({ code: "UNVERIFIED_DRAFT" });
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
    const delayed = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 119000));
        return reply(completion("not JSON"));
      })
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", delayed);
    const pending = plan();
    const check = expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(120000);
    await check;
    expect(delayed).toHaveBeenCalledTimes(2);
  });
  it("sanitizes unexpected host callback failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(completion())));
    const pending = planWithCompatible(fixture().tools, {
      connection,
      prompt: "查询配置",
      at,
      onProgress: () => {
        throw new Error(connection.apiKey);
      },
    });
    const error = await pending.catch((failure) => failure);
    expect(error).toMatchObject({ code: "MODEL_FAILED" });
    expect(String(error)).not.toContain(connection.apiKey);
  });
});
