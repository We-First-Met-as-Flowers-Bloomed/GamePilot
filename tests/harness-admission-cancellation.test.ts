import { expect, it, vi } from "vitest";
import { ChatCommandService } from "../apps/desktop/main/chat-commands";
import { launchAgentBatch } from "../apps/desktop/main/agent-execution-batch";
import { withTrackedAdmission } from "../apps/desktop/main/tracked-admission";
import type { LaneExecutionSnapshot } from "../apps/desktop/main/lane-snapshot";
import type { ChatCommandStore } from "../packages/protocol/chat-commands";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("stopping during the second durable chat admission cancels both leases and starts no games", async () => {
  const snapshots = ["lane-a", "lane-b"].map(
    (id) => ({ lane: { id } }) as LaneExecutionSnapshot,
  );
  const preparations = new Map<string, AbortController>();
  const savingSecond = deferred(),
    finishSaving = deferred();
  const finishA = vi.fn(async () => {}),
    finishB = vi.fn(async () => {});
  const run = vi.fn(async () => {});
  let store: ChatCommandStore | undefined;
  const launch = vi.fn(async (_prepared, view) => {
    const result = await withTrackedAdmission(
      snapshots,
      new AbortController().signal,
      preparations,
      (signal) =>
        launchAgentBatch(snapshots, view.reviewId, signal, {
          admit: async (snapshot) => {
            if (snapshot.lane.id === "lane-b") {
              savingSecond.resolve();
              await finishSaving.promise;
              return { finish: finishB };
            }
            return { finish: finishA };
          },
          run,
        }),
    );
    await Promise.allSettled(result.jobs.map((entry) => entry.job));
    return {
      batchId: view.reviewId,
      requestIds: snapshots.map(
        (snapshot) => `${view.reviewId}:${snapshot.lane.id}`,
      ),
    };
  });
  const host = new ChatCommandService({
    validateSession: async () => "session-a:turn-a",
    prepare: async () => ({
      fingerprint: "frozen",
      summary: [],
      payload: snapshots,
    }),
    save: async (value) => {
      store = structuredClone(value);
    },
    launch,
  });
  const review = await host.review({
    sessionId: "session-a",
    text: "运行保存的日常",
  });
  const input = {
    sessionId: review.sessionId,
    reviewId: review.reviewId,
    revision: review.revision,
  };
  const confirmation = host.confirm(input);
  await savingSecond.promise;
  expect(preparations.size).toBe(2);
  expect(preparations.get("lane-a")).toBe(preparations.get("lane-b"));
  expect(store?.entries[0].status).toBe("unknown");
  // Same synchronous cancellation operations used by the App's stopLanes entrypoint.
  host.cancelPending();
  for (const controller of preparations.values()) controller.abort();
  finishSaving.resolve();
  const result = await confirmation;
  expect(result.status).toBe("unknown");
  expect(result.receipt).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  expect(finishA).toHaveBeenCalledWith("cancelled", expect.any(String));
  expect(finishB).toHaveBeenCalledWith("cancelled", expect.any(String));
  expect(preparations.size).toBe(0);
  expect((await host.confirm(input)).status).toBe("unknown");
  expect(launch).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
});

it("a stop during the final asynchronous review prevents launch after intent was persisted", async () => {
  const preparing = deferred(),
    release = deferred();
  let calls = 0;
  const launch = vi.fn(async () => ({
    batchId: "batch",
    requestIds: ["batch:lane-a"],
  }));
  const host = new ChatCommandService({
    validateSession: async () => "session-a:turn-a",
    prepare: async () => {
      if (++calls === 3) {
        preparing.resolve();
        await release.promise;
      }
      return { fingerprint: "frozen", summary: [], payload: {} };
    },
    save: async () => {},
    launch,
  });
  const review = await host.review({
    sessionId: "session-a",
    text: "运行保存的日常",
  });
  const input = {
    sessionId: review.sessionId,
    reviewId: review.reviewId,
    revision: review.revision,
  };
  const confirmation = host.confirm(input);
  await preparing.promise;
  host.cancelPending();
  release.resolve();
  expect((await confirmation).status).toBe("blocked");
  expect(launch).not.toHaveBeenCalled();
  expect((await host.confirm(input)).status).toBe("blocked");
  expect(launch).not.toHaveBeenCalled();
});
