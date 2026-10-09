import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DailyScheduler,
  IntervalScheduler,
  IntervalScheduleStore,
  type IntervalLedger,
  type ScheduleLedger,
} from "../apps/desktop/main/scheduler";
import { arknightsGameDay } from "../games/arknights/result-policy";

it("loads old ledgers and round-trips calibrated deadlines on disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamepilot-foster-"));
  const file = join(directory, "foster-scheduler.json");
  try {
    const old = {
      scope: "lane-a",
      lastCompletedAt: "2026-09-21T00:00:00.000Z",
      lastStatus: "succeeded",
    };
    await writeFile(file, JSON.stringify(old));
    expect(await new IntervalScheduleStore(file).read()).toEqual(old);
    const store = new IntervalScheduleStore(file);
    await new IntervalScheduler(
      store,
      6 * 60 * 60_000,
      30 * 60_000,
      async () => "succeeded",
    ).calibrate(
      {
        observedAt: old.lastCompletedAt,
        nextRunAt: "2026-09-21T02:00:00.000Z",
      },
      old.scope,
      new Date(old.lastCompletedAt),
    );
    expect((await new IntervalScheduleStore(file).read()).nextRunAt).toBe(
      "2026-09-21T02:00:00.000Z",
    );
    await writeFile(file, JSON.stringify({ ...old, nextRunAt: "invalid" }));
    await expect(new IntervalScheduleStore(file).read()).rejects.toThrow(
      "损坏",
    );
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});
it("persists the unknown gate on disk and does not replay it after a process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamepilot-foster-block-"));
  const file = join(directory, "foster-scheduler.json");
  let calls = 0;
  const create = () =>
    new IntervalScheduler(
      new IntervalScheduleStore(file),
      6 * 60 * 60_000,
      30 * 60_000,
      async () => {
        calls++;
        throw Error("worker lost");
      },
    );
  try {
    await expect(create().tick(new Date(), true, false, "a")).rejects.toThrow(
      "worker lost",
    );
    const saved = await new IntervalScheduleStore(file).read();
    expect(saved.lastStatus).toBe("unknown");
    expect(saved.blockedAt).toBeTruthy();
    await create().tick(new Date(Date.now() + 24 * 3600000), true, false, "a");
    expect(calls).toBe(1);
    await writeFile(file, JSON.stringify({ ...saved, blockedAt: "invalid" }));
    await expect(new IntervalScheduleStore(file).read()).rejects.toThrow(
      "损坏",
    );
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});

it("keeps the confirmed no-slot recheck enabled while ordinary failed work stays blocked", async () => {
  let calls = 0;
  let scheduler!: IntervalScheduler;
  const h = intervalHarness(async () => {
    calls++;
    if (calls === 1)
      await scheduler.calibrate(
        {
          outcome: "unavailable",
          observedAt: observed.toISOString(),
          nextRunAt: new Date(observed.getTime() + 30 * 60000).toISOString(),
        },
        "a",
        observed,
      );
    return "succeeded";
  });
  scheduler = h.create();
  await scheduler.tick(observed, true, false, "a");
  await h
    .create()
    .tick(new Date(observed.getTime() + 29 * 60000), true, false, "a");
  expect(calls).toBe(1);
  await h
    .create()
    .tick(new Date(observed.getTime() + 30 * 60000), true, false, "a");
  expect(calls).toBe(2);
});

function intervalHarness(
  execute: () => Promise<string> = async () => "succeeded",
  initial: IntervalLedger = {},
) {
  let stored = initial;
  const io = {
    read: async () => ({ ...stored }),
    save: async (value: IntervalLedger) => {
      stored = { ...value };
    },
  };
  const create = () =>
    new IntervalScheduler(io, 6 * 60 * 60_000, 30 * 60_000, execute);
  return {
    create,
    get stored() {
      return stored;
    },
  };
}
const observed = new Date("2026-09-21T00:00:00Z");
it("does not retry unknown, interrupted or legacy failed maintenance after restart", async () => {
  for (const lastStatus of ["unknown", "running", "failed"]) {
    let calls = 0;
    const h = intervalHarness(
      async () => {
        calls++;
        return "succeeded";
      },
      { scope: "lane-a", lastStatus, lastAttemptAt: observed.toISOString() },
    );
    await h
      .create()
      .tick(new Date("2026-09-22T00:00:00Z"), true, false, "lane-a");
    expect(calls).toBe(0);
  }
});
it("records an unclassified exception as unknown and rejects late calibration until a fresh observation", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(observed);
    const h = intervalHarness(async () => {
      throw Error("timeout after submission");
    });
    const scheduler = h.create();
    await expect(
      scheduler.tick(observed, true, false, "lane-a"),
    ).rejects.toThrow("timeout");
    expect(h.stored.lastStatus).toBe("unknown");
    await scheduler.calibrate(
      {
        observedAt: observed.toISOString(),
        nextRunAt: new Date(observed.getTime() + 3600000).toISOString(),
      },
      "lane-a",
      observed,
    );
    expect(h.stored.lastStatus).toBe("unknown");
    const later = new Date(observed.getTime() + 1000);
    await scheduler.calibrate(
      {
        observedAt: later.toISOString(),
        nextRunAt: new Date(later.getTime() + 3600000).toISOString(),
      },
      "lane-a",
      later,
    );
    expect(h.stored.lastStatus).toBe("succeeded");
  } finally {
    vi.useRealTimers();
  }
});
const calibrated = {
  outcome: "active",
  observedAt: observed.toISOString(),
  nextRunAt: "2026-09-21T01:00:00.000Z",
};

