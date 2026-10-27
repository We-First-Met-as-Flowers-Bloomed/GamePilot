import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import CommandPalette, {
  paletteFocusTarget,
} from "../apps/desktop/renderer/components/CommandPalette";

it("restores visible origin focus and falls back to the new page when the mounted origin is hidden", () => {
  const element = (visible: boolean, hidden = false, connected = true) =>
    ({
      isConnected: connected,
      closest: () => (hidden ? {} : null),
      getClientRects: () => (visible ? [{}] : []),
    }) as unknown as HTMLElement;
  const origin = element(true);
  const heading = element(true);
  expect(paletteFocusTarget(origin, [heading])).toBe(origin);
  expect(paletteFocusTarget(element(true, true), [heading])).toBe(heading);
  expect(paletteFocusTarget(element(false), [heading])).toBe(heading);
  expect(paletteFocusTarget(element(true, false, false), [heading])).toBe(
    heading,
  );
  expect(paletteFocusTarget(null, [element(false), heading])).toBe(heading);
});

it("labels the modal search and its navigation list for keyboard users", () => {
  const html = renderToStaticMarkup(
    createElement(CommandPalette, {
      open: false,
      onClose: () => {},
      commands: [
        {
          id: "daily",
          label: "打开每日计划",
          keywords: "daily",
          run: () => {},
        },
        { id: "new-chat", label: "新对话", disabled: true, run: () => {} },
      ],
    }),
  );
  expect(html).toContain('aria-modal="true"');
  expect(html).toContain('aria-labelledby="command-palette-title"');
  expect(html).toContain('aria-label="搜索命令"');
  expect(html).toContain('role="listbox"');
  expect(html).toContain('data-command-id="daily"');
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("仅切换界面与本机外观");
});
