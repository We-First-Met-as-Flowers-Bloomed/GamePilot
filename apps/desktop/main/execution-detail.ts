import { validateRequestId } from "../../../packages/protocol/execution";
import type { ExecutionDetail } from "../../../packages/protocol/execution-detail";
import type { ExecutionCoordinator } from "./execution-coordinator";
import type { RunLedger } from "./run-ledger";
import { projectExecutionDetail } from "../../../games/execution-detail";
/** Exact read-only query; never loads/recover stores or controls devices. */
export class ExecutionDetailService {
  constructor(
    private executions: Pick<ExecutionCoordinator, "get" | "assertHealthy">,
    private ledger: Pick<RunLedger, "forExecution" | "assertHealthy">,
  ) {}
  get(id: unknown): ExecutionDetail {
    const requestId = validateRequestId(id);
    this.executions.assertHealthy();
    this.ledger.assertHealthy();
    return projectExecutionDetail(
      this.executions.get(requestId),
      this.ledger.forExecution(requestId),
    );
  }
}
