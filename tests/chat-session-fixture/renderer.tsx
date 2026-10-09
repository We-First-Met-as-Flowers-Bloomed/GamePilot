import { createRoot } from "react-dom/client";
import App from "../../apps/desktop/renderer/App";
import { createFixtureSnapshot } from "../../packages/agent/fixture";
import { games } from "../../games/registry";
import type { DesktopAPI } from "../../packages/protocol";
import type { GoalRun, GoalView } from "../../packages/protocol/agent-goal";
import type { ChatView, ChatTurn } from "../../packages/protocol/agent-chat";
import type { PlannerViewState } from "../../packages/protocol/agent-planner";
import "../../apps/desktop/renderer/theme.css";
import "../../apps/desktop/renderer/styles.css";
import "../../apps/desktop/renderer/workspaces.css";
import "../../apps/desktop/renderer/agent-planner.css";
import "../../apps/desktop/renderer/execution-detail.css";
import "../../apps/desktop/renderer/chat.css";
import "../../apps/desktop/renderer/components/incident-agent.css";

// Real renderer, synthetic functions only. No preload, IPC, network or user data.
const at = "2026-10-07T08:00:00Z";
const fixture = createFixtureSnapshot();
const calls: { method: string; input?: unknown }[] = [];
const chatListeners = new Set<(value: ChatView) => void>();
const goalListeners = new Set<(value: GoalView) => void>();
const plannerListeners = new Set<(value: PlannerViewState) => void>();
const historical = (id: string): ChatTurn => ({
  id,
  prompt: `只读问题 ${id}`,
  source: "recorded",
  at,
  createdAt: at,
  planner: {
    revision: 1,
    requestId: `model-${id}`,
    status: "completed",
    result: {
      source: "recorded",
      status: "answer",
      modelText: "这是隔离界面的已记录答复；没有执行游戏。",
      trace: [],
      model: "offline-fixture",
      codexVersion: "isolated",
      elapsedMs: 1,
      execution: "not-started",
      canExecute: false,
    },
  },
});
let chat: ChatView = {
  revision: 1,
  selectedSessionId: "session-a",
  sessions: [
    {
      id: "session-a",
      title: "今天的双游戏日常",
      createdAt: at,
      updatedAt: at,
      turns: Array.from({ length: 12 }, (_, i) => historical(`turn-${i}`)),
    },
    {
      id: "session-b",
      title: "另一条会话的任务",
      createdAt: at,
      updatedAt: at,
      turns: [historical("turn-0")],
    },
  ],
};
chat.sessions[0].turns[0].prompt = "安排账号一的明日方舟日常";
chat.sessions[0].turns[0].planner.result!.execution = "managed-by-goal";
chat.sessions[0].turns[0].planner.result!.modelText =
  "任务已交办，实际进度与结果由宿主记录更新。";
