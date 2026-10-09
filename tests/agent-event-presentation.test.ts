import { expect, it } from "vitest";
import {
  modelEventReceipt,
  plannerStateReceipt,
} from "../apps/desktop/main/agent-event-presentation";
it("separates tool intent, host invocation, result and game success", () => {
  expect(
    modelEventReceipt("r", {
      kind: "tool-requested",
      tool: "get_run",
      callId: "c",
    })?.status,
  ).toBe("running");
  expect(
    modelEventReceipt("r", {
      kind: "tool-result",
      tool: "get_run",
      callId: "c",
      success: false,
    })?.status,
  ).toBe("failed");
  expect(
    modelEventReceipt("r", { kind: "answer-delta", text: "partial" }),
  ).toBeUndefined();
  expect(modelEventReceipt("r", { kind: "finished" })?.text).toContain(
    "另行核对",
  );
  expect(
    plannerStateReceipt({
      requestId: "r",
      revision: 2,
      status: "completed",
      result: { status: "blocked" } as never,
    })?.status,
  ).toBe("blocked");
});
it("maps only supplied safe tool details and never infers legacy duration", () => {
  expect(
    modelEventReceipt("r", {
      kind: "tool-started",
      tool: "get_run",
      callId: "c",
      details: { arguments: '{"requestId":"request-a"}' },
    } as never)?.details,
  ).toEqual({ arguments: '{"requestId":"request-a"}' });
  expect(
    modelEventReceipt("r", {
      kind: "tool-result",
      tool: "get_run",
      callId: "c",
      success: true,
      details: { result: '{"complete":true}', durationMs: 15 },
    } as never)?.details,
  ).toEqual({ result: '{"complete":true}', durationMs: 15 });
  expect(
    modelEventReceipt("r", {
      kind: "tool-result",
      tool: "get_run",
      callId: "legacy",
      success: true,
    }),
  ).not.toHaveProperty("details");
});
it("shows a cancelled model's missing tool response as unknown without claiming the game stopped", () => {
  const receipt = modelEventReceipt("request-original", {
    kind: "tool-result",
    callId: "call-original",
    tool: "run_plan",
    success: false,
    code: "TOOL_RESPONSE_UNCONFIRMED",
  });
  expect(receipt).toMatchObject({
    requestId: "request-original",
    callId: "call-original",
    tool: "run_plan",
    status: "unknown",
  });
  expect(receipt?.text).toContain("响应未确认");
  expect(receipt?.text).toContain("执行账本");
  expect(receipt?.text).not.toContain("游戏已停止");
});
