import { expect, it } from "vitest";
import { assertDailyHistoryClear } from "../apps/desktop/main/daily-history-guard";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import type { ExecutionRecord } from "../packages/protocol/execution";

const data = createFixtureSnapshot();
const now = new Date("2026-10-13T08:00:00Z");
const target = freezeLaneExecution(
  data.lanes!.lanes[0],
  data.profiles!,
  false,
  now,
);
const occurrence = {
  slot: "primary" as const,
  dueAt: new Date("2026-10-13T00:00:00Z"),
};
function record(
  status: ExecutionRecord["status"] = "unknown",
): ExecutionRecord {
  return {
    version: 1,
    id: "manual:lane-a",
    batchId: "manual",
    laneId: target.lane.id,
    source: "daily",
    resources: [mumuResource(target.lane.managerPath, target.lane.instance)],
    snapshot: { ...structuredClone(target) },
    fingerprint: "a".repeat(64),
    status,
    startedAt: "2026-10-13T05:00:00Z",
    finishedAt: "2026-10-13T05:30:00Z",
    message: "recorded",
  };
}
it("blocks the actual manual failure before first scheduler claim without requiring an Agent tag", () => {
  expect(() =>
    assertDailyHistoryClear(target, [record()], [], now, [], occurrence),
  ).toThrow();
});
it("blocks a same-day full replay from the manual device button", () => {
  expect(() =>
    assertDailyHistoryClear(target, [record("succeeded")], [], now),
  ).toThrow();
});
it("allows a later scheduled period after verified earlier success but not unknown work", () => {
  const evening = {
    slot: "secondary" as const,
    dueAt: new Date("2026-10-13T12:00:00Z"),
  };
  const later = new Date("2026-10-13T12:05:00Z");
  expect(() =>
    assertDailyHistoryClear(
      target,
      [record("succeeded")],
      [],
      later,
      [],
      evening,
    ),
  ).not.toThrow();
  expect(() =>
    assertDailyHistoryClear(target, [record()], [], later, [], evening),
  ).toThrow();
});
it("preserves the exact pre-submit startup retry without exempting unrelated or unknown failures", () => {
  const r = record("failed");
  r.snapshot.schedule = {
    slot: occurrence.slot,
    dueAt: occurrence.dueAt.toISOString(),
  };
  r.startupFault = {
    version: 1,
    source: "startup",
    code: "mumu-boot-timeout",
    observedAt: r.finishedAt!,
  };
  expect(() =>
    assertDailyHistoryClear(target, [r], [], now, [], occurrence),
  ).not.toThrow();
  expect(() =>
    assertDailyHistoryClear(
      target,
      [{ ...r, status: "unknown" }],
      [],
      now,
      [],
      occurrence,
    ),
  ).toThrow();
  expect(() =>
    assertDailyHistoryClear(target, [r, record()], [], now, [], occurrence),
  ).toThrow();
  expect(() => assertDailyHistoryClear(target, [r], [], now)).toThrow();
  const changed = structuredClone(r);
  changed.id = "earlier:lane-a";
  changed.batchId = "earlier";
  changed.startedAt = "2026-10-13T04:00:00Z";
  changed.finishedAt = "2026-10-13T04:30:00Z";
  changed.startupFault!.observedAt = changed.finishedAt;
  delete changed.startupFault;
  expect(() =>
    assertDailyHistoryClear(target, [r, changed], [], now, [], occurrence),
  ).toThrow();
});
