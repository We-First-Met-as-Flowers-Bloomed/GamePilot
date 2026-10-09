import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("gamepilot", {
  reviewAgentExecution: (input: unknown) => ipcRenderer.invoke("review", input),
  confirmAgentExecution: (input: unknown) =>
    ipcRenderer.invoke("confirm", input),
  agentExecutionSnapshot: () => ipcRenderer.invoke("snapshot"),
  cancelAgentExecution: (input: unknown) => ipcRenderer.invoke("cancel", input),
});
