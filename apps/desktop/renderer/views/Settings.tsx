import type { DesktopController } from "../hooks/useDesktop";
import AutomationSettings from "../components/AutomationSettings";
import "../channels.css";
import { useEffect, useState } from "react";
import {
  applyTheme,
  currentThemePreference,
  saveThemePreference,
  themePreference,
  themeChangeEvent,
  type ThemePreference,
} from "../appearance";
export default function Settings({ desktop }: { desktop: DesktopController }) {
  const { api } = desktop;
  const [appearance, setAppearance] = useState<ThemePreference>(() => {
    return currentThemePreference(document.documentElement);
  });
  const [appearanceNotice, setAppearanceNotice] = useState("");
  useEffect(() => {
    const syncTheme = () =>
      setAppearance(currentThemePreference(document.documentElement));
    document.documentElement.addEventListener(themeChangeEvent, syncTheme);
    return () =>
      document.documentElement.removeEventListener(themeChangeEvent, syncTheme);
  }, []);
  return (
    <div className="page">
      <div className="eyebrow">PREFERENCES</div>
      <h1>全局设置</h1>
      <p className="intro">
        管理 App 定时、启动与外观。已启用的 App
        定时执行各槽位的保存计划；Windows 方舟日常是独立的起跑入口。
      </p>
      <AutomationSettings api={api} />
      <section className="surface" aria-labelledby="appearance-heading">
        <div className="section-label">
          <h3 id="appearance-heading">外观</h3>
          <span className="badge">本机偏好</span>
        </div>
        <p className="muted">
          选择工作台主题。跟随系统时会自动响应系统外观变化。
        </p>
        <label className="appearance-control">
          主题
          <select
            aria-label="外观主题"
            value={appearance}
            onChange={(event) => {
              const value = themePreference(event.target.value);
              setAppearance(value);
              applyTheme(value, document.documentElement);
              let saved = false;
              try {
                saved = saveThemePreference(value, window.localStorage);
              } catch {
                /* storage unavailable */
              }
              setAppearanceNotice(
                saved
                  ? ""
                  : "主题已应用；本机偏好暂未保存，重启后可能恢复此前的选择。",
              );
            }}
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        {appearanceNotice && (
          <p className="muted" role="status">
            {appearanceNotice}
          </p>
        )}
      </section>
      <section className="surface">
        <h3>设备与连接</h3>
        <p className="muted">
          各槽位的账号、游戏与模拟器绑定在设备与账号页保存。高级连接用于单设备工具和设备预览。
        </p>
        <button className="button" onClick={desktop.openDeviceConnection}>
          打开高级连接
        </button>
      </section>
      <details className="surface settings-ai-tools">
        <summary>高级 AI 辅助工具</summary>
        <div className="section-label">
          <h3>AI 辅助与模型连接</h3>
          <span className="badge">模型连接</span>
        </div>
        <p className="muted">
          按需打开对话辅助与计划草稿。已保存的槽位计划可直接运行；模型连接用于选择服务、管理密钥并测试连接。
        </p>
        <button
          type="button"
          className="button"
          onClick={() => desktop.setView("chat")}
        >
          打开AI辅助
        </button>
        <button
          type="button"
          className="button"
          aria-label="模型连接"
          onClick={() => desktop.setView("models")}
        >
          打开模型连接
        </button>
      </details>
    </div>
  );
}
