import { afterEach, expect, it, vi } from "vitest";
import * as preview from "../apps/desktop/renderer/hooks/useLanePreview";
import type { LanePreviewFrame } from "../packages/protocol/lane-preview";

afterEach(() => vi.useRealTimers());
const frame = (laneId = "lane-a"): LanePreviewFrame => ({
  status: "connected",
  laneId,
  laneName: laneId,
  instance: 1,
  imageDataUrl: "data:image/png;base64,aGVsbG8=",
  capturedAt: new Date().toISOString(),
  message: "当前设备帧",
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
it("refreshes sequentially only after a capture settles and disposal rejects pending frames", async () => {
  vi.useFakeTimers();
  const pending: ((frame: LanePreviewFrame) => void)[] = [];
  const capture = vi.fn(
    () => new Promise<LanePreviewFrame>((resolve) => pending.push(resolve)),
  );
  const receive = vi.fn();
  expect(typeof (preview as any).watchLanePreview).toBe("function");
  const close = (preview as any).watchLanePreview(
    { captureLanePreview: capture },
    "lane-a",
    receive,
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(capture).toHaveBeenCalledTimes(1);
  pending.shift()!(frame());
  await flush();
  expect(receive).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "connected" }),
  );
  await vi.advanceTimersByTimeAsync(999);
  expect(capture).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(capture).toHaveBeenCalledTimes(2);
  close();
  pending.shift()!(frame());
  await flush();
  await vi.advanceTimersByTimeAsync(4000);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenCalledTimes(1);
});
it("clears untrusted, stale and unavailable frames instead of presenting a connected account", async () => {
  vi.useFakeTimers();
  const capture = vi
    .fn()
    .mockResolvedValueOnce(frame("lane-b"))
    .mockResolvedValueOnce({
      ...frame(),
      capturedAt: new Date(Date.now() - 20000).toISOString(),
    })
    .mockRejectedValueOnce(Error("账号设备已断开"));
  const receive = vi.fn();
  expect(typeof (preview as any).watchLanePreview).toBe("function");
  const close = (preview as any).watchLanePreview(
    { captureLanePreview: capture },
    "lane-a",
    receive,
  );
  await flush();
  await vi.advanceTimersByTimeAsync(2000);
  for (const [value] of receive.mock.calls) {
    expect(value.status).toBe("unavailable");
    expect(value.imageDataUrl).toBeUndefined();
  }
  expect(receive).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: "账号设备已断开" }),
  );
  close();
});
it("defaults to a running enabled account when the global manual device is disconnected", () => {
  expect(typeof (preview as any).defaultPreviewTarget).toBe("function");
  const lanes = [
    { id: "lane-a", enabled: true },
    { id: "lane-b", enabled: true },
  ];
  expect((preview as any).defaultPreviewTarget(lanes, false, ["lane-b"])).toBe(
    "lane-b",
  );
  expect((preview as any).defaultPreviewTarget(lanes, true, [])).toBe("manual");
  expect((preview as any).defaultPreviewTarget(lanes, false, [])).toBe(
    "lane-a",
  );
});
it("expires the last connected frame while the next read is still pending", async () => {
  vi.useFakeTimers();
  const capture = vi
    .fn()
    .mockResolvedValueOnce(frame())
    .mockImplementationOnce(() => new Promise<LanePreviewFrame>(() => {}));
  const receive = vi.fn();
  const close = preview.watchLanePreview(
    { captureLanePreview: capture },
    "lane-a",
    receive,
  );
  await flush();
  expect(receive).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "connected" }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(receive).toHaveBeenLastCalledWith(
    expect.objectContaining({
      status: "unavailable",
      message: expect.stringContaining("过期"),
    }),
  );
  expect(receive.mock.calls.at(-1)![0].imageDataUrl).toBeUndefined();
  close();
});
