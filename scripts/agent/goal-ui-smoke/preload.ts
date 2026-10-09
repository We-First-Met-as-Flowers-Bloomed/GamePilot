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
  "chatCommands",
  "agentEvents",
  "goalSnapshot",
  "cancelGoal",
  "selectChat",
  "newChat",
  "quit",
];
const api = Object.fromEntries(
  methods.map((method) => [
    method,
    (...args: unknown[]) =>
      ipcRenderer.invoke(`goal-fixture:${method}`, ...args),
  ]),
);
const events = {
  onEvent: "run",
  onChatState: "chat",
  onPlannerState: "planner",
  onPlannerStream: "stream",
  onAgentEvent: "agent",
  onAgentError: "agent-error",
  onGoalState: "goal",
};
const subscriptions = Object.fromEntries(
  Object.entries(events).map(([method, channel]) => [
    method,
    (listener: (value: unknown) => void) => {
      const wrapped = (_event: unknown, value: unknown) => listener(value);
      ipcRenderer.on(`goal-fixture:${channel}`, wrapped);
      return () =>
        ipcRenderer.removeListener(`goal-fixture:${channel}`, wrapped);
    },
  ]),
);
contextBridge.exposeInMainWorld("gamepilot", { ...api, ...subscriptions });
