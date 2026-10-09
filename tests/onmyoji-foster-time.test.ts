import { describe, it, expect } from "vitest";
import {
  fosterRemainingSeconds,
  fosterScheduleResult,
} from "../games/onmyoji/foster-time";
import type { Frame } from "../packages/runtime/device";
const frame = (text: string, x = 1660, score = 0.99): Frame => ({
  width: 1920,
  height: 1080,
  texts: [
    { text: "式神育成", box: [100, 35, 150, 40], score: 1 },
    { text: "我的寄养", box: [1550, 25, 150, 40], score: 1 },
    { text, box: [x, 100, 130, 40], score },
  ],
});
describe("foster countdown calibration", () => {
  it("only reads a confident unique timer in the active foster region", () => {
    expect(fosterRemainingSeconds(frame("05:51:52"))).toBe(21112);
    expect(fosterRemainingSeconds(frame("00：04：09"))).toBe(249);
    for (const x of [
      frame("06:01:00"),
      frame("01:60:00"),
      frame("01:05:00", 100),
      frame("01:05:00", 1660, 0.6),
      frame("9:00"),
    ])
      expect(fosterRemainingSeconds(x)).toBeNull();
    const doubled = frame("01:00:00");
    doubled.texts.push({ ...doubled.texts[2], box: [1660, 170, 130, 40] });
    expect(fosterRemainingSeconds(doubled)).toBeNull();
  });
  it("calibrates an active placement, not a fresh six-hour period", () => {
    const now = new Date("2026-09-21T08:00:00Z");
    expect(fosterScheduleResult("active", now, 90).nextRunAt).toBe(
      "2026-09-21T08:01:30.000Z",
    );
  });
  it("uses a short recheck for unreadable active/unavailable states and six hours only for new placements", () => {
    const now = new Date("2026-09-21T08:00:00Z");
    expect(fosterScheduleResult("active", now, null).nextRunAt).toBe(
      "2026-09-21T08:30:00.000Z",
    );
    expect(fosterScheduleResult("unavailable", now, null).nextRunAt).toBe(
      "2026-09-21T08:30:00.000Z",
    );
    expect(fosterScheduleResult("started", now, null).nextRunAt).toBe(
      "2026-09-21T14:00:00.000Z",
    );
    expect(fosterScheduleResult("active", now, 0).nextRunAt).toBe(
      "2026-09-21T08:01:00.000Z",
    );
  });
});
import { ownTrainingEntry } from "../games/onmyoji/policy";
it("locates the central training sign using both realm labels on an alternate skin", () => {
  const f: Frame = {
    width: 1920,
    height: 1080,
    texts: [
      { text: "结界防守", box: [498, 593, 34, 121], score: 1 },
      { text: "结界卡", box: [1314, 593, 34, 121], score: 1 },
    ],
  };
  expect(ownTrainingEntry(f)).toEqual([923, 653.5]);
  expect(ownTrainingEntry({ ...f, texts: f.texts.slice(1) })).toBeNull();
});
