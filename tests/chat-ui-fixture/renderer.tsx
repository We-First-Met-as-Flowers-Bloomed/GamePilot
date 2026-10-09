import { useState } from "react";
import { createRoot } from "react-dom/client";
import Chat from "../../apps/desktop/renderer/views/Chat";
import { useChat } from "../../apps/desktop/renderer/hooks/useChat";
import type { DesktopAPI } from "../../packages/protocol";
import type { DesktopController } from "../../apps/desktop/renderer/hooks/useDesktop";
import type {
  ChatView,
  ChatTurn,
  ChatArchiveEntry,
} from "../../packages/protocol/agent-chat";
import type { ChatCommandView } from "../../packages/protocol/chat-commands";
import type { PlannerViewState } from "../../packages/protocol/agent-planner";
import type { AgentEvent } from "../../packages/protocol/agent-events";
import "../../apps/desktop/renderer/theme.css";
import "../../apps/desktop/renderer/styles.css";
import "../../apps/desktop/renderer/agent-planner.css";
import "../../apps/desktop/renderer/chat.css";

// Production Chat and hooks, with no production IPC, storage, credentials or engines.
const at = "2026-10-04T04:00:00Z";
let state: ChatView = {
  revision: 1,
  selectedSessionId: "session-a",
  sessions: [
    {
      id: "session-a",
      title: "测试当前会话",
      createdAt: at,
      updatedAt: at,
      turns: [],
    },
  ],
};
let planner: PlannerViewState = { revision: 1, status: "idle" };
const calls: { method: string; input?: unknown }[] = [];
const reviews: ChatCommandView[] = [];
const journal: AgentEvent[] = [];
const eventListeners = new Set<(event: AgentEvent) => void>();
const errorListeners = new Set<(message: string) => void>();
function append(event: Omit<AgentEvent, "seq" | "at">) {
  const value = { ...event, seq: journal.length + 1, at };
  journal.push(value);
  eventListeners.forEach((listener) => listener(value));
}
let push: ((value: ChatView) => void) | undefined;
let plannerPush: ((value: PlannerViewState) => void) | undefined;
let failArchive = false,
  failLoad = false;
