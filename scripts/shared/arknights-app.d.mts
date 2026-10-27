export interface ArknightsAppOutcome {
  batchId: string;
  laneId?: string;
  status?: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  message?: string;
}
/** Submits once. Cancelling observation leaves the App task running; any observation failure after admission has outcomeUnknown=true. */
export function runSavedArknightsChannel(
  profileDir: string,
  laneId: string,
  options?: {
    requestId?: string;
    wait?: boolean;
    signal?: AbortSignal;
    request?: (
      profileDir: string,
      method: string,
      input: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<any>;
    pause?: (ms: number) => Promise<unknown>;
    now?: () => number;
    timeoutMs?: number;
    onAdmitted?: (receipt: ArknightsAppOutcome) => void;
  },
): Promise<ArknightsAppOutcome>;
