import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { PlannerSession } from "../packages/agent/planner";
import { plannerOutputSchema } from "../packages/agent/tool-specs";
import { createAgentTools } from "../packages/agent/tools";
import { planWithCompatible } from "../packages/agent/openai-compatible/adapter";
import { ChatService } from "../apps/desktop/main/agent-chat";
import { PlannerService } from "../apps/desktop/main/agent-planner";
import type { PlannerResult } from "../packages/protocol/agent-planner";
import type { ChatView } from "../packages/protocol/agent-chat";

const at = "2026-10-04T12:00:00.000Z";
const kinds = ["saved-daily", "saved-both-games"] as const;
function configuredTools() {
  return createAgentTools({ ...createFixtureSnapshot(), source: "configured" });
}
function result(kind: string): PlannerResult {
  return {
    status: kind as PlannerResult["status"],
    modelText: "请求检查保存日常，等待宿主冻结清单与用户确认。",
    source: "configured",
    execution: "not-started",
    canExecute: false,
    trace: [],
    model: "test",
    codexVersion: "test",
    elapsedMs: 1,
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("saved daily model intents remain inert", () => {
  it.each([
    "请帮我按现在保存的完整日常计划安排两个启用账号。这轮生成执行检查清单给我看，暂时不要确认启动",
    "帮我把两个已启用账号的明日方舟和阴阳师都按各自保存的完整日常安排好，先给我宿主执行检查清单，这轮不确认启动",
  ])(
    "sends saved preview routing instructions and the unchanged user request: %s",
    async (prompt) => {
      let submitted:
        | { messages: { role: string; content: string }[]; tools: any[] }
        | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: unknown, init: RequestInit) => {
          submitted = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              model: "test",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      kind: "answer",
                      text: "模拟回复仅验证请求契约，不验证模型分类。",
                      planHash: null,
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }),
      );
      await planWithCompatible(configuredTools(), {
        connection: {
          baseUrl: "https://model.example/v1",
          model: "test",
          apiKey: "test-key",
        },
        prompt,
        at,
      });
      expect(submitted?.messages[1]).toEqual({ role: "user", content: prompt });
      const system = submitted!.messages[0].content;
      expect(system).toContain("完整已保存日常的运行、安排、预览或执行检查");
      expect(system).toContain(
        "先给清单、暂时不确认启动属于同一个保存日常意图",
      );
      expect(system).toContain("跳过邮件");
      expect(system).toContain("source=fixture");
      expect(system).toContain("不能用compile_plan生成替代草稿");
      expect(system).toContain("saved-both-games");
      expect(
        submitted!.tools.filter(
          (tool) => tool.function.name !== "submit_result",
        ),
      ).toHaveLength(6);
    },
  );

  it.each(kinds)(
    "accepts %s without turning an existing draft into execution",
    (kind) => {
      const tools = configuredTools();
      const session = new PlannerSession(tools, at);
      const catalog = tools.call("list_capabilities");
      const environment = tools.call("get_environment");
      expect(
        session.call("compile", "compile_plan", {
          catalogRevision: catalog.revision,
          environmentRevision: environment.revision,
          at,
          lanes: [
            {
              laneId: "lane-a",
              games: [{ gameId: "arknights", parameters: {} }],
            },
          ],
        }).success,
      ).toBe(true);
      const intent = session.finish(
        JSON.stringify({ kind, text: "检查保存日常", planHash: null }),
      );
      expect(intent).toMatchObject({
        status: kind,
        execution: "not-started",
        canExecute: false,
      });
      expect(intent.draft).toBeUndefined();
      expect(intent.trace).toHaveLength(1);
    },
  );

  it.each(kinds)(
    "requires a null planHash and forbids arbitrary scope for %s",
    (kind) => {
      const session = new PlannerSession(configuredTools(), at);
      for (const payload of [
        { kind, text: "检查", planHash: "a".repeat(64) },
        { kind, text: "检查", planHash: null, laneIds: ["lane-a"] },
        { kind, text: "检查", planHash: null, excludedSkills: ["mail"] },
      ]) {
        expect(() => session.finish(JSON.stringify(payload))).toThrowError(
          expect.objectContaining({ code: "INVALID_OUTPUT" }),
        );
      }
    },
  );

  it("advertises the restricted intents in the Codex output schema while keeping three fields", () => {
    expect(plannerOutputSchema.required).toEqual(["kind", "text", "planHash"]);
    expect(Object.keys(plannerOutputSchema.properties)).toEqual([
      "kind",
      "text",
      "planHash",
    ]);
    expect(
      (plannerOutputSchema.properties.kind as { enum: string[] }).enum,
    ).toEqual(expect.arrayContaining([...kinds]));
  });

  it.each(kinds)(
    "carries %s through a compatible provider's final result without game tools",
    async (kind) => {
      let advertisedKinds: string[] = [];
      const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const finalTool = body.tools.find(
          (tool: any) => tool.function.name === "submit_result",
        );
        advertisedKinds = finalTool.function.parameters.properties.kind.enum;
        return new Response(
          JSON.stringify({
            model: "test",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "final",
                      type: "function",
                      function: {
                        name: "submit_result",
                        arguments: JSON.stringify({
                          kind,
                          text: "等待宿主日常检查",
                          planHash: null,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetch);
      const intent = await planWithCompatible(configuredTools(), {
        connection: {
          baseUrl: "https://model.example/v1",
          model: "test",
          apiKey: "test-key",
        },
        prompt: "请按保存计划安排日常",
        at,
      });
      expect(intent).toMatchObject({
        status: kind,
        canExecute: false,
        execution: "not-started",
        trace: [],
      });
      expect(intent.draft).toBeUndefined();
      expect(advertisedKinds).toContain(kind);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(kinds)(
    "persists %s as chat history and restores it without replay",
    async (kind) => {
      let stored: ChatView | undefined;
      const planner = new PlannerService({
        find: async () => "test",
        run: async () => result(kind),
        readConfigured: async () => ({
          fingerprint: "configured",
          snapshot: { ...createFixtureSnapshot(), source: "configured" },
        }),
      });
      const chat = new ChatService({
        planner,
        save: async (view) => {
          stored = structuredClone(view);
        },
      });
      const sessionId = (await chat.snapshot()).selectedSessionId!;
      await chat.send({
        sessionId,
        prompt: "安排保存日常",
        source: "configured",
        at,
      });
      await vi.waitFor(() =>
        expect(planner.snapshot().status).toBe("completed"),
      );
      const complete = await chat.snapshot();
      expect(complete.error).toBeUndefined();
      expect(complete.sessions[0].turns[0].planner.result).toMatchObject({
        status: kind,
        canExecute: false,
        execution: "not-started",
      });
      const replay = vi.fn();
      const inertPlanner = new PlannerService({ find: replay, run: replay });
      const restored = new ChatService({
        planner: inertPlanner,
        load: async () => structuredClone(stored),
        save: async () => {},
      });
      const history = await restored.snapshot();
      expect(history.error).toBeUndefined();
      expect(history.sessions[0].turns[0].planner.result?.status).toBe(kind);
      expect(inertPlanner.snapshot().status).toBe("idle");
      expect(replay).not.toHaveBeenCalled();
    },
  );

  it("rejects a persisted saved intent carrying a custom draft", async () => {
    const tools = configuredTools();
    const draft = tools.call("compile_plan", {
      catalogRevision: tools.call("list_capabilities").revision,
      environmentRevision: tools.call("get_environment").revision,
      at,
      lanes: [
        { laneId: "lane-a", games: [{ gameId: "arknights", parameters: {} }] },
      ],
    });
    const view: ChatView = {
      revision: 1,
      selectedSessionId: "session-a",
      sessions: [
        {
          id: "session-a",
          title: "日常",
          createdAt: at,
          updatedAt: at,
          turns: [
            {
              id: "turn-a",
              prompt: "日常",
              source: "configured",
              at,
              createdAt: at,
              planner: {
                revision: 1,
                requestId: "request-a",
                status: "completed",
                prompt: "日常",
                source: "configured",
                at,
                result: { ...result("saved-daily"), draft },
              },
            },
          ],
        },
      ],
    };
    const chat = new ChatService({
      planner: new PlannerService(),
      load: async () => view,
      save: async () => {},
    });
    expect((await chat.snapshot()).error).toContain("会话记录");
  });
});
