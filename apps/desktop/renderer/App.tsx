import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Archive,
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
import SlotDashboard from "./views/SlotDashboard";
import "./slot-shell.css";
import ChatSessionMenu from "./components/ChatSessionMenu";
import {
  groupWorkspaceSessions,
  nextSessionIndex,
  readWorkspacePreferences,
  saveWorkspacePreferences,
  sessionAlias,
  type WorkspaceTab,
} from "./workspace-layout-state";
import CommandPalette, {
  paletteFocusTarget,
  type PaletteCommand,
} from "./components/CommandPalette";
import {
  applyTheme,
  currentThemePreference,
  saveThemePreference,
  themeChangeEvent,
  type ThemePreference,
} from "./appearance";
import { isComposingKey } from "./slash-command-state";
import { projectAccountChannels } from "./account-channels";

const Chat = lazy(() => import("./views/Chat"));
const GameWorkspace = lazy(() => import("./components/GameWorkspace"));
const WorkspacePanel = lazy(() => import("./components/WorkspacePanel"));
const ChatArchives = lazy(() => import("./components/ChatArchives"));
const Devices = lazy(() => import("./views/Devices"));
const Daily = lazy(() => import("./views/Daily"));
const Library = lazy(() => import("./views/Library"));
const Settings = lazy(() => import("./views/Settings"));
const ModelConnection = lazy(() => import("./views/ModelConnection"));
const ExecutionDetailDialog = lazy(
  () => import("./components/ExecutionDetail"),
);
const loading = (
  <p className="view-loading" role="status">
    正在打开页面…
  </p>
);

