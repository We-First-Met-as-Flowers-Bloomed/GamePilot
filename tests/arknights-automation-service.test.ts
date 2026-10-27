import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type {
  ArknightsAutomationConfig,
  ArknightsJob,
} from "../packages/protocol/arknights-automation";
import type {
  ArknightsAutomationDocument,
  ArknightsAutomationOutcome,
  ArknightsAutomationRun,
} from "../apps/desktop/main/arknights-automation";

const clock = (hours: number, minutes = 0, day = 25) =>
  new Date(2026, 9, day, hours, minutes);
const job = (
  id = "morning",
  time = "08:00",
  laneId = "ark-a",
): ArknightsJob => ({
  id,
  name: id,
  laneId,
  enabled: true,
  time,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  skillIds: ["login", "award"],
  catchUp: true,
});
const config = (jobs = [job()]): ArknightsAutomationConfig => ({
  version: 1,
  enabled: true,
  jobs,
});

it("defers a second due account on the same physical device without consuming its period", async () => {
  const s = await fixture(
    config([job("a", "08:00", "a"), job("b", "08:00", "b")]),
  );
  let busy = false;
  const service = new s.ArknightsAutomationService({
    ...s.options,
    resourceKey: async () => "same-device",
    canRunJob: async () => !busy,
  });
  await service.tick(clock(8));
  expect(s.run).toHaveBeenCalledTimes(1);
  busy = true;
  await service.tick(clock(8, 1));
  expect((await service.state()).runs).toHaveLength(1);
  s.pending[0].resolve({ status: "succeeded" });
  await vi.waitFor(async () =>
    expect((await service.state()).runs[0].status).toBe("succeeded"),
  );
  busy = false;
  await service.tick(clock(8, 2));
  expect(s.run).toHaveBeenCalledTimes(2);
  expect(s.run.mock.calls[1][0].id).toBe("b");
});
const load = async () => {
  const module =
    await import("../apps/desktop/main/arknights-automation").catch(
      () => undefined,
    );
  expect(module?.ArknightsAutomationService).toBeTypeOf("function");
  expect(module?.ArknightsAutomationStore).toBeTypeOf("function");
  return module!;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(input = config()) {
  const module = await load();
  let saved: ArknightsAutomationDocument = {
    version: 1,
    config: structuredClone(input),
    runs: [],
  };
  const store = {
    read: async () => structuredClone(saved),
    save: async (value: ArknightsAutomationDocument) => {
      saved = structuredClone(value);
    },
  };
  const pending: ReturnType<typeof deferred<ArknightsAutomationOutcome>>[] = [];
  const run = vi.fn(
    async (
      _job: ArknightsJob,
      _dueAt: Date,
      _signal: AbortSignal,
      _requestId: string,
    ) => {
      const completion = deferred<ArknightsAutomationOutcome>();
      pending.push(completion);
      return {
        batchId: `batch-${pending.length}`,
        completion: completion.promise,
      };
    },
  );
  const options = { store, run, now: () => clock(9) };
  const service = new module.ArknightsAutomationService(options);
  return {
    ...module,
    service,
    store,
    options,
    run,
    pending,
    saved: () => saved,
  };
}
async function finish(
  s: Awaited<ReturnType<typeof fixture>>,
  index = 0,
  status: ArknightsAutomationOutcome["status"] = "succeeded",
) {
  s.pending[index].resolve({ status });
  await vi.waitFor(async () =>
    expect(
      (await s.service.state()).runs.find(
        (run) => run.batchId === `batch-${index + 1}`,
      )?.status,
    ).toBe(status),
  );
}

it("persists config plus ledger atomically, returns independent copies, and fails closed on corrupt evidence", async () => {
  const { ArknightsAutomationStore } = await load();
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-ark-automation-"));
  const path = join(dir, "automation.json");
  const store = new ArknightsAutomationStore(path, config());
  const initial = await store.read();
  expect(initial).toEqual({ version: 1, config: config(), runs: [] });
  await store.save(initial);
  initial.config.jobs[0].time = "22:00";
  expect((await store.read()).config.jobs[0].time).toBe("08:00");
  expect(JSON.parse(await readFile(path, "utf8")).runs).toEqual([]);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      config: config(),
      runs: [{ status: "succeeded" }],
    }),
  );
  await expect(store.read()).rejects.toThrow(/损坏/);
  expect(await readFile(path, "utf8")).toContain("succeeded");
});
it("keeps two account schedules independent and claims before invoking the execution callback", async () => {
  const s = await fixture(config([job(), job("b-morning", "08:00", "ark-b")]));
  s.run.mockImplementation(async (item) => {
    expect(
      s
        .saved()
        .runs.some((run) => run.jobId === item.id && run.status === "running"),
    ).toBe(true);
    return {
      batchId: `batch-${item.laneId}`,
      completion: new Promise(() => {}),
    };
  });
  expect(await s.service.tick(clock(9))).toHaveLength(2);
  expect(s.run.mock.calls.map(([item]) => item.laneId)).toEqual([
    "ark-a",
    "ark-b",
  ]);
  await s.service.tick(clock(10));
  expect(s.run).toHaveBeenCalledTimes(2);
});
it("only catches up the latest due job per channel, retaining older slots as skipped", async () => {
  const s = await fixture(config([job(), job("evening", "20:00")]));
  await s.service.tick(clock(21));
  expect(s.run).toHaveBeenCalledTimes(1);
  expect(s.run.mock.calls[0][0].id).toBe("evening");
  expect(s.run.mock.calls[0][1]).toEqual(clock(20));
  expect(
    (await s.service.state()).runs.find((run) => run.jobId === "morning")
      ?.status,
  ).toBe("skipped");
  await finish(s);
  await s.service.save(config([job()]));
  await s.service.tick(clock(22));
  expect(s.run).toHaveBeenCalledTimes(1);
});
it("runs morning and evening separately without treating morning's success as evening completion", async () => {
  const s = await fixture(config([job(), job("evening", "20:00")]));
  await s.service.tick(clock(9));
  await finish(s);
  await s.service.tick(clock(21));
  expect(s.run.mock.calls.map(([item]) => item.id)).toEqual([
    "morning",
    "evening",
  ]);
  expect((await s.service.state()).runs.map((run) => run.status)).toEqual([
    "succeeded",
    "running",
  ]);
});
it("honors weekdays, disabled switches, future times, and today's date", async () => {
  const input = config([
    job("future", "20:00"),
    { ...job("weekday"), weekdays: [1] },
    { ...job("disabled"), enabled: false },
  ]);
  const s = await fixture(input);
  await s.service.tick(clock(9));
  expect(s.run).not.toHaveBeenCalled();
  await s.service.save({ ...config(), enabled: false });
  await s.service.tick(clock(9));
  expect(s.run).not.toHaveBeenCalled();
  await s.service.save(config());
  await s.service.tick(clock(7, 59, 26));
  expect(s.run).not.toHaveBeenCalled();
});
it("only runs a no-catch-up job in its scheduled minute", async () => {
  const s = await fixture(config([{ ...job(), catchUp: false }]));
  await s.service.tick(clock(9));
  expect(s.run).not.toHaveBeenCalled();
  expect((await s.service.state()).runs[0].status).toBe("skipped");
  await s.service.tick(clock(8, 0, 26));
  expect(s.run).toHaveBeenCalledTimes(1);
});
it.each(["failed", "unknown", "cancelled", "succeeded"] as const)(
  "never replays a %s slot after restart or after changing its time",
  async (status) => {
    const s = await fixture();
    await s.service.tick(clock(9));
    await finish(s, 0, status);
    const restarted = new s.ArknightsAutomationService(s.options);
    await restarted.save(config([{ ...job(), time: "10:00" }]));
    await restarted.tick(clock(11));
    expect(s.run).toHaveBeenCalledTimes(1);
    expect((await restarted.state()).runs[0].status).toBe(status);
  },
);
it("retains deleted job receipts when the same ID is restored", async () => {
  const s = await fixture();
  await s.service.tick(clock(9));
  await finish(s);
  await s.service.save(config([]));
  await s.service.save(config());
  await s.service.tick(clock(11));
  expect(s.run).toHaveBeenCalledTimes(1);
});
it("marks interrupted claims unknown on restart and does not invoke the engine again", async () => {
  const s = await fixture();
  await s.service.tick(clock(9));
  const restarted = new s.ArknightsAutomationService(s.options);
  await restarted.tick(clock(11));
  expect(s.run).toHaveBeenCalledTimes(1);
  expect((await restarted.state()).runs[0].status).toBe("unknown");
});
it("blocks tick reentry and overlapping jobs on the same lane", async () => {
  const s = await fixture(config([job(), job("evening", "20:00")]));
  const admission = deferred<{
    batchId: string;
    completion: Promise<ArknightsAutomationOutcome>;
  }>();
  s.run.mockImplementation(() => admission.promise);
  const first = s.service.tick(clock(9));
  await vi.waitFor(() => expect(s.run).toHaveBeenCalledTimes(1));
  const second = s.service.tick(clock(9));
  admission.resolve({ batchId: "batch-a", completion: new Promise(() => {}) });
  await Promise.all([first, second]);
  await s.service.tick(clock(21));
  expect(s.run).toHaveBeenCalledTimes(1);
});
it("rejects saves while executing and respects the host busy gate without claiming work", async () => {
  const s = await fixture();
  let busy = true;
  const service = new s.ArknightsAutomationService({
    ...s.options,
    isBusy: () => busy,
  });
  await expect(service.save(config())).rejects.toThrow(/运行|执行/);
  await service.tick(clock(9));
  expect(s.run).not.toHaveBeenCalled();
  expect((await service.state()).runs).toEqual([]);
  busy = false;
  await service.tick(clock(9));
  await expect(service.save(config())).rejects.toThrow(/运行|执行/);
});
it("returns a manual batch receipt immediately, keeps the selected steps, and deduplicates request IDs across restart", async () => {
  const s = await fixture({
    ...config([{ ...job(), skillIds: ["recruit", "fight"] }]),
    enabled: false,
  });
  const result = await s.service.runNow({
    jobId: "morning",
    requestId: "manual-1",
  });
  expect(result).toEqual({ batchId: "batch-1" });
  expect(s.run.mock.calls[0][0].skillIds).toEqual(["recruit", "fight"]);
  expect(s.run.mock.calls[0][3]).toBe("manual-1");
  expect((await s.service.state()).runs[0].source).toBe("manual");
  await finish(s);
  const restarted = new s.ArknightsAutomationService(s.options);
  expect(
    await restarted.runNow({ jobId: "morning", requestId: "manual-1" }),
  ).toEqual(result);
  expect(s.run).toHaveBeenCalledTimes(1);
  await expect(restarted.runNow({ jobId: "missing" })).rejects.toThrow();
  await expect(
    restarted.runNow({ jobId: "morning", requestId: "../bad" }),
  ).rejects.toThrow();
});
it("records admission rejection and rejected completion as unknown without retrying", async () => {
  const s = await fixture();
  s.run.mockRejectedValueOnce(Error("admission uncertain"));
  await s.service.tick(clock(9));
  expect((await s.service.state()).runs[0].status).toBe("unknown");
  await s.service.tick(clock(10));
  expect(s.run).toHaveBeenCalledTimes(1);
  await s.service.tick(clock(9, 0, 26));
  s.pending[0].reject(Error("completion uncertain"));
  await vi.waitFor(async () =>
    expect((await s.service.state()).runs[1].status).toBe("unknown"),
  );
});
it("does not launch when claim persistence fails", async () => {
  const s = await fixture();
  const service = new s.ArknightsAutomationService({
    ...s.options,
    store: {
      read: s.store.read,
      save: async () => {
        throw Error("disk full");
      },
    },
  });
  await expect(service.tick(clock(9))).rejects.toThrow("disk full");
  expect(s.run).not.toHaveBeenCalled();
});
it("aborts active work on stop and persists uncertainty rather than inventing confirmed cancellation", async () => {
  const s = await fixture();
  await s.service.tick(clock(9));
  const signal = s.run.mock.calls[0][2];
  await s.service.stop();
  expect(signal.aborted).toBe(true);
  expect((await s.service.state()).runs[0].status).toBe("unknown");
  await s.service.tick(clock(21));
  await expect(s.service.runNow({ jobId: "morning" })).rejects.toThrow(/停止/);
  expect(s.run).toHaveBeenCalledTimes(1);
});