it("persists an observed deadline across restart and executes when it arrives", async () => {
  let executions = 0;
  const h = intervalHarness(async () => {
    executions++;
    return "succeeded";
  });
  await h.create().calibrate(calibrated, "lane-a", observed);
  await h
    .create()
    .tick(new Date("2026-09-21T00:59:00Z"), true, false, "lane-a");
  expect(executions).toBe(0);
  await h.create().tick(new Date(calibrated.nextRunAt), true, false, "lane-a");
  expect(executions).toBe(1);
});
it.each(["succeeded", "failed"])(
  "preserves calibration when the enclosing run is %s",
  async (status) => {
    let scheduler!: IntervalScheduler;
    const h = intervalHarness(async () => {
      await scheduler.calibrate(calibrated, "lane-a", observed);
      return status;
    });
    scheduler = h.create();
    await scheduler.tick(observed, true, false, "lane-a");
    expect(h.stored.nextRunAt).toBe(calibrated.nextRunAt);
    expect(h.stored.lastStatus).toBe(status);
  },
);
it("rejects invalid or unbounded calibration without changing the ledger", async () => {
  const h = intervalHarness();
  for (const result of [
    { ...calibrated, nextRunAt: "invalid" },
    { ...calibrated, nextRunAt: "2026-09-21T07:00:00Z" },
    { ...calibrated, nextRunAt: "2026-09-20T23:00:00Z" },
    { ...calibrated, observedAt: "2026-09-22T00:00:00Z" },
  ])
    await expect(
      h.create().calibrate(result, "lane-a", observed),
    ).rejects.toThrow();
  expect(h.stored).toEqual({});
});
it("clears old scope deadlines even if the new scope fails", async () => {
  const h = intervalHarness(async () => "failed", {
    scope: "old",
    nextRunAt: "2026-09-21T05:00:00Z",
    lastCompletedAt: observed.toISOString(),
  });
  await h.create().tick(observed, true, false, "new");
  expect(h.stored.scope).toBe("new");
  expect(h.stored.nextRunAt).toBeUndefined();
  expect(h.stored.lastCompletedAt).toBeUndefined();
});
it("serializes calibration with stop deferral and retains the cancellation cooldown", async () => {
  let executions = 0;
  const h = intervalHarness(async () => {
    executions++;
    return "succeeded";
  });
  const scheduler = h.create();
  await Promise.all([
    scheduler.calibrate(calibrated, "lane-a", observed),
    scheduler.defer(observed, "lane-a"),
  ]);
  expect(h.stored.nextRunAt).toBe(calibrated.nextRunAt);
  expect(h.stored.lastStatus).toBe("cancelled");
  await h
    .create()
    .tick(new Date("2026-09-21T01:00:00Z"), true, false, "lane-a");
  expect(executions).toBe(0);
});
it("does not erase a stop request when a previously observed result reaches storage late", async () => {
  const h = intervalHarness();
  const scheduler = h.create();
  await scheduler.defer(new Date("2026-09-21T00:00:01Z"), "lane-a");
  await scheduler.calibrate(
    calibrated,
    "lane-a",
    new Date("2026-09-21T00:00:02Z"),
  );
  expect(h.stored.nextRunAt).toBe(calibrated.nextRunAt);
  expect(h.stored.lastStatus).toBe("cancelled");
});
function setup(ledger: ScheduleLedger = {}) {
  let stored = ledger;
  let executions = 0;
  const io = {
    read: async () => stored,
    save: async (v: ScheduleLedger) => {
      stored = { ...v };
    },
  };
  const create = () =>
    new DailyScheduler(
      io,
      () => "game-day",
      async () => {
        executions++;
        return "succeeded";
      },
    );
  return {
    create,
    get executions() {
      return executions;
    },
    get stored() {
      return stored;
    },
  };
}
const config = {
  scheduleEnabled: true,
  scheduleTime: "08:00",
  runOnLaunch: true,
};
const twice = {
  ...config,
  runOnLaunch: false,
  secondScheduleEnabled: true,
  secondScheduleTime: "20:00",
};
it("does not claim a rejected preflight and can run the same period after the guard clears", async () => {
  let stored: ScheduleLedger = {};
  let blocked = true;
  const save = vi.fn(async (value: ScheduleLedger) => {
    stored = value;
  });
  const execute = vi.fn(async () => "succeeded");
  const preflight = vi.fn(async (occurrence) => {
    expect(occurrence.slot).toBe("secondary");
    if (blocked) throw Error("待核对，未受理");
  });
  const scheduler = new DailyScheduler(
    { read: async () => stored, save },
    () => "day",
    execute,
    undefined,
    preflight,
  );
  const at = new Date(2026, 9, 8, 20, 45);
  await expect(scheduler.tick(at, twice, false)).rejects.toThrow("未受理");
  expect(execute).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(stored).toEqual({});
  blocked = false;
  await scheduler.tick(at, twice, false);
  expect(preflight).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledOnce();
  expect(stored.attempts).toEqual(["day||secondary"]);
  expect(stored.completedDay).toBe("day||secondary");
  expect(stored.lastStatus).toBe("succeeded");
});
it("still records an actual execution exception after successful preflight as unknown", async () => {
  let stored: ScheduleLedger = {};
  const preflight = vi.fn(async () => {});
  const execute = vi.fn(async () => {
    expect(stored.attempts).toEqual(["day||secondary"]);
    expect(stored.lastStatus).toBe("running");
    throw Error("worker lost");
  });
  const scheduler = new DailyScheduler(
    {
      read: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    () => "day",
    execute,
    undefined,
    preflight,
  );
  await expect(
    scheduler.tick(new Date(2026, 9, 8, 20, 45), twice, false),
  ).rejects.toThrow("worker lost");
  expect(preflight).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(stored.lastStatus).toBe("unknown");
  expect(stored.completedDay).toBeUndefined();
});
it("does not migrate or replay a previously claimed unknown attempt through preflight", async () => {
  const stored: ScheduleLedger = {
    attemptDay: "day||secondary",
    attempts: ["day||secondary"],
    lastStatus: "unknown",
  };
  const save = vi.fn(async () => {});
  const execute = vi.fn(async () => "succeeded");
  const preflight = vi.fn(async () => {});
  const scheduler = new DailyScheduler(
    { read: async () => stored, save },
    () => "day",
    execute,
    undefined,
    preflight,
  );
  await scheduler.tick(new Date(2026, 9, 8, 21), twice, false);
  expect(preflight).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(stored.lastStatus).toBe("unknown");
});
it.each(["primary", "secondary"] as const)(
  "retains a concurrent %s completion during preflight without a stale claim",
  async (slot) => {
    let stored: ScheduleLedger = {};
    let release!: () => void;
    const preflight = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const execute = vi.fn(async () => "succeeded");
    const scheduler = new DailyScheduler({
      read: async () => stored,
      save: async (value) => { stored = value; },
    }, () => "day", execute, undefined, preflight);
    const at = new Date(2026, 9, 8, 20, 45);
    const pending = scheduler.tick(at, twice, false);
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce());
    await scheduler.complete(at, "", twice, slot);
    const completion = structuredClone(stored);
    release();
    await pending;
    expect(execute).not.toHaveBeenCalled();
    expect(stored).toEqual(completion);
    preflight.mockResolvedValue(undefined);
    await scheduler.tick(at, twice, false);
    expect(execute).toHaveBeenCalledTimes(slot === "primary" ? 1 : 0);
    expect(stored.completions).toEqual(slot === "primary"
      ? ["day|", "day||secondary"] : ["day||secondary"]);
  },
);
it("manual evening completion suppresses only the evening and changing its time does not replay it", async () => {
  const h = setup();
  await h.create().complete(new Date(2026, 8, 28, 20), "", twice);
  expect(h.stored.completedDay).toBe("game-day||secondary");
  await h
    .create()
    .tick(
      new Date(2026, 8, 28, 22),
      { ...twice, secondScheduleTime: "21:00" },
      false,
    );
  expect(h.executions).toBe(0);
});
it("reports a morning plan that was attempted but never completed", async () => {
  // 事故：tick 先记 attempts 再执行。一次瞬态失败（模拟器冷启动、
  // adb screencap 失败）过去就等于当天主计划彻底不再执行，而失败当下的
  // 瞬时通知错过之后**没有任何持久信号**说明"今天仍未完成"。
  //
  // 现在的契约：失败后先有界重试；只有重试用尽（retriesRemaining=0）
  // 才由调用方发"今天仍未完成"的通知。dailyState 必须能报出这个状态。
  let stored: ScheduleLedger = {};
  let executions = 0;
  let lastAttemptAt: string | undefined;
  let attemptedAt = new Date(2026, 8, 28, 8, 1);
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    (date) => `day-${date.getDate()}`,
    async () => {
      executions++;
      lastAttemptAt = attemptedAt.toISOString();
      throw Error("模拟器未就绪");
    },
    () => ({ allowed: true, status: "failed", lastAttemptAt }),
  );
  const at = (minute: number) => new Date(2026, 8, 28, 8, minute);
  const tick = (now: Date) => {
    attemptedAt = now;
    return s.tick(now, twice, false);
  };
  await expect(tick(at(1))).rejects.toThrow("模拟器未就绪");
  expect(executions).toBe(1);

  const state = await s.dailyState(at(2), "", twice);
  expect(state.day).toBe("day-28");
  expect(state.primary.lastStatus).toBe("failed");
  expect(state.primary.retryAllowed).toBe(true);
  expect(state.primary.attempted).toBe(true);
  expect(state.primary.completed).toBe(false);
  // 还有重试机会 ⇒ 调用方应推迟"今天没跑"的通知
  expect(state.primary.attempts).toBe(1);
  expect(state.primary.retriesRemaining).toBe(DailyScheduler.MAX_RETRIES);

  // 退避窗口内不再尝试
  await tick(at(2));
  expect(executions).toBe(1);

  // 退避之后把重试用完
  await expect(tick(at(5))).rejects.toThrow("模拟器未就绪");
  await expect(tick(at(9))).rejects.toThrow("模拟器未就绪");
  expect(executions).toBe(3);

  // 用尽 ⇒ 不再尝试，且 retriesRemaining 归零，调用方据此发通知
  await tick(at(30));
  expect(executions).toBe(3);
  const exhausted = await s.dailyState(at(30), "", twice);
  expect(exhausted.primary.retriesRemaining).toBe(0);
  expect(exhausted.primary.attempted).toBe(true);
  expect(exhausted.primary.completed).toBe(false);
  expect(exhausted.primary.lastStatus).toBe("failed");
  expect(exhausted.primary.retryAllowed).toBe(false);
  expect(exhausted.primary.retryReason).toBe("retry-limit-reached");

  // 但第二天是新的一天，不应把昨天的失败算到今天
  const next = await s.dailyState(new Date(2026, 8, 29, 8, 1), "", twice);
  expect(next.day).toBe("day-29");
  expect(next.primary.attempted).toBe(false);
  expect(next.primary.completed).toBe(false);
});

