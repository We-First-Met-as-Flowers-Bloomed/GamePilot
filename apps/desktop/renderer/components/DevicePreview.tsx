import { Monitor, ScanLine, ArrowUpRight, ShieldCheck } from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
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
  return (
    <>
      <div className="panel-title">
        <span>设备预览</span>
        <span className={`badge ${connected ? "green" : ""}`}>
          <i />
          {connected ? "已连接" : "未连接"}
        </span>
      </div>
      <div className={`device-screen ${shot ? "has-shot" : ""}`}>
        {shot ? (
          <img src={shot} alt="已连接 Android 设备的最新截图" />
        ) : (
          <div className="device-empty">
            <Monitor size={30} strokeWidth={1.2} />
            <strong>{connected ? "设备已就绪" : "等待连接设备"}</strong>
            <p>
              {connected
                ? "点击截取画面，查看当前游戏状态"
                : "连接模拟器后，在这里查看真实游戏画面"}
            </p>
          </div>
        )}
      </div>
      <div className="device-meta">
        <span>{connected ? snapshot.engine?.address : "Android / MuMu"}</span>
        <span>{shotTime ? `截于 ${shotTime}` : "暂无截图"}</span>
      </div>
      <button
        className="button full"
        disabled={!api || !connected || !!busy || active}
        onClick={capture}
      >
        <ScanLine size={15} />
        {busy === "capture" ? "正在截图…" : "截取画面"}
      </button>
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