it("keeps automatic request IDs reserved so manual execution cannot poison a future claim", async () => {
  const s = await fixture();
  await expect(
    s.service.runNow({
      jobId: "morning",
      requestId: "ark-auto-morning-2026-10-25",
    }),
  ).rejects.toThrow(/编号/);
  expect(s.run).not.toHaveBeenCalled();
  expect((await s.service.state()).runs).toEqual([]);
  await s.service.tick(clock(9));
  expect(s.run).toHaveBeenCalledTimes(1);
});

it("deduplicates concurrent manual admissions and refuses request IDs reused for another job", async () => {
  const s = await fixture(config([job(), job("evening", "20:00")]));
  const admission = deferred<{
    batchId: string;
    completion: Promise<ArknightsAutomationOutcome>;
  }>();
  s.run.mockImplementation(() => admission.promise);
  const first = s.service.runNow({
    jobId: "morning",
    requestId: "manual-concurrent",
  });
  await vi.waitFor(() => expect(s.run).toHaveBeenCalledTimes(1));
  const second = s.service.runNow({
    jobId: "morning",
    requestId: "manual-concurrent",
  });
  admission.resolve({
    batchId: "same-batch",
    completion: new Promise(() => {}),
  });
  expect(await Promise.all([first, second])).toEqual([
    { batchId: "same-batch" },
    { batchId: "same-batch" },
  ]);
  await expect(
    s.service.runNow({ jobId: "evening", requestId: "manual-concurrent" }),
  ).rejects.toThrow(/其他/);
  expect(s.run).toHaveBeenCalledTimes(1);
});

