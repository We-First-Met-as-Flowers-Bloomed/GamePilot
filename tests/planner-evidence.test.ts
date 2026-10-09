import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlannerEvidence } from "../apps/desktop/renderer/components/PlannerEvidence";

it.each(["bounded-ledger", "not-read"] as const)(
  "shows the host's unknown boundary for %s",
  (scope) => {
    const html = renderToStaticMarkup(
      createElement(PlannerEvidence, {
        assessment: {
          scope,
          dailyCompletion: "unknown",
          missingRecordMeans: "unknown",
          canInferNotRun: false,
          canAuthorizeReplay: false,
        },
      }),
    );
    expect(html).toContain("整套日常完成情况：待核对");
    expect(html).toContain("缺失记录不代表未执行");
    expect(html).toContain("不能据此自动补跑");
  },
);
