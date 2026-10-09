import { expect, it, vi } from "vitest";
import { AgentExecutionService } from "../apps/desktop/main/agent-execution";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import { createFixtureSnapshot } from "../packages/agent/fixture";

const target = { requestId: "planner-1", planHash: "a".repeat(64) };
it("reviews an Onmyoji-only frozen subset without inventing an Arknights profile", async () => {
  const t = setup();
  const { snapshots } = await t.validate();
  snapshots[0].lane.arknights.enabled = false;
  snapshots[0].lane.onmyoji.enabled = true;
  delete snapshots[0].arknightsPlan;
  delete snapshots[0].profile;
  snapshots[0].onmyojiPlan = {
    gameId: "onmyoji",
    skillIds: ["login", "mail"],
    mode: "live",
  };
  const review = await t.service.review(target);
  expect(review).toMatchObject({
    status: "ready",
    lanes: [
      {
        gameId: "onmyoji",
        skillIds: ["login", "mail"],
        games: [
          { gameId: "onmyoji", skillIds: ["login", "mail"], parameters: {} },
        ],
      },
    ],
  });
  expect(t.launch).not.toHaveBeenCalled();
});
it("validates identical normalized targets in review and confirmation", async () => {
  const t = setup();
  const { snapshots } = await t.validate();
  t.validate.mockImplementation(async (...args: unknown[]) => ({
    fingerprint: JSON.stringify(args[0]),
    snapshots,
  }));
  const review = await t.service.review(target);
  expect(
    (await t.service.confirm({ ...target, reviewId: review.reviewId! })).status,
  ).toBe("running");
  expect(t.launch).toHaveBeenCalledOnce();
  t.complete();
});
function setup() {
  let now = new Date("2026-09-27T08:00:00Z");
  const fixture = createFixtureSnapshot();
  fixture.lanes!.lanes[0].onmyoji.enabled = false;
  const snapshots = [
    freezeLaneExecution(fixture.lanes!.lanes[0], fixture.profiles!, false, now),
  ];
  let complete!: () => void;
  let fail!: (error: Error) => void;
  const job = new Promise<void>((yes, no) => {
    complete = yes;
    fail = no;
  });
  const validate = vi.fn(async () => ({ fingerprint: "stable", snapshots }));
  const launch = vi.fn(async () => ({
    jobs: [{ laneId: snapshots[0].lane.id, job }],
  }));
  const stop = vi.fn(async () => {});
  const service = new AgentExecutionService({
    validate,
    launch,
    stop,
    now: () => now,
  });
  return {
    service,
    validate,
    launch,
    stop,
    complete,
    fail,
    setNow: (v: Date) => {
      now = v;
    },
  };
}
it("review is read-only, confirm launches once, and reports observed job completion", async () => {
  const t = setup();
  const review = await t.service.review(target);
  expect(review.status).toBe("ready");
  expect(t.launch).not.toHaveBeenCalled();
  const confirmation = { ...target, reviewId: review.reviewId! };
  await Promise.all([
    t.service.confirm(confirmation),
    t.service.confirm(confirmation),
  ]);
  expect(t.launch).toHaveBeenCalledTimes(1);
  expect(t.service.snapshot().status).toBe("running");
  t.complete();
  await vi.waitFor(() => expect(t.service.snapshot().status).toBe("succeeded"));
  await t.service.confirm(confirmation);
  expect(t.launch).toHaveBeenCalledTimes(1);
  await expect(t.service.review(target)).rejects.toThrow();
});
it("rejects expired and mismatched confirmation tickets without launching", async () => {
  const t = setup();
  const review = await t.service.review(target);
  await expect(
    t.service.confirm({ ...target, reviewId: "other" }),
  ).rejects.toThrow();
  t.setNow(new Date("2026-09-27T08:03:00Z"));
  expect(
    (await t.service.confirm({ ...target, reviewId: review.reviewId! })).status,
  ).toBe("blocked");
  expect(t.launch).not.toHaveBeenCalled();
});
it("rechecks private configuration and ledger before admission", async () => {
  const t = setup();
  const review = await t.service.review(target);
  const previous = await t.validate();
  t.validate.mockResolvedValue({ ...previous, fingerprint: "changed" });
  expect(
    (await t.service.confirm({ ...target, reviewId: review.reviewId! })).status,
  ).toBe("blocked");
  expect(t.launch).not.toHaveBeenCalled();
});
it("matching confirmation retries expose current state before host busy guards", async () => {
  const t = setup();
  const review = await t.service.review(target);
  const value = await t.validate();
  let release!: (v: typeof value) => void;
  t.validate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const input = { ...target, reviewId: review.reviewId! };
  const first = t.service.confirm(input);
  expect(t.service.existingConfirmation(input)?.status).toBe("starting");
  expect(
    t.service.existingConfirmation({ ...input, reviewId: "different" }),
  ).toBeUndefined();
  release(value);
  await first;
  t.complete();
});
it("cancel during asynchronous validation never starts a worker", async () => {
  const t = setup();
  const value = await t.validate();
  let release!: (v: typeof value) => void;
  t.validate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const reviewing = t.service.review(target);
  await t.service.cancel(target.requestId);
  await expect(
    t.service.review({ ...target, requestId: "replacement" }),
  ).rejects.toThrow();
  release(value);
  expect((await reviewing).status).toBe("cancelled");
  expect(t.launch).not.toHaveBeenCalled();
});
it("cancellation while confirmation is validating cannot admit", async () => {
  const t = setup();
  const review = await t.service.review(target);
  const value = await t.validate();
  let release!: (v: typeof value) => void;
  t.validate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const confirming = t.service.confirm({
    ...target,
    reviewId: review.reviewId!,
  });
  await t.service.cancel(target.requestId);
  expect(t.stop).not.toHaveBeenCalled();
  release(value);
  expect((await confirming).status).toBe("cancelled");
  expect(t.launch).not.toHaveBeenCalled();
});
it("admission failure consumes the request even when IPC is retried", async () => {
  const t = setup();
  const review = await t.service.review(target);
  t.launch.mockRejectedValue(new Error("disk failure"));
  const input = { ...target, reviewId: review.reviewId! };
  expect((await t.service.confirm(input)).status).toBe("unknown");
  await t.service.confirm(input);
  expect(t.launch).toHaveBeenCalledTimes(1);
  await expect(t.service.review(target)).rejects.toThrow();
});
it("cancel starts immediately, remains stopping until job settles, and cannot replay", async () => {
  const t = setup();
  const review = await t.service.review(target);
  await t.service.confirm({ ...target, reviewId: review.reviewId! });
  await t.service.cancel(target.requestId);
  expect(t.stop).toHaveBeenCalledTimes(1);
  expect(t.service.snapshot().status).toBe("stopping");
  t.fail(new DOMException("cancelled", "AbortError"));
  await vi.waitFor(() => expect(t.service.snapshot().status).toBe("cancelled"));
});
it("job failure remains unknown and raw remote errors are not exposed", async () => {
  const t = setup();
  const review = await t.service.review(target);
  await t.service.confirm({ ...target, reviewId: review.reviewId! });
  t.fail(new Error("private diagnostic text"));
  await vi.waitFor(() => expect(t.service.snapshot().status).toBe("unknown"));
  expect(JSON.stringify(t.service.snapshot())).not.toContain(
    "private diagnostic",
  );
});
it("malformed renderer input and overlapping reviews cannot replace active state", async () => {
  const t = setup();
  await expect(t.service.review({ ...target, plan: {} })).rejects.toThrow();
  const value = await t.validate();
  let release!: (v: typeof value) => void;
  t.validate.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const one = t.service.review(target);
  await expect(
    t.service.review({ ...target, requestId: "second" }),
  ).rejects.toThrow();
  release(value);
  await one;
});
