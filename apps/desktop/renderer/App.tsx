import { useLayoutEffect, useState } from "react";
import {
  Bot,
  ChevronDown,
  Command,
  Folder,
  ListChecks,
  MessageSquare,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings2,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { useDesktop, type View } from "./hooks/useDesktop";
import { useChat } from "./hooks/useChat";
import Chat from "./views/Chat";
import GameWorkspace from "./components/GameWorkspace";
import DevicePreview from "./components/DevicePreview";
import Devices from "./views/Devices";
import Daily from "./views/Daily";
import Library from "./views/Library";
import Settings from "./views/Settings";
import ModelConnection from "./views/ModelConnection";
import ExecutionDetailDialog from "./components/ExecutionDetail";

const titles: Record<View, string> = {
  chat: "对话",
  daily: "每日计划",
  workspace: "游戏工作区",
  devices: "设备与账号",
  library: "技能库",
  settings: "设置",
  models: "模型连接",
};
export default function App() {
  const desktop = useDesktop(),
    chat = useChat(desktop.api);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detailId, setDetailId] = useState<string>();
  const { api, view, setView, game, snapshot, error, setError, notice } =
    desktop;
  const session = chat.state.sessions.find(
    (s) => s.id === chat.state.selectedSessionId,
  );
  useLayoutEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);
  const newChat = () => {
    setView("chat");
    desktop.openPlanner();
    void chat.newSession();
  };
  return (
    <div
      className={`app-shell chat-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}
    >
      <aside
        className="sidebar"
        hidden={!sidebarOpen}
        aria-label="工作空间侧栏"
      >
        <div className="brand">
          <span className="brand-mark">
            <Command size={23} />
          </span>
          <strong>GamePilot</strong>
          <span className="version">AGENT</span>
        </div>
        <button
          className="new-task"
          id="chat-new"
          onClick={newChat}
          disabled={chat.pending || !api}
        >
          <Plus size={17} />
          新对话
        </button>
        <nav aria-label="主导航">
          <button
            className={`nav-item ${view === "chat" ? "selected" : ""}`}
            aria-current={view === "chat" ? "page" : undefined}
            onClick={() => setView("chat")}
          >
            <MessageSquare size={17} />
            对话工作台
          </button>
        </nav>
        <details className="sidebar-tools">
          <summary>
            <Wrench size={16} />
            游戏与工具
            <ChevronDown size={14} />
          </summary>
          <div>
            <button
              className={`nav-item ${view === "daily" ? "selected" : ""}`}
              onClick={() => setView("daily")}
            >
              <ListChecks size={16} />
              每日计划与开关
            </button>
            <button
              className={`nav-item ${view === "devices" ? "selected" : ""}`}
              onClick={() => setView("devices")}
            >
              <Monitor size={16} />
              设备与账号
            </button>
            <button
              className={`nav-item ${view === "library" ? "selected" : ""}`}
              onClick={() => setView("library")}
            >
              <Wrench size={16} />
              技能库
            </button>
            {desktop.games.map((item) => (
              <button
                className={`nav-item ${view === "workspace" && game.id === item.id ? "selected" : ""}`}
                key={item.id}
                disabled={desktop.active || !!desktop.busy}
                onClick={() => desktop.selectGame(item.id)}
              >
                <Folder size={16} />
                {item.name}
                <small>工作区</small>
              </button>
            ))}
          </div>
        </details>
        <div className="chat-history-heading">
          最近对话
          <span>
            {chat.state.sessions.filter((s) => s.turns.length).length}
          </span>
        </div>
        <nav className="chat-history" aria-label="历史对话">
          {[...chat.state.sessions]
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .map((s) => (
              <button
                className={`chat-session ${s.id === session?.id && view === "chat" ? "selected" : ""}`}
                data-chat-session-id={s.id}
                key={s.id}
                title={s.title}
                disabled={chat.pending}
                onClick={() => {
                  setView("chat");
                  void chat.select(s.id);
                }}
              >
                <MessageSquare size={14} />
                <span>{s.title}</span>
                {s.turns.some((t) =>
                  ["running", "cancelling"].includes(t.planner.status),
                ) && <i className="tiny-dot" />}
              </button>
            ))}
          {!chat.state.sessions.length && (
            <p className="sidebar-empty">对话会保存在这台电脑上。</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-runtime">
            <span className="tiny-dot" />
            {desktop.active ? "任务正在执行" : "本地游戏工作空间"}
          </div>
          <div className="sidebar-footer-tools">
            <button className="nav-item" onClick={() => setView("settings")}>
              <Settings2 size={17} />
              设置
            </button>
            <button
              className="icon-button"
              aria-label="模型连接"
              title="模型连接"
              onClick={() => setView("models")}
            >
              <Bot size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="设备与账号"
              title="设备与账号"
              onClick={() => setView("devices")}
            >
              <Monitor size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="chat-topbar-left">
            <button
              className="icon-button"
              id="sidebar-toggle"
              aria-label={sidebarOpen ? "收起侧栏" : "展开侧栏"}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
            <span className="chat-topbar-title">
              {view === "chat" ? session?.title || "新对话" : titles[view]}
            </span>
            {view !== "chat" && (
              <button className="text-button" onClick={() => setView("chat")}>
                <MessageSquare size={13} />
                返回对话
              </button>
            )}
          </div>
          <div className="chat-topbar-actions">
            {desktop.active && (
              <button
                className="button chat-global-stop"
                disabled={!api || desktop.globalStatus === "stopping"}
                onClick={desktop.stop}
              >
                <Square size={13} />
                {desktop.globalStatus === "stopping" ? "正在停止…" : "停止全部"}
              </button>
            )}
            <button
              className="icon-button"
              title={previewOpen ? "收起设备预览" : "打开设备预览"}
              aria-label={previewOpen ? "收起设备预览" : "打开设备预览"}
              aria-expanded={previewOpen}
              onClick={() => setPreviewOpen((v) => !v)}
            >
              {previewOpen ? (
                <PanelRightClose size={18} />
              ) : (
                <PanelRightOpen size={18} />
              )}
            </button>
          </div>
        </header>
        {snapshot.engineError && (
          <div className="banner warning">
            引擎暂不可用：{snapshot.engineError}
          </div>
        )}
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button aria-label="关闭错误" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner success" role="status">
            {notice}
          </div>
        )}
        <div className={`content-layout ${previewOpen ? "preview-open" : ""}`}>
          <main className="main-content">
            <div className="chat-view-host" hidden={view !== "chat"}>
              <Chat
                desktop={desktop}
                chat={chat}
                onOpenExecution={setDetailId}
              />
            </div>
            {view === "daily" && (
              <Daily desktop={desktop} onOpenExecution={setDetailId} />
            )}
            <div hidden={view !== "workspace"}>
              <GameWorkspace key={game.id} desktop={desktop} />
            </div>
            {view === "devices" && <Devices desktop={desktop} />}
            {view === "library" && <Library desktop={desktop} />}
            {view === "settings" && <Settings desktop={desktop} />}
            {view === "models" && (
              <ModelConnection api={api} onOpenPlanner={desktop.openPlanner} />
            )}
          </main>
          <aside className="device-panel" hidden={!previewOpen}>
            <DevicePreview desktop={desktop} />
          </aside>
        </div>
      </div>
      {detailId && (
        <ExecutionDetailDialog
          key={detailId}
          api={api}
          requestId={detailId}
          onClose={() => setDetailId(undefined)}
          onOpenExecution={setDetailId}
        />
      )}
    </div>
  );
}
