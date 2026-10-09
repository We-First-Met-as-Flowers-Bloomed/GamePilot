import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI, RunEvent } from "../../../packages/protocol";
const api: DesktopAPI = {
  goalSnapshot: (sessionId) =>
    ipcRenderer.invoke("gp:goal-snapshot", sessionId),
  cancelGoal: (input) => ipcRenderer.invoke("gp:goal-cancel", input),
  onGoalState: (listener) => {
    const handler = (
      _event: unknown,
      view: import("../../../packages/protocol/agent-goal").GoalView,
    ) => listener(view);
    ipcRenderer.on("gp:goal-state", handler);
    return () => ipcRenderer.removeListener("gp:goal-state", handler);
  },
  onAgentError: (listener) => {
    const handler = (_: Electron.IpcRendererEvent, message: string) =>
      listener(message);
    ipcRenderer.on("gp:agent-error", handler);
    return () => ipcRenderer.removeListener("gp:agent-error", handler);
  },
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
  listArchivedChats: (input) => ipcRenderer.invoke("gp:chat-archives", input),
  loadArchivedChat: (input) =>
    ipcRenderer.invoke("gp:chat-archive-load", input),
  agentEvents: (input) => ipcRenderer.invoke("gp:agent-events", input),
  onAgentEvent: (listener) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      value: import("../../../packages/protocol/agent-events").AgentEvent,
    ) => listener(value);
    ipcRenderer.on("gp:agent-event", handler);
    return () => {
      ipcRenderer.removeListener("gp:agent-event", handler);
    };
  },
  onPlannerState: (listener) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      value: import("../../../packages/protocol/agent-planner").PlannerViewState,
    ) => listener(value);
    ipcRenderer.on("gp:planner-state", handler);
    return () => {
      ipcRenderer.removeListener("gp:planner-state", handler);
    };
  },
  onPlannerStream: (listener) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      value: {
        requestId: string;
        event: import("../../../packages/protocol/agent-planner").PlannerStreamEvent;
      },
    ) => listener(value);
    ipcRenderer.on("gp:planner-stream", handler);
    return () => {
      ipcRenderer.removeListener("gp:planner-stream", handler);
    };
  },
  onChatState: (listener) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      value: import("../../../packages/protocol/agent-chat").ChatView,
    ) => listener(value);
    ipcRenderer.on("gp:chat-state", handler);
    return () => {
      ipcRenderer.removeListener("gp:chat-state", handler);
    };
  },
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
  saveDeviceLanes: (input) => ipcRenderer.invoke("gp:device-lanes-save", input),
  mumuInstances: (managerPath) =>
    ipcRenderer.invoke("gp:mumu-instances", managerPath),
  startLane: (laneId, requestId = crypto.randomUUID()) =>
    ipcRenderer.invoke("gp:lane-start", { laneId, requestId }),
  startLanes: (requestId = crypto.randomUUID()) =>
    ipcRenderer.invoke("gp:lanes-start", requestId),
  stopLane: (laneId) => ipcRenderer.invoke("gp:lane-stop", laneId),
  stopLanes: () => ipcRenderer.invoke("gp:lanes-stop"),
  arknights: () => ipcRenderer.invoke("gp:arknights"),
  saveArknights: (input) => ipcRenderer.invoke("gp:arknights-save", input),
  probeArknights: () => ipcRenderer.invoke("gp:arknights-probe"),
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
  onEvent(listener) {
    const handler = (_: Electron.IpcRendererEvent, event: RunEvent) =>
      listener(event);
    ipcRenderer.on("gp:event", handler);
    return () => ipcRenderer.removeListener("gp:event", handler);
  },
};
contextBridge.exposeInMainWorld("gamepilot", api);
