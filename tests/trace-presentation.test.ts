import { expect, it } from "vitest";
import type { AgentEvent } from "../packages/protocol/agent-events";
import {
  groupTraceEvents,
  traceSummary,
  traceStatusLabel,
  toolLabel,
} from "../apps/desktop/renderer/trace-presentation";

const event = (
  seq: number,
  requestId = "r",
  extra: Partial<AgentEvent> = {},
): AgentEvent => ({
  seq,
  requestId,
  callId: "c",
  kind: "tool-result",
  status: "succeeded",
  text: "公开摘要",
  at: "2026-10-12T00:00:00Z",
  ...extra,
});
it("deduplicates replay receipts and groups only the same request and call", () => {
  const values = [
    event(1, "r", { kind: "tool-requested", status: "running" }),
    event(2),
    event(2),
    event(3, "other"),
  ];
  expect(
    groupTraceEvents(values).map((group) =>
      group.events.map((item) => item.seq),
    ),
  ).toEqual([[1, 2], [3]]);
});
it("keeps distinct failed and unknown calls visible", () => {
  const groups = groupTraceEvents([
    event(1, "r", { callId: "a", status: "failed" }),
    event(2, "r", { callId: "b", status: "unknown" }),
  ]);
  expect(groups).toHaveLength(2);
  expect(traceStatusLabel(groups[1].events[0].status)).toBe("未确认");
});
it("sums only supplied tool measurements and never journal clocks", () => {
  expect(
    traceSummary([
      event(1, "r", { details: { durationMs: 1200 } }),
      event(2, "r", { callId: "d", details: { durationMs: 5000 } }),
    ]),
  ).toBe("调用 2 个工具 · 工具耗时合计 6.2 秒");
  expect(
    traceSummary([
      event(1),
      event(2, "r", { at: "2026-10-12T01:00:00Z", kind: "tool-started" }),
    ]),
  ).toBe("调用 1 个工具 · 耗时未记录");
  expect(
    traceSummary([event(1, "r", { details: { durationMs: -1 } })]),
  ).toContain("耗时未记录");
});
it("labels registered query and runtime tools without inventing unknown names", () => {
  expect(toolLabel("get_run")).toBe("查询任务记录");
  expect(toolLabel("run_plan")).toBe("提交计划执行");
  expect(toolLabel("unregistered_tool")).toBe("unregistered_tool");
});
