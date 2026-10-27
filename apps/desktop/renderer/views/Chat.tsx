import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceTab } from "../workspace-layout-state";
import { nearConversationEnd } from "../conversation-scroll";
import "../conversation-flow.css";
import "../commands.css";
import "../chat-home.css";
import {
  isComposingKey,
  localChatCommand,
  nextCommandIndex,
  slashSuggestions,
  slashEnterAction,
} from "../slash-command-state";
import {
  ArrowUp,
  Bot,
  ChevronDown,
  Clock3,
  Folder,
  ListChecks,
  MessageSquare,
  Pause,
  Plus,
  Square,
  Wrench,
} from "lucide-react";
import type { DesktopController } from "../hooks/useDesktop";
import type { ChatController } from "../hooks/useChat";
import { usePlanner } from "../hooks/usePlanner";
import {
  plannerActive,
  type PlannerSource,
} from "../../../../packages/protocol/agent-planner";
import type { ModelProviderView } from "../../../../packages/protocol/model-provider";
import {
  chatExecutionTarget,
  chatProgressLabel,
  chatTurnLabel,
  chatIntentTarget,
} from "../chat-state";
import { PlannerDraft } from "../components/AgentPlanner";
import { PlannerEvidence } from "../components/PlannerEvidence";
import { PlannerRecords } from "../components/PlannerRecords";
import { PlannerExecution } from "../components/PlannerExecution";
import CopilotConfirmationCard from "../components/CopilotConfirmationCard";
import ChatActivity from "../components/ChatActivity";
import { AgentRunTrace } from "../components/AgentRunTrace";
import { AgentRecordFacts } from "../components/AgentRecordFacts";
import { goalResultReport } from "../../../../games/goal-report";
import ChatCommandCards, {
  type ChatHostAction,
} from "../components/ChatCommandCards";
import ChatArchives, {
  ChatSessionSummaryCard,
} from "../components/ChatArchives";
import ChatTrajectory from "../components/ChatTrajectory";
import { useGoals } from "../hooks/useGoals";
import SessionTaskWorkspace from "../components/SessionTaskWorkspace";
import {
  clearSubmittedDraft,
  processingSession,
  sessionTaskState,
  updateSessionDraft,
  type SessionDrafts,
} from "../chat-workspace-state";

const suggestions = [
  {
    title: "运行保存的日常",
    icon: ListChecks,
    detail: "授权范围内执行 · 结果回到对话",
    prompt: "运行保存的日常",
  },
  {
    title: "安排方舟日常",
    icon: Clock3,
    detail: "双账号 · 使用现有理智",
    prompt:
      "按当前所有已启用账号保存的明日方舟日常生成本次计划，保留任务开关和参数，不用理智药、过期理智药或源石。",
  },
  {
    title: "看看今天的结果",
    icon: MessageSquare,
    detail: "核对记录 · 避免重复跑",
    prompt:
      "查询当前已启用账号最近的任务记录。分别说明所属游戏日、实际任务范围、已完成和失败或无法确认的步骤，区分原请求与续跑，不执行游戏。",
  },
];
const sources: Record<PlannerSource, string> = {
  recorded: "当前账号与记录",
  configured: "当前账号配置",
  fixture: "演练账号",
};

