import { expect, it, vi } from "vitest";
import { watchSnapshot } from "../apps/desktop/renderer/hooks/watchSnapshot";

it("subscribes before reading, coalesces an in-flight event, and discards late responses after disposal", async () => {
  vi.useFakeTimers();
  try {
    let refresh = () => {};
    let resolve!: (value: number) => void;
    const calls: string[] = [],
      unsubscribe = vi.fn(),
      accept = vi.fn();
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<number>((r) => {
            calls.push("read");
            resolve = r;
          }),
      )
      .mockResolvedValue(2);
    const close = watchSnapshot({
      read,
      subscribe: (listener) => {
        calls.push("subscribe");
        refresh = listener;
        return unsubscribe;
      },
      accept,
      error: vi.fn(),
    });
    expect(calls).toEqual(["subscribe", "read"]);
    refresh();
    refresh();
    resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(accept.mock.calls).toEqual([[1], [2]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    close();
    refresh();
    await vi.advanceTimersByTimeAsync(30000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("does not deliver an obsolete scope's pending initial result", async () => {
  let resolve!: (value: string) => void;
  const accept = vi.fn();
  const close = watchSnapshot({
    read: () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
    accept,
    error: vi.fn(),
  });
  close();
  resolve("old session");
  await Promise.resolve();
  await Promise.resolve();
  expect(accept).not.toHaveBeenCalled();
});
