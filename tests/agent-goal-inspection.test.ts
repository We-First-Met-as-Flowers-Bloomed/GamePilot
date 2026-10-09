import { expect, it, vi } from "vitest";
import { createGoalInspection } from "../apps/desktop/main/agent-goal-inspection";
import type { GoalRun, GoalScope } from "../packages/protocol/agent-goal";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { DeviceInspection } from "../packages/protocol/recovery";

const at = "2026-10-05T04:00:00.000Z";
function record(
  batchId = "batch-a",
  laneId = "lane-a",
  gameId = "arknights",
): ExecutionRecord {
  return {
    version: 1,
    id: `${batchId}:${laneId}`,
    batchId,
    laneId,
    source: "daily",
    resources: [`device:${laneId}`],
    fingerprint: `${batchId}-fingerprint`,
    status: "unknown",
    startedAt: at,
    message: "unknown",
    snapshot: {
      lane: { id: laneId },
      plan: { gameId, mode: "live", skillIds: ["login", "award"] },
    },
  };
}
function goalFor(records: ExecutionRecord[]): GoalRun {
  const scopes: GoalScope[] = records.map((r) => ({
    laneId: r.laneId!,
    gameId: (r.snapshot.plan as { gameId: string }).gameId,
    skillIds: ["login", "award"],
    resources: {},
  }));
  const owner = { sessionId: "session-a", turnId: "turn-a" };
  const attempts = records.map((r, attempt) => ({
    review: {
      id: `review-${attempt}`,
      fingerprint: `review-${attempt}`,
      reviewedAt: at,
      expiresAt: at,
      frozenPlan: { kind: "saved-daily" as const, hash: "hash" },
      scopes: [scopes[attempt]],
      summary: [],
    },
    submission: {
      batchId: r.batchId!,
      requestIds: [r.id],
      acceptedAt: at,
      state: "received" as const,
      attempt,
    },
  }));
  return {
    version: 1,
    id: "goal-a",
    revision: 1,
    ...owner,
    prompt: "核对当前目标",
    selection: { kind: "saved-daily" },
    grant: {
      id: "expired-grant",
      source: "user-message",
      ...owner,
      issuedAt: at,
      expiresAt: at,
      revokedAt: at,
      maxRetries: 2,
      scopes,
    },
    createdAt: at,
    updatedAt: at,
    status: "unknown",
    message: "unknown",
    attempts,
    retryCount: 0,
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
  };
}
function captureResult(): DeviceInspection {
  return {
    observedAt: at,
    address: "127.0.0.1:12345",
    image: "data:image/png;base64,private",
    foregroundPackage: "com.hypergryph.arknights",
    pageVerified: true,
    accountVerified: true,
    recognitionError: "private/trace/path",
    arknights: {
      page: "home",
      pageVerified: true,
      accountVerified: true,
      account: "matched",
      observedUid: "123456789",
      expectedUid: "123456789",
      frames: [{ page: "home", uid: "123456789", anchors: ["UID:123456789"] }],
      message: "private account details",
    },
  };
}
function setup(records: ExecutionRecord[]) {
  const inspect = vi.fn(
    async (_resources: string[], action: () => Promise<unknown>) => action(),
  );
  const executions = {
    assertHealthy: vi.fn(),
    get: vi.fn((id: string) => {
      const r = records.find((r) => r.id === id);
      if (!r) throw Error("private missing path");
      return structuredClone(r);
    }),
    inspect: <T>(resources: string[], action: () => Promise<T>) =>
      inspect(resources, action) as Promise<T>,
  };
  const capture = vi.fn(async (_id: string, _signal: AbortSignal) =>
    captureResult(),
  );
  const blocked = vi.fn(() => false);
  const inspection = createGoalInspection({ executions, capture, blocked });
  return { executions, capture, blocked, inspection, inspect };
}

