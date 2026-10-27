import { useEffect, useState } from "react";
import type { DesktopAPI, DeviceLane } from "../../../../packages/protocol";
import type { LanePreviewFrame } from "../../../../packages/protocol/lane-preview";

export function defaultPreviewTarget(
  lanes: Pick<DeviceLane, "id" | "enabled">[],
  manualConnected: boolean,
  runningLaneIds: string[],
) {
  const enabled = lanes.filter((lane) => lane.enabled);
  return (
    enabled.find((lane) => runningLaneIds.includes(lane.id))?.id ??
    (manualConnected ? "manual" : (enabled[0]?.id ?? "manual"))
  );
}

/** One capture at a time; cancelling a subscription also rejects its late frame. */
export function watchLanePreview(
  api: Pick<DesktopAPI, "captureLanePreview">,
  laneId: string,
  receive: (frame: LanePreviewFrame) => void,
) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const unavailable = (message: string): LanePreviewFrame => ({
    status: "unavailable",
    laneId,
    laneName: "",
    instance: null,
    message,
  });
  const poll = async () => {
    let frame: LanePreviewFrame;
    try {
      frame = await api.captureLanePreview(laneId);
      const age = Date.now() - Date.parse(frame.capturedAt ?? "");
      if (
        frame.laneId !== laneId ||
        (frame.status === "connected" &&
          (!frame.imageDataUrl?.startsWith("data:image/") ||
            !Number.isFinite(age) ||
            age > 5000 ||
            age < -1000))
      ) {
        frame = unavailable(
          "画面已过期或账号已切换，正在等待当前账号的新画面。",
        );
      } else if (frame.status !== "connected") {
        frame = { ...frame, imageDataUrl: undefined, capturedAt: undefined };
      }
    } catch (error) {
      frame = unavailable(
        error instanceof Error ? error.message : "账号画面暂不可用，正在重试。",
      );
    }
    if (closed) return;
    if (expiry) clearTimeout(expiry);
    receive(frame);
    if (frame.status === "connected") {
      expiry = setTimeout(
        () => {
          if (!closed)
            receive(unavailable("画面已过期，正在等待当前账号的新画面。"));
        },
        Math.max(0, 5000 - (Date.now() - Date.parse(frame.capturedAt!))),
      );
    }
    timer = setTimeout(poll, 1000);
  };
  void poll();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (expiry) clearTimeout(expiry);
  };
}

export function useLanePreview(
  api: DesktopAPI | undefined,
  laneId: string | undefined,
) {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [frame, setFrame] = useState<LanePreviewFrame>();
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    setFrame(undefined);
    if (
      !visible ||
      !laneId ||
      !api ||
      typeof api.captureLanePreview !== "function"
    )
      return;
    return watchLanePreview(api, laneId, setFrame);
  }, [api, laneId, visible]);
  return {
    visible,
    frame: visible && frame?.laneId === laneId ? frame : undefined,
  };
}
