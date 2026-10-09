import { createServer } from "node:http";
import {
  mkdtemp,
  rm,
  readdir,
  readFile,
  access,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDshRuntime, runWithDsh } from "../packages/agent/dsh/adapter";

const runtime = {
  directory: resolve(
    process.env.GAMEPILOT_DSH_TEST_RUNTIME ??
      "integrations/deepseek-harness/runtime",
  ),
};
let prepared = false;
try {
  await access(join(runtime.directory, "node", "node.exe"));
  await access(
    join(
      runtime.directory,
      "node_modules/@deepseek-ai/dsh-sdk-client/package.json",
    ),
  );
  prepared = process.platform === "win32";
} catch {}
const spec = {
  name: "goal_status",
  description: "Read the host goal state",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

async function syntheticProvider(
  respond: (body: any, response: import("node:http").ServerResponse) => void,
) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let source = "";
    for await (const chunk of request) source += chunk;
    const body = JSON.parse(source);
    bodies.push(body);
    expect(request.url).toBe("/v1/chat/completions");
    respond(body, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as import("node:net").AddressInfo;
  return {
    connection: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "synthetic-model",
      apiKey: "synthetic-offline-key",
    },
    bodies,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
function reply(
  response: import("node:http").ServerResponse,
  content: string | null,
  calls?: any[],
) {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      model: "synthetic-model",
      choices: [
        {
          message: {
            role: "assistant",
            content,
            ...(calls ? { tool_calls: calls } : {}),
          },
          finish_reason: calls ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    }),
  );
}

describe.skipIf(!prepared)(
  "real fixed-version DSH SDK runtime, offline bridge (requires setup-dsh-runtime)",
  () => {
    it("resumes a bounded model history above one MiB without discarding messages or replaying tools", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      const toolText = "recorded-only:" + "x".repeat(600000);
      const answer = "previous-answer:" + "y".repeat(480000);
      let requests = 0;
      let calls = 0;
      const provider = await syntheticProvider((_body, response) => {
        requests++;
        if (requests === 1)
          reply(response, null, [
            {
              id: "large-history",
              type: "function",
              function: {
                name: spec.name,
                arguments: '{"id":"goal-1"}',
              },
            },
          ]);
        else
          reply(response, requests === 2 ? answer : "current turn completed");
      });
      const client = createDshRuntime({
        connection: provider.connection,
        runtime: { ...runtime, home },
        tools: [spec],
        callTool: async () => {
          calls++;
          return { recorded: toolText };
        },
      });
      try {
        expect(
          (
            await client.run({
              prompt: "Read previous result",
              at: "2026-10-09T13:00:00Z",
              sessionId: "large-history",
            })
          ).finalText,
        ).toBe(answer);
        const result = await client.run({
          prompt: "Continue this current user turn",
          at: "2026-10-09T13:15:45Z",
          sessionId: "large-history",
        });
        expect(result.finalText).toBe("current turn completed");
        expect(calls).toBe(1);
        expect(requests).toBe(3);
        expect(
          Buffer.byteLength(JSON.stringify(provider.bodies[2])),
        ).toBeGreaterThan(1024 * 1024);
        expect(
          provider.bodies[2].messages.some(
            (m: any) => m.role === "tool" && m.content.includes(toolText),
          ),
        ).toBe(true);
        expect(
          provider.bodies[2].messages.some(
            (m: any) => m.role === "assistant" && m.content === answer,
          ),
        ).toBe(true);
      } finally {
        await client.close();
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it.each([
      [401, "AUTH_FAILED"],
      [429, "QUOTA_EXCEEDED"],
    ])(
      "retains the safe host error for provider status %i without exposing provider details",
      async (status, code) => {
        const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
        const provider = await syntheticProvider((_body, response) => {
          response.writeHead(status as number, {
            "Content-Type": "application/json",
          });
          response.end(JSON.stringify({ error: "private-provider-secret" }));
        });
        const events: any[] = [];
        let calls = 0;
        const client = createDshRuntime({
          connection: provider.connection,
          runtime: { ...runtime, home },
          tools: [],
          callTool: async () => {
            calls++;
          },
          onEvent: (event) => events.push(event),
        });
        try {
          const result = client.run({
            prompt: "Read status",
            at: "2026-10-09T13:15:45Z",
          });
          await expect(result).rejects.toMatchObject({ code });
          await expect(result).rejects.not.toThrow("private-provider-secret");
          expect(events.at(-1)).toMatchObject({ kind: "error", code });
          expect(calls).toBe(0);
          expect(provider.bodies).toHaveLength(1);
        } finally {
          await client.close();
          await provider.close();
          await rm(home, { recursive: true, force: true });
        }
      },
      60000,
    );

    it("stops model history above four MiB before the next provider request with an explicit safe error", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      let requests = 0;
      let calls = 0;
      const events: any[] = [];
      const provider = await syntheticProvider((_body, response) => {
        requests++;
        reply(response, null, [
          {
            id: `history-${requests}`,
            type: "function",
            function: {
              name: spec.name,
              arguments: '{"id":"goal-1"}',
            },
          },
        ]);
      });
      const client = createDshRuntime({
        connection: provider.connection,
        runtime: { ...runtime, home },
        tools: [spec],
        callTool: async () => {
          calls++;
          return { recorded: "x".repeat(900000) };
        },
        onEvent: (event) => events.push(event),
      });
      try {
        await expect(
          client.run({
            prompt: "Read bounded records",
            at: "2026-10-09T13:15:45Z",
            sessionId: "over-budget",
          }),
        ).rejects.toMatchObject({ code: "DSH_CONTEXT_TOO_LARGE" });
        expect(calls).toBe(5);
        expect(requests).toBe(5);
        expect(events.at(-1)).toMatchObject({
          kind: "error",
          code: "DSH_CONTEXT_TOO_LARGE",
        });
        expect(events.some((event) => event.kind === "finished")).toBe(false);
        // An already oversized persisted session fails before this new turn can
        // contact the provider or dispatch any tool, including effectful ones.
        events.length = 0;
        await expect(
          client.run({
            prompt: "Perform the currently authorized task",
            at: "2026-10-09T13:16:00Z",
            sessionId: "over-budget",
          }),
        ).rejects.toMatchObject({ code: "DSH_CONTEXT_TOO_LARGE" });
        expect(calls).toBe(5);
        expect(requests).toBe(5);
        expect(events).toEqual([
          expect.objectContaining({
            kind: "error",
            code: "DSH_CONTEXT_TOO_LARGE",
          }),
        ]);
      } finally {
        await client.close();
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it("creates a missing resumed session, runs official tools and safely resumes persisted history", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      const provider = await syntheticProvider((body, response) => {
        if (!body.messages.some((message: any) => message.role === "tool"))
          reply(response, null, [
            {
              id: "call-1",
              type: "function",
              function: { name: spec.name, arguments: '{"id":"goal-1"}' },
            },
          ]);
        else reply(response, "The host goal is waiting for the game.");
      });
      const calls: any[] = [];
      const events: any[] = [];
      const client = createDshRuntime({
        connection: provider.connection,
        runtime: { ...runtime, home },
        tools: [spec],
        callTool: async (name, args, context) => {
          calls.push({ name, args, callId: context.callId });
          return { state: "waiting-game" };
        },
        onEvent: (event) => events.push(event),
      });
      try {
        const result = await client.run({
          prompt: "Read the host goal",
          at: "2026-10-05T00:00:00.000Z",
          sessionId: "offline-loop-proof",
          resume: true,
        });
        expect(result.finalText).toBe("The host goal is waiting for the game.");
        expect(result.model).toBe("synthetic-model");
        expect(calls).toEqual([
          { name: spec.name, args: { id: "goal-1" }, callId: "call-1" },
        ]);
        expect(provider.bodies).toHaveLength(2);
        expect(
          provider.bodies[0].tools.map((tool: any) => tool.function.name),
        ).toEqual([spec.name]);
        expect(
          provider.bodies[1].messages.find(
            (message: any) => message.role === "tool",
          ),
        ).toMatchObject({
          tool_call_id: "call-1",
          content: '{"state":"waiting-game"}',
        });
        expect(
          events.some((event) => event.kind === "tool-result" && event.success),
        ).toBe(true);
        const history = await client.history({ sessionId: result.sessionId });
        expect(
          history.events.some((event: any) => event.type === "tool/result"),
        ).toBe(true);
        expect(JSON.stringify(history)).not.toContain(
          provider.connection.apiKey,
        );
        const followed: any[] = [];
        const follower = await client.follow({
          sessionId: result.sessionId,
          afterSeq: history.throughSeq,
          onEvent: (event) => followed.push(event),
        });
        const next = await client.run({
          prompt: "Recheck the recorded status",
          at: "2026-10-05T00:00:30.000Z",
          sessionId: result.sessionId,
        });
        follower.close();
        expect(next.finalText).toBe("The host goal is waiting for the game.");
        expect(
          followed.some((event) => event.type === "assistant/message"),
        ).toBe(true);
        expect(followed.every((event) => event.seq > history.throughSeq)).toBe(
          true,
        );
        expect(new Set(followed.map((event) => event.seq)).size).toBe(
          followed.length,
        );
        async function storedTexts(directory: string): Promise<string[]> {
          const texts: string[] = [];
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) texts.push(...(await storedTexts(path)));
            else if (entry.name.endsWith(".jsonl"))
              texts.push(await readFile(path, "utf8"));
          }
          return texts;
        }
        const stored = await storedTexts(home);
        expect(stored.length).toBeGreaterThan(0);
        expect(stored.join("\n")).not.toContain(provider.connection.apiKey);
        expect(stored.join("\n")).not.toContain(provider.connection.baseUrl);
        await client.close();
        const resumed = createDshRuntime({
          connection: provider.connection,
          runtime: { ...runtime, home },
          tools: [spec],
          callTool: async () => {
            throw new Error("must not replay completed host tool");
          },
        });
        try {
          const cold = await resumed.history({ sessionId: result.sessionId });
          expect(cold.status).toBe("cold");
          expect(provider.bodies).toHaveLength(3);
          const resumedResult = await resumed.run({
            prompt: "Describe the recorded status",
            at: "2026-10-05T00:01:00.000Z",
            sessionId: result.sessionId,
            resume: true,
          });
          expect(resumedResult.finalText).toBe(
            "The host goal is waiting for the game.",
          );
          expect(provider.bodies).toHaveLength(4);
        } finally {
          await resumed.close();
        }
      } finally {
        await client.close();
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it("refuses a locked or corrupt resumed session without creating a replacement or calling tools", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      let modelStarted!: () => void;
      const started = new Promise<void>((done) => {
        modelStarted = done;
      });
      let modelResponse: import("node:http").ServerResponse | undefined;
      const provider = await syntheticProvider((_body, response) => {
        if (modelResponse) {
          reply(response, "Unexpected second model activation.");
          return;
        }
        modelResponse = response;
        modelStarted();
      });
      let hostCalls = 0;
      const options = {
        timeoutMs: 30000,
        connection: provider.connection,
        runtime: { ...runtime, home },
        tools: [spec],
        callTool: async () => {
          hostCalls++;
          return {};
        },
      };
      const first = createDshRuntime(options);
      const second = createDshRuntime(options);
      const controller = new AbortController();
      const turn = {
        prompt: "Hold this session for ownership proof",
        at: "2026-10-05T00:00:00.000Z",
        sessionId: "offline-lock-proof",
        resume: true,
      };
      let firstRun: ReturnType<typeof first.run> | undefined;
      try {
        firstRun = first.run({ ...turn, signal: controller.signal });
        await started;
        // Force the pending official JSONL session to acquire its durable lease.
        await first.history({ sessionId: turn.sessionId });
        await expect(second.run(turn)).rejects.toMatchObject({
          code: "DSH_RUNTIME_FAILED",
        });
        expect(provider.bodies).toHaveLength(1);
        expect(hostCalls).toBe(0);
        reply(modelResponse!, "Original session remains valid.");
        await expect(firstRun).resolves.toMatchObject({
          finalText: "Original session remains valid.",
        });
        await first.close();
        await second.close();
        async function sessionLogs(directory: string): Promise<string[]> {
          const paths: string[] = [];
          for (const entry of await readdir(directory, {
            withFileTypes: true,
          })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) paths.push(...(await sessionLogs(path)));
            else if (
              entry.name.endsWith(".jsonl") &&
              (await readFile(path, "utf8")).includes(turn.prompt)
            )
              paths.push(path);
          }
          return paths;
        }
        const logs = await sessionLogs(home);
        expect(logs).toHaveLength(1);
        // A malformed header is corruption, unlike an officially recoverable torn tail.
        await writeFile(logs[0], "{invalid session header}\n");
        const corrupt = await readFile(logs[0], "utf8");
        await expect(runWithDsh({ ...options, ...turn })).rejects.toMatchObject(
          { code: "DSH_RUNTIME_FAILED" },
        );
        expect(provider.bodies).toHaveLength(1);
        expect(hostCalls).toBe(0);
        expect(await readFile(logs[0], "utf8")).toBe(corrupt);
      } finally {
        controller.abort();
        if (modelResponse && !modelResponse.writableEnded)
          reply(modelResponse, "Cleanup");
        await firstRun?.catch(() => {});
        await first.close();
        await second.close();
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it("rejects an unregistered shell tool without dispatching host code", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      const provider = await syntheticProvider((body, response) => {
        if (!body.messages.some((message: any) => message.role === "tool"))
          reply(response, null, [
            {
              id: "unsafe-call",
              type: "function",
              function: {
                name: "bash",
                arguments: '{"command":"echo unsafe"}',
              },
            },
          ]);
        else reply(response, "The unavailable tool was refused.");
      });
      let hostCalls = 0;
      try {
        const result = await runWithDsh({
          connection: provider.connection,
          runtime: { ...runtime, home },
          prompt: "Test unavailable tool",
          at: "2026-10-05T00:00:00.000Z",
          tools: [spec],
          callTool: async () => {
            hostCalls++;
            return {};
          },
        });
        expect(hostCalls).toBe(0);
        expect(result.finalText).toBe("The unavailable tool was refused.");
        expect(
          provider.bodies[0].tools.map((tool: any) => tool.function.name),
        ).toEqual([spec.name]);
      } finally {
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it("restricts extra profile native tools to the host allowlist", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      const marker = join(home, "unexpected-tool-executed.txt");
      const plugin = join(home, "unexpected-tool.mjs");
      await writeFile(
        plugin,
        `import {writeFile} from 'node:fs/promises'; export const name='unexpected-native'; export const inject=['tools']; export function apply(ctx){ctx.tools.register({name:'external_shell',description:'Must be hidden from the host agent',parameters:{type:'object'},output:{schema:{},render:()=>[{type:'text',text:'unexpected'}]},execute:async()=>{await writeFile(${JSON.stringify(marker)},'executed');return {};}});}`,
      );
      await writeFile(
        join(home, "cordis.patch.yml"),
        `- insert:\n    - id: unexpected-native\n      name: ${JSON.stringify(pathToFileURL(plugin).href)}\n`,
      );
      const provider = await syntheticProvider((body, response) => {
        if (!body.messages.some((message: any) => message.role === "tool"))
          reply(response, null, [
            {
              id: "extra-call",
              type: "function",
              function: { name: "external_shell", arguments: "{}" },
            },
          ]);
        else reply(response, "The extra native capability was denied.");
      });
      try {
        const result = await runWithDsh({
          connection: provider.connection,
          runtime: { ...runtime, home },
          prompt: "Try a disallowed capability",
          at: "2026-10-05T00:00:00.000Z",
          tools: [spec],
          callTool: async () => {
            throw new Error("no host calls expected");
          },
        });
        expect(result.finalText).toBe(
          "The extra native capability was denied.",
        );
        expect(
          provider.bodies[0].tools.map((tool: any) => tool.function.name),
        ).toEqual([spec.name]);
        await expect(access(marker)).rejects.toThrow();
      } finally {
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it("cancels a blocked model turn, reaps the subprocess and permits a later clean run", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      let first = true;
      const provider = await syntheticProvider((_body, response) => {
        if (first) {
          first = false;
          notifyStarted();
        } else reply(response, "clean retry");
      });
      const client = createDshRuntime({
        connection: provider.connection,
        runtime: { ...runtime, home },
        tools: [],
        callTool: async () => {
          throw new Error("no tools");
        },
      });
      const abort = new AbortController();
      try {
        const pending = client.run({
          prompt: "Block this turn",
          at: "2026-10-05T00:00:00.000Z",
          signal: abort.signal,
          sessionId: "cancel-proof",
        });
        const outcome = pending.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await Promise.race([
          started,
          outcome.then((result) => {
            throw (
              result.error ?? new Error("turn finished before provider request")
            );
          }),
        ]);
        abort.abort();
        expect((await outcome).error).toMatchObject({ code: "CANCELLED" });
        const result = await client.run({
          prompt: "Run next turn",
          at: "2026-10-05T00:01:00.000Z",
          sessionId: "cancel-proof",
        });
        expect(result.finalText).toBe("clean retry");
        await client.close();
        await expect(
          client.run({ prompt: "closed", at: "2026-10-05T00:01:00.000Z" }),
        ).rejects.toMatchObject({ code: "DSH_CLOSED" });
      } finally {
        await client.close();
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it("aborts a pending host tool cooperatively without dispatching the next call", async () => {
      const home = await mkdtemp(join(tmpdir(), "gamepilot-dsh-"));
      const provider = await syntheticProvider((_body, response) =>
        reply(response, null, [
          {
            id: "host-call-1",
            type: "function",
            function: { name: spec.name, arguments: '{"id":"goal-1"}' },
          },
          {
            id: "host-call-2",
            type: "function",
            function: { name: spec.name, arguments: '{"id":"goal-2"}' },
          },
        ]),
      );
      let started!: () => void;
      const hostStarted = new Promise<void>((done) => {
        started = done;
      });
      const calls: string[] = [];
      const abort = new AbortController();
      let sawAbort = false;
      const client = createDshRuntime({
        connection: provider.connection,
        runtime: { ...runtime, home },
        tools: [spec],
        callTool: async (_name, _args, context) => {
          calls.push(context.callId);
          return new Promise((done) => {
            context.signal.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                done({ cancelled: true });
              },
              { once: true },
            );
            started();
          });
        },
      });
      try {
        const pending = client.run({
          prompt: "Wait on a host observation",
          at: "2026-10-05T00:00:00.000Z",
          signal: abort.signal,
          sessionId: "host-cancel-proof",
        });
        const outcome = pending.then(
          (value) => ({ value, error: undefined }),
          (error: unknown) => ({ value: undefined, error }),
        );
        await Promise.race([
          hostStarted,
          outcome.then((result) => {
            throw result.error ?? new Error("turn finished before host call");
          }),
        ]);
        abort.abort();
        expect((await outcome).error).toMatchObject({ code: "CANCELLED" });
        expect(sawAbort).toBe(true);
        expect(calls).toEqual(["host-call-1"]);
      } finally {
        await client.close();
        await provider.close();
        await rm(home, { recursive: true, force: true });
      }
    }, 60000);

    it("rejects an already cancelled turn before any model or tool activity", async () => {
      const abort = new AbortController();
      abort.abort();
      let calls = 0;
      await expect(
        runWithDsh({
          connection: {
            baseUrl: "http://127.0.0.1:1",
            model: "synthetic-model",
            apiKey: "offline-unused-key",
          },
          runtime,
          prompt: "Cancelled",
          at: "2026-10-05T00:00:00.000Z",
          signal: abort.signal,
          tools: [],
          callTool: async () => {
            calls++;
          },
        }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      expect(calls).toBe(0);
    });
  },
);
