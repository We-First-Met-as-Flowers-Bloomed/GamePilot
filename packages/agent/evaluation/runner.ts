import { AgentToolError, agentToolNames } from "../../protocol/agent";
import type {
  PlannerResult,
  PlannerProgress,
} from "../../protocol/agent-planner";
import type { EvaluationCase, Verdict } from "./types";
import { judgeResult, resultDigest } from "./judge";
export interface EvaluationRecord {
  id: string;
  mode: "live";
  test: EvaluationCase;
  startedAt: string;
  finishedAt: string;
  status: Verdict["status"] | "error" | "skipped";
  result?: PlannerResult;
  digest?: string;
  verdict?: Verdict;
  error?: { code: string; message: string };
  progress?: (PlannerProgress & { at: string })[];
  omittedProgress?: number;
}
export async function runEvaluation(
  cases: EvaluationCase[],
  deps: {
    concurrency?: number;
    signal?: AbortSignal;
    run: (
      test: EvaluationCase,
      signal: AbortSignal,
      onProgress: (progress: PlannerProgress) => void,
    ) => Promise<PlannerResult>;
    save: (record: EvaluationRecord) => Promise<void>;
  },
) {
  const concurrency = deps.concurrency ?? 1;
  if (![1, 2].includes(concurrency)) throw Error("并发只能为1或2");
  if (
    !cases.length ||
    cases.some((c) => c.mode !== "live") ||
    new Set(cases.map((c) => c.id)).size !== cases.length
  )
    throw Error("请选择唯一的真实模型用例");
  const stop = new AbortController();
  const cancel = () => stop.abort();
  deps.signal?.addEventListener("abort", cancel);
  if (deps.signal?.aborted) cancel();
  let next = 0;
  let fatal = "";
  const records: EvaluationRecord[] = [];
  async function worker() {
    for (;;) {
      const test = cases[next++];
      if (!test) return;
      const record: EvaluationRecord = {
        id: test.id,
        mode: "live",
        test: structuredClone(test),
        startedAt: new Date().toISOString(),
        finishedAt: "",
        status: "skipped",
      };
      if (stop.signal.aborted)
        record.error = { code: "SKIPPED", message: fatal || "评测已取消" };
      else {
        let acceptingProgress = true;
        record.progress = [];
        record.omittedProgress = 0;
        const onProgress = (value: PlannerProgress) => {
          if (
            !acceptingProgress ||
            !value ||
            ![
              "discovering",
              "connecting",
              "checking",
              "thinking",
              "tool",
            ].includes(value.phase) ||
            (value.phase === "tool" && !agentToolNames.includes(value.tool!))
          )
            return;
          if (record.progress!.length >= 32) {
            record.omittedProgress!++;
            return;
          }
          record.progress!.push({
            phase: value.phase,
            ...(value.phase === "tool" ? { tool: value.tool } : {}),
            at: new Date().toISOString(),
          });
        };
        try {
          const result = await deps.run(test, stop.signal, onProgress);
          if (stop.signal.aborted)
            throw new AgentToolError("CANCELLED", "评测已取消");
          record.result = result;
          record.digest = resultDigest(result);
          record.verdict = judgeResult(test, result);
          record.status = record.verdict.status;
        } catch (e) {
          record.status = "error";
          record.error =
            e instanceof AgentToolError
              ? { code: e.code, message: e.message }
              : { code: "EVALUATION_FAILED", message: "评测异常，未运行游戏" };
          if (
            [
              "AUTH_REQUIRED",
              "QUOTA_EXCEEDED",
              "ISOLATION_FAILED",
              "SHUTDOWN_FAILED",
              "UNSUPPORTED_CODEX",
              "UNEXPECTED_TOOL",
              "UNEXPECTED_REQUEST",
              "TOOL_FORBIDDEN",
              "UNSUPPORTED_MCP_NAME",
              "CALL_SCOPE",
              "EVENT_SCOPE",
            ].includes(record.error.code)
          ) {
            fatal = record.error.code;
            stop.abort();
          }
        } finally {
          acceptingProgress = false;
        }
      }
      record.finishedAt = new Date().toISOString();
      // Storage failure aborts remaining work rather than continuing without evidence.
      try {
        await deps.save(record);
      } catch (error) {
        stop.abort();
        throw error;
      }
      records.push(record);
    }
  }
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: concurrency }, worker),
    );
    const failure = outcomes.find((o) => o.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return records.sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    deps.signal?.removeEventListener("abort", cancel);
  }
}
