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

it("allows sign-in rewards supported by the pinned upgraded engine and honors the busy lock", () => {
  expect(option(false)).not.toContain('disabled=""');
  expect(option(false)).not.toContain("当前不支持");
  expect(option(true)).not.toContain('disabled=""');
  expect(option(true)).toContain('aria-pressed="true"');
  expect(option(true)).not.toContain("请先关闭");
  expect(option(true, "signInEvent", true)).toContain('disabled=""');
  expect(option(false, "freeRecruit")).not.toContain('disabled=""');
});
