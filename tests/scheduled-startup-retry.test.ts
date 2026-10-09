import { expect, it } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import { mumuResource } from "../apps/desktop/main/execution-coordinator";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";
import {
  StartupFaultError,
  validStartupFault,
} from "../packages/protocol/startup-fault";
import {
  scheduledStartupRetry,
  unsubmittedStartupFailure,
} from "../apps/desktop/main/scheduled-startup-retry";

const data = createFixtureSnapshot();
const lane = data.lanes!.lanes[0];
const due = new Date("2026-10-06T00:00:00Z");
const now = new Date("2026-10-06T00:05:00Z");
const occurrence = { slot: "primary" as const, dueAt: due };
const frozen = freezeLaneExecution(lane, data.profiles!, false, due);
function receipt(): ExecutionRecord {
  return {
    version: 1,
    id: "scheduled:lane-a",
    laneId: lane.id,
    batchId: "scheduled",
    source: "daily",
    resources: [mumuResource(lane.managerPath, lane.instance)],
    snapshot: {
      ...structuredClone(frozen),
      schedule: { slot: "primary", dueAt: due.toISOString() },
    },
    status: "failed",
    fingerprint: "host-receipt",
    startedAt: "2026-10-06T00:00:00Z",
    finishedAt: "2026-10-06T00:01:00Z",
    message: "startup failed",
    startupFault: {
      version: 1,
      source: "startup",
      code: "mumu-boot-timeout",
      observedAt: "2026-10-06T00:01:00Z",
    },
  };
}
function proof(requests = [receipt()], tasks: TaskRecord[] = []) {
  return scheduledStartupRetry(frozen, occurrence, requests, tasks, now);
}
it("allows only the original exact unsubmitted startup failure and returns durable completion time", () => {
  expect(proof()).toMatchObject({
    allowed: true,
    status: "failed",
    lastAttemptAt: "2026-10-06T00:01:00Z",
  });
});
it.each(["mumu-stopping-timeout", "mumu-startup-interrupted"] as const)(
  "records %s but never schedules an automatic retry of it",
  (code) => {
    const r = receipt();
    r.startupFault!.code = code;
    expect(validStartupFault(r.startupFault)).toBe(true);
    expect(proof([r])).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("停止"),
    });
  },
);
it.each(["unknown", "running", "cancelled", "succeeded"] as const)(
  "refuses coordinator state %s despite scheduler failed state",
  (status) => {
    const r = receipt();
    r.status = status;
    expect(proof([r]).allowed).toBe(false);
  },
);
it("refuses an unclassified error even when no step succeeded", () => {
  const r = receipt();
  delete r.startupFault;
  expect(proof([r]).allowed).toBe(false);
});
it("refuses any game task record, including failed native submission", () => {
  expect(
    proof([receipt()], [{ executionId: receipt().id } as TaskRecord]).allowed,
  ).toBe(false);
});
it("does not hide a later manual or AI request behind an older safe failure", () => {
  const later = {
    ...receipt(),
    id: "manual",
    status: "unknown" as const,
    startedAt: "2026-10-06T00:03:00Z",
    snapshot: {},
  };
  expect(proof([receipt(), later]).allowed).toBe(false);
});
it("keeps the morning request status when a later evening request completed", () => {
  const morning = receipt();
  morning.status = "unknown";
  const evening = {
    ...receipt(),
    id: "evening",
    status: "succeeded" as const,
    startedAt: "2026-10-06T12:00:00Z",
    finishedAt: "2026-10-06T12:01:00Z",
    snapshot: {
      ...frozen,
      schedule: { slot: "secondary", dueAt: "2026-10-06T12:00:00Z" },
    },
  };
  expect(
    scheduledStartupRetry(
      frozen,
      occurrence,
      [morning, evening],
      [],
      new Date("2026-10-06T13:00:00Z"),
    ),
  ).toMatchObject({ allowed: false, status: "unknown" });
});
it("refuses another period, changed profile or uncertain physical binding", () => {
  const r = receipt();
  (r.snapshot.schedule as { slot: string }).slot = "secondary";
  expect(proof([r]).allowed).toBe(false);
  const changed = receipt();
  (changed.snapshot.profile as { uid: string }).uid = "changed";
  expect(proof([changed]).allowed).toBe(false);
  const wildcard = receipt();
  wildcard.resources = ["*"];
  expect(proof([wildcard]).allowed).toBe(false);
});
it("refuses a future or invalid completion/fault timestamp", () => {
  const r = receipt();
  r.finishedAt = "2026-10-06T00:06:00Z";
  expect(proof([r]).allowed).toBe(false);
  r.finishedAt = "invalid";
  expect(proof([r]).allowed).toBe(false);
});
it("refuses a stale receipt that cannot account for the latest durable scheduler attempt", () => {
  expect(
    scheduledStartupRetry(frozen, occurrence, [receipt()], [], now, 2).allowed,
  ).toBe(false);
});
it("only classifies a typed startup exception before any game record as known failure", () => {
  const error = new StartupFaultError(
    "mumu-boot-timeout",
    "temporary startup timeout",
  );
  expect(unsubmittedStartupFailure(error, "a", [])).toBe(true);
  expect(
    unsubmittedStartupFailure(Error("adb screencap failed"), "a", []),
  ).toBe(false);
  expect(
    unsubmittedStartupFailure(error, "a", [{ executionId: "a" } as TaskRecord]),
  ).toBe(false);
});
it("keeps another account in the same batch from becoming this device's startup proof", () => {
  const error = new StartupFaultError(
    "mumu-boot-timeout",
    "temporary startup timeout",
  );
  expect(
    unsubmittedStartupFailure(error, "batch:lane-a", [
      {
        batchId: "batch",
        laneId: "lane-b",
        executionId: "batch:lane-b",
      } as TaskRecord,
    ]),
  ).toBe(true);
  expect(
    unsubmittedStartupFailure(error, "batch:lane-a", [
      { batchId: "batch", laneId: "lane-a" } as TaskRecord,
    ]),
  ).toBe(false);
});
