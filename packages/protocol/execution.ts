/** Admission receipts describe requests, not verified in-game rewards. */
export type ExecutionStatus =
  "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface ExecutionRequest {
  id: string;
  source: "single" | "daily" | "maintenance";
  resources: string[];
  snapshot: Record<string, unknown>;
  laneId?: string;
  batchId?: string;
}
export interface ExecutionRecord extends ExecutionRequest {
  startupFault?: import("./startup-fault").StartupFault;
  resolution?: { action: "abandoned"; at: string; note: string };
  version: 1;
  fingerprint: string;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt?: string;
  message: string;
}

export function validateRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:._-]{1,160}$/.test(value))
    throw Error("执行请求编号无效");
  return value;
}