it("dailyState separates morning from evening and never mutates the ledger", async () => {
  let stored: ScheduleLedger = {};
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    (date) => `day-${date.getDate()}`,
    async () => "succeeded",
  );
  const morning = new Date(2026, 8, 28, 8, 1);
  await s.tick(morning, twice, false);
  const before = JSON.stringify(stored);
  const state = await s.dailyState(morning, "", twice);
  expect(state.primary.completed).toBe(true);
  expect(state.secondary.attempted).toBe(false);
  expect(state.secondary.completed).toBe(false);
  expect(state.scheduleTime).toBe(twice.scheduleTime);
  expect(state.secondScheduleTime).toBe("20:00");
  expect(JSON.stringify(stored)).toBe(before);
});

it("reports an interrupted morning run instead of hiding it behind a running status", async () => {
  // 应用在计划执行中途被杀：账本停在 running，attempts 已写入 ⇒ 当天不会再跑。
  // 注意空 scope 时 key 只有一个分隔符：`<day>|<scope>`（secondary 才追加 `|secondary`）。
  const stored: ScheduleLedger = {
    attemptDay: "day-28|",
    attempts: ["day-28|"],
    lastStatus: "running",
  };
  const s = new DailyScheduler(
    {
      read: async () => ({ ...stored }),
      save: async () => {
        throw Error("dailyState 不应写账本");
      },
    },
    (date) => `day-${date.getDate()}`,
    async () => "succeeded",
  );
  const state = await s.dailyState(new Date(2026, 8, 28, 10), "", twice);
  expect(state.primary.attempted).toBe(true);
  expect(state.primary.completed).toBe(false);
  // 调用方据此避开"本次手动执行仍在进行中"的误报
  expect(state.lastStatus).toBe("running");
  expect(state.primary.lastStatus).toBe("running");
  expect(state.primary.retryAllowed).toBe(false);
  expect(state.primary.retryReason).toBe("retry-proof-unavailable");
});

