export const workspacePreferenceKey = "gamepilot.workspace-layout.v1";
export type WorkspaceTab = "tasks" | "trajectory" | "device";
export interface WorkspacePreferences {
  width: number;
  aliases: Record<string, string>;
}
export function boundWorkspaceWidth(value: number) {
  return Number.isFinite(value)
    ? Math.round(Math.max(280, Math.min(480, value)))
    : 340;
}
export function sessionAlias(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}
export function readWorkspacePreferences(
  storage: Pick<Storage, "getItem">,
): WorkspacePreferences {
  const fallback = { width: 340, aliases: {} };
  try {
    const value = JSON.parse(storage.getItem(workspacePreferenceKey) ?? "null");
    if (!value || typeof value !== "object") return fallback;
    const aliases: Record<string, string> = Object.create(null);
    if (
      value.aliases &&
      typeof value.aliases === "object" &&
      !Array.isArray(value.aliases)
    ) {
      for (const [id, raw] of Object.entries(value.aliases).slice(0, 1000)) {
        const alias = sessionAlias(raw);
        if (id.length <= 200 && alias) aliases[id] = alias;
      }
    }
    return {
      width:
        typeof value.width === "number"
          ? boundWorkspaceWidth(value.width)
          : 340,
      aliases,
    };
  } catch {
    return fallback;
  }
}
export function saveWorkspacePreferences(
  value: WorkspacePreferences,
  storage: Pick<Storage, "setItem">,
) {
  try {
    storage.setItem(workspacePreferenceKey, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export function groupWorkspaceSessions<T extends { updatedAt: string }>(
  sessions: T[],
  now = new Date(),
) {
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const yesterday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - 1,
  ).getTime();
  const groups = ["今天", "昨天", "更早"].map((label) => ({
    label,
    sessions: [] as T[],
  }));
  for (const session of [...sessions].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  )) {
    const time = Date.parse(session.updatedAt);
    groups[time >= today ? 0 : time >= yesterday ? 1 : 2].sessions.push(
      session,
    );
  }
  return groups.filter((group) => group.sessions.length);
}
export function nextSessionIndex(index: number, length: number, key: string) {
  return key === "Home"
    ? 0
    : key === "End"
      ? Math.max(0, length - 1)
      : Math.max(0, Math.min(length - 1, index + (key === "ArrowUp" ? -1 : 1)));
}