let planner: PlannerViewState = { revision: 1, status: "idle" };
function goal(id: string, sessionId: string): GoalRun {
  return {
    version: 1,
    id,
    revision: 1,
    sessionId,
    turnId: "turn-0",
    prompt:
      sessionId === "session-a"
        ? "账号一执行明日方舟日常，保留当前任务开关"
        : "另一会话的阴阳师任务",
    selection: { kind: "saved-daily" },
    createdAt: at,
    updatedAt: at,
    grant: {
      id: "synthetic-grant",
      source: "user-message",
      sessionId,
      turnId: "turn-0",
      issuedAt: at,
      expiresAt: "2099-10-07T09:00:00Z",
      maxRetries: 2,
      scopes: [
        {
          laneId: "lane-a",
          gameId: "arknights",
          skillIds: ["login", "mail"],
          resources: { medicine: 0 },
        },
      ],
    },
    status: "waiting",
    message: "账号一 · 明日方舟邮件领取正在执行，尚未核验完成。",
    requests: [
      {
        requestId: "own-request",
        laneId: "lane-a",
        gameId: "arknights",
        status: "running",
        flowComplete: false,
        goalSatisfied: null,
        skills: [
          {
            skillId: "mail",
            status: "running",
            goalSatisfied: null,
            summary: "邮件领取正在执行",
          },
        ],
      },
    ],
    attempts: [],
    retryCount: 0,
    flowComplete: false,
    goalSatisfied: null,
  } as GoalRun;
}
let goals: GoalView = {
  revision: 1,
  goals: [goal("own-goal", "session-a"), goal("foreign-goal", "session-b")],
};
let releaseSend: (() => void) | undefined;
let releaseCancel: (() => void) | undefined;
const notifyChat = () => {
  chat.revision++;
  chatListeners.forEach((listener) => listener(structuredClone(chat)));
};
const independent = {
  version: 1,
  id: "device-other",
  source: "daily",
  laneId: "lane-b",
  batchId: "scheduled",
  status: "unknown",
  startedAt: at,
  finishedAt: at,
  fingerprint: "synthetic",
  resources: [],
  message: "独立定时任务失败，未关联当前聊天",
  snapshot: {},
};
const event = {
  runId: "scheduled",
  laneId: "lane-b",
  executionId: "device-other",
  batchId: "scheduled",
  source: "daily",
  type: "status",
  status: "failed",
  resultUncertain: true,
  message: independent.message,
  startedAt: at,
  at,
};
const methods: Record<string, any> = {
  snapshot: async () => ({
    games,
    settings: { adbPath: "", address: "", modelEndpoint: "", modelName: "" },
    engine: null,
    events: [event],
    runs: [],
    executions: [independent],
  }),
  deviceLanes: async () => fixture.lanes,
  arknights: async () => fixture.profiles,
  plannerSnapshot: async () => structuredClone(planner),
  chatSnapshot: async () => structuredClone(chat),
  goalSnapshot: async (sessionId: string) => {
    calls.push({ method: "goalRead", input: sessionId });
    return structuredClone(goals);
  },
  onChatState: (listener: (v: ChatView) => void) => {
    chatListeners.add(listener);
    return () => chatListeners.delete(listener);
  },
  onPlannerState: (listener: (v: PlannerViewState) => void) => {
    plannerListeners.add(listener);
    return () => plannerListeners.delete(listener);
  },
  onGoalState: (listener: (v: GoalView) => void) => {
    goalListeners.add(listener);
    return () => goalListeners.delete(listener);
  },
  modelProvider: async () => ({
    revision: 1,
    provider: "compatible",
    model: "offline-fixture",
    hasApiKey: false,
  }),
  chatCommands: async () => [],
  agentEvents: async () => ({
    version: 1,
    events: [],
    latestSeq: 0,
    cursor: 0,
    hasMore: false,
  }),
  selectChat: async (id: string) => {
    chat.selectedSessionId = id;
    notifyChat();
    return structuredClone(chat);
  },
  sendChat: async (input: any) => {
    calls.push({ method: "send", input });
    await new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    return structuredClone(chat);
  },
  cancelPlanner: async (id: string) => {
    calls.push({ method: "cancelModel", input: id });
    planner = {
      revision: planner.revision + 1,
      requestId: id,
      status: "cancelled",
    };
    chat.sessions.forEach((s) =>
      s.turns.forEach((t) => {
        if (t.planner.requestId === id) t.planner = structuredClone(planner);
      }),
    );
    notifyChat();
    plannerListeners.forEach((listener) => listener(planner));
    return structuredClone(planner);
  },
  cancelGoal: async (input: any) => {
    calls.push({ method: "cancelGoal", input });
    await new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    return structuredClone(goals.goals.find((g) => g.id === input.goalId));
  },
  incidentAgentSnapshot: async () => {
    calls.push({ method: "diagnosticRead" });
    return { sessions: [] };
  },
  executionProgress: async () => {
    throw Error("隔离任务进度只提供未确认状态。");
  },
  executionDetail: async () => {
    throw Error("隔离任务记录尚未确认。");
  },
  listArchivedChats: async () => ({
    entries: [],
    scope: "historical-only",
    canExecute: false,
  }),
};
// Unknown operations are blocked, never forwarded to a production connector.
window.gamepilot = new Proxy(methods, {
  get(target, key: string) {
    return key in target
      ? target[key]
      : key.startsWith("on")
        ? () => () => {}
        : async () => {
            calls.push({ method: "forbidden", input: key });
            throw Error(`Blocked isolated operation: ${key}`);
          };
  },
}) as DesktopAPI;
const control = {
  calls,
  subscribers: () => goalListeners.size,
  select(id: string) {
    chat.selectedSessionId = id;
    notifyChat();
  },
  releaseSend() {
    releaseSend?.();
    releaseSend = undefined;
  },
  releaseCancel() {
    releaseCancel?.();
    releaseCancel = undefined;
  },
  publish(status: GoalRun["status"], satisfied: boolean | null = null) {
    const value = goals.goals[0];
    value.revision++;
    value.status = status;
    value.goalSatisfied = satisfied;
    value.flowComplete = ["completed", "unknown", "needs-user"].includes(
      status,
    );
    value.message =
      satisfied === true
        ? "邮件奖励已核验领取，任务已完成。"
        : status === "needs-user"
          ? "邮件已观察到领取效果，但返回页面失败；请核对后继续。"
          : status === "unknown"
            ? "任务流程结束，实际结果尚未确认。"
            : "邮件领取正在执行。";
    value.requests[0].status =
      status === "completed"
        ? "succeeded"
        : status === "waiting"
          ? "running"
          : "unknown";
    value.requests[0].skills[0].status =
      status === "completed" ? "succeeded" : "failed";
    value.requests[0].skills[0].effectEvidence =
      status === "needs-user"
        ? [
            {
              kind: "reward-observed",
              observedAt: at,
              evidenceReference: "synthetic-effect",
              summary: "已确认出现邮件奖励画面",
            },
          ]
        : undefined;
    value.publicReply = { at, text: value.message };
    goals.revision++;
    goalListeners.forEach((listener) => listener(structuredClone(goals)));
  },
  busyInB() {
    planner = {
      revision: planner.revision + 1,
      requestId: "busy-in-b",
      status: "running",
      progress: { phase: "checking" },
    };
    chat.sessions[1].turns.push({
      ...historical("busy-turn"),
      planner: structuredClone(planner),
    });
    notifyChat();
    plannerListeners.forEach((listener) => listener(structuredClone(planner)));
  },
  cancelAcceptedTurn() {
    chat.sessions[0].turns[0].planner.status = "cancelled";
    notifyChat();
  },
};
(window as any).__sessionFixture = control;
createRoot(document.getElementById("root")!).render(<App />);
