export type ThemePreference = "system" | "light" | "dark";
export const themeStorageKey = "gamepilot.appearance";
export const themeChangeEvent = "gamepilot-theme-change";

export function themePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function readThemePreference(
  storage: Pick<Storage, "getItem">,
): ThemePreference {
  try {
    return themePreference(storage.getItem(themeStorageKey));
  } catch {
    return "system";
  }
}

export function applyTheme(preference: ThemePreference, target: HTMLElement) {
  if (preference === "system") delete target.dataset.theme;
  else target.dataset.theme = preference;
  target.dispatchEvent?.(new Event(themeChangeEvent));
}

export function saveThemePreference(
  preference: ThemePreference,
  storage: Pick<Storage, "setItem">,
): boolean {
  try {
    storage.setItem(themeStorageKey, preference);
    return true;
  } catch {
    return false;
  }
}

export function currentThemePreference(target: HTMLElement): ThemePreference {
  return themePreference(target.dataset.theme);
}

export function initializeAppearance() {
  let preference: ThemePreference = "system";
  try {
    preference = readThemePreference(window.localStorage);
  } catch {
    /* unavailable storage */
  }
  applyTheme(preference, document.documentElement);
}