const titles: Record<View, string> = {
  slots: "槽位总览",
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
  const [chatOpened, setChatOpened] = useState(false);
  const [workspaceOpened, setWorkspaceOpened] = useState(false);
  useEffect(() => {
    if (desktop.view === "chat") setChatOpened(true);
    if (desktop.view === "workspace") setWorkspaceOpened(true);
  }, [desktop.view]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [appearance, setAppearance] = useState(() =>
    currentThemePreference(document.documentElement),
  );
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("tasks");
  const [workspaceTarget, setWorkspaceTarget] = useState<HTMLDivElement | null>(
    null,
  );
  const [preferences, setPreferences] = useState(() => {
    try {
      return readWorkspacePreferences(window.localStorage);
    } catch {
      return { width: 340, aliases: {} as Record<string, string> };
    }
  });
  const [rename, setRename] = useState<{ id: string; value: string }>();
  const [layoutNotice, setLayoutNotice] = useState("");
  const renameDialog = useRef<HTMLDialogElement>(null);
  const renameReturn = useRef<HTMLElement | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string }>();
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const deleteReturn = useRef<HTMLElement | null>(null);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const archiveDialog = useRef<HTMLDialogElement>(null);
  const archiveReturn = useRef<HTMLElement | null>(null);
  const [detailId, setDetailId] = useState<string>();
  const { api, view, setView, game, snapshot, error, setError, notice } =
    desktop;
  const channels = projectAccountChannels({
    lanes: desktop.deviceLanes.lanes,
    profiles: desktop.arknightsProfiles.profiles,
  });
  const session = chat.state.sessions.find(
    (s) => s.id === chat.state.selectedSessionId,
  );
  const groups = groupWorkspaceSessions(chat.state.sessions);
  const orderedSessions = groups.flatMap((group) => group.sessions);
  const displayTitle = (id: string, title: string) =>
    Object.hasOwn(preferences.aliases, id) ? preferences.aliases[id] : title;
  const persistPreferences = (next: typeof preferences) => {
    setPreferences(next);
    let saved = false;
    try {
      saved = saveWorkspacePreferences(next, window.localStorage);
    } catch {
      /* storage unavailable */
    }
    setLayoutNotice(
      saved ? "" : "本机偏好无法保存，当前窗口仍会保留此次调整。",
    );
  };
  const openWorkspace = (tab: WorkspaceTab) => {
    setWorkspaceTab(tab);
    setPreviewOpen(true);
  };
  const restoreFocus = (origin: HTMLElement | null) => {
    paletteFocusTarget(origin, [
      ...document.querySelectorAll<HTMLElement>(
        ".chat-history button:not([disabled]), #chat-new:not([disabled]), #sidebar-toggle",
      ),
    ])?.focus({ preventScroll: true });
  };
  const closeRename = () => {
    renameDialog.current?.close();
    setRename(undefined);
    restoreFocus(renameReturn.current);
  };
  const startRename = (id: string, title: string, origin: HTMLElement) => {
    renameReturn.current = origin;
    setRename({ id, value: displayTitle(id, title) });
  };
  useLayoutEffect(() => {
    if (rename) {
      renameDialog.current?.showModal();
      renameDialog.current?.querySelector<HTMLInputElement>("input")?.select();
    }
  }, [rename?.id]);
  const closeDelete = () => {
    deleteDialog.current?.close();
    setDeleting(undefined);
    restoreFocus(deleteReturn.current);
  };
  const closeArchives = () => {
    archiveDialog.current?.close();
    setArchivesOpen(false);
    restoreFocus(archiveReturn.current);
  };
  useLayoutEffect(() => {
    if (deleting) {
      deleteDialog.current?.showModal();
      deleteDialog.current
        ?.querySelector<HTMLButtonElement>("[data-delete-cancel]")
        ?.focus();
    }
  }, [deleting?.id]);
  useLayoutEffect(() => {
    if (archivesOpen) {
      archiveDialog.current?.showModal();
      archiveDialog.current
        ?.querySelector<HTMLButtonElement>("[data-archive-close]")
        ?.focus();
    }
  }, [archivesOpen]);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);
  const newChat = () => {
    if (chat.pending || !api) return;
    setView("chat");
    desktop.openPlanner();
    void chat.newSession();
  };
  useEffect(() => {
    const syncTheme = () =>
      setAppearance(currentThemePreference(document.documentElement));
    document.documentElement.addEventListener(themeChangeEvent, syncTheme);
    return () =>
      document.documentElement.removeEventListener(themeChangeEvent, syncTheme);
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        isComposingKey(event) ||
        event.defaultPrevented ||
        document.querySelector("dialog[open]")
      )
        return;
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        newChat();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });
  const changeAppearance = (value: ThemePreference) => {
    applyTheme(value, document.documentElement);
    setAppearance(currentThemePreference(document.documentElement));
    let saved = false;
    try {
      saved = saveThemePreference(value, window.localStorage);
    } catch {
      /* unavailable storage */
    }
    setLayoutNotice(
      saved ? "" : "主题已应用；本机偏好暂未保存，重启后可能恢复此前的选择。",
    );
  };
  const paletteCommands: PaletteCommand[] = [
    ...(view === "chat"
      ? [
          {
            id: "new-chat",
            label: "新对话",
            keywords: "new chat",
            detail: "Ctrl+Shift+N",
            disabled: chat.pending || !api,
            run: newChat,
          },
        ]
      : []),
    ...(
      [
        "slots",
        "chat",
        "daily",
        "devices",
        "library",
        "settings",
        "models",
      ] as const
    ).map((target) => ({
      id: `page-${target}`,
      label: target === "chat" ? "打开AI辅助（高级）" : `打开${titles[target]}`,
      keywords: target,
      run: () => setView(target),
    })),
    ...(view === "chat" ? orderedSessions : []).map((item) => ({
      id: `session-${item.id}`,
      label: `切换会话：${displayTitle(item.id, item.title)}`,
      keywords: "session chat",
      disabled: chat.pending,
      run: () => {
        setView("chat");
        void chat.select(item.id);
      },
    })),
    ...(["system", "light", "dark"] as const).map((value) => ({
      id: `theme-${value}`,
      label: `外观：${{ system: "跟随系统", light: "浅色", dark: "深色" }[value]}`,
      keywords: `theme ${value}`,
      detail: appearance === value ? "当前" : undefined,
      run: () => changeAppearance(value),
    })),
    {
      id: "toggle-sidebar",
      label: sidebarOpen ? "收起侧栏" : "展开侧栏",
      keywords: "sidebar",
      run: () => setSidebarOpen((value) => !value),
    },
    {
      id: "toggle-workspace",
      label: previewOpen ? "收起右侧工作区" : "展开右侧工作区",
      keywords: "workspace panel",
      disabled: view !== "chat",
      run: () => setPreviewOpen((value) => !value),
    },
  ];
  return (
    <div
      className={`app-shell chat-shell slot-first-shell ${view === "chat" ? "ai-workspace" : "slot-workspace"} ${sidebarOpen ? "" : "sidebar-collapsed"}`}
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
          <span className="version">本地</span>
        </div>
        {view === "chat" && (
          <button
            className="new-task"
            id="chat-new"
            onClick={newChat}
            disabled={chat.pending || !api}
          >
            <Plus size={17} />
            新对话
          </button>
        )}
        <nav aria-label="主导航">
          <button
            className={`nav-item ${view === "slots" ? "selected" : ""}`}
            aria-current={view === "slots" ? "page" : undefined}
            onClick={() => setView("slots")}
          >
            <Monitor size={17} /> 槽位总览
          </button>
          <button
            className={`nav-item ${view === "daily" ? "selected" : ""}`}
            aria-current={view === "daily" ? "page" : undefined}
            onClick={() => setView("daily")}
          >
            <ListChecks size={17} /> 每日任务
          </button>
          <button
            className={`nav-item ${view === "devices" ? "selected" : ""}`}
            aria-current={view === "devices" ? "page" : undefined}
            onClick={() => setView("devices")}
          >
            <Monitor size={17} /> 设备与账号
          </button>
          {view === "chat" && (
            <button
              className={`nav-item ${view === "chat" ? "selected" : ""}`}
              aria-current={view === "chat" ? "page" : undefined}
              onClick={() => setView("chat")}
            >
              <MessageSquare size={17} />
              对话工作台
            </button>
          )}
        </nav>
        <details className="sidebar-tools">
          <summary>
            <Wrench size={16} />
            游戏与工具
            <ChevronDown size={14} />
          </summary>
          <div>
            <button
              className={`nav-item ${view === "library" ? "selected" : ""}`}
              onClick={() => setView("library")}
            >
              <Wrench size={16} />
              技能库
            </button>
            {desktop.games
              .filter((item) =>
                desktop.deviceLanes.lanes.some(
                  (lane) =>
                    lane.enabled &&
                    (item.id === "arknights"
                      ? lane.arknights.enabled
                      : item.id === "onmyoji"
                        ? lane.onmyoji.enabled
                        : false),
                ),
              )
              .map((item) => (
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
        {(view === "chat" || chatOpened) && (
          <div className="sidebar-chat-section" hidden={view !== "chat"}>
            <div className="chat-history-heading">
              最近对话
              <span>
                {chat.state.sessions.filter((s) => s.turns.length).length}
              </span>
            </div>
            <nav className="chat-history" aria-label="历史对话">
              {groups.map((group) => (
                <div className="chat-session-group" key={group.label}>
                  <h2>{group.label}</h2>
                  {group.sessions.map((s) => (
                    <div className="chat-session-row" key={s.id}>
                      <button
                        className={`chat-session ${s.id === session?.id && view === "chat" ? "selected" : ""}`}
                        data-chat-session-id={s.id}
                        key={s.id}
                        title={displayTitle(s.id, s.title)}
                        disabled={chat.pending}
                        onKeyDown={(event) => {
                          if (event.key === "F2") {
                            event.preventDefault();
                            startRename(s.id, s.title, event.currentTarget);
                          }
                          if (
                            ["ArrowUp", "ArrowDown", "Home", "End"].includes(
                              event.key,
                            )
                          ) {
                            event.preventDefault();
                            const next =
                              orderedSessions[
                                nextSessionIndex(
                                  orderedSessions.findIndex(
                                    (item) => item.id === s.id,
                                  ),
                                  orderedSessions.length,
                                  event.key,
                                )
                              ];
                            const buttons = [
                              ...event.currentTarget
                                .closest("nav")!
                                .querySelectorAll<HTMLButtonElement>(
                                  "[data-chat-session-id]",
                                ),
                            ];
                            buttons
                              .find(
                                (button) =>
                                  button.dataset.chatSessionId === next?.id,
                              )
                              ?.focus();
                          }
                        }}
                        onClick={() => {
                          setView("chat");
                          void chat.select(s.id);
                        }}
                      >
                        <MessageSquare size={14} />
                        <span>{displayTitle(s.id, s.title)}</span>
                        {s.turns.some((t) =>
                          ["running", "cancelling"].includes(t.planner.status),
                        ) && <i className="tiny-dot" />}
                      </button>
                      <ChatSessionMenu
                        title={displayTitle(s.id, s.title)}
                        pending={chat.pending}
                        processing={s.turns.some((turn) =>
                          ["running", "cancelling"].includes(
                            turn.planner.status,
                          ),
                        )}
                        canArchive={
                          !!api &&
                          typeof api.archiveChat === "function" &&
                          !!s.turns.length
                        }
                        canDelete={
                          !!api && typeof api.deleteChat === "function"
                        }
                        onRename={(origin) =>
                          startRename(s.id, s.title, origin)
                        }
                        onArchive={(origin) => {
                          void chat.archive(s.id).then((saved) => {
                            setLayoutNotice(
                              saved
                                ? "会话已归档，可在侧栏“归档对话”中查看与恢复。"
                                : "会话归档未完成，原对话保留。请查看对话中的错误提示。",
                            );
                            requestAnimationFrame(() => restoreFocus(origin));
                          });
                        }}
                        onDelete={(origin) => {
                          deleteReturn.current = origin;
                          setDeleting({
                            id: s.id,
                            title: displayTitle(s.id, s.title),
                          });
                        }}
                      />
                    </div>
                  ))}
                </div>
              ))}
              {!chat.state.sessions.length && (
                <p className="sidebar-empty">对话会保存在这台电脑上。</p>
              )}
            </nav>
            <button
              id="chat-archives-open"
              type="button"
              className="nav-item sidebar-archives"
              aria-haspopup="dialog"
              onClick={(event) => {
                archiveReturn.current = event.currentTarget;
                setArchivesOpen(true);
              }}
            >
              <Archive size={16} />
              归档对话
            </button>
          </div>
        )}
        <div className="sidebar-bottom">
          <button
            id="command-palette-open"
            type="button"
            className="nav-item"
            aria-haspopup="dialog"
            onClick={() => setPaletteOpen(true)}
          >
            <Command size={17} />
            命令面板 <small>Ctrl+K</small>
          </button>
          <div className="sidebar-runtime">
            <span className="tiny-dot" />
            {desktop.active
              ? "任务正在执行"
              : desktop.hydrated
                ? `${channels.length} 个账号渠道`
                : "正在读取账号渠道配置"}
          </div>
          <div className="sidebar-footer-tools">
            <button className="nav-item" onClick={() => setView("settings")}>
              <Settings2 size={17} />
              设置
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
            <h1 className="chat-topbar-title">
              {view === "chat"
                ? session
                  ? displayTitle(session.id, session.title)
                  : "新对话"
                : titles[view]}
            </h1>
            {view !== "chat" && chatOpened && (
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
            {view === "chat" && (
              <button
                className="icon-button"
                title={previewOpen ? "收起设备预览" : "打开设备预览"}
                aria-label={previewOpen ? "收起设备预览" : "打开设备预览"}
                aria-expanded={previewOpen}
                aria-controls="workspace-panel"
                aria-description="展开或收起右侧任务、轨迹与设备预览面板"
                disabled={view !== "chat"}
                onClick={() => setPreviewOpen((v) => !v)}
              >
                {previewOpen ? (
                  <PanelRightClose size={18} />
                ) : (
                  <PanelRightOpen size={18} />
                )}
              </button>
            )}
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
        {layoutNotice && (
          <p className="banner warning workspace-notice" role="status">
            {layoutNotice}
          </p>
        )}
        <div
          className={`content-layout ${previewOpen && view === "chat" ? "preview-open" : ""}`}
        >
          <main className="main-content">
            <Suspense fallback={loading}>
              {view === "slots" && (
                <SlotDashboard
                  desktop={desktop}
                  onOpenExecution={setDetailId}
                />
              )}
              <div className="chat-view-host" hidden={view !== "chat"}>
                {(view === "chat" || chatOpened) && (
                  <Chat
                    desktop={desktop}
                    chat={chat}
                    onOpenExecution={setDetailId}
                    workspaceTarget={workspaceTarget}
                    workspaceTab={workspaceTab}
                    onOpenWorkspace={openWorkspace}
                  />
                )}
              </div>
              {view === "daily" && (
                <Daily desktop={desktop} onOpenExecution={setDetailId} />
              )}
              <div hidden={view !== "workspace"}>
                {(view === "workspace" || workspaceOpened) && (
                  <GameWorkspace key={game.id} desktop={desktop} />
                )}
              </div>
              {view === "devices" && <Devices desktop={desktop} />}
              {view === "library" && <Library desktop={desktop} />}
              {view === "settings" && <Settings desktop={desktop} />}
              {view === "models" && (
                <ModelConnection
                  api={api}
                  onOpenPlanner={desktop.openPlanner}
                />
              )}
            </Suspense>
          </main>
          {(view === "chat" || chatOpened) && (
            <Suspense fallback={null}>
              <WorkspacePanel
                desktop={desktop}
                open={previewOpen && view === "chat"}
                tab={workspaceTab}
                width={preferences.width}
                onTab={setWorkspaceTab}
                onWidth={(width) =>
                  persistPreferences({ ...preferences, width })
                }
                onClose={() => {
                  setPreviewOpen(false);
                  document
                    .querySelector<HTMLButtonElement>(
                      '[aria-controls="workspace-panel"]',
                    )
                    ?.focus();
                }}
                targetRef={setWorkspaceTarget}
              />
            </Suspense>
          )}
        </div>
      </div>
      <dialog
        ref={renameDialog}
        className="workspace-rename-dialog"
        aria-labelledby="workspace-rename-title"
        onCancel={(event) => {
          event.preventDefault();
          closeRename();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!rename) return;
            const aliases = { ...preferences.aliases };
            const value = sessionAlias(rename.value);
            if (value)
              Object.defineProperty(aliases, rename.id, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
              });
            else delete aliases[rename.id];
            persistPreferences({ ...preferences, aliases });
            closeRename();
          }}
        >
          <h2 id="workspace-rename-title">修改本机显示名称</h2>
          <p className="helper">
            仅改变本机侧栏和标题显示，宿主会话标题与任务记录保持原值。留空恢复原名称。
          </p>
          <label htmlFor="workspace-rename-input">本机显示名称</label>
          <input
            id="workspace-rename-input"
            className="input"
            maxLength={120}
            value={rename?.value ?? ""}
            onChange={(event) =>
              setRename((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
          />
          <div className="workspace-rename-actions">
            <button type="button" className="button" onClick={closeRename}>
              取消
            </button>
            <button type="submit" className="button primary">
              保存
            </button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={deleteDialog}
        className="workspace-rename-dialog chat-delete-dialog"
        aria-labelledby="chat-delete-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!chat.pending) closeDelete();
        }}
      >
        <h2 id="chat-delete-title">删除当前对话</h2>
        <p>{deleting?.title}</p>
        <p className="helper">删除当前对话，已归档副本和任务记录会保留。</p>
        {chat.error && (
          <p className="banner warning" role="alert">
            {chat.error}
          </p>
        )}
        <div className="workspace-rename-actions">
          <button
            type="button"
            className="button"
            data-delete-cancel
            disabled={chat.pending}
            onClick={closeDelete}
          >
            取消
          </button>
          <button
            id="chat-delete-confirm"
            type="button"
            className="button danger"
            disabled={chat.pending || !deleting}
            onClick={() => {
              if (!deleting) return;
              void chat.delete(deleting.id).then((saved) => {
                if (saved) {
                  closeDelete();
                  requestAnimationFrame(() =>
                    restoreFocus(deleteReturn.current),
                  );
                }
              });
            }}
          >
            {chat.pending ? "正在删除…" : "确认删除"}
          </button>
        </div>
      </dialog>
      <dialog
        ref={archiveDialog}
        className="chat-archives-dialog"
        aria-labelledby="chat-archives-title"
        onCancel={(event) => {
          event.preventDefault();
          closeArchives();
        }}
      >
        <header>
          <h2 id="chat-archives-title">归档对话</h2>
          <button
            type="button"
            className="icon-button"
            data-archive-close
            aria-label="关闭归档对话"
            onClick={closeArchives}
          >
            <X size={17} />
          </button>
        </header>
        {archivesOpen && (
          <Suspense fallback={loading}>
            <ChatArchives
              api={api}
              pending={chat.pending}
              active={false}
              browser
              onRestore={async (archiveId) => {
                const restored = await chat.restore(archiveId);
                if (restored) {
                  setView("chat");
                  closeArchives();
                }
                return restored;
              }}
            />
          </Suspense>
        )}
      </dialog>
      {detailId && (
        <Suspense fallback={loading}>
          <ExecutionDetailDialog
            key={detailId}
            api={api}
            requestId={detailId}
            onClose={() => setDetailId(undefined)}
            onOpenExecution={setDetailId}
          />
        </Suspense>
      )}
      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
      />
    </div>
  );
}
