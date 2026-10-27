import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const directory = join(process.cwd(), "apps/desktop/renderer");
const theme = readFileSync(join(directory, "theme.css"), "utf8");
function luminance(hex: string) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function ratio(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
describe("renderer semantic theme", () => {
  it("keeps text and status pairs at AA contrast in both palettes", () => {
    for (const block of theme.matchAll(
      /(?:^:root\s*\{|:root\[data-theme="dark"\]\s*\{)([^}]+)\}/gm,
    )) {
      const colors = Object.fromEntries(
        [...block[1].matchAll(/--([\w-]+):\s*(#[\da-f]{6})\b/gi)].map((m) => [
          m[1],
          m[2],
        ]),
      );
      for (const fg of ["text", "text-secondary", "muted", "subtle"]) {
        for (const bg of [
          "canvas",
          "surface",
          "raised",
          "sidebar",
          "surface-muted",
        ])
          expect(
            ratio(colors[fg], colors[bg]),
            `${fg}/${bg}`,
          ).toBeGreaterThanOrEqual(4.5);
      }
      for (const state of ["success", "warning", "danger", "info"])
        expect(
          ratio(colors[state], colors[`${state}-light`]),
          state,
        ).toBeGreaterThanOrEqual(4.5);
      expect(ratio(colors["on-accent"], colors.accent)).toBeGreaterThanOrEqual(
        4.5,
      );
      for (const background of ["surface", "canvas", "raised", "sidebar"])
        expect(
          ratio(colors["control-border"], colors[background]),
        ).toBeGreaterThanOrEqual(3);
    }
  });
  it("has no component hex colours or fonts below 12px", () => {
    function scan(path: string) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) {
          scan(file);
          continue;
        }
        if (!entry.name.endsWith(".css") || entry.name === "theme.css")
          continue;
        const css = readFileSync(file, "utf8");
        expect(css, file).not.toMatch(/#[\da-f]{3,8}\b/i);
        expect(css, file).not.toMatch(/font:\s*(?:[0-9]|1[01])px/);
        expect(css, file).not.toMatch(
          /font-size:\s*(?:[0-9](?:\.\d+)?|1[01](?:\.\d+)?)px/,
        );
      }
    }
    scan(directory);
  });
});