it("busy evenings wait, disabled scheduling does not run, and failed evenings never hot-loop", async () => {
  let stored: ScheduleLedger = {},
    count = 0;
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    () => "day",
    async (occurrence) => {
      expect(occurrence.slot).toBe("secondary");
      count++;
      throw Error("offline");
    },
  );
  const at = new Date(2026, 8, 28, 20);
  await s.tick(at, { ...twice, scheduleEnabled: false }, false);
  await s.tick(at, twice, true);
  expect(stored.attemptDay).toBeUndefined();
  await expect(s.tick(at, twice, false)).rejects.toThrow("offline");
  // 退避窗口内不重试——这是原来"不会每 tick 重试"的意图，现在仍然成立。
  await s.tick(new Date(2026, 8, 28, 20, 1), twice, false);
  await s.tick(new Date(2026, 8, 28, 20, 2), twice, false);
  expect(count).toBe(1);
  expect(stored.attemptDay).toBe("day||secondary");
});
it("keeps the claimed evening on its starting day across a clock boundary", async () => {
  let stored: ScheduleLedger = {},
    day = "before";
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (value) => {
        stored = value;
      },
    },
    () => day,
    async (occurrence) => {
      expect(occurrence.slot).toBe("secondary");
      day = "after";
      return "succeeded";
    },
  );
  await s.tick(new Date(2026, 8, 28, 23), twice, false);
  expect(stored.completedDay).toBe("before||secondary");
});
it("runs morning and evening independently and persists both across restart", async () => {
  const h = setup();
  await h.create().tick(new Date(2026, 8, 28, 7, 59), twice, false, "startup");
  expect(h.executions).toBe(0);
  await h.create().tick(new Date(2026, 8, 28, 8), twice, false);
  await h.create().tick(new Date(2026, 8, 28, 19, 59), twice, false);
  expect(h.executions).toBe(1);
  await h.create().tick(new Date(2026, 8, 28, 20), twice, false);
  await h.create().tick(new Date(2026, 8, 28, 21), twice, false, "startup");
  expect(h.executions).toBe(2);
  expect(h.stored.completions).toEqual(["game-day|", "game-day||secondary"]);
});
it("catches up only the latest due slot, never both missed rounds", async () => {
  const h = setup();
  await h.create().tick(new Date(2026, 8, 28, 21), twice, false, "startup");
  await h.create().tick(new Date(2026, 8, 28, 22), twice, false);
  expect(h.executions).toBe(1);
  expect(h.stored.completedDay).toBe("game-day||secondary");
});
it("keeps legacy morning completions but allows the evening", async () => {
  const h = setup();
  await h.create().complete(new Date(2026, 8, 28, 9));
  await h.create().tick(new Date(2026, 8, 28, 12), twice, false);
  expect(h.executions).toBe(0);
  await h.create().tick(new Date(2026, 8, 28, 20), twice, false);
  expect(h.executions).toBe(1);
});
it("explicit saved primary completion at night does not incorrectly complete the secondary slot", async () => {
  const h = setup();
  await h
    .create()
    .complete(new Date(2026, 8, 28, 21), "scope", twice, "primary");
  expect(h.stored.completedDay).toBe("game-day|scope");
  await h
    .create()
    .tick(new Date(2026, 8, 28, 21), { ...twice, scope: "scope" }, false);
  expect(h.executions).toBe(1);
  expect(h.stored.completions).toEqual([
    "game-day|scope",
    "game-day|scope|secondary",
  ]);
});
it("credits a run crossing 04:00 to its starting game day and still runs at 08:00", async () => {
  vi.useFakeTimers();
  try {
    let stored: ScheduleLedger = {};
    let executions = 0;
    const scheduler = new DailyScheduler(
      {
        read: async () => stored,
        save: async (value) => {
          stored = value;
        },
      },
      arknightsGameDay,
      async () => {
        executions++;
        vi.setSystemTime(new Date("2026-09-24T04:05:00+08:00"));
        return "succeeded";
      },
    );
    const startedAt = new Date("2026-09-24T03:59:00+08:00");
    const nextRun = new Date("2026-09-24T08:00:00+08:00");
    vi.setSystemTime(startedAt);
    const scoped = {
      ...config,
      scheduleTime: `${String(nextRun.getHours()).padStart(2, "0")}:00`,
      scope: "lane-a",
    };
    await scheduler.tick(startedAt, scoped, false, "startup");
    expect(stored.completedDay).toBe("2026-09-23|lane-a");
    expect(stored.completions).not.toContain("2026-09-24|lane-a");
    await scheduler.tick(nextRun, scoped, false);
    expect(executions).toBe(2);
    expect(stored.completedDay).toBe("2026-09-24|lane-a");
  } finally {
    vi.useRealTimers();
  }
});
it("does not turn a pre-reset schedule into an extra run at game reset", async () => {
  let executions = 0,
    stored: ScheduleLedger = {};
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (v) => {
        stored = v;
      },
    },
    (d) => (d.getHours() < 6 ? "previous" : "current"),
    async () => {
      executions++;
      return "succeeded";
    },
  );
  await s.tick(
    new Date(2026, 8, 15, 6),
    { ...config, scheduleTime: "03:00" },
    false,
  );
  expect(executions).toBe(0);
});
it("waits for due time, then catches up once and survives restart", async () => {
  const h = setup(),
    s = h.create();
  await s.tick(new Date(2026, 8, 15, 7, 59), config, false);
  expect(h.executions).toBe(0);
  await s.tick(new Date(2026, 8, 15, 12), config, false);
  expect(h.executions).toBe(1);
  await h.create().tick(new Date(2026, 8, 15, 13), config, false, "startup");
  expect(h.executions).toBe(1);
});
it("does not consume the day when another task is busy", async () => {
  const h = setup(),
    s = h.create();
  await s.tick(new Date(2026, 8, 15, 9), config, true);
  expect(h.stored.attemptDay).toBeUndefined();
  await s.tick(new Date(2026, 8, 15, 9), config, false);
  expect(h.executions).toBe(1);
});
it("serializes simultaneous startup and timer ticks", async () => {
  const h = setup(),
    s = h.create();
  await Promise.all([
    s.tick(new Date(2026, 8, 15, 9), config, false),
    s.tick(new Date(2026, 8, 15, 9), config, false, "startup"),
  ]);
  expect(h.executions).toBe(1);
});
it("manual success suppresses automatic work, but a new game day can run", async () => {
  let day = "one",
    count = 0,
    stored: ScheduleLedger = {};
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (v) => {
        stored = v;
      },
    },
    () => day,
    async () => {
      count++;
      return "succeeded";
    },
  );
  await s.complete(new Date());
  await s.tick(new Date(2026, 8, 15, 9), config, false);
  expect(count).toBe(0);
  day = "two";
  await s.tick(new Date(2026, 8, 16, 9), config, false);
  expect(count).toBe(1);
});
it("retries a failed attempt at most MAX_RETRIES times, always with a backoff", async () => {
  // 需求变更：失败后允许**有界重试**，避免一次瞬态失败（模拟器冷启动、
  // adb screencap 失败）把当天的主计划彻底丢掉。边界仍然是硬的：
  // 退避窗口内绝不重试，总尝试次数 = 首次 + MAX_RETRIES，用尽后永不再试。
  let count = 0,
    stored: ScheduleLedger = {};
  let lastAttemptAt: string | undefined;
  let attemptedAt = new Date(2026, 8, 15, 9);
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (v) => {
        stored = v;
      },
    },
    () => "one",
    async () => {
      count++;
      lastAttemptAt = attemptedAt.toISOString();
      throw Error("offline");
    },
    () => ({ allowed: true, status: "failed", lastAttemptAt }),
  );
  const at = (minute: number) => new Date(2026, 8, 15, 9, minute);
  const tick = (now: Date) => {
    attemptedAt = now;
    return s.tick(now, config, false);
  };

  await expect(tick(at(0))).rejects.toThrow("offline");
  expect(count).toBe(1);

  // 退避窗口（默认 3 分钟）内每个 tick 都不再重试
  await tick(at(1));
  await tick(at(2));
  expect(count).toBe(1);

  // 退避之后允许重试，但总共只有 MAX_RETRIES 次
  await expect(tick(at(4))).rejects.toThrow("offline");
  expect(count).toBe(2);
  await tick(at(5));
  expect(count).toBe(2);
  await expect(tick(at(8))).rejects.toThrow("offline");
  expect(count).toBe(3);

  expect(count).toBe(1 + DailyScheduler.MAX_RETRIES);

  // 次数用尽：当天再也不会尝试
  await expect(tick(at(12))).resolves.toBeUndefined();
  await tick(new Date(2026, 8, 15, 23));
  expect(count).toBe(3);
  expect(stored.attempts?.filter((day) => day === "one|").length).toBe(3);
  // 新的一天重新计数
  expect(stored.attemptDay).toBe("one|");
});

