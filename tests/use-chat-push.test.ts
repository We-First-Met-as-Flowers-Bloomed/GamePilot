import { expect, it, vi, afterEach } from "vitest";
import * as chatHook from "../apps/desktop/renderer/hooks/useChat";
import type { ChatView } from "../packages/protocol/agent-chat";
afterEach(() => vi.useRealTimers());
const view = (revision: number): ChatView => ({ revision, sessions: [] });
it("subscribes before reading and rejects an older snapshot or duplicate push", async () => {
  vi.useFakeTimers();
  let push!: (value: ChatView) => void;
  let resolve!: (value: ChatView) => void;
  const order: string[] = [];
  const api = {
    onChatState: (listener: typeof push) => {
      order.push("subscribe");
      push = listener;
      return vi.fn();
    },
    chatSnapshot: () => {
      order.push("snapshot");
      return new Promise<ChatView>((done) => {
        resolve = done;
      });
    },
  };
  const states = vi.fn(),
    errors = vi.fn();
  const close = (chatHook as any).watchChatState(api, states, errors);
  expect(order).toEqual(["subscribe", "snapshot"]);
  push(view(8));
  push(view(8));
  resolve(view(7));
  await Promise.resolve();
  await Promise.resolve();
  expect(states.mock.calls.map((call) => call[0].revision)).toEqual([8]);
  close();
});
it("does not surface an obsolete snapshot error after a successful push and cleans up late delivery", async () => {
  vi.useFakeTimers();
  let push!: (value: ChatView) => void;
  let reject!: (error: Error) => void;
  const unsubscribe = vi.fn();
  const api = {
    onChatState: (listener: typeof push) => {
      push = listener;
      return unsubscribe;
    },
    chatSnapshot: () =>
      new Promise<ChatView>((_, fail) => {
        reject = fail;
      }),
  };
  const states = vi.fn(),
    errors = vi.fn();
  const close = (chatHook as any).watchChatState(api, states, errors);
  push(view(3));
  reject(Error("stale read failed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("无法读取"));
  close();
  push(view(4));
  await vi.advanceTimersByTimeAsync(60000);
  expect(states).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it("keeps polling compatible fake APIs that have no new push methods", async () => {
  vi.useFakeTimers();
  let revision = 0;
  const api = { chatSnapshot: vi.fn(async () => view(++revision)) };
  const states = vi.fn();
  const close = (chatHook as any).watchChatState(api, states, vi.fn());
  await vi.advanceTimersByTimeAsync(1100);
  expect(states.mock.calls.map((call) => call[0].revision)).toEqual([1, 2]);
  close();
});
