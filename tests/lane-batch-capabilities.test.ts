import { expect, it, vi } from "vitest";
import { launchIndependentLanes } from "../apps/desktop/main/lane-batch";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import { createFixtureSnapshot } from "../packages/agent/fixture";

it.each([false, true])(
  "starts the compatible account regardless of the rejected account order (reverse=%s)",
  async (reverse) => {
    const snapshot = createFixtureSnapshot();
    const lanes = snapshot.lanes!.lanes;
    const profiles = snapshot.profiles!;
    profiles.profiles[0].signInEvent = true;
    if (reverse) lanes.reverse();
    const started: string[] = [];
    const pendingJob = new Promise<void>(() => {});
    const result = await launchIndependentLanes(
      lanes,
      "batch",
      async (lane, batchId) => {
        expect(batchId).toBe("batch");
        freezeLaneExecution(lane, profiles, false);
        started.push(lane.id);
        return { job: pendingJob };
      },
    );
    expect(started).toEqual(["lane-b"]);
    expect(result).toEqual({
      batchId: "batch",
      issues: [
        { laneId: "lane-a", message: expect.stringContaining("限时签到") },
      ],
    });
    expect(result.issues![0].message).toContain(
      lanes.find((lane) => lane.id === "lane-a")!.name,
    );
  },
);

it("rejects all-incompatible batches clearly instead of returning a success receipt", async () => {
  const snapshot = createFixtureSnapshot();
  const lanes = snapshot.lanes!.lanes;
  const profiles = snapshot.profiles!;
  for (const profile of profiles.profiles) profile.signInEvent = true;
  const started = vi.fn();
  await expect(
    launchIndependentLanes(lanes, "batch", async (lane) => {
      freezeLaneExecution(lane, profiles, false);
      started();
    }),
  ).rejects.toThrow(/未启动任何账号.*限时签到/);
  expect(started).not.toHaveBeenCalled();
});

it("preserves the existing stop-on-error behavior for non-capability failures", async () => {
  const snapshot = createFixtureSnapshot();
  const fault = new Error("global admission unavailable");
  const launch = vi.fn(async () => {
    throw fault;
  });
  await expect(
    launchIndependentLanes(snapshot.lanes!.lanes, "batch", launch),
  ).rejects.toBe(fault);
  expect(launch).toHaveBeenCalledOnce();
});

it("keeps the successful response shape when all accounts are accepted", async () => {
  const snapshot = createFixtureSnapshot();
  const launch = vi.fn(async () => {});
  await expect(
    launchIndependentLanes(snapshot.lanes!.lanes, "batch", launch),
  ).resolves.toEqual({ batchId: "batch" });
  expect(launch).toHaveBeenCalledTimes(2);
});