it("does not re-admit an uncertain manual request without a batch receipt after restart", async () => {
  const s = await fixture();
  s.run.mockRejectedValueOnce(Error("admission uncertain"));
  await expect(
    s.service.runNow({ jobId: "morning", requestId: "manual-uncertain" }),
  ).rejects.toThrow("admission uncertain");
  const restarted = new s.ArknightsAutomationService(s.options);
  await expect(
    restarted.runNow({ jobId: "morning", requestId: "manual-uncertain" }),
  ).rejects.toThrow(/未知/);
  expect(s.run).toHaveBeenCalledTimes(1);
});

it("leaves tomorrow scheduled after an ordinary game cancellation", async () => {
  const s = await fixture();
  await s.service.tick(clock(9));
  await finish(s, 0, "cancelled");
  await s.service.tick(clock(9, 0, 26));
  expect(s.run).toHaveBeenCalledTimes(2);
  expect((await s.service.read()).enabled).toBe(true);
});

it("stops without waiting for admission and never turns late completion into confirmed success", async () => {
  const s = await fixture();
  const admission = deferred<{
    batchId: string;
    completion: Promise<ArknightsAutomationOutcome>;
  }>();
  const completion = deferred<ArknightsAutomationOutcome>();
  s.run.mockImplementation(() => admission.promise);
  const ticking = s.service.tick(clock(9));
  await vi.waitFor(() => expect(s.run).toHaveBeenCalledTimes(1));
  await s.service.stop();
  expect(s.run.mock.calls[0][2].aborted).toBe(true);
  expect((await s.service.state()).runs[0].status).toBe("unknown");
  admission.resolve({ batchId: "late-batch", completion: completion.promise });
  await ticking;
  completion.resolve({ status: "succeeded" });
  await vi.waitFor(async () =>
    expect((await s.service.state()).runs[0].batchId).toBe("late-batch"),
  );
  expect((await s.service.state()).runs[0].status).toBe("unknown");
});

