import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  AgentEventTimeline,
  AgentRunTrace,
} from "../apps/desktop/renderer/components/AgentRunTrace";
import { AgentRecordFacts } from "../apps/desktop/renderer/components/AgentRecordFacts";
import type { AgentEvent } from "../packages/protocol/agent-events";

it("renders unknown calls with a question icon and public summaries, retaining call identity", () => {
  const events: AgentEvent[] = [
    {
      requestId: "r",
      callId: "c",
      seq: 1,
      at: "2026-10-12T00:00:00Z",
      tool: "get_run",
      kind: "tool-result",
      status: "unknown",
      text: "响应未确认",
      details: {
        arguments: '{"requestId":"safe-r"}',
        result: '{"status":"unknown"}',
      },
    },
  ];
  const html = renderToStaticMarkup(
    createElement(AgentEventTimeline, { events }),
  );
  expect(html).toContain('data-agent-call-id="c"');
  expect(html).toContain('data-status="unknown"');
  expect(html).toContain("circle-help");
  expect(html).not.toContain("circle-check");
  expect(html).toContain("查询任务记录");
  expect(html).toContain("调用参数");
  expect(html).toContain("返回摘要");
  expect(html).toContain("耗时未记录");
});
it("marks host facts with their recorded unknown status without a completion claim", () => {
  const html = renderToStaticMarkup(
    createElement(AgentRecordFacts, {
      records: [
        { requestId: "r", recordedStatus: "unknown", tasks: [] } as never,
      ],
    }),
  );
  expect(html).toContain("宿主核验");
  expect(html).toContain('data-recorded-status="unknown"');
  expect(html).toContain("结果未知");
  expect(html).not.toContain("请求记录成功");
});
it("retains legacy trace without fabricating measured time or detailed JSON", () => {
  const html = renderToStaticMarkup(
    createElement(AgentRunTrace, {
      active: false,
      fallbackTrace: [
        {
          callId: "c",
          tool: "get_run",
          success: false,
          code: "TOOL_RESPONSE_UNCONFIRMED",
        },
      ],
    }),
  );
  expect(html).toContain("调用 1 个工具 · 耗时未记录");
  expect(html).toContain('data-status="unknown"');
  expect(html).toContain("circle-help");
  expect(html).not.toContain("circle-check");
  expect(html).toContain("调用参数");
  expect(html).not.toContain("记录时间");
});
