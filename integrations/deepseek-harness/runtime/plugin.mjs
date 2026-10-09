import Schema from "@deepseek-ai/schemastery";
import { HarnessSdkJsonRpcServer } from "@deepseek-ai/dsh-sdk-jsonrpc-server";
import { JsonRpcLineTransport } from "@deepseek-ai/dsh-sdk-protocol";
import {
  LlmAdapter,
  LlmError,
  attributionHeaders,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SessionPersistenceNotFoundError } from "@deepseek-ai/dsh-session-persistence";

export const name = "gamepilot-sdk-bridge";
export const inject = [
  "agents",
  "llm",
  "tools",
  "sessions",
  "sessionPersistence",
];
export const Config = Schema.object({});

function sessionId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(value))
    throw new Error("INVALID_SESSION_ID");
  return SessionId(value);
}

/** Trusted plugin only: no model tool can invoke these host controls. */
export async function apply(ctx) {
  const bridge = process.env.GAMEPILOT_DSH_BRIDGE;
  const token = process.env.GAMEPILOT_DSH_TOKEN;
  if (!bridge || !/^http:\/\/127\.0\.0\.1:\d+$/.test(bridge) || !token)
    throw new Error("INVALID_HOST_BRIDGE");
  const requestHost = async (path, payload, signal) => {
    const response = await fetch(bridge + path, {
      method: "POST",
      headers: {
        ...attributionHeaders(),
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal,
      redirect: "error",
    });
    const body = await response.json();
    if (!response.ok)
      throw new LlmError(
        body.message ?? "Host operation failed",
        body.code ?? "HOST_FAILED",
      );
    return body;
  };
  const metadata = await requestHost("/metadata", {});
  class HostModelAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: "GamePilot configured model" };
    }
    async listModels(provider) {
      return [
        {
          provider,
          id: metadata.model,
          name: metadata.model,
          inputModalities: ["text"],
        },
      ];
    }
    async resolveModel(provider, model) {
      if (model !== metadata.model)
        throw new LlmError("Unknown configured model", "UNKNOWN_MODEL");
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ["text"],
        defaultMaxTokens: 4096,
      };
    }
    async *stream(options) {
      const result = await requestHost(
        "/model",
        {
          sessionId: String(options.sessionId),
          messages: options.messages,
          tools: options.tools,
          maxTokens: options.maxTokens,
          ...(options.system !== undefined ? { system: options.system } : {}),
        },
        options.signal,
      );
      for (const [index, block] of result.blocks.entries()) {
        yield { type: "block-start", index, blockType: block.type };
        if (block.type === "text")
          yield { type: "text-delta", index, text: block.text };
        else if (block.type === "tool-call")
          yield {
            type: "tool-call-delta",
            index,
            id: block.id,
            name: block.name,
            argumentsDelta: block.arguments,
          };
        else throw new LlmError("Unsupported response block", "PROTOCOL_ERROR");
        yield { type: "block-end", index, block };
      }
      if (result.usage) yield { type: "usage", usage: result.usage };
      yield { type: "finish", reason: result.reason };
    }
  }
  ctx.llm.registerAdapter(["gamepilot-compatible"], new HostModelAdapter());
  for (const tool of metadata.tools) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: {},
        render: (_args, value) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      execute: (args, execution) =>
        requestHost(
          "/tool",
          {
            sessionId: String(execution.agent?.id),
            name: tool.name,
            args,
            callId: String(execution.callId),
          },
          execution.signal,
        ),
    });
  }
  const allowedTools = new Set(metadata.tools.map((tool) => tool.name));
  ctx.tools.guard((execution) =>
    allowedTools.has(execution.name)
      ? undefined
      : "Only registered GamePilot host tools are available",
  );

  const transport = new JsonRpcLineTransport(process.stdin, process.stdout);
  // Original SDK server supplies initialize validation and official notifications.
  const server = new HarnessSdkJsonRpcServer(ctx, transport, {
    maxTokensAsSuccess: false,
  });
  const handles = new Map();
  const pending = new Map();
  let route;
  let shuttingDown = false;
  async function open(id, resume) {
    sessionId(id);
    if (!route || shuttingDown) throw new Error("SDK_NOT_READY");
    if (handles.has(id)) return handles.get(id);
    if (pending.has(id)) return pending.get(id);
    const task = (async () => {
      const options = {
        provider: route.provider,
        model: route.model,
        maxTokens: route.maxTokens,
      };
      const setup = (agentCtx, agent) => {
        agentCtx.tools.restrict({ allow: [...allowedTools] });
        if (resume) agent.inbox.clear();
      };
      let handle;
      if (resume) {
        try {
          handle = await ctx.agents.resume({
            resumeSessionId: sessionId(id),
            agentOptions: options,
            // Resuming model history never grants permission to replay pending input.
            setup,
          });
        } catch (error) {
          // A new conversation has no durable session yet. Ownership, corruption
          // and format errors must retain the original session and refuse activation.
          if (!(error instanceof SessionPersistenceNotFoundError)) throw error;
        }
      }
      if (!handle) {
        handle = await ctx.agents.create({
          sessionId: sessionId(id),
          meta: { cwd: route.cwd },
          agentOptions: options,
          setup,
        });
      }
      if (shuttingDown) {
        await handle.dispose();
        throw new Error("SDK_SHUTTING_DOWN");
      }
      handles.set(id, handle);
      return handle;
    })();
    pending.set(id, task);
    try {
      return await task;
    } finally {
      pending.delete(id);
    }
  }
  let shutdownTask;
  function shutdown() {
    shutdownTask ??= (async () => {
      shuttingDown = true;
      await Promise.allSettled([...pending.values()]);
      const results = await Promise.allSettled(
        [...handles.values()].map((handle) => handle.dispose()),
      );
      handles.clear();
      await server.shutdown();
      const failure = results.find((value) => value.status === "rejected");
      if (failure) throw failure.reason;
    })();
    return shutdownTask;
  }
  const rootFiber = ctx.root.fiber;
  transport.onRequest(async (method, params) => {
    if (method === "initialize") {
      await ctx.get("loader")?.await();
      const result = await server.initialize(params);
      route = { ...params };
      return result;
    }
    if (method === "gamepilot/session/open") {
      const handle = await open(params.sessionId, params.resume === true);
      return {
        sessionId: String(handle.agent.id),
        status: handle.agent.status,
      };
    }
    if (method === "session/prompt") {
      const handle = await open(params.sessionId, false);
      if (
        !Array.isArray(params.contentBlocks) ||
        !params.contentBlocks.every(
          (block) => block.type === "text" && typeof block.text === "string",
        )
      )
        throw new Error("TEXT_PROMPT_REQUIRED");
      const message = createUserMessage({
        content: params.contentBlocks,
        source: { kind: "human" },
      });
      handle.agent.followup(message);
      return { messageId: String(message.id) };
    }
    if (method === "gamepilot/session/cancel") {
      const handle = handles.get(sessionId(params.sessionId));
      if (!handle) return { cancelled: false };
      handle.agent.cancel({ kind: "user" });
      await handle.agent.whenIdle();
      await ctx.sessions.flush(handle.agent.session);
      return { cancelled: true, status: handle.agent.status };
    }
    if (method === "gamepilot/session/history") {
      const id = sessionId(params.sessionId);
      if (
        params.afterSeq !== undefined &&
        (!Number.isSafeInteger(params.afterSeq) || params.afterSeq < -1)
      )
        throw new Error("INVALID_CURSOR");
      const live = handles.get(id)?.agent;
      if (live) await ctx.sessions.flush(live.session);
      const readHandle = await ctx.sessionPersistence.open(id, "read");
      try {
        const history = await readHandle.read((params.afterSeq ?? -1) + 1);
        return {
          sessionId: String(id),
          events: history.events,
          throughSeq: history.events.at(-1)?.seq ?? params.afterSeq ?? -1,
          status: live?.status ?? "cold",
        };
      } finally {
        await readHandle.close();
      }
    }
    if (method === "shutdown") {
      await shutdown();
      setImmediate(async () => {
        await transport.flush();
        await rootFiber.dispose();
        process.exit(0);
      });
      return {};
    }
    throw new Error("METHOD_NOT_ALLOWED");
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await shutdown();
      transport.close();
    };
  }, "gamepilot.sdk.serve");
}
