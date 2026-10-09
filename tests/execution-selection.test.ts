import { expect, it } from "vitest";
import type { ExecutionRecord } from "../packages/protocol/execution";
import { executionForEvent } from "../apps/desktop/renderer/execution-selection";

const request = (
  id: string,
  laneId: string,
  batchId = "batch",
): ExecutionRecord => ({
  id,
  laneId,
  batchId,
  version: 1,
  source: "daily",
  status: "succeeded",
  resources: [],
  snapshot: {},
  fingerprint: "test",
  startedAt: "2026-09-29T01:00:00Z",
  message: "done",
});

it("uses the exact event request even when it is outside the recent snapshot", () => {
  expect(
    executionForEvent(
      { executionId: "original", laneId: "a", batchId: "batch" },
      [request("other", "a")],
    ),
  ).toBe("original");
});
it("rejects a known exact ID with another lane or batch rather than falling back", () => {
  for (const bad of [
    request("original", "b"),
    request("original", "a", "other"),
  ])
    expect(
      executionForEvent(
        { executionId: "original", laneId: "a", batchId: "batch" },
        [bad, request("replacement", "a")],
      ),
    ).toBeUndefined();
});
it("legacy events match a unique lane and batch without crossing accounts", () => {
  const records = [request("req-a", "a"), request("req-b", "b")];
  expect(executionForEvent({ laneId: "a", batchId: "batch" }, records)).toBe(
    "req-a",
  );
  expect(executionForEvent({ laneId: "b", batchId: "batch" }, records)).toBe(
    "req-b",
  );
});
it("does not guess when a legacy batch has multiple requests on the same lane", () => {
  expect(
    executionForEvent({ laneId: "a", batchId: "batch" }, [
      request("daily", "a"),
      request("single", "a"),
    ]),
  ).toBeUndefined();
});
it("does not use incomplete or missing events to pick a recent request", () => {
  for (const event of [undefined, {}, { laneId: "a" }, { batchId: "batch" }])
    expect(executionForEvent(event, [request("req-a", "a")])).toBeUndefined();
});
