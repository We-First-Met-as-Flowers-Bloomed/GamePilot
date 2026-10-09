import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import ResultSummary, {
  DailyResultSummary,
} from "../apps/desktop/renderer/components/ResultSummary";
import type { TaskResultSummary } from "../packages/protocol/task-result-summary";

const summary = (): TaskResultSummary => ({
  version: 1,
  mode: "live",
  counts: {
    completed: 2,
    skipped: 1,
    failed: 1,
    unknown: 1,
    notRun: 1,
    running: 0,
    pending: 0,
    cancelled: 0,
  },
  items: [
    { id: "fight", label: "作战", value: "未记录", note: "旧版未采集次数" },
    {
      id: "credit",
      label: "信用购物",
      value: "0 次购买确认",
      note: "仅此请求",
    },
  ],
  issues: [{ skillId: "fight", message: "结果未知，请核对现场" }],
  scopeNote: "已跳过与领取完成分别记录。",
});
const render = (value?: TaskResultSummary) =>
  renderToStaticMarkup(createElement(ResultSummary, { summary: value }));

it("distinguishes recorded zero from missing metrics and retains confirmation limits", () => {
  const html = render(summary());
  expect(html).toContain("0 次购买确认");
  expect(html).toContain("未记录");
  expect(html).toContain("旧版未采集次数");
  expect(html).toContain("仅此请求");
  expect(html).not.toContain("0 次作战");
});

it("keeps failed, unknown, skipped and not-run states visible without claiming total success", () => {
  const html = render(summary());
  for (const status of ["completed", "skipped", "failed", "unknown", "notRun"])
    expect(html).toContain(`data-state="${status}"`);
  expect(html).toContain("结果未知，请核对现场");
  expect(html).toContain("已跳过与领取完成分别记录。");
  expect(html).not.toContain("全部完成");
});

it("shows absent summaries and rehearsal without inventing real game achievements", () => {
  expect(render()).toContain("未记录结果汇总");
  expect(render()).not.toContain("result-summary-counts");
  const value = summary();
  value.mode = "rehearsal";
  value.items = [];
  expect(render(value)).toContain("演练记录 · 未操作游戏");
  expect(render(value)).toContain("没有已记录的数量指标");
});

it("escapes values and failures originating in saved records", () => {
  const value = summary();
  value.items[0].value = "<script>alert(1)</script>";
  value.issues[0].message = '<img src=x onerror="run()">';
  const html = render(value);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});

it("does not substitute a single task when no daily receipt was selected", () => {
  const html = renderToStaticMarkup(
    createElement(DailyResultSummary, { laneId: "a" }),
  );
  expect(html).toContain("单项任务在最近任务中单独查看");
  expect(html).not.toContain("刷新结果");
  expect(html).not.toContain("result-summary-counts");
});
