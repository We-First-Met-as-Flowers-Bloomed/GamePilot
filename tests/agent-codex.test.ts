import { afterEach, expect, it } from "vitest";
import { StdioRpc } from "../packages/agent/codex/rpc";
import {
  runPlannerProtocol,
  plannerConfig,
  assertCodexVersion,
  verifyPlannerConfiguration,
} from "../packages/agent/codex/adapter";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { PlannerSession } from "../packages/agent/planner";
import type { RpcEvent } from "../packages/agent/codex/rpc";
import candidateTranscript from "./fixtures/codex/0.160-candidate.json";

const clients: StdioRpc[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients.length = 0;
});
function child(script: string) {
  const rpc = new StdioRpc(process.execPath, ["-e", script], process.cwd());
  clients.push(rpc);
  return rpc;
}
it("correlates responses and preserves early server calls until consumed", async () => {
  const rpc = child(
    `process.stdin.once('data',c=>{let m=JSON.parse(c);process.stdout.write(JSON.stringify({id:99,method:'item/tool/call',params:{tool:'get_environment'}})+'\\n'+JSON.stringify({id:m.id,result:{ok:true}})+'\\n');});`,
  );
  expect(await rpc.request("initialize", {}, 3000)).toEqual({ ok: true });
  expect(await rpc.next()).toMatchObject({ id: 99, method: "item/tool/call" });
});
it("times out bounded requests without exposing raw arguments", async () => {
  const rpc = child("process.stdin.resume()");
  await expect(
    rpc.request("PRIVATE", { secret: "PRIVATE" }, 40),
  ).rejects.toMatchObject({ code: "TIMEOUT" });
});
it.each([
  "process.exit(3)",
  "process.stdout.write('invalid json\\n');process.stdin.resume()",
  "process.stdout.write('x'.repeat(1100000));process.stdin.resume()",
])("fails closed on exit or malformed frames: %s", async (script) => {
  const rpc = child(script);
  await expect(rpc.next()).rejects.toBeTruthy();
});
it("pins supported protocol and disables external execution surfaces", () => {
  expect(() =>
    assertCodexVersion("codex-cli 0.155.0-alpha.16.4"),
  ).not.toThrow();
  expect(() => assertCodexVersion("codex-cli 0.155.1")).toThrow(/版本/);
  expect(() => assertCodexVersion("codex-cli 0.158.0-alpha.2.1")).not.toThrow();
  expect(plannerConfig()["features.shell_tool"]).toBe(false);
  expect(plannerConfig()["features.plugins"]).toBe(false);
  expect(plannerConfig().web_search).toBe("disabled");
});
it("uses Codex dotted override keys without introducing a new quoted MCP server", () => {
  expect(
    plannerConfig(["playwright", "node_repl"])[
      "mcp_servers.playwright.enabled"
    ],
  ).toBe(false);
  expect(Object.keys(plannerConfig(["node_repl"]))).toContain(
    "mcp_servers.node_repl.enabled",
  );
  expect(() => plannerConfig(["ambiguous.name"])).toThrow(/MCP/);
});
it("checks effective restrictions instead of trusting CLI flags", () => {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plannerConfig(["example"]))) {
    let target = config;
    const parts = key.split(".");
    for (const part of parts.slice(0, -1))
      target = (target[part] ??= {}) as Record<string, unknown>;
    target[parts.at(-1)!] = value;
  }
  expect(() =>
    verifyPlannerConfiguration(config, plannerConfig(["example"])),
  ).not.toThrow();
  (config.features as Record<string, unknown>).shell_tool = true;
  expect(() =>
    verifyPlannerConfiguration(config, plannerConfig(["example"])),
  ).toThrow(/限制/);
});