it("keeps shutdown uncertainty when its first write fails and completion arrives after disk recovery", async () => {
  const s = await fixture();
  const save = vi.fn(s.store.save);
  const service = new s.ArknightsAutomationService({
    ...s.options,
    store: { read: s.store.read, save },
  });
  await service.tick(clock(9));
  save.mockRejectedValueOnce(Error("disk full"));
  await expect(service.stop()).rejects.toThrow("disk full");
  s.pending[0].resolve({ status: "succeeded" });
  await vi.waitFor(async () =>
    expect((await service.state()).runs[0].status).not.toBe("running"),
  );
  expect((await service.state()).runs[0].status).toBe("unknown");
  expect(s.run.mock.calls[0][2].aborted).toBe(true);
});

it("preserves the original calendar date when the current timezone no longer matches its due timestamp", async () => {
  const { ArknightsAutomationStore } = await load();
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-ark-timezone-"));
  const path = join(dir, "automation.json");
  const run: ArknightsAutomationRun = {
    requestId: "ark-auto-morning-2026-10-24",
    jobId: "morning",
    laneId: "ark-a",
    date: "2026-10-24",
    dueAt: clock(0).toISOString(),
    startedAt: clock(0).toISOString(),
    finishedAt: clock(1).toISOString(),
    source: "scheduled",
    status: "unknown",
  };
  await writeFile(
    path,
    JSON.stringify({ version: 1, config: config(), runs: [run] }),
  );
  expect((await new ArknightsAutomationStore(path).read()).runs[0].date).toBe(
    "2026-10-24",
  );
});