const historical = (id: string): ChatTurn => ({
  id,
  prompt: `归档原文 ${id}`,
  source: "fixture",
  at,
  createdAt: at,
  planner: {
    revision: 3,
    requestId: `old-${id}`,
    status: "completed",
    result: {
      status: "answer",
      modelText: "归档模型说明，不授予执行权限。",
      source: "fixture",
      execution: "not-started",
      canExecute: false,
      trace: [],
      model: "isolated",
      codexVersion: "isolated-fixture",
      elapsedMs: 2,
    },
  },
});
const entry = (id: string): ChatArchiveEntry => ({
  version: 1,
  id,
  sessionId: `old-${id}`,
  title: `历史会话 ${id}`,
  createdAt: at,
  updatedAt: at,
  archivedAt: at,
  turnCount: 2,
  sources: ["fixture"],
});
const change = () => {
  state.revision++;
  push?.(structuredClone(state));
};
const api = {
  agentEvents: async ({ requestId }: { requestId: string }) => ({
    version: 1,
    events: journal.filter(
      (event) =>
        event.requestId === requestId || event.parentRequestId === requestId,
    ),
    cursor: journal.length,
    latestSeq: journal.length,
    hasMore: false,
  }),
  onAgentEvent: (listener: (event: AgentEvent) => void) => {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  },
  onPlannerStream: () => () => {},
  onAgentError: (listener: (message: string) => void) => {
    errorListeners.add(listener);
    return () => {
      errorListeners.delete(listener);
    };
  },
  chatSnapshot: async () => structuredClone(state),
  onChatState: (listener: typeof push) => {
    push = listener;
    return () => {
      push = undefined;
    };
  },
  plannerSnapshot: async () => structuredClone(planner),
  onPlannerState: (listener: typeof plannerPush) => {
    plannerPush = listener;
    return () => {
      plannerPush = undefined;
    };
  },
  modelProvider: async () => ({ model: "isolated-fixture", hasApiKey: false }),
  chatCommands: async (sessionId: string) =>
    structuredClone(reviews.filter((view) => view.sessionId === sessionId)),
  reviewChatCommand: async (input: {
    sessionId: string;
    text: string;
    requestId?: string;
  }) => {
    calls.push({ method: "review", input });
    const view: ChatCommandView = {
      reviewId: `review-${reviews.length + 1}`,
      sessionId: input.sessionId,
      revision: 1,
      kind: input.requestId ? "continue" : "saved-daily",
      text: input.text,
      ...(input.requestId
        ? { parentId: input.requestId, needsAcknowledgement: true }
        : {}),
      createdAt: at,
      expiresAt: "2099-10-04T04:00:00Z",
      status: "review",
      fingerprint: "fixture",
      summary: [
        {
          laneName: "测试账号",
          games: [
            {
              gameId: "arknights",
              title: "明日方舟",
              steps: input.requestId
                ? ["保留已完成登录与邮件", "剩余 LS-6，零药零源石"]
                : ["登录", "LS-6，零药零源石", "任务奖励，含邮件"],
            },
            {
              gameId: "onmyoji",
              title: "阴阳师",
              steps: ["每日签到", "花合战最后"],
            },
          ],
        },
      ],
    };
    reviews.push(view);
    append({
      requestId: view.reviewId,
      kind: "command",
      status: "succeeded",
      text: "宿主已核对默认步骤清单",
    });
    return structuredClone(view);
  },
  confirmChatCommand: async (input: {
    sessionId: string;
    reviewId: string;
    revision: number;
    acknowledgePartial?: boolean;
  }) => {
    calls.push({ method: "confirm", input });
    const view = reviews.find((item) => item.reviewId === input.reviewId)!;
    if (view.needsAcknowledgement && !input.acknowledgePartial)
      throw Error("缺少明确核对确认");
    await new Promise((resolve) => setTimeout(resolve, 80));
    view.status = "submitted";
    append({
      requestId: view.parentId ?? "synthetic-daily",
      parentRequestId: view.reviewId,
      kind: "game-step",
      status: "running",
      text: "合成游戏步骤记录",
    });
    view.receipt = {
      batchId: "synthetic",
      requestIds: [view.parentId ?? "synthetic-daily"],
    };
    return structuredClone(view);
  },
  reviewChatIntent: async (input: {
    sessionId: string;
    turnId: string;
    requestId: string;
  }) => {
    calls.push({ method: "intentReview", input });
    const view = await api.reviewChatCommand({
      sessionId: input.sessionId,
      text: "运行双游戏日常",
    });
    const stored = reviews.find((value) => value.reviewId === view.reviewId)!;
    stored.origin = { turnId: input.turnId, plannerRequestId: input.requestId };
    return structuredClone(stored);
  },
  pauseAfterStep: async (input: unknown) => {
    calls.push({ method: "pause", input });
    return { runId: "running-b", revision: 1, status: "queued" };
  },
  sendChat: async (input: unknown) => {
    calls.push({ method: "model", input });
    return structuredClone(state);
  },
  stop: async () => {
    calls.push({ method: "stop" });
  },
  cancelPlanner: async (id: string) => {
    calls.push({ method: "cancel", input: id });
    fixture.busy(false);
    return structuredClone(planner);
  },
  listArchivedChats: async (input: { cursor?: string; limit?: number }) => {
    calls.push({ method: "list", input });
    return {
      entries: [entry(input.cursor ? "archive-b" : "archive-a")],
      ...(input.cursor ? {} : { nextCursor: "list-next" }),
      scope: "historical-only",
      canExecute: false,
    };
  },
  loadArchivedChat: async (input: {
    archiveId: string;
    cursor?: string;
    limit?: number;
  }) => {
    calls.push({ method: "load", input });
    if (failLoad) throw Error("合成归档读取失败");
    return {
      archive: entry(input.archiveId),
      session: {
        id: `old-${input.archiveId}`,
        title: `历史会话 ${input.archiveId}`,
        createdAt: at,
        updatedAt: at,
      },
      turns: [historical(input.cursor ? "turn-two" : "turn-one")],
      ...(input.cursor ? {} : { nextCursor: "turn-next" }),
      scope: "historical-only",
      canExecute: false,
    };
  },
  archiveChat: async (input: unknown) => {
    calls.push({ method: "archive", input });
    if (failArchive) throw Error("合成归档保存失败");
    state.sessions = [
      {
        id: "session-b",
        title: "新的当前会话",
        createdAt: at,
        updatedAt: at,
        turns: [],
      },
    ];
    state.selectedSessionId = "session-b";
    change();
    return structuredClone(state);
  },
  newChat: async () => structuredClone(state),
  selectChat: async () => structuredClone(state),
} as unknown as DesktopAPI;
const fixture = {
  calls,
  journalError: (message: string) =>
    errorListeners.forEach((listener) => listener(message)),
  correction: (
    requestId: string,
    runId: string,
    status: AgentEvent["status"] = "succeeded",
    kind: AgentEvent["kind"] = "correction",
  ) => append({ requestId, runId, status, kind, text: "合成步骤边界回执" }),
  failArchive: (value: boolean) => {
    failArchive = value;
  },
  failLoad: (value: boolean) => {
    failLoad = value;
  },
  busy(value: boolean) {
    const session = state.sessions[0];
    session.turns = [
      {
        ...historical("current"),
        prompt: "当前会话原文",
        source: "recorded",
        planner: value
          ? {
              revision: ++planner.revision,
              status: "running",
              requestId: "model-busy",
              progress: { phase: "tool", tool: "get_environment" },
            }
          : {
              revision: ++planner.revision,
              status: "cancelled",
              requestId: "model-busy",
            },
      },
    ];
    planner = structuredClone(session.turns[0].planner);
    change();
    plannerPush?.(structuredClone(planner));
  },
  current: () => structuredClone(state),
  intent(
    status: "saved-daily" | "saved-both-games" = "saved-both-games",
    source: "recorded" | "fixture" = "recorded",
  ) {
    const session = state.sessions[0];
    const turn: ChatTurn = {
      ...historical("intent-current"),
      prompt: "请帮我把两个账号的两个游戏日常按保存计划都安排好。",
      source,
      planner: {
        revision: ++planner.revision,
        source,
        requestId: "model-intent-current",
        status: "completed",
        result: {
          ...historical("base").planner.result!,
          source,
          status,
          modelText: "已识别保存日常需求，请核对宿主冻结清单。",
        },
      },
    };
    session.turns = [turn];
    planner = structuredClone(turn.planner);
    change();
    plannerPush?.(structuredClone(planner));
    append({
      requestId: planner.requestId!,
      callId: "real-public-call",
      tool: "get_environment",
      kind: "tool-started",
      status: "running",
      text: "已开始读取账号设置",
      details: { arguments: "{}" },
    });
    append({
      requestId: planner.requestId!,
      callId: "real-public-call",
      tool: "get_environment",
      kind: "tool-result",
      status: "succeeded",
      text: "账号设置已返回",
      details: { result: '{"enabledLanes":2}', durationMs: 1250 },
    });
    append({
      requestId: planner.requestId!,
      callId: "historic-call",
      tool: "list_capabilities",
      kind: "tool-result",
      status: "succeeded",
      text: "旧调用没有详细字段",
    });
  },
  replayCurrent() {
    change();
    plannerPush?.(structuredClone(planner));
  },
  publishGameProgress() {
    const view = reviews.find(
      (value) => value.origin?.turnId === "intent-current",
    )!;
    view.status = "submitted";
    append({
      requestId: "synthetic-intent-game",
      parentRequestId: view.reviewId,
      sessionId: view.sessionId,
      kind: "game-step",
      status: "running",
      text: "本轮账号一正在执行 LS-6",
    });
    const legacy = {
      ...view,
      reviewId: "legacy-command",
      origin: undefined,
      text: "旧精确保存日常命令",
    };
    reviews.push(legacy);
    append({
      requestId: legacy.reviewId,
      sessionId: legacy.sessionId,
      kind: "command",
      status: "succeeded",
      text: "旧指令已受理",
    });
  },
};
declare global {
  interface Window {
    __chatFixture: typeof fixture;
  }
}
window.__chatFixture = fixture;
function Workspace() {
  const chat = useChat(api);
  const [view, setView] = useState("chat");
  const desktop = {
    api,
    view,
    setView,
    clearEntryTarget: () => {},
    snapshot: {
      executions: [
        { id: "original-a", laneId: "lane-a", status: "failed", startedAt: at },
        { id: "running-b", laneId: "lane-b", status: "running", startedAt: at },
      ],
    },
    deviceLanes: { version: 1, lanes: [] },
    taskRecords: [],
    laneDailyStates: {},
  } as unknown as DesktopController;
  return (
    <main className="app-shell chat-shell sidebar-collapsed">
      <div className="main-shell">
        <Chat
          desktop={desktop}
          chat={chat}
          onOpenExecution={(id) => calls.push({ method: "open", input: id })}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Workspace />);
