import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DailyScheduler } from "../apps/desktop/main/scheduler";
import {
  createChannelDailyScheduleStore,
  inheritDailyAttempts,
  inheritFosterTiming,
} from "../apps/desktop/main/channel-schedule-store";

it("inherits the original daily attempt without inventing two game completions", () => {
  const previous = {
    attemptDay: "2026-10-25|old",
    completedDay: "2026-10-25|old",
    completions: ["2026-10-25|old"],
    lastStatus: "succeeded",
  };
  const copy = structuredClone(previous);
  const result = inheritDailyAttempts({}, previous, "old", "new", true);
  expect(result.attempts).toEqual(["2026-10-25|new"]);
  expect(result.completedDay).toBeUndefined();
  expect(result.completions).toBeUndefined();
  expect(result.lastStatus).toBe("unknown");
  expect(previous).toEqual(copy);
});

it("retains retry counts, ignores foreign scopes and never duplicates inherited attempts", () => {
  const previous = {
    attempts: [
      "2026-10-25|old",
      "2026-10-25|old",
      "2026-10-25|foreign",
      "2026-10-25|old|secondary",
    ],
  };
  const first = inheritDailyAttempts({}, previous, "old", "new", false);
  expect(first.attempts).toEqual(["2026-10-25|new", "2026-10-25|new"]);
  expect(inheritDailyAttempts(first, previous, "old", "new", false)).toEqual(
    first,
  );
});

it("keeps a new channel's own completion and secondary attempts", () => {
  const current = {
    completedDay: "2026-10-25|new",
    lastStatus: "succeeded",
    attempts: ["2026-10-25|new"],
  };
  const result = inheritDailyAttempts(
    current,
    { attemptDay: "2026-10-25|old|secondary" },
    "old",
    "new",
    true,
  );
  expect(result.completedDay).toBe(current.completedDay);
  expect(result.lastStatus).toBe("succeeded");
  expect(result.attempts).toContain("2026-10-25|new|secondary");
});

it("keeps the newest retry count when a full predecessor ledger is merged repeatedly", () => {
  const previous = {
    attempts: Array.from(
      { length: 100 },
      (_, i) =>
        new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10) + "|old",
    ),
  };
  const key = "2026-10-25|new";
  let current = { attemptDay: key, attempts: [key, key, key] };
  const first = inheritDailyAttempts(current, previous, "old", "new", true);
  expect(first.attempts?.filter((value) => value === key)).toHaveLength(3);
  for (let count = 0; count < 40; count++) {
    const next = inheritDailyAttempts(current, previous, "old", "new", true);
    expect(next).toEqual(first);
    current = next as typeof current;
  }
});

it("keeps the old foster cooldown and unresolved state only on its original scope", () => {
  const previous = {
    scope: "old",
    lastStatus: "unknown",
    blockedAt: "2026-10-25T01:00:00Z",
    nextRunAt: "2026-10-25T07:00:00Z",
  };
  expect(inheritFosterTiming({}, previous, "old", "new")).toEqual({
    ...previous,
    scope: "new",
  });
  expect(inheritFosterTiming({}, previous, "other", "new")).toEqual({});
  const own = { scope: "new", lastStatus: "cancelled" };
  expect(inheritFosterTiming(own, previous, "old", "new")).toEqual(own);
});

it("does not automatically rerun an inherited completed period as a new channel", async () => {
  const store = {
    read: async () =>
      inheritDailyAttempts(
        {},
        { completedDay: "2026-10-25|old" },
        "old",
        "new",
        true,
      ),
    save: async () => {
      throw Error("must not claim another attempt");
    },
  };
  let starts = 0;
  const scheduler = new DailyScheduler(
    store,
    () => "2026-10-25",
    async () => {
      starts++;
      return "succeeded";
    },
  );
  await scheduler.tick(
    new Date("2026-10-25T12:00:00+08:00"),
    {
      scheduleEnabled: true,
      scheduleTime: "08:00",
      runOnLaunch: false,
      scope: "new",
    },
    false,
  );
  expect(starts).toBe(0);
});

it("writes only the new channel ledger and keeps the original ledger bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamepilot-channel-ledger-"));
  try {
    const originalPath = join(
      directory,
      "lanes",
      "old",
      "daily-scheduler.json",
    );
    await mkdir(join(directory, "lanes", "old"), { recursive: true });
    const original = JSON.stringify({ completedDay: "2026-10-25|source" });
    await writeFile(originalPath, original);
    const store = createChannelDailyScheduleStore(directory, {
      id: "new",
      name: "test",
      managerPath: "",
      instance: 2,
      enabled: true,
      closeEmulatorAfterSuccess: false,
      arknights: { enabled: false, profileId: "default" },
      onmyoji: { enabled: true },
      legacyBinding: { laneId: "old", instance: 2, scope: "source" },
    });
    const value = await store.read();
    await store.save(value);
    expect(await readFile(originalPath, "utf8")).toBe(original);
    expect(
      JSON.parse(
        await readFile(
          join(directory, "channels", "new", "daily-scheduler.json"),
          "utf8",
        ),
      ).completedDay,
    ).toBeUndefined();
    expect(await store.read()).toEqual(value);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
