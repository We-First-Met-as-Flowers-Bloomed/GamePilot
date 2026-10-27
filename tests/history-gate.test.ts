import { expect, it } from "vitest";
import {
  createHistoryIndex,
  frozenHistoryPlans,
  historySameDevice,
  historyTouchesDay,
} from "../games/history-gate";
import { projectExecutionDetail } from "../games/execution-detail";
import type { ExecutionRecord } from "../packages/protocol/execution";
import type { TaskRecord } from "../packages/protocol/task-record";

const record = (id: string, version?: number): ExecutionRecord => ({
  version: 1,
  id,
  source: "daily",
  resources: ["mumu:C:/MuMu/manager.exe#0"],
  fingerprint: "x",
  status: "unknown",
  startedAt: "2026-10-10T20:00:00Z",
  finishedAt: "2026-10-10T21:00:00Z",
  message: "unknown",
  snapshot: {
    ...(version === undefined ? {} : { schemaVersion: version }),
    plan: { gameId: "onmyoji", mode: "live", skillIds: ["login", "mail"] },
  },
});
it("parses legacy/current plans but keeps unsupported snapshots visible and unexecutable", () => {
  expect(frozenHistoryPlans(record("old"))).toHaveLength(1);
  expect(frozenHistoryPlans(record("new", 1))).toHaveLength(1);
  expect(frozenHistoryPlans(record("future", 99))).toBeUndefined();
  const detail = projectExecutionDetail(record("future", 99), []);
  expect(detail.games).toEqual([]);
  expect(detail.warnings.join(" ")).toContain("版本");
});
it("matches canonical physical resources and retains wildcard uncertainty", () => {
  const other = record("b");
  other.resources = ["mumu:c:\\MuMu\\.\\manager.exe#00"];
  expect(historySameDevice(record("a"), other)).toBe(true);
  other.resources = ["*"];
  expect(historySameDevice(record("a"), other)).toBe(true);
  other.resources = ["mumu:C:/MuMu/manager.exe#1"];
  expect(historySameDevice(record("a"), other)).toBe(false);
});
it("covers reset boundaries and refuses to exempt unfinished or invalid time ranges", () => {
  const now = new Date("2026-10-10T20:00:00Z"); // 04:00 local reset
  expect(
    historyTouchesDay(
      "arknights",
      "2026-10-10T19:59:00Z",
      "2026-10-10T20:01:00Z",
      now,
    ),
  ).toBe(true);
  expect(
    historyTouchesDay(
      "arknights",
      "2026-10-10T19:00:00Z",
      "2026-10-10T19:59:00Z",
      now,
    ),
  ).toBe(false);
  expect(historyTouchesDay("arknights", "bad", undefined, now)).toBe(true);
});
it("indexes once while preserving duplicates and orphan evidence", () => {
  const t = { executionId: "a", runId: "run", gameId: "onmyoji" } as TaskRecord;
  const orphan = { runId: "orphan", gameId: "onmyoji" } as TaskRecord;
  const index = createHistoryIndex([record("a"), record("a")], [t, t, orphan]);
  expect(index.requests("a")).toHaveLength(2);
  expect(index.tasks("a")).toHaveLength(2);
  expect(index.orphans()).toEqual([orphan]);
  index.tasks("a").pop();
  expect(index.tasks("a")).toHaveLength(2);
});
