import type { DesktopController } from "../hooks/useDesktop";
import AutomationSettings from "../components/AutomationSettings";
export default function Settings({ desktop }: { desktop: DesktopController }) {
  const { api } = desktop;
  return (
    <div className="page">
      <div className="eyebrow">PREFERENCES</div>
      <h1>全局设置</h1>
      <p className="intro">
        定时与开机启动执行首页的每日计划。游戏配置位于各游戏工作区。
      </p>
      <AutomationSettings api={api} />
      <section className="surface">
        <h3>设备与连接</h3>
        <p className="muted">
          ADB
          路径与地址统一在设备页保存，用于单设备工具与设备预览。每日计划使用设备页的模拟器绑定。
        </p>
        <button className="button" onClick={desktop.openDeviceConnection}>
          打开高级连接
        </button>
      </section>
      <section className="surface">
        <div className="section-label">
          <h3>AI 规划服务</h3>
          <span className="badge">模型连接</span>
        </div>
        <p className="muted">
          在模型连接页选择 Codex 或兼容 API，管理密钥并测试连接。
        </p>
        <button
          type="button"
          className="button"
          onClick={() => desktop.setView("models")}
        >
          打开模型连接
        </button>
      </section>
    </div>
  );
}
