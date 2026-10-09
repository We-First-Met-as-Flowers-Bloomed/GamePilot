import { describe, expect, it } from "vitest";
import {
  compatibleRequest,
  compatibleResponse,
  dshEndReasonError,
  publicDshEvents,
} from "../packages/agent/dsh/protocol";

describe("DSH provider bridge", () => {
  it("reports known terminal error codes with fixed host text, never SDK details", () => {
    const error = dshEndReasonError({
      kind: "error",
      error: {
        code: "DSH_CONTEXT_TOO_LARGE",
        message: "private-provider-secret",
        stack: "private-stack",
      },
    });
    expect(error.code).toBe("DSH_CONTEXT_TOO_LARGE");
    expect(error.message).toContain("4 MiB");
    expect(error.message).not.toContain("private");
  });

  it.each([
    {
      kind: "error",
      error: { code: "__proto__", message: "private-provider-secret" },
    },
    {
      kind: "error",
      error: { code: "constructor", message: "private-provider-secret" },
    },
    {
      kind: "error",
      error: {
        code: "UNKNOWN_PROVIDER_ERROR",
        message: "private-provider-secret",
      },
    },
    { kind: "error", error: null },
    { kind: "error", error: "private-provider-secret" },
    { kind: "max-tokens", error: { code: "AUTH_FAILED" } },
  ])("does not trust unknown or malformed terminal errors: %j", (reason) => {
    const error = dshEndReasonError(reason);
    expect(error.code).toBe("MODEL_FAILED");
    expect(error.message).toBe("DSH 模型未形成有效最终回复");
  });

  it("preserves the assistant tool call and matching host result in chat/completions", () => {
    const request = compatibleRequest({
      messages: [
        { role: "system", content: [{ type: "text", text: "host rules" }] },
        { role: "user", content: [{ type: "text", text: "check goal" }] },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "private reasoning" },
            {
              type: "tool-call",
              id: "call-1",
              name: "goal_status",
              arguments: '{"id":"goal-1"}',
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call-1",
          content: [{ type: "text", text: '{"state":"running"}' }],
        },
      ],
      tools: [
        {
          name: "goal_status",
          description: "Read status",
          parameters: { type: "object" },
        },
      ],
      maxTokens: 123,
    });
    expect(request).toMatchObject({
      max_tokens: 123,
      messages: [
        { role: "system", content: "host rules" },
        { role: "user", content: "check goal" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "goal_status", arguments: '{"id":"goal-1"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: '{"state":"running"}',
        },
      ],
    });
    expect(JSON.stringify(request)).not.toContain("private reasoning");
  });

  it("maps provider usage to disjoint DSH token counts without inventing totals", () => {
    const result = compatibleResponse({
      model: "test-model",
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 4 },
      },
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    });
    expect(result).toMatchObject({
      model: "test-model",
      blocks: [{ type: "text", text: "done" }],
      reason: { kind: "stop" },
      usage: {
        inputTokens: 8,
        cacheReadTokens: 4,
        outputTokens: 5,
        totalTokens: 17,
      },
    });
    const noUsage = compatibleResponse({
      model: "test-model",
      choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    });
    expect(noUsage.usage).toBeUndefined();
  });

  it("rejects malformed or unknown calls before a host tool can run", () => {
    expect(() =>
      compatibleResponse({
        model: "test-model",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "goal_status", arguments: "{broken" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      compatibleRequest({
        messages: [
          { role: "user", content: [{ type: "image", attachment: {} }] },
        ],
      }),
    ).toThrow();
  });

  it("exposes public answer/tool/usage events without raw system prompts or hidden reasoning", () => {
    const result = publicDshEvents({
      type: "assistant/message",
      seq: 3,
      data: {
        message: {
          content: [
            { type: "reasoning", text: "private" },
            { type: "text", text: "visible" },
            {
              type: "tool-call",
              id: "call-1",
              name: "goal_status",
              arguments: "{}",
            },
          ],
        },
      },
    });
    expect(result).toEqual([
      { kind: "answer-delta", text: "visible" },
      { kind: "tool-requested", callId: "call-1", tool: "goal_status" },
    ]);
    expect(
      publicDshEvents({
        type: "request/start",
        seq: 1,
        data: { system: "private system" },
      }),
    ).toEqual([]);
  });
});
