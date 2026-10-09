import { validateRequestId } from "../../../packages/protocol/execution";
import type { ExecutionCoordinator } from "./execution-coordinator";
import type { RunLedger } from "./run-ledger";
import type { ExecutionDetailService } from "./execution-detail";
import type { ExecutionDetail } from "../../../packages/protocol/execution-detail";
import { mergeExecutionProgress } from "../../../games/execution-progress";
import type { StartupReconciliationFact } from "../../../packages/protocol/startup-reconciliation";

/** Uses complete stores rather than the recent UI window. No writes, models or device operations. */
export class ExecutionProgressService {
  constructor(
    private executions: Pick<
      ExecutionCoordinator,
      "assertHealthy" | "get" | "snapshot"
    >,
    private ledger: Pick<RunLedger, "assertHealthy" | "forExecution"> &
      Partial<Pick<RunLedger, "snapshot">>,
    private details: Pick<ExecutionDetailService, "get">,
    /** Facts have already been validated against both actual ledger associations. */
    private startupFacts: () => StartupReconciliationFact[] = () => [],
  ) {}
  get(id: unknown) {
    const requestId = validateRequestId(id);
    this.executions.assertHealthy();
    this.ledger.assertHealthy();
    this.executions.get(requestId);
    const records = this.executions.snapshot(Number.MAX_SAFE_INTEGER),
      ids = new Set([requestId]),
      queue = [requestId],
      details = new Map<string, ExecutionDetail>();
    while (queue.length && ids.size <= 128) {
      const current = queue.shift()!;
      for (const record of records) {
        const parent = (
          record.snapshot.continuation as { parentId?: unknown } | undefined
        )?.parentId;
        const connected =
          record.id === current
            ? parent
            : parent === current
              ? record.id
              : undefined;
        if (typeof connected === "string" && !ids.has(connected)) {
          ids.add(connected);
          queue.push(connected);
        }
      }
    }
    for (const record of records.filter((r) => ids.has(r.id))) {
      try {
        const projected = this.details.get(record.id),
          detail = { ...projected, warnings: [...projected.warnings] },
          raw = this.ledger.forExecution(record.id);
        for (const game of detail.games)
          if (!game.record && raw.some((t) => t.gameId === game.plan.gameId))
            detail.warnings.push(
              "存在不能唯一可靠关联的步骤账本，不能合并进度",
            );
        details.set(record.id, detail);
      } catch {
        /* The pure projection exposes missing facts as unconfirmed. */
      }
    }
    const progress = mergeExecutionProgress(
      requestId,
      records,
      details,
      this.startupFacts(),
      this.ledger.snapshot?.(Number.MAX_SAFE_INTEGER),
    );
    if (ids.size > 128) {
      progress.warnings.push("续跑关联超出查询范围，需核对");
      progress.wholePlanComplete = false;
      progress.outcome = "unconfirmed";
    }
    return progress;
  }
}
