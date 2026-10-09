import type { Frame } from "../../packages/runtime/device";

/** Confirm only decision-relevant state; animated backgrounds are irrelevant. */
export async function waitForStableFrame(
  observe: () => Promise<Frame>,
  key: (frame: Frame) => string | null,
  signal: AbortSignal,
  pause: (ms: number, signal: AbortSignal) => Promise<void>,
  attempts = 8,
): Promise<Frame> {
  let previous: string | null = null;
  for (let i = 0; i < attempts; i++) {
    signal.throwIfAborted();
    const frame = await observe();
    signal.throwIfAborted();
    const current = key(frame);
    if (current !== null && current === previous) return frame;
    previous = current;
    if (i + 1 < attempts) await pause(600, signal);
  }
  throw new Error("画面关键信息未稳定，结果无法确认；已停止操作");
}