it("rejects confirmed terminal evidence without a batch receipt and impossible calendar dates", async () => {
  const { ArknightsAutomationStore } = await load();
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-ark-evidence-"));
  const store = new ArknightsAutomationStore(join(dir, "automation.json"));
  const run: ArknightsAutomationRun = {
    requestId: "manual-1",
    jobId: "morning",
    laneId: "ark-a",
    date: "2026-10-25",
    dueAt: clock(8).toISOString(),
    startedAt: clock(9).toISOString(),
    finishedAt: clock(10).toISOString(),
    source: "manual",
    status: "succeeded",
  };
  await expect(
    store.save({ version: 1, config: config(), runs: [run] }),
  ).rejects.toThrow();
  await expect(
    store.save({
      version: 1,
      config: config(),
      runs: [{ ...run, status: "unknown", date: "2026-02-30" }],
    }),
  ).rejects.toThrow();
});

it("cancels only selected active lanes synchronously and keeps tomorrow's schedule enabled", async () => {
  const s = await fixture(config([job(), job("other", "08:00", "ark-b")]));
  await s.service.tick(clock(9));
  expect(s.service.cancelActive).toBeTypeOf("function");
  expect(s.service.cancelActive(["ark-a"])).toBeUndefined();
  expect(s.run.mock.calls[0][2].aborted).toBe(true);
  expect(s.run.mock.calls[1][2].aborted).toBe(false);
  // A cancellation signal alone does not confirm what the engine did.
  expect(
    (await s.service.state()).runs.every((run) => run.status === "running"),
  ).toBe(true);
  s.service.cancelActive();
  expect(s.run.mock.calls[1][2].aborted).toBe(true);
  await finish(s, 0, "unknown");
  await finish(s, 1, "cancelled");
  await s.service.tick(clock(9, 0, 26));
  expect(s.run).toHaveBeenCalledTimes(4);
  expect((await s.service.read()).enabled).toBe(true);
});

it.each(["scheduled", "manual"])(
  "cancels a %s claim while its first durable write is pending",
  async (source) => {
    const s = await fixture();
    const writing = deferred<void>();
    const entered = deferred<void>();
    let block = true;
    const service = new s.ArknightsAutomationService({
      ...s.options,
      store: {
        read: s.store.read,
        save: async (value) => {
          if (block) {
            block = false;
            entered.resolve();
            await writing.promise;
          }
          await s.store.save(value);
        },
      },
    });
    const admission =
      source === "manual"
        ? service
            .runNow({ jobId: "morning", requestId: "manual-persist-stop" })
            .catch((error) => error)
        : service.tick(clock(9));
    await entered.promise;
    service.cancelActive(["ark-a"]);
    writing.resolve();
    const receipt = await admission;
    if (source === "scheduled") expect(receipt).toEqual([]);
    else expect(receipt).toBeInstanceOf(Error);
    expect(s.run).not.toHaveBeenCalled();
    expect((await service.state()).runs[0].status).toBe("unknown");
    await service.tick(clock(9, 0, 26));
    expect(s.run).toHaveBeenCalledTimes(1);
  },
);

it.each([159, 160, 161])(
  "validates the combined execution ID length %i before writing a manual claim",
  async (length) => {
    const laneId = "a".repeat(64),
      requestId = "r".repeat(length - laneId.length - 1);
    const s = await fixture(config([job("morning", "08:00", laneId)]));
    const admission = s.service.runNow({ jobId: "morning", requestId });
    if (length > 160) {
      await expect(admission).rejects.toThrow(/编号/);
      expect((await s.service.state()).runs).toEqual([]);
      expect(s.run).not.toHaveBeenCalled();
    } else {
      expect(await admission).toEqual({ batchId: "batch-1" });
      expect(s.run).toHaveBeenCalledTimes(1);
    }
  },
);

