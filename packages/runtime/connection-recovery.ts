import { setTimeout as delay } from "node:timers/promises";
import { isConnectionUnavailable } from "../protocol/failure";

/** This wraps connection only. Never wrap a game task or an entire plan. */
export async function recoverConnection<T>(
  connect: () => Promise<T>,
  signal: AbortSignal,
  pause: (ms: number, signal: AbortSignal) => Promise<unknown> = (ms, s) =>
    delay(ms, undefined, { signal: s }),
  beforeRetry: (retry: number) => Promise<void> = async () => {},
): Promise<T> {
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    try {
      if (retry) await beforeRetry(retry);
      signal.throwIfAborted();
      const result = await connect();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (retry >= 2 || !isConnectionUnavailable(error)) throw error;
      await pause(2000, signal);
    }
  }
}
