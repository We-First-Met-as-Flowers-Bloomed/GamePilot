import type { Frame } from "../../packages/runtime/device";
import { isTrainingPage, isFosterActive, findText } from "./policy";

export function fosterRemainingSeconds(frame: Frame): number | null {
  if (
    !(isTrainingPage(frame) || isFosterActive(frame)) ||
    !findText(frame, /我的寄养|好友寄养/, [1250, 0, 670, 300])
  )
    return null;
  const timers = frame.texts.filter(
    (hit) =>
      hit.score >= 0.85 &&
      hit.box[0] >= 1450 &&
      hit.box[1] < 300 &&
      /^\d{2}[:：]\d{2}[:：]\d{2}$/.test(hit.text.replace(/\s/g, "")),
  );
  if (timers.length !== 1) return null;
  const [hours, minutes, seconds] = timers[0].text
    .replace(/\s/g, "")
    .split(/[:：]/)
    .map(Number);
  const total = hours * 3600 + minutes * 60 + seconds;
  return minutes < 60 && seconds < 60 && total <= 21600 ? total : null;
}

export function fosterScheduleResult(
  outcome: "active" | "started" | "unavailable",
  now: Date,
  remaining: number | null,
) {
  const valid =
    remaining !== null &&
    Number.isInteger(remaining) &&
    remaining >= 0 &&
    remaining <= 21600;
  const seconds = valid
    ? Math.max(60, remaining)
    : outcome === "started"
      ? 21600
      : 1800;
  return {
    outcome,
    observedAt: now.toISOString(),
    nextRunAt: new Date(now.getTime() + seconds * 1000).toISOString(),
  };
}