it("leaves a disabled account unclaimed and catches up after it becomes eligible without replaying another account", async () => {
  const s = await fixture(config([job(), job("other", "08:00", "ark-b")]));
  let enabled = false;
  const canRunJob = vi.fn(async (item: ArknightsJob) => {
    expect(s.saved().runs.some((run) => run.jobId === item.id)).toBe(false);
    return item.laneId === "ark-b" || enabled;
  });
  const service = new s.ArknightsAutomationService({ ...s.options, canRunJob });
  expect(await service.tick(clock(9))).toHaveLength(1);
  expect((await service.state()).runs.map((run) => run.laneId)).toEqual([
    "ark-b",
  ]);
  s.pending[0].resolve({ status: "succeeded" });
  await vi.waitFor(async () =>
    expect((await service.state()).runs[0].status).toBe("succeeded"),
  );
  enabled = true;
  canRunJob.mockImplementation(async () => true);
  await service.tick(clock(10));
  expect(s.run.mock.calls.map(([item]) => item.laneId)).toEqual([
    "ark-b",
    "ark-a",
  ]);
});

it("does not consume a scheduled or manual opportunity when account eligibility cannot be established", async () => {
  const s = await fixture();
  const canRunJob = vi.fn(async (): Promise<boolean> => {
    throw Error("account store unavailable");
  });
  const service = new s.ArknightsAutomationService({ ...s.options, canRunJob });
  expect(await service.tick(clock(9))).toEqual([]);
  await expect(
    service.runNow({ jobId: "morning", requestId: "same-after-enable" }),
  ).rejects.toThrow(/渠道|账号/);
  expect((await service.state()).runs).toEqual([]);
  expect(s.run).not.toHaveBeenCalled();
  canRunJob.mockImplementation(async () => true);
  expect(
    await service.runNow({ jobId: "morning", requestId: "same-after-enable" }),
  ).toEqual({ batchId: "batch-1" });
});

it.each(["scheduled", "manual"])(
  "cancels pending %s eligibility promptly without claiming or waiting for its store",
  async (source) => {
    const s = await fixture(),
      eligibility = deferred<boolean>();
    const canRunJob = vi.fn(
      (_job: ArknightsJob, _signal?: AbortSignal) => eligibility.promise,
    );
    const service = new s.ArknightsAutomationService({
      ...s.options,
      canRunJob,
    });
    const attempt =
      source === "manual"
        ? service
            .runNow({ jobId: "morning", requestId: "waiting-account" })
            .catch((error) => error)
        : service.tick(clock(9));
    await vi.waitFor(() => expect(canRunJob).toHaveBeenCalledTimes(1));
    service.cancelActive(["ark-a"]);
    const result = await attempt;
    if (source === "scheduled") expect(result).toEqual([]);
    else expect(result).toBeInstanceOf(Error);
    expect(canRunJob.mock.calls[0][1]?.aborted).toBe(true);
    expect((await service.state()).runs).toEqual([]);
    expect(s.run).not.toHaveBeenCalled();
    canRunJob.mockImplementation(async () => true);
    await service.tick(clock(10));
    expect(s.run).toHaveBeenCalledTimes(1);
    eligibility.resolve(true);
    await service.state();
    expect(s.run).toHaveBeenCalledTimes(1);
  },
);

it("does not claim an already checked account cancelled while a different account's eligibility is pending", async () => {
  const s = await fixture(config([job(), job("other", "08:00", "ark-b")])),
    other = deferred<boolean>();
  const canRunJob = vi.fn(async (item: ArknightsJob) =>
    item.laneId === "ark-a" ? true : other.promise,
  );
  const service = new s.ArknightsAutomationService({ ...s.options, canRunJob });
  const tick = service.tick(clock(9));
  await vi.waitFor(() => expect(canRunJob).toHaveBeenCalledTimes(2));
  service.cancelActive(["ark-a"]);
  other.resolve(true);
  expect(await tick).toHaveLength(1);
  expect((await service.state()).runs.map((run) => run.laneId)).toEqual([
    "ark-b",
  ]);
});
