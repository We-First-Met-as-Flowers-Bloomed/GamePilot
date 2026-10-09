import { expect, it } from "vitest";
import { mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DailyScheduler,
  ScheduleStore,
  type DailyOccurrence,
  type DailyRetryContext,
  type DailyRetryDecision,
  type ScheduleLedger,
} from "../apps/desktop/main/scheduler";

const config = {
  scheduleEnabled: true,
  scheduleTime: "08:00",
  secondScheduleEnabled: true,
  secondScheduleTime: "20:00",
  runOnLaunch: false,
  scope: "lane-a:device-a",
};
const at = (hour: number, minute = 0) => new Date(2026, 9, 5, hour, minute);
const key = "day|lane-a:device-a";

function harness(
  initial: ScheduleLedger = {},
  gate?: (
    occurrence: DailyOccurrence,
    context: DailyRetryContext,
  ) => DailyRetryDecision | Promise<DailyRetryDecision>,
) {
  let ledger = initial;
  let executions = 0;
  const create = () =>
    new DailyScheduler(
      {
        read: async () => ({ ...ledger }),
        save: async (value) => {
          ledger = { ...value };
        },
      },
      () => "day",
      async () => {
        executions++;
        return "failed";
      },
      gate,
    );
  return {
    create,
    get ledger() {
      return ledger;
    },
    get executions() {
      return executions;
    },
  };
}

it("denies a retry by default without host proof of a safe startup failure", async () => {
  const h = harness({ attemptDay: key, attempts: [key], lastStatus: "failed" });
  await h.create().tick(at(9), config, false);
  expect(h.executions).toBe(0);
  expect(h.ledger.attempts).toEqual([key]);
});

it.each([
  undefined,
  "invalid",
  at(7, 59).toISOString(),
  at(9, 1).toISOString(),
])("denies proof with an invalid or unrelated last attempt time: %s", async (lastAttemptAt) => {
  const h = harness(
    { attemptDay: key, attempts: [key], lastStatus: "failed" },
    () => ({ allowed: true, status: "failed", lastAttemptAt }),
  );
  await h.create().tick(at(9), config, false);
  expect(h.executions).toBe(0);
});

it("reconstructs the backoff from durable evidence across scheduler restarts", async () => {
  const h = harness(
    { attemptDay: key, attempts: [key], lastStatus: "failed" },
    () => ({ allowed: true, status: "failed", lastAttemptAt: at(8).toISOString() }),
  );
  await h.create().tick(at(8, 2), config, false);
  expect(h.executions).toBe(0);
  await h.create().tick(at(8, 3), config, false);
  expect(h.executions).toBe(1);
});

it("checks the current occurrence and scope rather than the global ledger status", async () => {
  let checked: { occurrence: DailyOccurrence; context: DailyRetryContext } | undefined;
  const h = harness(
    {
      attemptDay: key + "|secondary",
      attempts: [key, key + "|secondary"],
      lastStatus: "failed",
    },
    (occurrence, context) => {
      checked = { occurrence, context };
      return { allowed: false, status: "unknown", reason: "submitted-unconfirmed" };
    },
  );
  await h.create().tick(at(9), config, false);
  expect(h.executions).toBe(0);
  expect(checked).toEqual({
    occurrence: { slot: "primary", dueAt: at(8) },
    context: { now: at(9), scope: config.scope, key, attempts: 1 },
  });
});

it("uses per-slot confirmed failure even when another slot owns lastStatus", async () => {
  const h = harness(
    {
      attemptDay: key + "|secondary",
      attempts: [key, key + "|secondary"],
      lastStatus: "unknown",
    },
    () => ({ allowed: true, status: "failed", lastAttemptAt: at(8).toISOString() }),
  );
  await h.create().tick(at(9), config, false);
  expect(h.executions).toBe(1);
});

it.each(["unknown", "running", "cancelled", "succeeded"])(
  "denies permissive proof unless the host status is failed: %s",
  async (status) => {
    const h = harness(
      { attemptDay: key, attempts: [key], lastStatus: "failed" },
      () => ({ allowed: true, status, lastAttemptAt: at(8).toISOString() }),
    );
    await h.create().tick(at(9), config, false);
    expect(h.executions).toBe(0);
  },
);

it("counts legacy attemptDay-only evidence toward the hard retry limit", async () => {
  const h = harness(
    { attemptDay: key, lastStatus: "failed" },
    () => ({ allowed: true, status: "failed", lastAttemptAt: at(8).toISOString() }),
  );
  await h.create().tick(at(9), config, false);
  await h.create().tick(at(10), config, false);
  await h.create().tick(at(11), config, false);
  expect(h.executions).toBe(DailyScheduler.MAX_RETRIES);
  expect(h.ledger.attempts).toEqual([key, key, key]);
});

it("reports each slot's blocked retry and legacy running residue without writing", async () => {
  const initial: ScheduleLedger = {
    attemptDay: key,
    lastStatus: "running",
    attempts: [key, key + "|secondary"],
  };
  const h = harness(initial, (occurrence) =>
    occurrence.slot === "primary"
      ? { allowed: false, status: "unknown", reason: "interrupted" }
      : { allowed: true, status: "failed", lastAttemptAt: at(20).toISOString() },
  );
  const state = await h.create().dailyState(at(20, 1), config.scope, config);
  expect(state.primary).toMatchObject({
    lastStatus: "unknown",
    retryAllowed: false,
    retryReason: "interrupted",
    retryNotBefore: null,
  });
  expect(state.secondary).toMatchObject({
    lastStatus: "failed",
    retryAllowed: true,
    retryNotBefore: at(20, 3).toISOString(),
  });
  expect(h.ledger).toEqual(initial);
});

it("records an unclassified execution exception as unknown", async () => {
  let ledger: ScheduleLedger = {};
  const scheduler = new DailyScheduler(
    {
      read: async () => ledger,
      save: async (value) => {
        ledger = value;
      },
    },
    () => "day",
    async () => {
      throw Error("lost after submission");
    },
  );
  await expect(scheduler.tick(at(8), config, false)).rejects.toThrow("lost");
  expect(ledger.lastStatus).toBe("unknown");
});

it("keeps the daily ledger readable by the previous strict schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamepilot-daily-retry-"));
  const file = join(directory, "scheduler.json");
  try {
    const store = new ScheduleStore(file);
    await store.save({ attemptDay: key, lastStatus: "failed" });
    const create = () =>
      new DailyScheduler(
        new ScheduleStore(file),
        () => "day",
        async () => "failed",
        () => ({ allowed: true, status: "failed", lastAttemptAt: at(8).toISOString() }),
      );
    await create().tick(at(9), config, false);
    const value = JSON.parse(await readFile(file, "utf8"));
    expect(Object.keys(value).sort()).toEqual(["attemptDay", "attempts", "lastStatus"]);
    expect(value.attempts).toEqual([key, key]);
    expect(await new ScheduleStore(file).read()).toEqual(value);
    // A rolled-back scheduler stops on includes(key), retaining the no-replay guard.
    expect(value.attempts.includes(key)).toBe(true);
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});
