import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, RunEvent } from "../../../packages/protocol";

/**
 * 每个事件通道只挂一个 ipcRenderer 监听器，向多个订阅者本地扇出。
 * 聊天历史会同时渲染多个 AgentRunTrace（每实例 3 个事件通道），
 * 逐实例直挂 ipcRenderer 会触发 EventEmitter 上限告警。
 */
const dispatchers = new Map<string, Set<(payload: never) => void>>();
function subscribe<T>(channel: string, listener: (payload: T) => void) {
  let set = dispatchers.get(channel) as Set<(payload: T) => void> | undefined;
  if (!set) {
    const handlers = new Set<(payload: T) => void>();
    dispatchers.set(channel, handlers as Set<(payload: never) => void>);
    ipcRenderer.on(channel, (_event, value: T) => {
      for (const handler of [...handlers]) handler(value);
    });
    set = handlers;
  }
  set.add(listener);
  return () => {
    const current = dispatchers.get(channel) as
      Set<(payload: T) => void> | undefined;
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      dispatchers.delete(channel);
      ipcRenderer.removeAllListeners(channel);
    }
  };
}

const api: DesktopAPI = {
  arknightsActivity: (input) =>
    ipcRenderer.invoke("gp:arknights-activity", input),
  importMaaSettings: (input) =>
    ipcRenderer.invoke("gp:arknights-maa-import", input),
  onmyojiAutomation: () => ipcRenderer.invoke("gp:onmyoji-automation"),
  saveOnmyojiAutomation: (input) =>
    ipcRenderer.invoke("gp:onmyoji-automation-save", input),
  runOnmyojiJob: (input) => ipcRenderer.invoke("gp:onmyoji-job-run", input),
  arknightsAutomation: () => ipcRenderer.invoke("gp:arknights-automation"),
  saveArknightsAutomation: (input) =>
    ipcRenderer.invoke("gp:arknights-automation-save", input),
  runArknightsJob: (input) => ipcRenderer.invoke("gp:arknights-job-run", input),
  goalSnapshot: (sessionId) =>
    ipcRenderer.invoke("gp:goal-snapshot", sessionId),
  cancelGoal: (input) => ipcRenderer.invoke("gp:goal-cancel", input),
  onGoalState: (listener) =>
    subscribe<import("../../../packages/protocol/agent-goal").GoalView>(
      "gp:goal-state",
      listener,
    ),
  onAgentError: (listener) => subscribe<string>("gp:agent-error", listener),
  chatCommands: (sessionId) =>
    ipcRenderer.invoke("gp:chat-command-snapshot", sessionId),
  reviewChatCommand: (input) =>
    ipcRenderer.invoke("gp:chat-command-review", input),
  reviewChatIntent: (input) =>
    ipcRenderer.invoke("gp:chat-intent-review", input),
  confirmChatCommand: (input) =>
    ipcRenderer.invoke("gp:chat-command-confirm", input),
  pauseAfterStep: (input) =>
    ipcRenderer.invoke("gp:chat-pause-after-step", input),
  archiveChat: (input) => ipcRenderer.invoke("gp:chat-archive", input),
  restoreArchivedChat: (input) =>
    ipcRenderer.invoke("gp:chat-archive-restore", input),
  deleteChat: (input) => ipcRenderer.invoke("gp:chat-delete", input),
  captureLanePreview: (laneId) =>
    ipcRenderer.invoke("gp:lane-preview-capture", laneId),
  listArchivedChats: (input) => ipcRenderer.invoke("gp:chat-archives", input),
  loadArchivedChat: (input) =>
    ipcRenderer.invoke("gp:chat-archive-load", input),
  agentEvents: (input) => ipcRenderer.invoke("gp:agent-events", input),
  onAgentEvent: (listener) =>
    subscribe<import("../../../packages/protocol/agent-events").AgentEvent>(
      "gp:agent-event",
      listener,
    ),
  onPlannerState: (listener) =>
    subscribe<
      import("../../../packages/protocol/agent-planner").PlannerViewState
    >("gp:planner-state", listener),
  onPlannerStream: (listener) =>
    subscribe<{
      requestId: string;
      event: import("../../../packages/protocol/agent-planner").PlannerStreamEvent;
    }>("gp:planner-stream", listener),
  onChatState: (listener) =>
    subscribe<import("../../../packages/protocol/agent-chat").ChatView>(
      "gp:chat-state",
      listener,
    ),
  newChat: () => ipcRenderer.invoke("gp:chat-new"),
  selectChat: (id) => ipcRenderer.invoke("gp:chat-select", id),
  chatSnapshot: () => ipcRenderer.invoke("gp:chat-snapshot"),
  sendChat: (input) => ipcRenderer.invoke("gp:chat-send", input),
  cancelChat: (input) => ipcRenderer.invoke("gp:chat-cancel", input),
  executionDetail: (id) => ipcRenderer.invoke("gp:execution-detail", id),
  previewContinuation: (id) =>
    ipcRenderer.invoke("gp:continuation-preview", id),
  executionProgress: (id) => ipcRenderer.invoke("gp:execution-progress", id),
  startContinuation: (input) =>
    ipcRenderer.invoke("gp:continuation-start", input),
  modelProvider: () => ipcRenderer.invoke("gp:model-provider"),
  saveModelProvider: (input) =>
    ipcRenderer.invoke("gp:model-provider-save", input),
  testModelProvider: () => ipcRenderer.invoke("gp:model-provider-test"),
  failureEvidence: (id) => ipcRenderer.invoke("gp:failure-evidence", id),
  readFailureImage: (input) => ipcRenderer.invoke("gp:failure-image", input),
  deleteFailureImage: (input) =>
    ipcRenderer.invoke("gp:failure-image-delete", input),
  plannerSnapshot: () => ipcRenderer.invoke("gp:planner-snapshot"),
  incidentAgentSnapshot: () => ipcRenderer.invoke("gp:incident-agent-snapshot"),
  onIncidentAgentState: (listener) =>
    subscribe<
      import("../../../packages/protocol/incident-agent").IncidentAgentView
    >("gp:incident-agent-state", listener),
  diagnoseFailure: (input) =>
    ipcRenderer.invoke("gp:incident-agent-start", input),
  cancelFailureDiagnosis: (id) =>
    ipcRenderer.invoke("gp:incident-agent-cancel", id),
  confirmFailureContinuation: (id) =>
    ipcRenderer.invoke("gp:incident-agent-confirm", id),
  agentExecutionSnapshot: () =>
    ipcRenderer.invoke("gp:agent-execution-snapshot"),
  reviewAgentExecution: (input) =>
    ipcRenderer.invoke("gp:agent-execution-review", input),
  confirmAgentExecution: (input) =>
    ipcRenderer.invoke("gp:agent-execution-confirm", input),
  cancelAgentExecution: (id) =>
    ipcRenderer.invoke("gp:agent-execution-cancel", id),
  startPlanner: (input) => ipcRenderer.invoke("gp:planner-start", input),
  cancelPlanner: (requestId) =>
    ipcRenderer.invoke("gp:planner-cancel", requestId),
  reviewExecution: (id) => ipcRenderer.invoke("gp:execution-review", id),
  inspectExecution: (id) => ipcRenderer.invoke("gp:execution-inspect", id),
  resolveExecution: (input) =>
    ipcRenderer.invoke("gp:execution-resolve", input),
  deviceLanes: () => ipcRenderer.invoke("gp:device-lanes"),
  copyChannels: (input) => ipcRenderer.invoke("gp:channel-copy", input),
  saveDeviceLanes: (input) => ipcRenderer.invoke("gp:device-lanes-save", input),
  inspectOnmyojiIdentity: (laneId) =>
    ipcRenderer.invoke("gp:onmyoji-identity-inspect", laneId),
  mumuInstances: (managerPath) =>
    ipcRenderer.invoke("gp:mumu-instances", managerPath),
  startGameSlot: (input) =>
    ipcRenderer.invoke("gp:game-slot-start", {
      ...input,
      requestId: input.requestId ?? crypto.randomUUID(),
    }),
  stopGameSlot: (input) => ipcRenderer.invoke("gp:game-slot-stop", input),
  startLane: (laneId, requestId = crypto.randomUUID()) =>
    ipcRenderer.invoke("gp:lane-start", { laneId, requestId }),
  startLanes: (requestId = crypto.randomUUID()) =>
    ipcRenderer.invoke("gp:lanes-start", requestId),
  stopLane: (laneId) => ipcRenderer.invoke("gp:lane-stop", laneId),
  stopLanes: () => ipcRenderer.invoke("gp:lanes-stop"),
  arknights: () => ipcRenderer.invoke("gp:arknights"),
  saveArknights: (input) => ipcRenderer.invoke("gp:arknights-save", input),
  probeArknights: () => ipcRenderer.invoke("gp:arknights-probe"),
  searchCopilot: (input) => ipcRenderer.invoke("gp:copilot-search", input),
  prepareCopilot: (input) => ipcRenderer.invoke("gp:copilot-prepare", input),
  confirmCopilot: (input) => ipcRenderer.invoke("gp:copilot-confirm", input),
  cancelCopilot: (input) => ipcRenderer.invoke("gp:copilot-cancel", input),
  quit: () => ipcRenderer.invoke("gp:quit"),
  testNotification: () => ipcRenderer.invoke("gp:notification-test"),
  automation: () => ipcRenderer.invoke("gp:automation"),
  saveAutomation: (input) => ipcRenderer.invoke("gp:automation-save", input),
  detectMuMu: () => ipcRenderer.invoke("gp:mumu-detect"),
  snapshot: () => ipcRenderer.invoke("gp:snapshot"),
  saveSettings: (settings) => ipcRenderer.invoke("gp:settings", settings),
  discover: () => ipcRenderer.invoke("gp:discover"),
  connect: (device) => ipcRenderer.invoke("gp:connect", device),
  capture: () => ipcRenderer.invoke("gp:capture"),
  start: (plan, requestId = crypto.randomUUID()) =>
    ipcRenderer.invoke("gp:start", { plan, requestId }),
  stop: () => ipcRenderer.invoke("gp:stop"),
  onEvent: (listener) => subscribe<RunEvent>("gp:event", listener),
};
contextBridge.exposeInMainWorld("gamepilot", api);
