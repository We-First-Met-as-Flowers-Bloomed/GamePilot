import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import SessionTaskWorkspace from "../apps/desktop/renderer/components/SessionTaskWorkspace";
import type { GoalController } from "../apps/desktop/renderer/hooks/useGoals";
import type { GoalRun } from "../packages/protocol/agent-goal";

function render(
  revision: number,
  error = "",
  available = true,
  goals: GoalRun[] = [],
) {
  const controller: GoalController = {
    state: { revision, goals },
    error,
    available,
    pending: [],
    cancel: async () => true,
  };
  return renderToStaticMarkup(
    createElement(SessionTaskWorkspace, {
      sessionId: "session-a",
      controller,
      onOpenExecution: () => {},
      onResume: () => {},
    }),
  );
}
it("does not call pending or unavailable host state empty", () => {
  for (const available of [true, false]) {
    const html = render(-1, "", available);
    expect(html).toContain('data-task-loading="true"');
    expect(html).not.toContain("还没有交办任务");
    expect(html).not.toContain("本会话任务汇总");
    expect(html).toContain(available ? "读取中" : "尚未核实");
  }
});
it("does not display zero task counts or empty conclusion after the initial read fails", () => {
  const html = render(-1, "无法读取目标状态");
  expect(html).toContain('role="alert"');
  expect(html).toContain("尚未核实");
  expect(html).not.toContain("本会话任务汇总");
  expect(html).not.toContain("还没有交办任务");
});
it("renders the empty illustration only after a confirmed empty host snapshot", () => {
  const html = render(0);
  expect(html).toContain('data-task-empty="true"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain("读取中");
});