it("never retries a failure when the safety check says the run already touched the game", async () => {
  // 今天已经跑成过游戏步骤时重跑会重复消耗理智/许可，所以即使失败也不许自动重试。
  let count = 0,
    stored: ScheduleLedger = {},
    safe = false;
  let lastAttemptAt: string | undefined;
  let attemptedAt = new Date(2026, 8, 15, 9);
  const s = new DailyScheduler(
    {
      read: async () => stored,
      save: async (v) => {
        stored = v;
      },
    },
    () => "one",
    async () => {
      count++;
      lastAttemptAt = attemptedAt.toISOString();
      throw Error("offline");
    },
    () => ({ allowed: safe, status: "failed", lastAttemptAt }),
  );
  const at = (minute: number) => new Date(2026, 8, 15, 9, minute);
  const tick = (now: Date) => {
    attemptedAt = now;
    return s.tick(now, config, false);
  };
  await expect(tick(at(0))).rejects.toThrow("offline");
  expect(count).toBe(1);
  // 即使退避已过，安全前提不成立就不重试
  await tick(at(30));
  await tick(at(59));
  expect(count).toBe(1);
  // 前提成立后，下一轮退避到期即可重试
  safe = true;
  await expect(tick(new Date(2026, 8, 15, 10))).rejects.toThrow(
    "offline",
  );
  expect(count).toBe(2);
});