function protocolFixture(mode: string) {
  const tools = createAgentTools(createFixtureSnapshot());
  const session = new PlannerSession(tools, "2026-09-26T00:00:00Z");
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const responses: unknown[] = [];
  let index = 0;
  const events =
    mode === "unexpected"
      ? [
          {
            id: 99,
            method: "item/commandExecution/requestApproval",
            params: {},
          },
        ]
      : mode === "wrong-thread"
        ? [
            {
              id: 99,
              method: "item/tool/call",
              params: {
                threadId: "other",
                turnId: "turn",
                callId: "call",
                tool: "get_environment",
                arguments: {},
              },
            },
          ]
        : mode === "failed"
          ? [
              {
                method: "turn/completed",
                params: {
                  threadId: "thread",
                  turn: {
                    id: "turn",
                    status: "failed",
                    error: {
                      codexErrorInfo: "usageLimitExceeded",
                      message: "PRIVATE",
                    },
                  },
                },
              },
            ]
          : [
              {
                id: 99,
                method: "item/tool/call",
                params: {
                  threadId: "thread",
                  turnId: "turn",
                  namespace: null,
                  callId: "call",
                  tool: "get_environment",
                  arguments: {},
                },
              },
              {
                method: "item/completed",
                params: {
                  threadId: "thread",
                  turnId: "turn",
                  item: {
                    type: "agentMessage",
                    phase: "final_answer",
                    text: JSON.stringify({
                      kind: "answer",
                      text: "这是合成配置",
                      planHash: null,
                    }),
                  },
                },
              },
              {
                method: "turn/completed",
                params: {
                  threadId: "thread",
                  turn: { id: "turn", status: "completed" },
                },
              },
            ];
  const rpc = {
    async request<T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      calls.push({ method, params });
      if (method === "thread/start")
        return { thread: { id: "thread" }, model: "test-model" } as T;
      if (method === "turn/start") return { turn: { id: "turn" } } as T;
      return {} as T;
    },
    async next() {
      if (index >= events.length) throw new Error("missing completion");
      return events[index++];
    },
    respond(id: string | number, result: unknown) {
      responses.push({ id, result });
    },
  };
  return { calls, responses, rpc, session, tools };
}
it("routes a real tool result and keeps final explanation explicitly synthetic", async () => {
  const f = protocolFixture("normal");
  const progress: unknown[] = [];
  const result = await runPlannerProtocol(f.rpc, f.session, f.tools, {
    prompt: "查询账号",
    cwd: process.cwd(),
    onProgress: (value) => progress.push(value),
  });
  expect(result).toMatchObject({
    status: "answer",
    execution: "not-started",
    model: "test-model",
    canExecute: false,
  });
  expect(f.responses).toHaveLength(1);
  expect(progress).toEqual([
    { phase: "thinking" },
    { phase: "tool", tool: "get_environment" },
  ]);
  expect(
    f.calls.find((c) => c.method === "thread/start")?.params,
  ).toMatchObject({ environments: [], ephemeral: true, sandbox: "read-only" });
});
it.each(["unexpected", "wrong-thread", "failed"])(
  "stops protocol failures instead of fabricating a plan: %s",
  async (mode) => {
    const f = protocolFixture(mode);
    await expect(
      runPlannerProtocol(f.rpc, f.session, f.tools, {
        prompt: "编计划",
        cwd: process.cwd(),
      }),
    ).rejects.toBeTruthy();
    expect(f.responses).toHaveLength(0);
  },
);

