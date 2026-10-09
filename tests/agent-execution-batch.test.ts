import { expect, it, vi } from "vitest";
import { launchAgentBatch } from "../apps/desktop/main/agent-execution-batch";
import type { LaneExecutionSnapshot } from "../apps/desktop/main/lane-snapshot";
const snapshots = ["a", "b"].map(
  (id) => ({ lane: { id } }) as LaneExecutionSnapshot,
);
it("admits all target lanes before any worker starts", async () => {
  const order: string[] = [];
  const lease = { finish: vi.fn(async () => {}) };
  const result = await launchAgentBatch(
    snapshots,
    "batch",
    new AbortController().signal,
    {
      admit: async (s) => {
        order.push(`admit-${s.lane.id}`);
        return lease;
      },
      run: async (s) => {
        order.push(`run-${s.lane.id}`);
      },
    },
  );
  await Promise.all(result.jobs.map((j) => j.job));
  expect(order).toEqual(["admit-a", "admit-b", "run-a", "run-b"]);
});
it("second admission failure releases first and starts no game", async () => {
  const finish = vi.fn(async () => {});
  const run = vi.fn(async () => {});
  await expect(
    launchAgentBatch(snapshots, "batch", new AbortController().signal, {
      admit: async (s) => {
        if (s.lane.id === "b") throw Error("occupied");
        return { finish };
      },
      run,
    }),
  ).rejects.toThrow("occupied");
  expect(finish).toHaveBeenCalledWith("cancelled", expect.any(String));
  expect(run).not.toHaveBeenCalled();
});
it("cancellation during admission cancels all leases and starts no game", async () => {
  const controller = new AbortController();
  const finish = vi.fn(async () => {});
  const run = vi.fn(async () => {});
  await expect(
    launchAgentBatch(snapshots, "batch", controller.signal, {
      admit: async (s) => {
        if (s.lane.id === "b") controller.abort();
        return { finish };
      },
      run,
    }),
  ).rejects.toThrow();
  expect(finish).toHaveBeenCalledTimes(2);
  expect(run).not.toHaveBeenCalled();
});
it("worker failure finishes the lease unknown while sibling proceeds", async () => {
  const finish = vi.fn(async () => {});
  const result = await launchAgentBatch(
    snapshots,
    "batch",
    new AbortController().signal,
    {
      admit: async () => ({ finish }),
      run: async (s) => {
        if (s.lane.id === "a") throw Error("native exit");
      },
    },
  );
  const outcomes = await Promise.allSettled(result.jobs.map((j) => j.job));
  expect(outcomes.map((o) => o.status)).toEqual(["rejected", "fulfilled"]);
  expect(finish).toHaveBeenCalledWith("unknown", expect.any(String));
});
