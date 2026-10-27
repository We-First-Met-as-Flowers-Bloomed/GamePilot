import { contextBridge, ipcRenderer } from "electron";

const methods = [
  "snapshot",
  "deviceLanes",
  "arknights",
  "arknightsAutomation",
  "onmyojiAutomation",
  "runArknightsJob",
  "runOnmyojiJob",
  "saveArknightsAutomation",
  "saveOnmyojiAutomation",
  "searchCopilot",
  "prepareCopilot",
  "confirmCopilot",
  "cancelCopilot",
  "inspectOnmyojiIdentity",
  "modelProvider",
  "automation",
  "plannerSnapshot",
  "agentEvents",
  "agentExecutionSnapshot",
  "incidentAgentSnapshot",
  "chatSnapshot",
  "newChat",
  "selectChat",
  "sendChat",
  "cancelChat",
  "archiveChat",
  "listArchivedChats",
  "loadArchivedChat",
  "restoreArchivedChat",
  "deleteChat",
  "captureLanePreview",
  "reviewAgentExecution",
  "confirmAgentExecution",
  "cancelAgentExecution",
  "executionProgress",
  "executionDetail",
  "previewContinuation",
  "failureEvidence",
  "readFailureImage",
  "reviewExecution",
  "inspectExecution",
  "saveSettings",
  "saveDeviceLanes",
  "saveArknights",
  "saveAutomation",
  "saveModelProvider",
  "testModelProvider",
  "testNotification",
  "probeArknights",
  "mumuInstances",
  "detectMuMu",
  "discover",
  "connect",
  "capture",
  "start",
  "startLane",
  "startGameSlot",
  "startLanes",
  "startContinuation",
  "stop",
  "stopLane",
  "stopGameSlot",
  "stopLanes",
  "startPlanner",
  "cancelPlanner",
  "diagnoseFailure",
  "cancelFailureDiagnosis",
  "confirmFailureContinuation",
  "resolveExecution",
  "deleteFailureImage",
  "quit",
] as const;
const api = Object.fromEntries(
  methods.map((method) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(`fixture:${method}`, ...args),
  ]),
);
contextBridge.exposeInMainWorld("gamepilot", {
  ...api,
  onAgentEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => listener(event);
    ipcRenderer.on("fixture:agent-event", wrapped);
    return () => ipcRenderer.removeListener("fixture:agent-event", wrapped);
  },
  onAgentError: (listener: (message: string) => void) => {
    const wrapped = (_event: unknown, value: string) => listener(value);
    ipcRenderer.on("fixture:agent-error", wrapped);
    return () => ipcRenderer.removeListener("fixture:agent-error", wrapped);
  },
  onPlannerStream: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => listener(event);
    ipcRenderer.on("fixture:planner-stream", wrapped);
    return () => ipcRenderer.removeListener("fixture:planner-stream", wrapped);
  },
  onEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => listener(event);
    ipcRenderer.on("fixture:event", wrapped);
    return () => ipcRenderer.removeListener("fixture:event", wrapped);
  },
});
