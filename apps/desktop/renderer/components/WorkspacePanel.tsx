import { useRef } from "react";
import { X } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import {
  boundWorkspaceWidth,
  type WorkspaceTab,
} from "../workspace-layout-state";
import DevicePreview from "./DevicePreview";

const tabs = ["tasks", "trajectory", "device"] as const;
const labels = { tasks: "任务", trajectory: "轨迹", device: "设备预览" };
export default function WorkspacePanel({
  desktop,
  open,
  tab,
  width,
  onTab,
  onWidth,
  onClose,
  targetRef,
}: {
  desktop: DesktopController;
  open: boolean;
  tab: WorkspaceTab;
  width: number;
  onTab: (tab: WorkspaceTab) => void;
  onWidth: (width: number) => void;
  onClose: () => void;
  targetRef: (element: HTMLDivElement | null) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <aside
      className="workspace-panel"
      id="workspace-panel"
      aria-label="右侧工作面板"
      hidden={!open || desktop.view !== "chat"}
      style={{ width }}
    >
      <div
        className="workspace-resize"
        role="separator"
        aria-label="调整右栏宽度"
        aria-orientation="vertical"
        aria-valuemin={280}
        aria-valuemax={480}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (drag.current)
            onWidth(
              boundWorkspaceWidth(
                drag.current.width + drag.current.x - event.clientX,
              ),
            );
        }}
        onPointerUp={(event) => {
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          onWidth(
            event.key === "Home"
              ? 280
              : event.key === "End"
                ? 480
                : boundWorkspaceWidth(
                    width + (event.key === "ArrowLeft" ? 10 : -10),
                  ),
          );
        }}
      />
      <div className="workspace-panel-header">
        <div role="tablist" aria-label="右栏内容">
          {tabs.map((value) => (
            <button
              type="button"
              role="tab"
              key={value}
              id={
                value === "trajectory"
                  ? "chat-trajectory-tab"
                  : `workspace-${value}-tab`
              }
              aria-controls={
                value === "trajectory"
                  ? "chat-trajectory-panel"
                  : `workspace-${value}-panel`
              }
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => onTab(value)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const index = tabs.indexOf(value);
                const next =
                  tabs[
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 2
                        : (index + (event.key === "ArrowLeft" ? 2 : 1)) % 3
                  ];
                onTab(next);
                document
                  .getElementById(
                    next === "trajectory"
                      ? "chat-trajectory-tab"
                      : `workspace-${next}-tab`,
                  )
                  ?.focus();
              }}
            >
              {labels[value]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭右侧工作面板"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <div className="workspace-panel-content" ref={targetRef} />
      <div
        className="workspace-device-content"
        id="workspace-device-panel"
        role="tabpanel"
        aria-labelledby="workspace-device-tab"
        hidden={tab !== "device"}
      >
        {open && tab === "device" && desktop.view === "chat" && (
          <DevicePreview desktop={desktop} />
        )}
      </div>
    </aside>
  );
}
