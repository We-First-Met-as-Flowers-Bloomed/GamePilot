import { expect, it, vi } from "vitest";
import { startupRecoveryFixture } from "./startup-recovery-fixture";
import { mergeExecutionProgress } from "../games/execution-progress";
import type { Plan } from "../packages/protocol";

it.each([{ skills: ["login"] }, { skills: ["login", "award"] }])(
  "continues only the unsubmitted lane with frozen $skills while retaining its successful sibling",
  async ({ skills }) => {
    const s = startupRecoveryFixture(skills);
    const original = structuredClone(s.records);
    const preview = await s.continuation.preview(s.parent.id);
    expect(preview.canContinue).toBe(true);
    const launch = vi.fn(async () => {});
    const receipt = await s.continuation.start(
      {
        parentId: s.parent.id,
        fingerprint: preview.fingerprint,
        selections: preview.defaults,
        acknowledgePartial: true,
      },
      launch,
    );
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(s.records.slice(0, 2)).toEqual(original);
    const child = s.records.find((r) => r.id === receipt.requestId)!;
    expect(child.laneId).toBe("lane-b");
    expect(child.snapshot.arknightsPlan).toEqual(
      s.parent.snapshot.arknightsPlan,
    );
    child.status = "succeeded";
    child.finishedAt = "2026-10-08T11:08:00.000Z";
    s.tasks.push(s.succeeded(child));
    const details = new Map(s.records.map((r) => [r.id, s.details.get(r.id)]));
    const progress = mergeExecutionProgress(
      s.parent.id,
      s.records,
      details,
      [],
      s.tasks,
    );
    expect(progress.warnings).toEqual([]);
    expect(progress.wholePlanComplete).toBe(true);
    expect(s.parent.status).toBe("failed");
  },
);

it("rechecks the full ledger after asynchronous device admission", async () => {
  const s = startupRecoveryFixture();
  const preview = await s.continuation.preview(s.parent.id);
  expect(preview.canContinue).toBe(true);
  s.assertCanStart.mockImplementation(async () => {
    s.tasks.push(s.succeeded(s.parent));
  });
  const launch = vi.fn(async () => {});
  await expect(
    s.continuation.start(
      {
        parentId: s.parent.id,
        fingerprint: preview.fingerprint,
        selections: preview.defaults,
        acknowledgePartial: true,
      },
      launch,
    ),
  ).rejects.toThrow();
  expect(s.executions.begin).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});

it.each(["uid", "device", "client"])(
  "refuses a changed current %s binding",
  async (change) => {
    const s = startupRecoveryFixture();
    if (change === "uid") s.currentProfile.expectedUid = "111111111";
    else if (change === "device") s.currentLane.instance = 3;
    else s.currentProfile.clientType = "Bilibili";
    expect((await s.continuation.preview(s.parent.id)).canContinue).toBe(false);
  },
);

it.each(["orphan-task", "new-request", "binding"])(
  "rejects a late %s before acquiring the continuation lease",
  async (change) => {
    const s = startupRecoveryFixture();
    const preview = await s.continuation.preview(s.parent.id);
    expect(preview.canContinue).toBe(true);
    s.assertCanStart.mockImplementation(async () => {
      if (change === "orphan-task") {
        const task = s.succeeded(s.parent);
        task.executionId = undefined;
        task.laneId = undefined;
        s.tasks.push(task);
      } else if (change === "new-request") {
        s.records.push({
          ...structuredClone(s.parent),
          id: "external:lane-b",
          batchId: "external",
          startedAt: "2026-10-08T11:06:30.000Z",
          finishedAt: "2026-10-08T11:06:50.000Z",
        });
      } else s.currentProfile.expectedUid = "111111111";
    });
    const launch = vi.fn(async () => {});
    await expect(
      s.continuation.start(
        {
          parentId: s.parent.id,
          fingerprint: preview.fingerprint,
          selections: preview.defaults,
          acknowledgePartial: true,
        },
        launch,
      ),
    ).rejects.toThrow();
    expect(s.executions.begin).not.toHaveBeenCalled();
  },
);

it("does not turn a manual partial continuation into automatic startup recovery", async () => {
  const s = startupRecoveryFixture(["login", "friends", "award"]);
  const older = {
    ...structuredClone(s.parent),
    id: "earlier:lane-b",
    batchId: "earlier",
    status: "succeeded" as const,
    startupFault: undefined,
    startedAt: "2026-10-08T10:00:00.000Z",
    finishedAt: "2026-10-08T10:01:00.000Z",
  };
  (older.snapshot.arknightsPlan as Plan).skillIds = ["login", "friends"];
  s.records.push(older);
  s.tasks.push(s.succeeded(older));
  const preview = await s.continuation.preview(s.parent.id);
  expect(preview.canContinue).toBe(true);
  expect(preview.needsAcknowledgement).toBe(true);
  expect(preview.defaults).toEqual([
    { gameId: "arknights", skillIds: ["award"] },
  ]);
  expect(await s.continuation.startupRecovery(s.parent.id)).toBeUndefined();
});
