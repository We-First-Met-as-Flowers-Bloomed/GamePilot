import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AgentRunTrace } from "../apps/desktop/renderer/components/AgentRunTrace";
import type { AgentEvent } from "../packages/protocol/agent-events";

const journal = vi.hoisted(() => ({ events: [] as AgentEvent[] }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) =>
      react.useState(Array.isArray(initial) ? journal.events : initial),
  };
});
it("shows fallback calls alongside non-tool journal records and usage in one process card", () => {
  journal.events = [
    {
      requestId: "r",
      seq: 1,
      at: "2026-10-12T00:00:00Z",
      kind: "model-usage",
      status: "succeeded",
      text: "模型用量",
      usage: { inputTokens: 12, outputTokens: 3 },
    },
    {
      requestId: "r",
      seq: 2,
      at: "2026-10-12T01:00:00Z",
      kind: "model-finished",
      status: "succeeded",
      text: "模型回复结束；游戏结果另行核对。",
    },
  ];
  const html = renderToStaticMarkup(
    createElement(AgentRunTrace, {
      active: false,
      requestId: "r",
      fallbackTrace: [{ callId: "legacy", tool: "get_run", success: false }],
    }),
  );
  expect(html).toContain('data-agent-call-id="legacy"');
  expect(html).toContain("调用 1 个工具 · 耗时未记录");
  expect(html).not.toContain("调用 0 个工具");
  expect(html).toContain("模型回复结束；游戏结果另行核对。");
  expect(html).toContain("输入 12 · 输出 3");
  expect(html.match(/aria-label="实时工具与模型记录"/g)).toHaveLength(1);
});