it("retries only failures, never unknown, cancelled or interrupted attempts", async () => {
  for (const lastStatus of ["unknown", "cancelled", "running", "succeeded"]) {
    let count = 0;
    const stored: ScheduleLedger = {
      attemptDay: "one|",
      attempts: ["one|"],
      lastStatus,
    };
    const s = new DailyScheduler(
      {
        read: async () => ({ ...stored }),
        save: async () => {},
      },
      () => "one",
      async () => {
        count++;
        return "succeeded";
      },
    );
    await s.tick(new Date(2026, 8, 15, 10), config, false);
    expect(count, `lastStatus=${lastStatus} 不应自动重放`).toBe(0);
  }
});
it("never executes if the claim cannot be saved", async () => {
  let ran = false;
  const s = new DailyScheduler(
    {
      read: async () => ({}),
      save: async () => {
        throw Error("disk");
      },
    },
    () => "one",
    async () => {
      ran = true;
      return "succeeded";
    },
  );
  await expect(s.tick(new Date(2026, 8, 15, 9), config, false)).rejects.toThrow(
    "disk",
  );
  expect(ran).toBe(false);
});
it("does not confuse completion of different emulator instances", async () => {
  const h = setup(),
    s = h.create();
  await s.tick(
    new Date(2026, 8, 15, 9),
    { ...config, scope: "instance0" },
    false,
  );
  await s.tick(
    new Date(2026, 8, 15, 9),
    { ...config, scope: "instance1" },
    false,
  );
  await s.tick(
    new Date(2026, 8, 15, 9),
    { ...config, scope: "instance0" },
    false,
  );
  expect(h.executions).toBe(2);
});

