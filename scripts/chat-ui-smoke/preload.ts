import { contextBridge, ipcRenderer } from "electron";

const methods = [
  "snapshot",
  "deviceLanes",
  "arknights",
  "modelProvider",
  "automation",
  "plannerSnapshot",
  "agentExecutionSnapshot",
  "incidentAgentSnapshot",
  "chatSnapshot",
  "newChat",
  "selectChat",
  "sendChat",
  "cancelChat",
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
  "startLanes",
  "startContinuation",
  "stop",
  "stopLane",
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
  onEvent: (listener: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => listener(event);
    ipcRenderer.on("fixture:event", wrapped);
    return () => ipcRenderer.removeListener("fixture:event", wrapped);
  },
});