export default function Chat({
  desktop: d,
  chat: c,
  onOpenExecution,
  workspaceTarget,
  workspaceTab,
  onOpenWorkspace,
}: {
  desktop: DesktopController;
  chat: ChatController;
  onOpenExecution: (id: string) => void;
  workspaceTarget?: HTMLDivElement | null;
  workspaceTab?: WorkspaceTab;
  onOpenWorkspace?: (tab: WorkspaceTab) => void;
}) {
  const live = usePlanner(d.api);
  const [standaloneTab, setStandaloneTab] = useState<WorkspaceTab>("tasks");
  const currentWorkspaceTab = workspaceTab ?? standaloneTab;
  const openWorkspace = onOpenWorkspace ?? setStandaloneTab;
  const [drafts, setDrafts] = useState<SessionDrafts>({});
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [focusedGoalId, setFocusedGoalId] = useState<string>();
  const [provider, setProvider] = useState<ModelProviderView>();
  const [localNotice, setLocalNotice] = useState("");
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [composing, setComposing] = useState(false);
  const [followConversation, setFollowConversation] = useState(true);
  const following = useRef(true);
  const [hostAction, setHostAction] = useState<ChatHostAction>();
  const attemptedIntent = useRef(new Set<string>());
  const hostActionKey = useRef(0);
  const input = useRef<HTMLTextAreaElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const session = c.state.sessions.find(
    (s) => s.id === c.state.selectedSessionId,
  );
  const draftId = session?.id ?? "";
  const prompt = drafts[draftId]?.text ?? "";
  const source = drafts[draftId]?.source ?? "recorded";
  const slashItems =
    slashDismissed || composing ? [] : slashSuggestions(prompt);
  const selectedSlashIndex = Math.min(
    slashIndex,
    Math.max(0, slashItems.length - 1),
  );
  const selectedSlash = slashItems[selectedSlashIndex];
  const goals = useGoals(d.api, draftId);
  const tasks = sessionTaskState(session?.id, goals.state.goals);
  function setPrompt(value: string | ((current: string) => string)) {
    setDrafts((current) =>
      updateSessionDraft(
        current,
        draftId,
        typeof value === "function"
          ? value(current[draftId]?.text ?? "")
          : value,
      ),
    );
  }
  function setSource(value: PlannerSource) {
    setDrafts((current) => ({
      ...current,
      [draftId]: { text: current[draftId]?.text ?? "", source: value },
    }));
  }
  function returnToEnd() {
    following.current = true;
    setFollowConversation(true);
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }
  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setLocalNotice("已复制文字。");
    } catch {
      setLocalNotice("暂时无法访问剪贴板，请选择文字后复制。");
    }
  }
  function showGoal(id?: string) {
    openWorkspace("tasks");
    setFocusedGoalId(id);
    requestAnimationFrame(() => {
      const card = [
        ...document.querySelectorAll<HTMLElement>(
          ".session-task-workspace [data-goal-id]",
        ),
      ].find((element) => element.dataset.goalId === id);
      const history = card?.closest<HTMLDetailsElement>(
        ".session-task-history",
      );
      if (history) history.open = true;
      (
        card ?? document.querySelector(".session-task-workspace")
      )?.scrollIntoView({ block: "start" });
      card?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    if (focusedGoalId) showGoal(focusedGoalId);
  }, [focusedGoalId, workspaceTarget]);
  function resumeGoal(id: string) {
    setPrompt(`继续目标 ${id}，默认重试失败项并保留已完成步骤。`);
    input.current?.focus();
  }
  const last = session?.turns.at(-1);
  const intentTarget = last && chatIntentTarget(last, last, live.state);
  const runningTurn = c.state.sessions
    .flatMap((s) => s.turns)
    .find((t) => plannerActive(t.planner));
  const liveActive = live.ready && plannerActive(live.state);
  const busy = liveActive || Boolean(runningTurn);
  const activeRequestId = liveActive
    ? live.state.requestId
    : runningTurn?.planner.requestId;
  const activeSession = processingSession(c.state.sessions, activeRequestId);
  const activeTurn = session?.turns.find((t) => plannerActive(t.planner));
  const disabled =
    !d.api ||
    !c.ready ||
    c.pending ||
    busy ||
    !session ||
    Boolean(c.state.error) ||
    live.state.error?.code === "SHUTDOWN_FAILED";
  useEffect(() => {
    const cancelModel = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        isComposingKey(event) ||
        composing ||
        d.view !== "chat" ||
        !busy ||
        !activeRequestId ||
        live.pending ||
        (liveActive ? live.state.status : runningTurn?.planner.status) ===
          "cancelling" ||
        slashItems.length ||
        document.querySelector("dialog[open], .chat-tools-menu[open]")
      )
        return;
      event.preventDefault();
      void live.cancel(activeRequestId);
    };
    window.addEventListener("keydown", cancelModel);
    return () => window.removeEventListener("keydown", cancelModel);
  });
  useEffect(() => {
    if (selectedSlash)
      document
        .getElementById(`slash-${selectedSlash.command.slice(1)}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [selectedSlash?.command]);
  useEffect(() => {
    if (!d.api) return;
    let stopped = false;
    const read = async () => {
      try {
        const value = await d.api!.modelProvider();
        if (!stopped) setProvider(value);
      } catch {
        if (!stopped) setProvider(undefined);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [d.api]);
  useEffect(() => {
    setFocusedGoalId(undefined);
    setLocalNotice("");
    setHostAction(undefined);
    setSlashDismissed(false);
    setSlashIndex(0);
    if (d.view === "chat") input.current?.focus();
    following.current = true;
    setFollowConversation(true);
  }, [session?.id]);
  useEffect(() => {
    if (!session || !intentTarget || !d.api || !c.ready) return;
    const key = `${session.id}:${intentTarget.turnId}:${intentTarget.requestId}`;
    if (attemptedIntent.current.has(key)) return;
    attemptedIntent.current.add(key);
    setHostAction({
      key: ++hostActionKey.current,
      sessionId: session.id,
      kind: "saved-daily",
      text: last!.prompt,
      intentTarget,
    });
  }, [
    session?.id,
    intentTarget?.turnId,
    intentTarget?.requestId,
    c.ready,
    d.api,
  ]);
  useEffect(() => {
    if (d.view === "chat" && d.entryTarget === "planner") {
      input.current?.focus();
      d.clearEntryTarget();
    }
  }, [d.view, d.entryTarget]);
  useEffect(() => {
    const el = scroll.current;
    if (el && following.current && (last || hostAction))
      el.scrollTo({ top: el.scrollHeight });
  }, [
    session?.id,
    session?.turns.length,
    last?.planner.status,
    hostAction?.key,
  ]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!following.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (following.current) element.scrollTo({ top: element.scrollHeight });
      });
    });
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [session?.id]);
  function closeTools() {
    const menu = document.getElementById(
      "chat-tools-menu",
    ) as HTMLDetailsElement | null;
    if (menu) menu.open = false;
  }
  function requestHostAction(kind: ChatHostAction["kind"], text: string) {
    if (!d.api || !session || !c.ready) return;
    closeTools();
    if (
      kind === "saved-daily" &&
      typeof d.api.reviewChatCommand !== "function"
    ) {
      d.setView("daily");
      setLocalNotice("当前预览未提供聊天指令检查，已打开保存的每日计划。");
      return;
    }
    setLocalNotice("");
    setHostAction({
      key: ++hostActionKey.current,
      sessionId: session.id,
      kind,
      text,
    });
  }
  async function send() {
    const text = prompt.trim();
    if (!d.api || !text) return;
    const command = localChatCommand(text, Boolean(d.api.goalSnapshot));
    if (command) {
      if (command === "stop") {
        // Cancellation must not wait for a model response or a game start receipt.
        const results = await Promise.allSettled([
          d.api.stop(),
          ...(activeRequestId ? [d.api.cancelPlanner(activeRequestId)] : []),
        ]);
        setLocalNotice(
          results.some((r) => r.status === "rejected")
            ? "部分停止请求未完成，请核对任务状态并使用停止按钮。"
            : "停止指令已发送；以任务状态变为已停止为准。",
        );
      } else if (
        command === "saved-daily" ||
        command === "continue" ||
        command === "pause"
      ) {
        requestHostAction(command, text);
      } else {
        d.setView(command);
        setLocalNotice("已打开对应工具，配置和执行结果仍会保留。");
      }
      setPrompt((current) => (current.trim() === text ? "" : current));
      return;
    }
    if (disabled || !session) return;
    const ok = await c.send({
      sessionId: session.id,
      prompt: text,
      source,
      at: new Date().toISOString(),
    });
    if (ok)
      setDrafts((current) => clearSubmittedDraft(current, session.id, text));
  }
  const toolAction = (view: "daily" | "devices" | "settings" | "library") => {
    d.setView(view);
    closeTools();
  };
  const workspaceContents = (
    <>
      <div
        id="workspace-tasks-panel"
        role="tabpanel"
        aria-labelledby="workspace-tasks-tab"
        hidden={currentWorkspaceTab !== "tasks"}
      >
        <SessionTaskWorkspace
          sessionId={session?.id}
          controller={goals}
          onOpenExecution={onOpenExecution}
          onResume={resumeGoal}
          focusGoalId={focusedGoalId}
        />
      </div>
      <div
        id="chat-trajectory-panel"
        role="tabpanel"
        aria-labelledby="chat-trajectory-tab"
        hidden={currentWorkspaceTab !== "trajectory"}
      >
        {currentWorkspaceTab === "trajectory" && (
          <ChatTrajectory api={d.api} session={session} controller={goals} />
        )}
      </div>
    </>
  );
  return (
    <section
      className={`chat-workspace chat-home ${session?.turns.length ? "has-conversation" : ""} ${hostAction ? "has-host-command" : ""}`}
      aria-label="Agent聊天工作台"
    >
      <div
        className="chat-workspace-nav"
        role={onOpenWorkspace ? "navigation" : "tablist"}
        aria-label="对话与轨迹"
        onKeyDown={(event) => {
          if (
            onOpenWorkspace ||
            !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
          )
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "tasks"
              : event.key === "End"
                ? "trajectory"
                : currentWorkspaceTab === "trajectory"
                  ? "tasks"
                  : "trajectory";
          setStandaloneTab(next);
          document
            .getElementById(
              next === "trajectory"
                ? "chat-trajectory-tab"
                : "chat-conversation-tab",
            )
            ?.focus();
        }}
      >
        <button
          type="button"
          role={onOpenWorkspace ? undefined : "tab"}
          id="chat-conversation-tab"
          data-current={onOpenWorkspace ? "true" : undefined}
          aria-selected={
            onOpenWorkspace ? undefined : currentWorkspaceTab !== "trajectory"
          }
          aria-controls="chat-conversation-panel"
          tabIndex={
            !onOpenWorkspace && currentWorkspaceTab === "trajectory" ? -1 : 0
          }
          onClick={() => {
            if (!onOpenWorkspace) setStandaloneTab("tasks");
            input.current?.focus();
          }}
        >
          <MessageSquare size={15} />
          对话
        </button>
        <button
          type="button"
          id={onOpenWorkspace ? "chat-trajectory-open" : "chat-trajectory-tab"}
          role={onOpenWorkspace ? undefined : "tab"}
          aria-selected={
            onOpenWorkspace ? undefined : currentWorkspaceTab === "trajectory"
          }
          className="text-button"
          tabIndex={
            !onOpenWorkspace && currentWorkspaceTab !== "trajectory" ? -1 : 0
          }
          aria-controls="chat-trajectory-panel"
          onClick={() => openWorkspace("trajectory")}
        >
          <Wrench size={15} />
          轨迹
        </button>
        <span className="chat-workspace-context">
          {session?.turns.length
            ? `${session.turns.length} 轮对话`
            : "本地游戏工作空间"}
        </span>
      </div>
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={(event) => {
          const next = nearConversationEnd(event.currentTarget);
          following.current = next;
          setFollowConversation(next);
        }}
      >
        {!onOpenWorkspace && workspaceContents}
        <div
          id="chat-conversation-panel"
          hidden={!onOpenWorkspace && currentWorkspaceTab === "trajectory"}
          role={onOpenWorkspace ? "region" : "tabpanel"}
          aria-labelledby="chat-conversation-tab"
        >
          {!session?.turns.length ? (
            <div className="chat-welcome">
              <div className="chat-welcome-eyebrow">
                <span className="chat-welcome-symbol">
                  <Bot size={22} strokeWidth={1.6} aria-hidden="true" />
                </span>
                <span>你的游戏日常工作台</span>
              </div>
              <h1>
                把日常交给 <span>GamePilot</span>
              </h1>
              <p>安排任务，核对进度。说说你今天想做什么。</p>
              <div className="chat-suggestions" aria-label="开始一项任务">
                {suggestions.map((item) => (
                  <button
                    type="button"
                    key={item.title}
                    className="chat-suggestion"
                    disabled={disabled}
                    onClick={() => {
                      setPrompt(item.prompt);
                      input.current?.focus();
                    }}
                  >
                    <span className="chat-suggestion-top" aria-hidden="true">
                      <span className="chat-suggestion-icon">
                        <item.icon size={19} strokeWidth={1.7} />
                      </span>
                      <ArrowUp className="chat-suggestion-arrow" size={16} />
                    </span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="chat-transcript" aria-label="聊天记录">
              {session.turns.map((turn) => {
                const state = turn.planner,
                  result = state.result,
                  active = plannerActive(state);
                const target = chatExecutionTarget(state, live.state);
                const ownedGoals = tasks.entries.filter(
                  (goal) => goal.turnId === turn.id,
                );
                return (
                  <article
                    key={turn.id}
                    className="chat-turn"
                    data-message-request-id={state.requestId}
                    data-chat-turn-id={turn.id}
                  >
                    <div className="chat-user-message chat-message">
                      <p>{turn.prompt}</p>
                      <small>
                        {sources[turn.source]} ·{" "}
                        <time dateTime={turn.createdAt}>
                          {new Date(turn.createdAt).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </time>
                      </small>
                      <div className="chat-message-actions">
                        <button
                          type="button"
                          className="text-button"
                          aria-label="复制用户需求"
                          onClick={() => void copyMessage(turn.prompt)}
                        >
                          复制
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          aria-label="重新生成需求（填回输入框，不发送）"
                          onClick={() => {
                            setPrompt(turn.prompt);
                            input.current?.focus();
                          }}
                        >
                          重新生成需求
                        </button>
                      </div>
                    </div>
                    <div className="chat-assistant-message chat-message">
                      <div className="chat-message-author">
                        <Bot size={17} />
                        <strong>GamePilot</strong>
                        <span>
                          {ownedGoals.length
                            ? sessionTaskState(session.id, ownedGoals).label
                            : chatTurnLabel(state)}
                        </span>
                      </div>
                      {active && (
                        <div className="chat-thinking" role="status">
                          <Clock3 size={15} className="spin" />
                          {chatProgressLabel(state)}
                          <span>进度来自实际工具调用</span>
                        </div>
                      )}
                      {active && (
                        <p
                          className="chat-ai-disclaimer"
                          data-host-result-waiting="true"
                        >
                          正在核对宿主结果…模型回复与游戏完成分别记录。
                        </p>
                      )}
                      {state.error && (
                        <p role="alert" className="banner warning">
                          {state.error.message}
                        </p>
                      )}
                      <AgentRunTrace
                        api={d.api}
                        requestId={state.requestId}
                        active={active}
                        fallbackTrace={result?.trace}
                      />
                      {state.status === "cancelled" && (
                        <p>
                          本轮模型请求已取消。游戏任务是否已受理或停止，请以本会话交办任务与原请求记录为准。
                        </p>
                      )}
                      {!!ownedGoals.length && (
                        <section
                          className="agent-record-facts chat-goal-results"
                          aria-label="本轮交办结果"
                        >
                          <strong>本轮交办结果</strong>
                          {ownedGoals.map((goal) => (
                            <article
                              key={goal.id}
                              data-goal-result-id={goal.id}
                            >
                              <p className="chat-answer">
                                {goalResultReport(goal).text}
                              </p>
                            </article>
                          ))}
                        </section>
                      )}
                      {result && (
                        <>
                          <p className="chat-ai-disclaimer">
                            AI 说明 · 以任务记录为准
                          </p>
                          {!ownedGoals.length && (
                            <AgentRecordFacts records={result.records} />
                          )}
                          {ownedGoals.length ||
                          result.records?.length ||
                          result.modelText.length > 500 ? (
                            <details className="chat-response-details chat-model-explanation">
                              <summary>
                                <MessageSquare size={14} />
                                模型说明<span>结合宿主事实阅读</span>
                                <ChevronDown size={14} />
                              </summary>
                              <p className="chat-answer">{result.modelText}</p>
                            </details>
                          ) : (
                            <p className="chat-answer">{result.modelText}</p>
                          )}
                          <div className="chat-message-actions">
                            <button
                              type="button"
                              className="text-button"
                              aria-label="复制模型说明"
                              onClick={() => void copyMessage(result.modelText)}
                            >
                              复制说明
                            </button>
                          </div>
                          {result.execution !== "managed-by-goal" && (
                            <PlannerEvidence
                              assessment={result.historyAssessment}
                            />
                          )}
                          {result.draft && (
                            <details
                              className="chat-response-details"
                              open={Boolean(target)}
                            >
                              <summary>
                                <ListChecks size={15} />
                                任务计划<span>查看账号、步骤与资源</span>
                                <ChevronDown size={14} />
                              </summary>
                              <PlannerDraft result={result} />
                            </details>
                          )}
                          {!!result.records?.length && (
                            <details
                              className={`chat-response-details chat-record-details${ownedGoals.length ? " chat-history-reference" : ""}`}
                            >
                              <summary>
                                <Folder size={14} />
                                {ownedGoals.length
                                  ? "历史参考"
                                  : "完整执行记录"}
                                <span>
                                  {ownedGoals.length
                                    ? "查询时的记录与原请求"
                                    : "原请求与续跑明细"}
                                </span>
                                <ChevronDown size={14} />
                              </summary>
                              {!!ownedGoals.length && (
                                <>
                                  <p className="helper">
                                    以下记录来自本轮查询，不代表本次交办的最新结果；原请求状态保持不变。
                                  </p>
                                  <AgentRecordFacts records={result.records} />
                                </>
                              )}
                              <PlannerRecords records={result.records} />
                            </details>
                          )}
                          {result.draft && !target && (
                            <p className="chat-history-note">
                              历史或未通过当前检查的草稿，仅供查看。要运行，请重新发送需求。
                            </p>
                          )}
                        </>
                      )}
                      {target && (
                        <PlannerExecution
                          api={d.api}
                          target={target}
                          onOpenExecution={onOpenExecution}
                        />
                      )}
                      {result?.copilot && (
                        <CopilotConfirmationCard
                          key={result.copilot.preparedId}
                          review={result.copilot}
                          api={d.api}
                          enabled={
                            state.status === "completed" &&
                            state.requestId === live.state.requestId &&
                            state.source !== "fixture" &&
                            !d.active &&
                            !d.busy
                          }
                          onOpenExecution={onOpenExecution}
                        />
                      )}
                      {ownedGoals.map((goal) => (
                        <button
                          key={goal.id}
                          type="button"
                          className="text-button chat-goal-reference"
                          data-goal-reference={goal.id}
                          onClick={() => showGoal(goal.id)}
                        >
                          <ListChecks size={14} aria-hidden="true" />
                          查看交办任务
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <ChatCommandCards
          api={d.api}
          sessionId={session?.id}
          action={hostAction}
          requests={d.snapshot.executions ?? []}
          onOpenExecution={onOpenExecution}
          turns={session?.turns}
        />
        <div className="chat-supporting-panels">
          <details
            className="chat-task-area chat-device-tasks"
            aria-label="设备任务与定时任务"
            onToggle={(event) => setDevicesOpen(event.currentTarget.open)}
          >
            <summary>
              <Folder size={15} aria-hidden="true" />
              设备任务<span>含其他会话、手动与定时任务</span>
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            {devicesOpen && (
              <ChatActivity desktop={d} onOpenExecution={onOpenExecution} />
            )}
          </details>
          <div className="chat-session-details">
            <ChatSessionSummaryCard summary={session?.summary} />
            <ChatArchives
              api={d.api}
              session={session}
              pending={c.pending}
              active={Boolean(activeTurn)}
              onArchive={c.archive}
            />
          </div>
        </div>
      </div>
      {workspaceTarget && createPortal(workspaceContents, workspaceTarget)}
      <div className="chat-composer-wrap">
        {!followConversation && (
          <button
            type="button"
            className="button chat-return-bottom"
            onClick={returnToEnd}
          >
            回到底部
          </button>
        )}
        {!!tasks.entries.length && (
          <button
            type="button"
            className="chat-task-jump"
            data-task-tone={tasks.tone}
            onClick={() => showGoal()}
          >
            <ListChecks size={14} aria-hidden="true" />
            {tasks.label}
            <span>查看任务</span>
          </button>
        )}
        {localNotice && (
          <p role="status" className="chat-local-notice">
            {localNotice}
          </p>
        )}
        {c.error && (
          <p role="alert" className="banner warning">
            {c.error}
          </p>
        )}
        {live.error && (
          <p role="alert" className="banner warning">
            {live.error}
          </p>
        )}
        {busy && !activeTurn && (
          <p role="status" className="chat-local-notice">
            {activeSession
              ? `“${activeSession.title}”正在处理，当前草稿已保留。`
              : "另一条模型请求正在处理，当前草稿已保留；会话关联尚未确认。"}
            {activeSession && activeSession.id !== session?.id && (
              <button
                type="button"
                className="text-button"
                onClick={() => void c.select(activeSession.id)}
              >
                查看正在处理的会话
              </button>
            )}
          </p>
        )}
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {!!slashItems.length && (
            <div
              id="chat-slash-menu"
              className="chat-slash-menu"
              role="listbox"
              aria-label="本地聊天命令"
            >
              {slashItems.map((item, index) => (
                <button
                  key={item.command}
                  id={`slash-${item.command.slice(1)}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === selectedSlashIndex}
                  data-slash-command={item.command}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setPrompt(item.command);
                    setSlashDismissed(true);
                    input.current?.focus();
                  }}
                >
                  <code>{item.command}</code>
                  <span>
                    {item.label}
                    <small>{item.detail}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          <label className="sr-only" htmlFor="chat-prompt">
            描述你的游戏任务
          </label>
          <textarea
            id="chat-prompt"
            ref={input}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              setSlashDismissed(false);
              setSlashIndex(0);
            }}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            aria-haspopup="listbox"
            aria-controls={slashItems.length ? "chat-slash-menu" : undefined}
            aria-activedescendant={
              selectedSlash
                ? `slash-${selectedSlash.command.slice(1)}`
                : undefined
            }
            aria-describedby="chat-input-help"
            rows={3}
            maxLength={12000}
            disabled={!d.api}
            placeholder="安排日常、查询进度，或说明遇到的问题…"
            onKeyDown={(e) => {
              if (isComposingKey(e.nativeEvent) || composing) return;
              if (slashItems.length) {
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashIndex(
                    nextCommandIndex(
                      selectedSlashIndex,
                      slashItems.length,
                      e.key,
                    ),
                  );
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setSlashDismissed(true);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && selectedSlash) {
                  e.preventDefault();
                  setSlashDismissed(true);
                  if (
                    slashEnterAction(prompt, selectedSlash.command) === "send"
                  )
                    void send();
                  else setPrompt(selectedSlash.command);
                  return;
                }
              }
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !isComposingKey(e.nativeEvent)
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="chat-composer-bottom">
            <details className="chat-tools-menu" id="chat-tools-menu">
              <summary id="chat-tools-toggle" aria-label="打开聊天工具">
                <Plus size={18} />
              </summary>
              <div className="chat-popover">
                <button
                  type="button"
                  onClick={() =>
                    requestHostAction("saved-daily", "运行保存的日常")
                  }
                >
                  <ListChecks size={15} />
                  运行已保存每日计划
                </button>
                <button
                  type="button"
                  onClick={() => requestHostAction("continue", "继续原失败")}
                >
                  <ListChecks size={15} />
                  继续原失败请求
                </button>
                <button
                  type="button"
                  onClick={() =>
                    requestHostAction("pause", "当前步骤结束后暂停")
                  }
                >
                  <Pause size={15} />
                  当前步骤结束后暂停
                </button>
                <button type="button" onClick={() => toolAction("devices")}>
                  <Folder size={15} />
                  设备与账号
                </button>
                <button type="button" onClick={() => toolAction("library")}>
                  <Wrench size={15} />
                  游戏技能库
                </button>
                <button type="button" onClick={() => toolAction("settings")}>
                  <Clock3 size={15} />
                  定时与开机启动
                </button>
                <p>/stop 停止全部任务 · /daily 打开计划</p>
              </div>
            </details>
            <label
              className="chat-source chat-source-footer"
              title="参考数据影响查询依据，游戏与账号范围以交办任务的宿主清单为准。"
            >
              <span>参考数据</span>
              <select
                aria-label="参考数据"
                value={source}
                disabled={c.pending || busy}
                onChange={(e) => setSource(e.target.value as PlannerSource)}
              >
                <option value="recorded">当前账号与记录</option>
                <option value="configured">当前账号配置</option>
                <option value="fixture">演练账号</option>
              </select>
            </label>
            {source === "fixture" && (
              <span
                className="chat-fixture-warning"
                id="chat-fixture-warning"
                role="status"
              >
                演练账号
              </span>
            )}
            <span className="chat-composer-spacer" />
            <button
              className="chat-model"
              type="button"
              onClick={() => d.setView("models")}
              title="配置模型连接"
            >
              {provider?.model || (d.api ? "模型连接" : "桌面预览")}
              <ChevronDown size={13} />
            </button>
            {busy ? (
              <button
                className="chat-send chat-cancel"
                data-model-request-id={activeRequestId}
                type="button"
                aria-label={
                  activeSession?.id === session?.id
                    ? "停止当前规划"
                    : activeSession
                      ? `停止“${activeSession.title}”的模型请求`
                      : "停止当前模型请求（会话未关联）"
                }
                title={
                  activeSession?.id === session?.id
                    ? "停止本会话的模型请求，游戏任务请使用停止目标"
                    : "停止正在处理的模型请求；不会代替停止游戏目标"
                }
                disabled={
                  live.pending ||
                  (liveActive
                    ? live.state.status
                    : runningTurn?.planner.status) === "cancelling"
                }
                onClick={() => void live.cancel(activeRequestId)}
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                className="chat-send"
                id="chat-send"
                type="submit"
                aria-label="发送需求"
                disabled={disabled || !prompt.trim()}
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </form>
        <p className="chat-composer-note" id="chat-input-help">
          <span>
            执行前核验账号与资源 ·{" "}
            <button type="button" onClick={() => d.setView("daily")}>
              每日任务开关
            </button>
          </span>
          <span className="chat-input-shortcuts">
            <kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行
          </span>
          <span className="sr-only">
            需求发给已配置模型。Esc 仅停止模型请求。
          </span>
        </p>
        {!d.api && (
          <p className="helper">
            浏览器仅预览界面，请打开桌面 App 使用聊天与游戏工具。
          </p>
        )}
      </div>
    </section>
  );
}