it("runs interval work once every six hours and catches up after restart", async () => {
  let stored = {},
    executions = 0;
  const io = {
    read: async () => stored,
    save: async (value: typeof stored) => {
      stored = { ...value };
    },
  };
  const create = () =>
    new IntervalScheduler(io, 6 * 60 * 60 * 1000, 30 * 60 * 1000, async () => {
      executions++;
      return "succeeded";
    });
  await create().tick(new Date("2026-09-17T00:00:00Z"), true, false, "mumu0");
  await create().tick(new Date("2026-09-17T05:59:59Z"), true, false, "mumu0");
  expect(executions).toBe(1);
  await create().tick(new Date("2026-09-17T06:00:01Z"), true, false, "mumu0");
  expect(executions).toBe(2);
});

it("uses a failure cooldown and keeps interval scopes independent", async () => {
  let stored = {},
    executions = 0;
  const scheduler = new IntervalScheduler(
    {
      read: async () => stored,
      save: async (value) => {
        stored = { ...value };
      },
    },
    6 * 60 * 60 * 1000,
    30 * 60 * 1000,
    async () => {
      executions++;
      throw new Error("offline");
    },
  );
  await expect(
    scheduler.tick(new Date("2026-09-17T00:00:00Z"), true, false, "mumu0"),
  ).rejects.toThrow("offline");
  await scheduler.tick(new Date("2026-09-17T00:10:00Z"), true, false, "mumu0");
  expect(executions).toBe(1);
  await expect(
    scheduler.tick(new Date("2026-09-17T00:10:01Z"), true, false, "mumu1"),
  ).rejects.toThrow("offline");
  expect(executions).toBe(2);
});

