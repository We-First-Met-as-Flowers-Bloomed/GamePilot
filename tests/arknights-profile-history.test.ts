import { expect, it } from "vitest";
import { historyNativeMatches } from "../games/agent-history";
import type { TaskRecord } from "../packages/protocol/task-record";

const task = (homeObservedAt: string): TaskRecord => ({
  version: 1,
  executionId: "request",
  runId: "run",
  gameId: "arknights",
  plan: { gameId: "arknights", mode: "live", skillIds: ["login"] },
  startedAt: "2026-09-30T12:00:00Z",
  updatedAt: "2026-09-30T12:00:05Z",
  finishedAt: "2026-09-30T12:00:05Z",
  status: "succeeded",
  message: "",
  steps: [
    {
      skillId: "login",
      status: "succeeded",
      message: "",
      diagnostics: [],
      startedAt: "2026-09-30T12:00:00Z",
      finishedAt: "2026-09-30T12:00:05Z",
      result: {
        status: "succeeded",
        arknights: {
          version: 1,
          taskType: "StartUp",
          submission: "submitted",
          completion: "native-confirmed",
          taskId: 1,
          observedAt: "2026-09-30T12:00:01Z",
          login: {
            expectedUid: "864209759",
            observedUid: "864209759",
            observedAt: "2026-09-30T12:00:02Z",
            method: "profile",
            homeObservedAt,
            home: true,
          },
        },
      },
    },
  ],
});
it("requires both identity and final home evidence to belong to the login step", () => {
  expect(historyNativeMatches(task("2026-09-30T12:00:04Z"), "864209759")).toBe(
    true,
  );
  for (const at of ["2026-09-30T12:00:06Z", "2026-09-30T12:00:01Z", "bad"]) {
    expect(historyNativeMatches(task(at), "864209759")).toBe(false);
  }
  const incomplete = task("2026-09-30T12:00:04Z");
  delete incomplete.steps[0]!.result!.arknights!.login!.homeObservedAt;
  expect(historyNativeMatches(incomplete, "864209759")).toBe(false);
});
