import { expect, it } from "vitest";
import {
  validFailureEvidence,
  type FailureEvidence,
} from "../packages/protocol/fault";
import {
  reduceTaskRecords,
  validateTaskRecord,
} from "../packages/protocol/task-record";
import type { RunEvent } from "../packages/protocol";
const at = "2026-09-26T00:00:00.000Z";
const fault: FailureEvidence = {
  version: 1,
  code: "skill-exception",
  source: "runner",
  runId: "test-run",
  skillId: "login",
  observedAt: at,
  capture: { status: "unavailable" },
};
const start: RunEvent = {
  runId: "test-run",
  gameId: "arknights",
  type: "status",
  status: "queued",
  message: "",
  at,
  plan: { gameId: "arknights", mode: "live", skillIds: ["login"] },
};
it("rejects malformed codes, extra fields, mismatched sources and path traversal", () => {
  expect(validFailureEvidence(fault)).toBe(true);
  for (const input of [
    { ...fault, source: ["runner"] },
    { ...fault, code: "anything" },
    { ...fault, extra: "PRIVATE" },
    { ...fault, code: "worker-exited" },
    { ...fault, capture: { status: "stored", key: "../../a.png" } },
  ])
    expect(validFailureEvidence(input)).toBe(false);
});
it("does not accept faults on successful events or silently overwrite the first failure", () => {
  const rows = reduceTaskRecords(reduceTaskRecords([], start), {
    ...start,
    type: "step",
    skillId: "login",
    stepStatus: "running",
  });
  expect(() =>
    reduceTaskRecords(rows, {
      ...start,
      type: "step",
      skillId: "login",
      stepStatus: "succeeded",
      fault,
    }),
  ).toThrow();
  const failed = reduceTaskRecords(rows, {
    ...start,
    type: "step",
    skillId: "login",
    stepStatus: "failed",
    fault,
  });
  expect(validateTaskRecord(failed[0]).fault).toEqual(fault);
  const end = reduceTaskRecords(failed, {
    ...start,
    status: "failed",
    fault: {
      ...fault,
      skillId: undefined,
      source: "watchdog",
      code: "worker-exited",
    },
  });
  expect(end[0].fault).toEqual(fault);
});

it("rejects fault times outside the failed step and fault/success contradictions", () => {
  const rows = reduceTaskRecords(reduceTaskRecords([], start), {
    ...start,
    type: "step",
    skillId: "login",
    stepStatus: "running",
    at: "2026-09-26T00:03:00Z",
  });
  const failed = reduceTaskRecords(rows, {
    ...start,
    type: "step",
    skillId: "login",
    stepStatus: "failed",
    at: "2026-09-26T00:04:00Z",
    fault: { ...fault, observedAt: "2026-09-26T00:03:30Z" },
  })[0];
  expect(validateTaskRecord(failed).fault).toBeDefined();
  const stale = structuredClone(failed);
  stale.fault!.observedAt = "2026-09-26T00:01:00Z";
  expect(() => validateTaskRecord(stale)).toThrow();
  const success = structuredClone(failed);
  success.status = "succeeded";
  success.steps[0].status = "succeeded";
  expect(() => validateTaskRecord(success)).toThrow();
});
