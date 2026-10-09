import { AgentToolError } from "../protocol/agent";

export function isUnconfirmedRuntimeShutdown(
  error: unknown,
): error is AgentToolError {
  return (
    error instanceof AgentToolError &&
    ["SHUTDOWN_FAILED", "DSH_REAP_FAILED"].includes(error.code)
  );
}

/** Shares concurrent cleanup; successful close stays final, failed cleanup can be retried. */
export function retryableRuntimeClose(
  cleanup: () => Promise<void>,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      await cleanup();
    })().catch((error: unknown) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
}
