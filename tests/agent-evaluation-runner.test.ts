import { expect, it } from "vitest";
import { runEvaluation } from "../packages/agent/evaluation/runner";
import { evaluationCases } from "../packages/agent/evaluation/cases";
import { AgentToolError } from "../packages/protocol/agent";
import type { EvaluationRecord } from "../packages/agent/evaluation/runner";
const cases = evaluationCases.filter((c) => c.mode === "live").slice(6, 9);
it("persists every failure and does not call remaining cases after quota failure", async () => {
  const records: EvaluationRecord[] = [];
  let calls = 0;
  await runEvaluation(cases, {
    run: async () => {
      calls++;
      throw new AgentToolError("QUOTA_EXCEEDED", "quota");
    },
    save: async (record) => {
      records.push(record);
    },
  });
  expect(calls).toBe(1);
  expect(records.map((r) => r.status)).toEqual(["error", "skipped", "skipped"]);
  expect(records[0].error?.code).toBe("QUOTA_EXCEEDED");
});
it("continues on per-case failures, sanitizes unknown exceptions and limits concurrency", async () => {
  const records: EvaluationRecord[] = [];
  let active = 0,
    maximum = 0;
  await runEvaluation(cases, {
    concurrency: 2,
    run: async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      throw Error("PRIVATE");
    },
    save: async (record) => {
      records.push(record);
    },
  });
  expect(maximum).toBe(2);
  expect(records).toHaveLength(3);
  expect(records.every((r) => r.status === "error")).toBe(true);
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
});
it("stops admission on cancellation and awaits the active adapter cleanup", async () => {
  const abort = new AbortController();
  const records: EvaluationRecord[] = [];
  let cleaned = false;
  await runEvaluation(cases, {
    signal: abort.signal,
    run: async () => {
      abort.abort();
      await new Promise((r) => setTimeout(r, 10));
      cleaned = true;
      throw new AgentToolError("CANCELLED", "cancel");
    },
    save: async (record) => {
      expect(cleaned).toBe(true);
      records.push(record);
    },
  });
  expect(records.map((r) => r.status)).toEqual(["error", "skipped", "skipped"]);
});
it("rejects excessive concurrency before invoking any model", async () => {
  await expect(
    runEvaluation(cases, {
      concurrency: 3,
      run: async () => {
        throw Error();
      },
      save: async () => {},
    }),
  ).rejects.toThrow(/并发/);
});
it("keeps bounded host-timed progress on failed calls without copying model text or accepting late callbacks", async () => {
  let late!: (
    value: import("../packages/protocol/agent-planner").PlannerProgress,
  ) => void;
  const records = await runEvaluation(cases.slice(0, 1), {
    run: async (_test, _signal, progress) => {
      late = progress;
      progress({ phase: "checking", privateText: "PRIVATE" } as never);
      progress({ phase: "bad-phase", privateText: "PRIVATE" } as never);
      for (let i = 0; i < 100; i++)
        progress({ phase: "tool", tool: "get_incident" });
      throw new AgentToolError("CODEX_RPC_ERROR", "rejected");
    },
    save: async () => {},
  });
  expect(records[0].progress).toHaveLength(32);
  expect(records[0].progress![0]).toMatchObject({ phase: "checking" });
  expect(
    records[0].progress!.every((p) => Number.isFinite(Date.parse(p.at))),
  ).toBe(true);
  expect(records[0].omittedProgress).toBe(69);
  const before = JSON.stringify(records);
  late({ phase: "thinking" });
  expect(JSON.stringify(records)).toBe(before);
  expect(before).not.toMatch(/PRIVATE|privateText|bad-phase/);
});
it.each([
  "UNEXPECTED_TOOL",
  "UNEXPECTED_REQUEST",
  "TOOL_FORBIDDEN",
  "UNSUPPORTED_MCP_NAME",
  "CALL_SCOPE",
  "EVENT_SCOPE",
])("stops the batch when isolation is breached: %s", async (code) => {
  let calls = 0;
  const records: EvaluationRecord[] = [];
  await runEvaluation(cases, {
    run: async () => {
      calls++;
      throw new AgentToolError(code, "隔离失败");
    },
    save: async (r) => {
      records.push(r);
    },
  });
  expect(calls).toBe(1);
  expect(records.map((r) => r.status)).toEqual(["error", "skipped", "skipped"]);
});