function streamProtocol(events: RpcEvent[]) {
  const f = protocolFixture("normal");
  let index = 0;
  f.rpc.next = async () => {
    if (index >= events.length) throw new Error("missing completion");
    return events[index++] as Awaited<ReturnType<typeof f.rpc.next>>;
  };
  return f;
}
const finalJson = JSON.stringify({
  kind: "answer",
  text: "合成配置",
  planHash: null,
});
const itemStart: RpcEvent = {
  method: "item/started",
  params: {
    threadId: "thread",
    turnId: "turn",
    item: {
      id: "final-item",
      type: "agentMessage",
      phase: "final_answer",
      text: "",
    },
  },
};
const itemEnd: RpcEvent = {
  method: "item/completed",
  params: {
    threadId: "thread",
    turnId: "turn",
    item: {
      id: "final-item",
      type: "agentMessage",
      phase: "final_answer",
      text: finalJson,
    },
  },
};
const turnEnd: RpcEvent = {
  method: "turn/completed",
  params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
};
it("correlates answer delta and actual usage to the active Codex item without adding cached input twice", async () => {
  const usage: RpcEvent = {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread",
      turnId: "turn",
      tokenUsage: {
        total: {
          inputTokens: 50,
          outputTokens: 8,
          totalTokens: 58,
          cachedInputTokens: 20,
        },
        last: {
          inputTokens: 50,
          outputTokens: 8,
          totalTokens: 58,
          cachedInputTokens: 20,
        },
      },
    },
  };
  const f = streamProtocol([
    itemStart,
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "final-item",
        delta: finalJson,
      },
    },
    usage,
    usage,
    itemEnd,
    turnEnd,
  ]);
  const events: unknown[] = [];
  const result = await runPlannerProtocol(f.rpc, f.session, f.tools, {
    prompt: "查询",
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });
  expect(result.status).toBe("answer");
  expect(events).toContainEqual({ kind: "answer-delta", text: finalJson });
  expect(
    events.filter((event) => (event as { kind: string }).kind === "usage"),
  ).toEqual([
    {
      kind: "usage",
      usage: {
        inputTokens: 50,
        outputTokens: 8,
        totalTokens: 58,
        cachedInputTokens: 20,
      },
    },
  ]);
  expect(events.at(-1)).toEqual({ kind: "finished" });
});
it.each([
  { itemId: "unrelated", threadId: "thread", turnId: "turn" },
  { itemId: "final-item", threadId: "other", turnId: "turn" },
  { itemId: "final-item", threadId: "thread", turnId: "old" },
  { itemId: "final-item", threadId: "thread" },
])(
  "rejects deltas without exact scope or an active message item: %j",
  async (scope) => {
    const f = streamProtocol([
      itemStart,
      {
        method: "item/agentMessage/delta",
        params: { ...scope, delta: finalJson },
      },
      itemEnd,
      turnEnd,
    ]);
    await expect(
      runPlannerProtocol(f.rpc, f.session, f.tools, {
        prompt: "查询",
        cwd: process.cwd(),
      }),
    ).rejects.toHaveProperty("code");
  },
);
it("does not finish a plan from a partial Codex delta even after turn completion", async () => {
  const f = streamProtocol([
    itemStart,
    {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "final-item",
        delta: finalJson,
      },
    },
    turnEnd,
  ]);
  await expect(
    runPlannerProtocol(f.rpc, f.session, f.tools, {
      prompt: "查询",
      cwd: process.cwd(),
    }),
  ).rejects.toHaveProperty("code");
});
it("retains the verified alpha pins while treating the latest release as a candidate only", () => {
  expect(() => assertCodexVersion("codex-cli 0.160.0")).toThrow(/版本/);
});
it("does not enter a host tool after cancellation of the requested intent", async () => {
  const f = protocolFixture("normal");
  const controller = new AbortController();
  const events: unknown[] = [];
  await expect(
    runPlannerProtocol(f.rpc, f.session, f.tools, {
      prompt: "查询",
      cwd: process.cwd(),
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "tool-requested") controller.abort();
      },
    }),
  ).rejects.toMatchObject({ code: "CANCELLED" });
  expect(f.session.trace).toHaveLength(0);
  expect(
    events.some((event) => (event as { kind: string }).kind === "tool-started"),
  ).toBe(false);
});
it("publishes the actual ephemeral thread usage snapshot rather than the last model request only", async () => {
  const f = streamProtocol([
    {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread",
        turnId: "turn",
        tokenUsage: {
          total: {
            inputTokens: 80,
            outputTokens: 12,
            totalTokens: 92,
            cachedInputTokens: 30,
          },
          last: {
            inputTokens: 50,
            outputTokens: 8,
            totalTokens: 58,
            cachedInputTokens: 20,
          },
        },
      },
    },
    itemEnd,
    turnEnd,
  ]);
  const events: unknown[] = [];
  await runPlannerProtocol(f.rpc, f.session, f.tools, {
    prompt: "查询",
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });
  expect(events).toContainEqual({
    kind: "usage",
    usage: {
      inputTokens: 80,
      outputTokens: 12,
      totalTokens: 92,
      cachedInputTokens: 30,
    },
  });
});
it("checks the candidate notification transcript without admitting the unverified executable", async () => {
  const f = streamProtocol(candidateTranscript.events);
  const result = await runPlannerProtocol(f.rpc, f.session, f.tools, {
    prompt: "候选schema测试",
    cwd: process.cwd(),
  });
  expect(result.modelText).toBe("候选转录");
  expect(candidateTranscript.provenance.admitted).toBe(false);
  expect(() => assertCodexVersion(candidateTranscript.version)).toThrow(/版本/);
});
it("records scoped provider retry attempts without exposing server error text", async () => {
  const f = streamProtocol([
    {
      method: "error",
      params: {
        threadId: "thread",
        turnId: "turn",
        willRetry: true,
        error: { codexErrorInfo: "internalServerError", message: "PRIVATE" },
      },
    },
    itemEnd,
    turnEnd,
  ]);
  const events: unknown[] = [];
  await runPlannerProtocol(f.rpc, f.session, f.tools, {
    prompt: "查询",
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });
  expect(events).toContainEqual({
    kind: "attempt",
    attempt: 1,
    status: "failed",
    code: "MODEL_FAILED",
  });
  expect(events).toContainEqual({
    kind: "attempt",
    attempt: 2,
    status: "completed",
  });
  expect(JSON.stringify(events)).not.toContain("PRIVATE");
});
it("refuses a final answer following a nonretryable Codex error notification", async () => {
  const f = streamProtocol([
    {
      method: "error",
      params: {
        threadId: "thread",
        turnId: "turn",
        willRetry: false,
        error: { codexErrorInfo: "usageLimitExceeded", message: "PRIVATE" },
      },
    },
    itemEnd,
    turnEnd,
  ]);
  await expect(
    runPlannerProtocol(f.rpc, f.session, f.tools, {
      prompt: "查询",
      cwd: process.cwd(),
    }),
  ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});
it("fails closed on unknown notifications and private or unknown message phases", async () => {
  for (const event of [
    { method: "unexpected/foo", params: {} },
    {
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          id: "private-item",
          type: "agentMessage",
          phase: "analysis",
          text: finalJson,
        },
      },
    },
    {
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: {
          id: "private-item",
          type: "agentMessage",
          phase: "unknown-phase",
        },
      },
    },
  ]) {
    const f = streamProtocol([event, itemEnd, turnEnd]);
    const events: unknown[] = [];
    await expect(
      runPlannerProtocol(f.rpc, f.session, f.tools, {
        prompt: "查询",
        cwd: process.cwd(),
        onEvent: (value) => events.push(value),
      }),
    ).rejects.toHaveProperty("code");
    expect(
      events.some(
        (value) => (value as { kind: string }).kind === "answer-delta",
      ),
    ).toBe(false);
  }
});
it("ignores recognized private reasoning notifications while returning only the final answer", async () => {
  const f = streamProtocol([
    {
      method: "item/started",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { id: "reasoning", type: "reasoning" },
      },
    },
    {
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "reasoning",
        delta: "PRIVATE_REASONING",
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { id: "reasoning", type: "reasoning" },
      },
    },
    itemEnd,
    turnEnd,
  ]);
  const events: unknown[] = [];
  await runPlannerProtocol(f.rpc, f.session, f.tools, {
    prompt: "查询",
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });
  expect(events).toContainEqual({ kind: "finished" });
  expect(JSON.stringify(events)).not.toContain("PRIVATE_REASONING");
});
