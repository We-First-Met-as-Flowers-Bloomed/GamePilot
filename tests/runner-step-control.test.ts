import { expect, it, vi } from "vitest";
import { Runner } from "../packages/runtime/runner";
import type { Game, Plan, RunEvent, SkillResult } from "../packages/protocol";
import {
  reduceTaskRecords,
  validateTaskRecord,
} from "../packages/protocol/task-record";

const game: Game = {
  id: "test",
  name: "test",
  subtitle: "",
  skills: ["a", "b", "c"].map((id) => ({
    id,
    title: id,
    description: "",
    ready: true,
  })),
};
const plan: Plan = { gameId: "test", skillIds: ["a", "b", "c"], mode: "live" };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function controlledRun(input = plan) {
  const started = deferred<void>(),
    completion = deferred<SkillResult | void>();
  const events: RunEvent[] = [],
    calls: string[] = [];
  let activeSignal!: AbortSignal;
  const runner = new Runner(
    [game],
    (event) => events.push(event),
    async (id, signal, _log, receivedPlan) => {
      calls.push(id);
      expect(receivedPlan).toEqual(input);
      activeSignal = signal;
      signal.addEventListener("abort", () => completion.reject(signal.reason), {
        once: true,
      });
      started.resolve();
      return completion.promise;
    },
  );
  const run = runner.start(input);
  return {
    runner,
    run,
    started: started.promise,
    completion,
    calls,
    events,
    signal: () => activeSignal,
  };
}
it("queues a bounded pause, preserves the completed step, and leaves the suffix not run", async () => {
  const h = controlledRun();
  expect(h.runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  await h.started;
  expect(h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 })).toEqual({
    runId: h.run.runId,
    revision: 1,
    status: "queued",
  });
  expect(h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 })).toEqual({
    runId: h.run.runId,
    revision: 1,
    status: "queued",
  });
  expect(h.signal().aborted).toBe(false);
  h.completion.resolve({ status: "succeeded", summary: "step completed" });
  await h.run.finished;
  expect(h.calls).toEqual(["a"]);
  expect(h.events.at(-1)).toMatchObject({
    status: "cancelled",
    stepControl: { runId: h.run.runId, revision: 1, status: "applied" },
  });
  expect(h.events.at(-1)?.message).toContain("步骤边界暂停");
  const record = validateTaskRecord(h.events.reduce(reduceTaskRecords, [])[0]);
  expect(record.steps.map((step) => [step.skillId, step.status])).toEqual([
    ["a", "succeeded"],
    ["b", "not-run"],
    ["c", "not-run"],
  ]);
  expect(record.plan).toEqual(plan);
  expect(record.fault).toBeUndefined();
  expect(
    h.events.filter((event) => event.message.includes("暂停请求已排队")),
  ).toHaveLength(1);
});
it("rejects a different run, wrong revision and extra permissions without changing the active execution", async () => {
  const h = controlledRun();
  expect(h.runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  await h.started;
  for (const input of [
    { runId: "different-run", revision: 1 },
    { runId: h.run.runId, revision: 2 },
    { runId: h.run.runId, revision: 1, skillIds: ["c"] },
    { runId: h.run.runId, revision: 1, medicine: 1 },
  ])
    expect(() => h.runner.pauseAfterStep(input)).toThrow();
  const stopping = h.runner.stop();
  await stopping;
  expect(h.events.some((event) => "stepControl" in event)).toBe(false);
});
it("never reports an immediate stop as an applied boundary pause", async () => {
  const h = controlledRun();
  expect(h.runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  await h.started;
  h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 });
  const stop = h.runner.stop();
  expect(() =>
    h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 }),
  ).toThrow();
  await stop;
  expect(h.events.at(-1)?.status).toBe("cancelled");
  expect(h.events.at(-1)?.message).not.toContain("暂停");
  expect(h.events.at(-1)).not.toHaveProperty("stepControl");
  expect(
    h.events
      .filter((event) => event.stepStatus)
      .map((event) => event.stepStatus),
  ).toEqual(["running", "cancelled"]);
});
it("retains native submitted unknown evidence when the current step fails after a pause request", async () => {
  const started = deferred<void>(),
    completion = deferred<void>(),
    events: RunEvent[] = [],
    calls: string[] = [];
  const unknown = {
    arknights: {
      version: 1 as const,
      taskType: "Mall",
      submission: "submitted" as const,
      completion: "unknown" as const,
      observedAt: new Date().toISOString(),
    },
  };
  const runner = new Runner(
    [game],
    (event) => events.push(event),
    async (id, _signal, log) => {
      calls.push(id);
      started.resolve();
      await completion.promise;
      log("native outcome unknown", unknown);
      throw Error("native result unconfirmed");
    },
  );
  expect(runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  const run = runner.start(plan);
  await started.promise;
  runner.pauseAfterStep({ runId: run.runId, revision: 1 });
  completion.resolve();
  await run.finished;
  const record = validateTaskRecord(events.reduce(reduceTaskRecords, [])[0]);
  expect(calls).toEqual(["a"]);
  expect(events.at(-1)?.status).toBe("failed");
  expect(events.at(-1)).not.toHaveProperty("stepControl");
  expect(record.steps[0].status).toBe("failed");
  expect(record.steps[0].result?.arknights).toEqual(unknown.arknights);
  expect(record.steps.slice(1).every((step) => step.status === "not-run")).toBe(
    true,
  );
});
it("a boundary command received during the completed-step event prevents the next step", async () => {
  const events: RunEvent[] = [],
    calls: string[] = [];
  let runId = "";
  const runner = new Runner(
    [game],
    (event) => {
      events.push(event);
      if (event.type === "step" && event.stepStatus === "succeeded")
        runner.pauseAfterStep({ runId, revision: 1 });
    },
    async (id) => {
      calls.push(id);
    },
  );
  expect(runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  const run = runner.start(plan);
  runId = run.runId;
  await run.finished;
  expect(calls).toEqual(["a"]);
  expect(events.at(-1)).toMatchObject({
    status: "cancelled",
    stepControl: { status: "applied" },
  });
});
it("a pause during the last step blocks the next game while retaining completed steps", async () => {
  const h = controlledRun({ ...plan, skillIds: ["a"] });
  expect(h.runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  await h.started;
  h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 });
  h.completion.resolve();
  await h.run.finished;
  expect(h.events.at(-1)?.status).toBe("cancelled");
  expect(h.events.at(-1)).toHaveProperty("stepControl.status", "applied");
  expect(
    h.events.find((event) => event.stepStatus === "succeeded"),
  ).toBeTruthy();
  expect(() =>
    h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 }),
  ).toThrow();
});
it("refuses ended runs and does not let a stale run control a replacement", async () => {
  const events: RunEvent[] = [],
    runner = new Runner(
      [game],
      (event) => events.push(event),
      async () => {},
    );
  expect(runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  expect(() =>
    runner.pauseAfterStep({ runId: "missing", revision: 1 }),
  ).toThrow();
  const old = runner.start(plan);
  await old.finished;
  const current = runner.start(plan);
  expect(() =>
    runner.pauseAfterStep({ runId: old.runId, revision: 1 }),
  ).toThrow();
  await current.finished;
  expect(events.filter((event) => "stepControl" in event)).toHaveLength(0);
});
it("does not queue a boundary pause during failure evidence capture", async () => {
  const capturing = deferred<void>(),
    captured = deferred<{ status: "unavailable" }>();
  const runner = new Runner(
    [game],
    () => {},
    async () => {
      throw Error("failure");
    },
    async () => {
      capturing.resolve();
      return captured.promise;
    },
  );
  expect(runner).toHaveProperty("pauseAfterStep", expect.any(Function));
  const run = runner.start(plan);
  await capturing.promise;
  expect(() =>
    runner.pauseAfterStep({ runId: run.runId, revision: 1 }),
  ).toThrow();
  captured.resolve({ status: "unavailable" });
  await run.finished;
});
it("does not let callers mutate the queued receipt or queue a second command", async () => {
  const h = controlledRun();
  await h.started;
  const receipt = h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 });
  receipt.status = "applied";
  expect(
    h.runner.pauseAfterStep({ runId: h.run.runId, revision: 1 }).status,
  ).toBe("queued");
  h.completion.resolve({ status: "skipped", summary: "already complete" });
  await h.run.finished;
  const record = validateTaskRecord(h.events.reduce(reduceTaskRecords, [])[0]);
  expect(record.steps[0].status).toBe("skipped");
  expect(record.steps[1].status).toBe("not-run");
});
it("immediate stop at the completed-step boundary takes precedence over a queued pause", async () => {
  const completed = deferred<void>(),
    started = deferred<void>(),
    events: RunEvent[] = [];
  let stopping: Promise<void> | undefined;
  const runner = new Runner(
    [game],
    (event) => {
      events.push(event);
      if (event.stepStatus === "succeeded") stopping = runner.stop();
    },
    async () => {
      started.resolve();
      await completed.promise;
    },
  );
  const run = runner.start(plan);
  await started.promise;
  runner.pauseAfterStep({ runId: run.runId, revision: 1 });
  completed.resolve();
  await run.finished;
  await stopping;
  expect(events.at(-1)).toMatchObject({ status: "cancelled" });
  expect(events.at(-1)).not.toHaveProperty("stepControl");
  expect(events.at(-1)?.message).not.toContain("暂停");
  const record = validateTaskRecord(events.reduce(reduceTaskRecords, [])[0]);
  expect(record.steps[0].status).toBe("succeeded");
  expect(record.steps[1].status).toBe("not-run");
});
it("stop after the applied terminal event cannot append a misleading stopping state", async () => {
  const completed = deferred<void>(),
    started = deferred<void>(),
    events: RunEvent[] = [];
  let stopping: Promise<void> | undefined;
  const runner = new Runner(
    [game],
    (event) => {
      events.push(event);
      if (event.stepControl?.status === "applied") stopping = runner.stop();
    },
    async () => {
      started.resolve();
      await completed.promise;
    },
  );
  const run = runner.start(plan);
  await started.promise;
  runner.pauseAfterStep({ runId: run.runId, revision: 1 });
  completed.resolve();
  await run.finished;
  await stopping;
  expect(events.at(-1)).toMatchObject({
    status: "cancelled",
    stepControl: { status: "applied" },
  });
  expect(events.some((event) => event.status === "stopping")).toBe(false);
});
it("routes a worker pause command to the actual runner during software-only rehearsal", async () => {
  const responses: {
    id?: string;
    result?: unknown;
    error?: string;
    event?: RunEvent;
  }[] = [];
  let receive!: (message: {
    data: { id: string; method: string; payload?: unknown };
  }) => void;
  const workerProcess = process as unknown as { parentPort?: unknown },
    previousPort = workerProcess.parentPort;
  workerProcess.parentPort = {
    on: (_name: string, callback: typeof receive) => {
      receive = callback;
    },
    postMessage: (message: (typeof responses)[number]) =>
      responses.push(message),
  };
  // A rehearsal must never load the native device engine.
  vi.doMock("../packages/runtime/maa", () => {
    throw Error("native device access forbidden in software rehearsal");
  });
  try {
    await import("../packages/runtime/worker");
    receive({
      data: {
        id: "start",
        method: "start",
        payload: {
          gameId: "onmyoji",
          skillIds: ["login", "check-in"],
          mode: "rehearsal",
        },
      },
    });
    await vi.waitFor(() =>
      expect(
        responses.find((response) => response.id === "start")?.result,
      ).toBeDefined(),
    );
    const runId = (
      responses.find((response) => response.id === "start")!.result as {
        runId: string;
      }
    ).runId;
    receive({
      data: {
        id: "pause",
        method: "pause-after-step",
        payload: { runId, revision: 1 },
      },
    });
    await vi.waitFor(() =>
      expect(
        responses.find((response) => response.id === "pause")?.result,
      ).toEqual({ runId, revision: 1, status: "queued" }),
    );
    await vi.waitFor(
      () =>
        expect(
          responses.find(
            (response) => response.event?.stepControl?.status === "applied",
          )?.event,
        ).toMatchObject({ runId, status: "cancelled" }),
      { timeout: 3000 },
    );
    const events = responses.flatMap((response) =>
      response.event ? [response.event] : [],
    );
    const record = validateTaskRecord(events.reduce(reduceTaskRecords, [])[0]);
    expect(record.plan.mode).toBe("rehearsal");
    expect(record.steps.map((step) => step.status)).toEqual([
      "succeeded",
      "not-run",
    ]);
    receive({
      data: {
        id: "ended-pause",
        method: "pause-after-step",
        payload: { runId, revision: 1 },
      },
    });
    await vi.waitFor(() =>
      expect(
        responses.find((response) => response.id === "ended-pause")?.error,
      ).toContain("没有正在执行"),
    );
  } finally {
    receive?.({ data: { id: "cleanup", method: "stop" } });
    if (previousPort === undefined) delete workerProcess.parentPort;
    else workerProcess.parentPort = previousPort;
    vi.doUnmock("../packages/runtime/maa");
    vi.resetModules();
  }
});
