import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ExecutionNotice from "../apps/desktop/renderer/components/ExecutionNotice";
import type { ExecutionRecord } from "../packages/protocol/execution";

it("shows interrupted live requests without claiming completion or recovery", () => {
  const record: ExecutionRecord = {
    version: 1,
    id: "request",
    fingerprint: "hash",
    source: "daily",
    resources: ["device"],
    snapshot: { lane: { name: "MuMu 0" } },
    status: "unknown",
    startedAt: "2026-09-25T00:00:00Z",
    message: "应用退出，未自动重放",
  };
  const html = renderToStaticMarkup(
    createElement(ExecutionNotice, { records: [record] }),
  );
  expect(html).toContain("1 次执行结果待核对");
  expect(html).toContain("MuMu 0");
  expect(html).toContain("未自动重放");
  expect(html).toContain("核对任务记录");
  expect(html).toContain("读取当前现场");
  expect(html).toContain("查看失败证据");
  const reviewed = renderToStaticMarkup(
    createElement(ExecutionNotice, {
      records: [
        {
          ...record,
          resolution: {
            action: "abandoned",
            at: record.startedAt,
            note: "用户结束此轮",
          },
        },
      ],
    }),
  );
  expect(reviewed).toContain("已处理 1 次中断记录");
  expect(reviewed).toContain("未标记任务成功");
  expect(reviewed).not.toContain("读取当前现场");
  expect(
    renderToStaticMarkup(
      createElement(ExecutionNotice, {
        records: [{ ...record, status: "succeeded" }],
      }),
    ),
  ).toBe("");
  expect(
    renderToStaticMarkup(
      createElement(ExecutionNotice, {
        records: [
          {
            ...record,
            source: "single",
            snapshot: { plan: { mode: "rehearsal" } },
          },
        ],
      }),
    ),
  ).toBe("");
});
