import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useDesktop,
  type DesktopController,
} from "../apps/desktop/renderer/hooks/useDesktop";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function controller(api: Record<string, unknown>) {
  vi.stubGlobal("window", { gamepilot: api });
  let desktop!: DesktopController;
  function Probe() {
    desktop = useDesktop();
    return null;
  }
  // SSR gives the real hook's command closures and refs without mounting IPC subscriptions.
  renderToStaticMarkup(createElement(Probe));
  return desktop;
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(() => vi.unstubAllGlobals());

describe("lane cancellation while another desktop receipt is pending", () => {
  it("starts only the requested game slot without falling back to a mixed lane plan", async () => {
    const startGameSlot = vi.fn().mockResolvedValue({ batchId: "slot-batch" });
    const startLane = vi.fn();
    const d = controller({ startGameSlot, startLane });
    d.startGameSlot({ laneId: "a", gameId: "onmyoji" });
    await flush();
    expect(startGameSlot).toHaveBeenCalledWith({
      laneId: "a",
      gameId: "onmyoji",
    });
    expect(startLane).not.toHaveBeenCalled();
  });
  it("cancels exact game slots while start is pending and retries after a transport failure", async () => {
    const pending = deferred(),
      a = deferred(),
      b = deferred();
    const stopGameSlot = vi
      .fn()
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
      .mockResolvedValue(undefined);
    const stopLane = vi.fn();
    const d = controller({ stopGameSlot, stopLane });
    const action = d.perform("pending-start", () => pending.promise);
    d.stopGameSlot({ laneId: "a", gameId: "arknights" });
    d.stopGameSlot({ laneId: "a", gameId: "arknights" });
    d.stopGameSlot({ laneId: "a", gameId: "onmyoji" });
    expect(stopGameSlot.mock.calls).toEqual([
      [{ laneId: "a", gameId: "arknights" }],
      [{ laneId: "a", gameId: "onmyoji" }],
    ]);
    expect(stopLane).not.toHaveBeenCalled();
    a.reject(Error("slot transport failed"));
    await flush();
    d.stopGameSlot({ laneId: "a", gameId: "arknights" });
    expect(stopGameSlot).toHaveBeenCalledTimes(3);
    const ordinary = vi.fn(async () => undefined);
    await d.perform("another-start", ordinary);
    expect(ordinary).not.toHaveBeenCalled();
    b.resolve();
    pending.resolve();
    await action;
    await flush();
  });
  it("sends per-lane and global cancellation immediately, independently deduplicated, without releasing the ordinary action guard", async () => {
    const pending = deferred(),
      laneA = deferred(),
      laneB = deferred(),
      all = deferred();
    const stopLane = vi.fn((id: string) =>
      id === "a" ? laneA.promise : laneB.promise,
    );
    const stopLanes = vi.fn(() => all.promise);
    const d = controller({ stopLane, stopLanes });
    const action = d.perform("save-pending", () => pending.promise);
    d.stopLane("a");
    d.stopLane("a");
    d.stopLane("b");
    d.stopLanes();
    d.stopLanes();
    expect(stopLane.mock.calls).toEqual([["a"], ["b"]]);
    expect(stopLanes).toHaveBeenCalledTimes(1);
    const independent = vi.fn(async () => undefined);
    await d.perform("ordinary-second", independent);
    expect(independent).not.toHaveBeenCalled();
    laneA.resolve();
    all.resolve();
    await flush();
    d.stopLane("a");
    d.stopLane("b");
    d.stopLanes();
    expect(stopLane.mock.calls).toEqual([["a"], ["b"], ["a"]]);
    expect(stopLanes).toHaveBeenCalledTimes(2);
    await d.perform("ordinary-after-stop", independent);
    expect(independent).not.toHaveBeenCalled();
    laneB.resolve();
    pending.resolve();
    await action;
    await flush();
    await d.perform("ordinary-after-original", independent);
    expect(independent).toHaveBeenCalledTimes(1);
  });
  it("releases only the failed cancellation guard so a lane and global stop can retry", async () => {
    const first = deferred(),
      globalFirst = deferred();
    const stopLane = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const stopLanes = vi
      .fn()
      .mockReturnValueOnce(globalFirst.promise)
      .mockResolvedValue(undefined);
    const d = controller({ stopLane, stopLanes });
    d.stopLane("a");
    d.stopLanes();
    first.reject(Error("lane transport failed"));
    globalFirst.reject(Error("global transport failed"));
    await flush();
    d.stopLane("a");
    d.stopLanes();
    await flush();
    expect(stopLane).toHaveBeenCalledTimes(2);
    expect(stopLanes).toHaveBeenCalledTimes(2);
  });
});