it("defers cancelled maintenance for six hours across scheduler restart", async () => {
  let stored = {},
    executions = 0;
  const io = {
    read: async () => stored,
    save: async (value: typeof stored) => {
      stored = { ...value };
    },
  };
  const create = () =>
    new IntervalScheduler(io, 6 * 60 * 60_000, 30 * 60_000, async () => {
      executions++;
      return "succeeded";
    });
  await create().defer(new Date("2026-09-20T00:00:00Z"), "lane-a");
  await create().tick(new Date("2026-09-20T00:00:15Z"), true, false, "lane-a");
  await create().tick(new Date("2026-09-20T05:59:00Z"), true, false, "lane-a");
  expect(executions).toBe(0);
  await create().tick(new Date("2026-09-20T06:00:01Z"), true, false, "lane-a");
  expect(executions).toBe(1);
});

it("reports a gated maintenance pause instead of failing silently", async () => {
  // 线上事故：09-28 的六小时维护结果未确认，闸门落下后界面上没有任何提示，
  // 用户只看到"每 6 小时检查寄养"仍开着却再也不运行。gateState 必须能报出原因。
  const observedAt = "2026-09-28T03:22:15.898Z";
  const h = intervalHarness(async () => "succeeded", {
    scope: "lane-a",
    blockedAt: observedAt,
    lastStatus: "unknown",
    lastAttemptAt: observedAt,
  });
  await expect(h.create().gateState("lane-a")).resolves.toEqual({
    blocked: true,
    blockedAt: observedAt,
    lastStatus: "unknown",
  });
  // 其它槽位互不影响
  await expect(h.create().gateState("lane-b")).resolves.toEqual({
    blocked: false,
    blockedAt: null,
    lastStatus: null,
  });
});

it("backfills blockedAt for legacy gated records that only carry a status", async () => {
  // 早期版本只写 lastStatus，不写 blockedAt。闸门仍然要挡（既有用例已锁定该语义），
  // 但必须补登时刻，否则界面报不出"从什么时候开始暂停"，人工也无从解除。
  let stored: IntervalLedger = {
    scope: "lane-a",
    lastStatus: "failed",
    lastAttemptAt: observed.toISOString(),
  };
  let calls = 0;
  const io = {
    read: async () => ({ ...stored }),
    save: async (value: IntervalLedger) => {
      stored = { ...value };
    },
  };
  const scheduler = new IntervalScheduler(io, 6 * 60 * 60_000, 30 * 60_000, async () => {
    calls++;
    return "succeeded";
  });
  await scheduler.tick(new Date("2026-09-22T00:00:00Z"), true, false, "lane-a");
  expect(calls).toBe(0);
  expect(stored.blockedAt).toBe(observed.toISOString());
  await expect(scheduler.gateState("lane-a")).resolves.toEqual({
    blocked: true,
    blockedAt: observed.toISOString(),
    lastStatus: "failed",
  });
});

it("clears a maintenance pause only on explicit operator action, and then runs again", async () => {
  // 人工核对现场后的唯一出口：日常流程已不含 foster（compileDailyPlan 过滤
  // maintenanceOnly），calibrate() 可能永远等不到观测，闸门否则就是永久死锁。
  let calls = 0;
  const h = intervalHarness(
    async () => {
      calls++;
      return "succeeded";
    },
    {
      scope: "lane-a",
      blockedAt: "2026-09-28T03:22:15.898Z",
      lastStatus: "unknown",
      lastAttemptAt: "2026-09-28T03:09:55.000Z",
      nextRunAt: "2026-09-28T09:09:55.000Z",
    },
  );
  await h.create().tick(new Date("2026-10-05T00:00:00Z"), true, false, "lane-a");
  expect(calls).toBe(0);

  await h.create().clearBlocked("lane-a");
  expect(h.stored.blockedAt).toBeUndefined();
  expect(h.stored.lastStatus).toBe("cancelled");
  await expect(h.create().gateState("lane-a")).resolves.toEqual({
    blocked: false,
    blockedAt: null,
    lastStatus: "cancelled",
  });

  await h.create().tick(new Date("2026-10-05T00:00:15Z"), true, false, "lane-a");
  expect(calls).toBe(1);
});

it("clearing a pause is a no-op for another scope or an unblocked ledger", async () => {
  const blocked = intervalHarness(async () => "succeeded", {
    scope: "lane-a",
    blockedAt: "2026-09-28T03:22:15.898Z",
    lastStatus: "unknown",
  });
  await blocked.create().clearBlocked("lane-b");
  expect(blocked.stored.blockedAt).toBe("2026-09-28T03:22:15.898Z");
  expect(blocked.stored.lastStatus).toBe("unknown");

  const healthy = intervalHarness(async () => "succeeded", {
    scope: "lane-a",
    lastStatus: "succeeded",
    lastCompletedAt: "2026-10-04T00:00:00.000Z",
  });
  const before = { ...healthy.stored };
  await healthy.create().clearBlocked("lane-a");
  expect(healthy.stored).toEqual(before);
});
