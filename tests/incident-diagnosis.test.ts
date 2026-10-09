import { expect, it, vi, afterEach } from "vitest";
import {
  validateIncidentDiagnosis,
  diagnoseIncident,
} from "../packages/agent/incident-diagnosis";
import * as incidentDiagnosis from "../packages/agent/incident-diagnosis";
import type { PlannerRpc, RpcEvent } from "../packages/agent/codex/rpc";
import type { AgentIncident } from "../packages/protocol/agent-incident";
afterEach(() => vi.unstubAllGlobals());
it("requires an explicit diagnosis summary and existing evidence references", () => {
  const value = {
    summary: "登录网络异常，建议重新核验后继续。",
    basis: ["screen-1"],
    action: "retry-remaining",
  };
  expect(validateIncidentDiagnosis(value, ["screen-1"])).toEqual(value);
  for (const bad of [
    { ...value, basis: ["invented"] },
    { ...value, action: "tap" },
    { ...value, coordinates: [50, 50] },
    { ...value, summary: "" },
  ])
    expect(() => validateIncidentDiagnosis(bad, ["screen-1"])).toThrow();
});
it("sends only the bounded incident and derived screen evidence through the compatible API", async () => {
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({
        model: "test",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "未知画面，需要核对",
                basis: ["screen-1"],
                action: "manual",
              }),
            },
            finish_reason: "stop",
          },
        ],
      });
    }),
  );
  const result = await diagnoseIncident(
    { baseUrl: "http://127.0.0.1:9012/v1", model: "test", apiKey: "test-key" },
    {
      incident: { signals: [], faults: [] } as unknown as AgentIncident,
      screens: [
        {
          id: "screen-1",
          runId: "screen-run-1",
          gameId: "arknights",
          observedAt: "2026-10-03T12:00:00Z",
          page: "unknown",
          imageSent: false,
        },
      ],
    },
    new AbortController().signal,
  );
  expect(result.diagnosis.action).toBe("manual");
  expect(body).not.toHaveProperty("tools");
  expect(JSON.stringify(body)).not.toContain("test-key");
  expect(JSON.stringify(body)).not.toContain("data:image");
});
it("rejects invented evidence and unsupported tool calls without a second model request", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      model: "test",
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "直接点击",
              basis: ["invented"],
              action: "retry-remaining",
            }),
          },
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    diagnoseIncident(
      {
        baseUrl: "http://127.0.0.1:9012/v1",
        model: "test",
        apiKey: "test-key",
      },
      {
        incident: { signals: [], faults: [] } as unknown as AgentIncident,
        screens: [],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([
  "identity-input",
  "payment",
  "unknown-confirmation",
  "client-update-required",
] as const)(
  "rejects retry suggestions for %s using an offline response",
  async (page) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          model: "offline",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  summary: "继续剩余项",
                  basis: ["screen-1"],
                  action: "retry-remaining",
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );
    await expect(
      diagnoseIncident(
        {
          baseUrl: "http://127.0.0.1:9012/v1",
          model: "offline",
          apiKey: "fixture-only",
        },
        {
          incident: { signals: [], faults: [] } as unknown as AgentIncident,
          screens: [
            {
              id: "screen-1",
              runId: "screen-run-1",
              gameId:
                page === "client-update-required" ? "arknights" : "onmyoji",
              observedAt: "2026-10-07T04:00:00Z",
              page,
              imageSent: false,
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("人工");
  },
);

const diagnosticBundle = {
  incident: { signals: [], faults: [] } as unknown as AgentIncident,
  screens: [],
};
const diagnosisJson = JSON.stringify({
  summary: "证据需要人工核对",
  basis: ["run-record"],
  action: "manual",
});
it("uses the shared streaming transport and semantic events for compatible diagnosis", async () => {
  const events: unknown[] = [];
  const fetch = vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).stream).toBe(true);
    const frames = [
      {
        model: "test",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: diagnosisJson },
            finish_reason: "stop",
          },
        ],
      },
    ];
    return new Response(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const result = await diagnoseIncident(
    { baseUrl: "http://127.0.0.1:9012/v1", model: "test", apiKey: "test" },
    diagnosticBundle,
    new AbortController().signal,
    (event) => events.push(event),
  );
  expect(result.diagnosis.action).toBe("manual");
  expect(events).toContainEqual({ kind: "answer-delta", text: diagnosisJson });
  expect(events.at(-1)).toEqual({ kind: "finished" });
});
function diagnosisRpc(
  content: string,
  tool = false,
): {
  rpc: PlannerRpc;
  requests: { method: string; params: Record<string, unknown> }[];
} {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  const events: RpcEvent[] = tool
    ? [
        {
          id: 1,
          method: "item/tool/call",
          params: {
            threadId: "diagnosis",
            turnId: "turn",
            callId: "evil",
            tool: "shell",
            arguments: {},
          },
        },
      ]
    : [
        {
          method: "item/completed",
          params: {
            threadId: "diagnosis",
            turnId: "turn",
            item: {
              id: "final",
              type: "agentMessage",
              phase: "final_answer",
              text: content,
            },
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: "diagnosis",
            turn: { id: "turn", status: "completed" },
          },
        },
      ];
  return {
    requests,
    rpc: {
      async request<T>(method: string, params: Record<string, unknown>) {
        requests.push({ method, params });
        return (
          method === "thread/start"
            ? { thread: { id: "diagnosis" }, model: "test" }
            : { turn: { id: "turn" } }
        ) as T;
      },
      async next() {
        const event = events.shift();
        if (!event) throw new Error("missing event");
        return event;
      },
      respond() {
        throw new Error("diagnosis must not respond to tools");
      },
    },
  };
}
it("runs evidence-validated Codex diagnosis with a strong schema and no dynamic execution tools", async () => {
  const run = (incidentDiagnosis as Record<string, unknown>)
    .runIncidentDiagnosisProtocol as
    | ((
        rpc: PlannerRpc,
        bundle: typeof diagnosticBundle,
        options: { cwd: string },
      ) => Promise<{ diagnosis: { action: string } }>)
    | undefined;
  expect(run).toBeTypeOf("function");
  const f = diagnosisRpc(diagnosisJson);
  const result = await run!(f.rpc, diagnosticBundle, { cwd: process.cwd() });
  expect(result.diagnosis.action).toBe("manual");
  expect(f.requests[0].params).toMatchObject({
    dynamicTools: [],
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  expect(f.requests[1].params).toMatchObject({
    outputSchema: {
      additionalProperties: false,
      required: ["summary", "basis", "action"],
    },
  });
  await expect(
    run!(diagnosisRpc(diagnosisJson, true).rpc, diagnosticBundle, {
      cwd: process.cwd(),
    }),
  ).rejects.toMatchObject({ code: "UNEXPECTED_REQUEST" });
  await expect(
    run!(
      diagnosisRpc(
        JSON.stringify({
          summary: "伪造",
          basis: ["invented"],
          action: "manual",
        }),
      ).rpc,
      diagnosticBundle,
      { cwd: process.cwd() },
    ),
  ).rejects.toMatchObject({ code: "INVALID_DIAGNOSIS" });
});
it.each(["sdk-login", "phone-login", "verification-code"] as const)(
  "rejects model retry advice for identity screen %s",
  async (page) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          model: "test",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  summary: "自动重试",
                  basis: ["screen-identity"],
                  action: "retry-remaining",
                }),
              },
            },
          ],
        }),
      ),
    );
    await expect(
      diagnoseIncident(
        { baseUrl: "http://127.0.0.1:9012/v1", model: "test", apiKey: "test" },
        {
          ...diagnosticBundle,
          screens: [
            {
              id: "screen-identity",
              runId: "run",
              gameId: "arknights",
              observedAt: "2026-10-04T00:00:00Z",
              page,
              imageSent: false,
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_DIAGNOSIS" });
  },
);
it("enforces the evidence budget before network access", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    diagnoseIncident(
      { baseUrl: "http://127.0.0.1:9012/v1", model: "test", apiKey: "test" },
      { ...diagnosticBundle, feedback: "x".repeat(12001) },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "DIAGNOSIS_BUDGET" });
  expect(fetch).not.toHaveBeenCalled();
});
