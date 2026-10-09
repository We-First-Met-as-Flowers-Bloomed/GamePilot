import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ArknightsRewardOption } from "../apps/desktop/renderer/components/ArknightsSettings";

function option(
  value: boolean,
  configKey: "signInEvent" | "freeRecruit" = "signInEvent",
  disabled = false,
) {
  return renderToStaticMarkup(
    createElement(ArknightsRewardOption, {
      configKey,
      value,
      disabled,
      label: "奖励开关",
      onChange: () => {},
    }),
  );
}

it("disables new unsupported rewards but lets old selected rewards be turned off", () => {
  expect(option(false)).toContain('disabled=""');
  expect(option(false)).toContain("当前不支持");
  expect(option(true)).not.toContain('disabled=""');
  expect(option(true)).toContain('aria-pressed="true"');
  expect(option(true)).toContain("请先关闭");
  expect(option(true, "signInEvent", true)).toContain('disabled=""');
  expect(option(false, "freeRecruit")).not.toContain('disabled=""');
});
