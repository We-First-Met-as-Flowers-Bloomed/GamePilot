// MaaCore may finish Fight successfully after its OfflineConfirm stop node.
// That is not evidence that the configured combat work completed.
export function isArknightsDisconnect(message: string): boolean {
  const match = /^MAA 20001: (.+)$/s.exec(message);
  if (!match) return false;
  try {
    const task = JSON.parse(match[1]).details?.task;
    return typeof task === "string" && /(?:^|@)OfflineConfirm$/.test(task);
  } catch {
    return false;
  }
}

export const arknightsGameDay = (now: Date) =>
  new Date(now.getTime() + 4 * 3600000).toISOString().slice(0, 10);
