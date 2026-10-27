import { useState } from "react";
import { Monitor, ScanLine, ArrowUpRight, ShieldCheck } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import { defaultPreviewTarget, useLanePreview } from "../hooks/useLanePreview";
export default function DevicePreview({
  desktop,
}: {
  desktop: DesktopController;
}) {
  const {
    connected,
    shot,
    snapshot,
    shotTime,
    api,
    busy,
    active,
    capture,
    setView,
  } = desktop;
  const supported = typeof api?.captureLanePreview === "function";
  const lanes = desktop.deviceLanes.lanes.filter((lane) => lane.enabled);
  const runningLaneIds = lanes
    .filter(
      (lane) =>
        ["running", "queued", "stopping"].includes(
          desktop.laneStatuses[lane.id] ?? "",
        ) ||
        snapshot.executions?.some(
          (record) => record.laneId === lane.id && record.status === "running",
        ),
    )
    .map((lane) => lane.id);
  const [choice, setChoice] = useState<string>();
  const target = !supported
    ? "manual"
    : choice &&
        (choice === "manual" || lanes.some((lane) => lane.id === choice))
      ? choice
      : defaultPreviewTarget(lanes, connected, runningLaneIds);
  const lane = lanes.find((item) => item.id === target);
  const preview = useLanePreview(api, supported && lane ? lane.id : undefined);
  const frame = preview.frame;
  const accountMode = supported && !!lane;
  const isConnected = accountMode ? frame?.status === "connected" : connected;
  const image = accountMode ? frame?.imageDataUrl : shot;
  const message = accountMode
    ? !preview.visible
      ? "窗口不可见，账号画面已暂停。"
      : (frame?.message ?? "正在读取账号当前连接的设备画面…")
    : connected
      ? "点击截取画面，查看当前游戏状态"
      : "连接模拟器后，在这里查看真实游戏画面";
  return (
    <>
      <div className="panel-title">
        <span>设备预览</span>
        <span
          className={`badge ${isConnected ? "green" : ""}`}
          data-preview-status={
            accountMode
              ? (frame?.status ?? "loading")
              : connected
                ? "connected"
                : "unavailable"
          }
        >
          <i />
          {isConnected
            ? "已连接"
            : accountMode
              ? frame
                ? "画面暂不可用"
                : "等待画面"
              : "未连接"}
        </span>
      </div>
      {supported && (
        <label className="device-preview-select">
          预览账号
          <select
            className="input"
            aria-label="预览账号"
            value={target}
            onChange={(event) => setChoice(event.target.value)}
          >
            {lanes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · 实例 {item.instance}
              </option>
            ))}
            <option value="manual">手动连接设备</option>
          </select>
        </label>
      )}
      <div
        className={`device-screen ${image ? "has-shot" : ""}`}
        data-preview-lane-id={lane?.id}
      >
        {image ? (
          <img
            src={image}
            alt={
              accountMode
                ? `${lane!.name}当前设备画面`
                : "已连接 Android 设备的最新截图"
            }
          />
        ) : (
          <div className="device-empty">
            <Monitor size={30} strokeWidth={1.2} />
            <strong>
              {accountMode
                ? lane!.name
                : connected
                  ? "设备已就绪"
                  : "等待连接设备"}
            </strong>
            <p>{message}</p>
          </div>
        )}
      </div>
      <div className="device-meta">
        <span>
          {accountMode
            ? `${lane!.name} · 实例 ${frame?.instance ?? lane!.instance}`
            : connected
              ? snapshot.engine?.address
              : "Android / MuMu"}
        </span>
        <span>
          {accountMode
            ? frame?.capturedAt
              ? `截于 ${new Date(frame.capturedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
              : "暂无当前画面"
            : shotTime
              ? `截于 ${shotTime}`
              : "暂无截图"}
        </span>
      </div>
      {accountMode ? (
        <p className="helper device-preview-message" role="status">
          {message} · 可见时约每秒刷新
        </p>
      ) : (
        <button
          className="button full"
          disabled={!api || !connected || !!busy || active}
          onClick={capture}
        >
          <ScanLine size={15} />
          {busy === "capture" ? "正在截图…" : "截取画面"}
        </button>
      )}
      <button className="text-button full" onClick={() => setView("devices")}>
        管理设备 <ArrowUpRight size={14} />
      </button>
      <div className="device-note">
        <ShieldCheck size={17} />
        <p>
          画面来自本地设备。
          <br />
          演练不会点击或操作游戏。
        </p>
      </div>
    </>
  );
}
