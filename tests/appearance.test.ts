import { describe, expect, it } from "vitest";
import {
  applyTheme,
  currentThemePreference,
  readThemePreference,
  saveThemePreference,
  themePreference,
  themeStorageKey,
  themeChangeEvent,
} from "../apps/desktop/renderer/appearance";

describe("appearance preferences", () => {
  it("notifies mounted renderer controls of the applied theme without rereading storage", () => {
    const target = Object.assign(new EventTarget(), {
      dataset: {},
    }) as unknown as HTMLElement;
    const values: string[] = [];
    target.addEventListener(themeChangeEvent, () =>
      values.push(currentThemePreference(target)),
    );
    applyTheme("dark", target);
    applyTheme("system", target);
    expect(values).toEqual(["dark", "system"]);
  });
  it("keeps the applied preference on settings re-entry after a failed save", () => {
    const target = { dataset: { theme: "light" } } as unknown as HTMLElement;
    const storage = {
      getItem: () => "light",
      setItem: () => {
        throw new Error("quota");
      },
    };
    applyTheme("dark", target);
    expect(saveThemePreference("dark", storage)).toBe(false);
    expect(currentThemePreference(target)).toBe("dark");
    expect(readThemePreference(storage)).toBe("light");
  });
  it("accepts only supported choices and defaults stale values to system", () => {
    expect([null, "auto", {}, "DARK"].map(themePreference)).toEqual([
      "system",
      "system",
      "system",
      "system",
    ]);
    expect(themePreference("dark")).toBe("dark");
    expect(themePreference("light")).toBe("light");
  });
  it("reads and stores only the dedicated local preference", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    expect(readThemePreference(storage)).toBe("system");
    expect(saveThemePreference("dark", storage)).toBe(true);
    expect(values.get(themeStorageKey)).toBe("dark");
    expect(readThemePreference(storage)).toBe("dark");
  });
  it("keeps startup usable when browser storage is blocked", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readThemePreference(storage)).toBe("system");
    expect(saveThemePreference("light", storage)).toBe(false);
  });
  it("removes explicit theme when returning to system so CSS media changes remain live", () => {
    const target = { dataset: {} } as HTMLElement;
    applyTheme("dark", target);
    expect(target.dataset.theme).toBe("dark");
    applyTheme("light", target);
    expect(target.dataset.theme).toBe("light");
    applyTheme("system", target);
    expect(target.dataset.theme).toBeUndefined();
  });
});
