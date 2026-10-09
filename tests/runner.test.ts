import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { Runner } from "../packages/runtime/runner";
import type { RunEvent, Game } from "../packages/protocol";
import {
  reduceTaskRecords,
  validateTaskRecord,
} from "../packages/protocol/task-record";
const game: Game = {
  id: "test",
  name: "test",
  subtitle: "",
  skills: ["a", "b"].map((id) => ({
    id,
    title: id,
    description: "",
    ready: true,
  })),
};
const plan = { gameId: "test", skillIds: ["a", "b"], mode: "live" as const };
describe("run lifecycle", () => {
  it("stopping during failure capture keeps the original failure instead of rewriting it as cancelled", async () => {
    const events: RunEvent[] = [];
    let started!: () => void;
    const capturing = new Promise<void>((done) => {
      started = done;
    });
    const runner = new Runner(
      [game],
      (e) => events.push(e),
      async () => {
        throw Error("original failure");
      },
      async (signal) => {
        started();
        return new Promise((resolve) =>
          signal.addEventListener(
            "abort",
            () => resolve({ status: "unavailable" }),
            { once: true },
          ),
        );
      },
    );
    const run = runner.start(plan);
    await capturing;
    await runner.stop();
    await run.finished;
    expect(events.at(-1)?.status).toBe("failed");
    expect(events.at(-1)?.message).toContain("original failure");
    expect(events.find((e) => e.fault)?.fault?.code).toBe("skill-exception");
  });
  it("ends a hung capture after five seconds and retains the failure", async () => {
    vi.useFakeTimers();
    try {
      const events: RunEvent[] = [];
      let captureSignal: AbortSignal | undefined;
      const runner = new Runner(
        [game],
        (e) => events.push(e),
        async () => {
          throw Error("failed");
        },
        async (signal) => {
          captureSignal = signal;
          return new Promise(() => {});
        },
      );
      const run = runner.start(plan);
      await vi.advanceTimersByTimeAsync(5100);
      await run.finished;
      expect(captureSignal?.aborted).toBe(true);
      expect(runner.busy).toBe(false);
      expect(events.find((e) => e.fault)?.fault?.capture.status).toBe(
        "unavailable",
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps the lock while collecting failure evidence, persists it and never runs later steps", async () => {
    const events: RunEvent[] = [];
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const runner = new Runner(
      [game],
      (e) => events.push(e),
      async () => {
        throw Error("PRIVATE");
      },
      async () => {
        await pending;
        return { status: "unavailable" as const };
      },
    );
    const run = runner.start(plan);
    await delay(10);
    expect(runner.busy).toBe(true);
    expect(() => runner.start(plan)).toThrow();
    release();
    await run.finished;
    const event = events.find((e) => e.fault);
    expect(event?.fault).toMatchObject({
      code: "skill-exception",
      runId: run.runId,
      skillId: "a",
      capture: { status: "unavailable" },
    });
    expect(events.some((e) => e.skillId === "b")).toBe(false);
    const records = events.reduce(reduceTaskRecords, []);
    expect(validateTaskRecord(records[0]).fault).toEqual(event?.fault);
    expect(events.at(-1)?.status).toBe("failed");
  });
  it("a capture failure cannot replace the original error and cancellation never triggers capture", async () => {
    const events: RunEvent[] = [];
    let calls = 0;
    const runner = new Runner(
      [game],
      (e) => events.push(e),
      async () => {
        throw Error("original");
      },
      async () => {
        calls++;
        throw Error("capture error");
      },
    );
    await runner.start(plan).finished;
    expect(calls).toBe(1);
    expect(events.at(-1)?.message).toContain("original");
    expect(events.find((e) => e.fault)?.fault?.capture.status).toBe(
      "unavailable",
    );
    const cancelled = new Runner(
      [game],
      () => {},
      async (_, signal) => {
        await delay(2000, undefined, { signal });
      },
      async () => {
        calls++;
        return { status: "unavailable" as const };
      },
    );
    cancelled.start(plan);
    await delay(10);
    await cancelled.stop();
    expect(calls).toBe(1);
  });
  it("records an immutable plan and explicit step outcomes before later failure", async () => {
    const events: RunEvent[] = [];
    const input = { ...plan, skillIds: [...plan.skillIds] };
    const runner = new Runner(
      [game],
      (e) => events.push(e),
      async (id) => {
        if (id === "b") throw Error("page unknown");
        return { status: "skipped", summary: "already claimed" };
      },
    );
    const run = runner.start(input);
    input.skillIds.reverse();
    await run.finished;
    expect(events.find((e) => e.plan)?.plan?.skillIds).toEqual(["a", "b"]);
    expect(
      events.filter((e) => e.stepStatus).map((e) => [e.skillId, e.stepStatus]),
    ).toEqual([
      ["a", "running"],
      ["a", "skipped"],
      ["b", "running"],
      ["b", "failed"],
    ]);
  });
  it("records cancellation without claiming the active step completed", async () => {
    const events: RunEvent[] = [];
    const runner = new Runner(
      [game],
      (e) => events.push(e),
      async (_, signal) => {
        await delay(5000, undefined, { signal });
      },
    );
    const run = runner.start(plan);
    await delay(10);
    await runner.stop();
    await run.finished;
    expect(events.filter((e) => e.stepStatus).map((e) => e.stepStatus)).toEqual(
      ["running", "cancelled"],
    );
    expect(events.some((e) => e.skillId === "b")).toBe(false);
  });
  it("publishes a verified result before a later skill fails", async () => {
    const events: RunEvent[] = [];
    const result = {
      outcome: "active",
      observedAt: "2026-09-21T00:00:00Z",
      nextRunAt: "2026-09-21T01:00:00Z",
    };
    const runner = new Runner(
      [game],
      (event) => events.push(event),
      async (id) => {
        if (id === "b") throw new Error("later failure");
        return result;
      },
    );
    const run = runner.start(plan);
    await run.finished;
    expect(events.filter((event) => event.result)).toEqual([
      expect.objectContaining({
        runId: run.runId,
        gameId: "test",
        type: "log",
        skillId: "a",
        result,
      }),
    ]);
    expect(events.at(-1)?.status).toBe("failed");
  });
  it("does not publish a result when cancellation arrives during execution", async () => {
    const events: RunEvent[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = new Runner(
      [game],
      (event) => events.push(event),
      async () => {
        await pending;
        return { outcome: "active" };
      },
    );
    const run = runner.start(plan);
    await Promise.resolve();
    const stopped = runner.stop();
    release();
    await stopped;
    await run.finished;
    expect(events.some((event) => event.result)).toBe(false);
    expect(events.at(-1)?.status).toBe("cancelled");
  });
  it("executes in order and reports success only after execution", async () => {
    const calls: string[] = [],
      events: RunEvent[] = [];
    const runner = new Runner(
      [game],
      (event) => events.push(event),
      async (id) => {
        calls.push(id);
      },
    );
    await runner.start(plan).finished;
    expect(calls).toEqual(["a", "b"]);
    expect(events.at(-1)?.status).toBe("succeeded");
    expect(runner.busy).toBe(false);
  });
  it("stops before later actions and confirms cancellation", async () => {
    const calls: string[] = [],
      events: RunEvent[] = [];
    const runner = new Runner(
      [game],
      (event) => events.push(event),
      async (id, signal) => {
        calls.push(id);
        await delay(5000, undefined, { signal });
      },
    );
    const run = runner.start(plan);
    await delay(10);
    await runner.stop();
    await run.finished;
    expect(calls).toEqual(["a"]);
    expect(events.some((e) => e.status === "stopping")).toBe(true);
    expect(events.at(-1)?.status).toBe("cancelled");
  });
  it("rejects concurrent runs on the device", async () => {
    const runner = new Runner(
      [game],
      () => {},
      async (_, signal) => {
        await delay(5000, undefined, { signal });
      },
    );
    const run = runner.start(plan);
    expect(() => runner.start(plan)).toThrow("运行");
    await runner.stop();
    await run.finished;
  });
  it("does not misreport failures as success", async () => {
    const events: RunEvent[] = [];
    const runner = new Runner(
      [game],
      (e) => events.push(e),
      async () => {
        throw new Error("disconnected");
      },
    );
    await runner.start(plan).finished;
    expect(events.at(-1)?.status).toBe("failed");
    expect(events.at(-1)?.message).toContain("disconnected");
  });
  it("never invokes the engine during rehearsal", async () => {
    let calls = 0;
    const runner = new Runner(
      [game],
      () => {},
      async () => {
        calls++;
      },
    );
    const run = runner.start({ ...plan, mode: "rehearsal" });
    await runner.stop();
    await run.finished;
    expect(calls).toBe(0);
  });
});
