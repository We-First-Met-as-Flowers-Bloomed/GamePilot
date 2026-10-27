import { expect, it } from "vitest";
import {
  boundWorkspaceWidth,
  groupWorkspaceSessions,
  nextSessionIndex,
  readWorkspacePreferences,
  saveWorkspacePreferences,
  sessionAlias,
} from "../apps/desktop/renderer/workspace-layout-state";

it("bounds stored widths and rejects corrupt values", () => {
  expect(boundWorkspaceWidth(40)).toBe(280);
  expect(boundWorkspaceWidth(900)).toBe(480);
  expect(boundWorkspaceWidth(NaN)).toBe(340);
  expect(
    readWorkspacePreferences({ getItem: () => '{"width":"900","aliases":[]}' })
      .width,
  ).toBe(340);
});
it("storage errors preserve usable default layout and report unsuccessful persistence", () => {
  expect(
    readWorkspacePreferences({
      getItem: () => {
        throw Error();
      },
    }),
  ).toEqual({ width: 340, aliases: {} });
  expect(
    saveWorkspacePreferences(
      { width: 350, aliases: {} },
      {
        setItem: () => {
          throw Error();
        },
      },
    ),
  ).toBe(false);
});
it("groups by local calendar day, including month boundaries, without mutating sessions", () => {
  const sessions = [
    { id: "older", updatedAt: new Date(2026, 8, 29, 12).toISOString() },
    { id: "today", updatedAt: new Date(2026, 9, 1, 0, 1).toISOString() },
    { id: "yesterday", updatedAt: new Date(2026, 8, 30, 23, 59).toISOString() },
  ];
  expect(
    groupWorkspaceSessions(sessions, new Date(2026, 9, 1, 12)).map((g) => [
      g.label,
      g.sessions.map((s) => s.id),
    ]),
  ).toEqual([
    ["今天", ["today"]],
    ["昨天", ["yesterday"]],
    ["更早", ["older"]],
  ]);
  expect(sessions[0].id).toBe("older");
});
it("keyboard session navigation stays in bounds", () => {
  expect(nextSessionIndex(0, 3, "ArrowUp")).toBe(0);
  expect(nextSessionIndex(1, 3, "ArrowDown")).toBe(2);
  expect(nextSessionIndex(2, 3, "Home")).toBe(0);
  expect(nextSessionIndex(0, 3, "End")).toBe(2);
});
it("aliases use exact session IDs, trim and limit text without changing host names", () => {
  expect(sessionAlias(" a ")).toBe("a");
  expect(sessionAlias("x".repeat(130))).toHaveLength(120);
  const preferences = readWorkspacePreferences({
    getItem: () =>
      '{"width":350,"aliases":{"__proto__":"local","ok":" display ","bad":23}}',
  });
  expect(Object.getPrototypeOf(preferences.aliases)).toBeNull();
  expect(preferences.aliases["__proto__"]).toBe("local");
  expect(preferences.aliases.ok).toBe("display");
  expect(preferences.aliases.bad).toBeUndefined();
});
