import { expect, it } from "vitest";
import { dailyMissedNotices } from "../apps/desktop/main/daily-missed-notice";

const state = (slot: "primary" | "secondary", status = "unknown") => ({
  slot,
  key: slot,
  attempted: true,
  completed: false,
  attempts: 1,
  retriesRemaining: 2,
  lastStatus: status,
  retryAllowed: false,
  retryNotBefore: null,
  retryReason: "需要核对原任务",
});
const daily = () => ({
  day: "2026-10-06",
  scheduleTime: "08:00",
  secondScheduleTime: "20:00",
  lastStatus: "succeeded",
  primary: state("primary"),
  secondary: state("secondary", "succeeded"),
});
const config = { scheduleEnabled: true, secondScheduleEnabled: true };
it("reports each unfinished period using its own evidence rather than global status", () => {
  const notices = dailyMissedNotices("账号一", daily(), config, false);
  expect(notices).toHaveLength(2);
  expect(notices[0]).toMatchObject({ slot: "primary", day: "2026-10-06" });
  expect(notices[0].message).toContain("unknown");
  expect(notices[1].message).toContain("20:00");
});
it("shows interrupted running records once the physical lane is no longer busy", () => {
  const d = daily();
  d.primary.lastStatus = "running";
  d.secondary.completed = true;
  expect(dailyMissedNotices("账号一", d, config, true)).toEqual([]);
  expect(dailyMissedNotices("账号一", d, config, false)[0].message).toContain(
    "核对",
  );
});
it("keeps safe bounded retries quiet during backoff but reports exhausted or denied work", () => {
  const d = daily();
  d.primary.retryAllowed = true;
  d.secondary.completed = true;
  expect(dailyMissedNotices("账号一", d, config, false)).toEqual([]);
  d.primary.retryAllowed = false;
  expect(dailyMissedNotices("账号一", d, config, false)).toHaveLength(1);
});
it("does not report disabled, unattempted or completed periods", () => {
  const d = daily();
  d.primary.completed = true;
  d.secondary.attempted = false;
  expect(dailyMissedNotices("账号一", d, config, false)).toEqual([]);
  expect(
    dailyMissedNotices(
      "账号一",
      daily(),
      { scheduleEnabled: false, secondScheduleEnabled: false },
      false,
    ),
  ).toEqual([]);
});