it("does not probe a running executor and selects only its latest accepted request per lane", async () => {
  const original = record(),
    latest = record("batch-next");
  latest.status = "running";
  const unrelated = record("other");
  const t = setup([original, latest, unrelated]);
  const results = await t.inspection.inspect(
    goalFor([original, latest]),
    new AbortController().signal,
  );
  expect(results).toEqual([
    {
      kind: "not-probed",
      requestId: latest.id,
      laneId: latest.laneId,
      scopeGameIds: ["arknights"],
      reason: "executor-owns-device",
      pageVerified: false,
      accountVerified: false,
      account: "unknown",
    },
  ]);
  expect(t.executions.get).toHaveBeenCalledWith(latest.id);
  expect(t.executions.get).not.toHaveBeenCalledWith(original.id);
  expect(t.capture).not.toHaveBeenCalled();
  expect(t.inspect).not.toHaveBeenCalled();
});
it("uses original resources for a read-only lease and returns only actual public evidence", async () => {
  const r = record(),
    t = setup([r]);
  const results = await t.inspection.inspect(
    goalFor([r]),
    new AbortController().signal,
  );
  expect(t.inspect).toHaveBeenCalledWith(r.resources, expect.any(Function));
  expect(results).toEqual([
    {
      kind: "observed",
      requestId: r.id,
      laneId: r.laneId,
      scopeGameIds: ["arknights"],
      observedAt: at,
      foregroundPackage: "com.hypergryph.arknights",
      page: "home",
      pageVerified: true,
      accountVerified: true,
      account: "matched",
    },
  ]);
  const publicText = JSON.stringify(results);
  for (const privateValue of [
    "123456789",
    "127.0.0.1",
    "base64",
    "private",
    "expectedUid",
    "observedUid",
    "frames",
  ])
    expect(publicText).not.toContain(privateValue);
});
it.each(["missing", "resolved", "blocked"] as const)(
  "returns unknown without capturing when the request is %s",
  async (reason) => {
    const r = record(),
      t = setup(reason === "missing" ? [] : [r]);
    if (reason === "resolved")
      r.resolution = { action: "abandoned", at, note: "private note" };
    if (reason === "blocked") t.blocked.mockReturnValue(true);
    const [result] = await t.inspection.inspect(
      goalFor([r]),
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      kind: "not-probed",
      account: "unknown",
      accountVerified: false,
      pageVerified: false,
    });
    expect(result).not.toHaveProperty("observedAt");
    expect(t.capture).not.toHaveBeenCalled();
    expect(t.inspect).not.toHaveBeenCalled();
  },
);
it("does not claim an Onmyoji account was verified by the Arknights-only inspector", async () => {
  const r = record("batch-a", "lane-a", "onmyoji"),
    t = setup([r]);
  const [result] = await t.inspection.inspect(
    goalFor([r]),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    kind: "observed",
    scopeGameIds: ["onmyoji"],
    account: "unknown",
    accountVerified: false,
    pageVerified: false,
    page: "home",
    observedAt: at,
  });
});
it("checks the original fingerprint again inside the lease before capture", async () => {
  const r = record(),
    t = setup([r]);
  t.inspect.mockImplementation(async (_resources, action) => {
    r.fingerprint = "changed";
    return action();
  });
  const [result] = await t.inspection.inspect(
    goalFor([r]),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    kind: "not-probed",
    reason: "request-changed",
    account: "unknown",
  });
  expect(t.capture).not.toHaveBeenCalled();
});
it("discards a capture after its target binding changes", async () => {
  const r = record(),
    t = setup([r]);
  t.capture.mockImplementation(async () => {
    t.blocked.mockReturnValue(true);
    return captureResult();
  });
  const [result] = await t.inspection.inspect(
    goalFor([r]),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    kind: "not-probed",
    reason: "binding-unverified",
    account: "unknown",
  });
  expect(result).not.toHaveProperty("observedAt");
});
it("checks two independent lanes and rejects a wider inspection scope", async () => {
  const a = record(),
    b = record("batch-a", "lane-b"),
    t = setup([a, b]);
  expect(
    await t.inspection.inspect(goalFor([a, b]), new AbortController().signal),
  ).toHaveLength(2);
  expect(t.capture.mock.calls.map(([id]) => id)).toEqual([a.id, b.id]);
  const c = record("batch-a", "lane-c");
  t.capture.mockClear();
  await expect(
    t.inspection.inspect(goalFor([a, b, c]), new AbortController().signal),
  ).rejects.toThrow();
  expect(t.capture).not.toHaveBeenCalled();
});
it("does not swallow cancellation or expose an inspection error", async () => {
  const r = record(),
    t = setup([r]),
    controller = new AbortController();
  t.capture.mockImplementation(async () => {
    controller.abort(Error("cancel"));
    return captureResult();
  });
  await expect(
    t.inspection.inspect(goalFor([r]), controller.signal),
  ).rejects.toThrow("cancel");
  t.capture.mockRejectedValue(Error("private path and UID:123456789"));
  const results = await t.inspection.inspect(
    goalFor([r]),
    new AbortController().signal,
  );
  expect(results[0]).toMatchObject({
    kind: "not-probed",
    reason: "inspection-unavailable",
  });
  expect(JSON.stringify(results)).not.toContain("private");
});
it("returns an unknown public result when the execution store is unavailable", async () => {
  const r = record(),
    t = setup([r]);
  t.executions.assertHealthy.mockImplementation(() => {
    throw Error("private/store/path");
  });
  const results = await t.inspection.inspect(
    goalFor([r]),
    new AbortController().signal,
  );
  expect(results[0]).toMatchObject({
    kind: "not-probed",
    reason: "inspection-unavailable",
    account: "unknown",
  });
  expect(t.capture).not.toHaveBeenCalled();
  expect(JSON.stringify(results)).not.toContain("private");
});
