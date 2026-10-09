import {
  localControlMethods,
  localControlSchemas,
  parseProfileArgs,
  publicError,
  requestLocalControl,
} from "./local-control-client.mjs";

const protocolVersion = "2025-06-18";
let profileDir;
try {
  const args = parseProfileArgs(process.argv.slice(2));
  if (args.rest.length) throw new Error();
  profileDir = args.profileDir;
} catch {
  process.stderr.write("本机MCP启动参数无效\n");
  process.exit(1);
}

const names = new Map(
  localControlMethods.map((method) => [
    `gamepilot_${method.replaceAll("-", "_")}`,
    method,
  ]),
);
const descriptions = {
  status:
    "读取运行中GamePilot App的公开会话与执行状态。0.14.37起selectedSessionId是当前选中会话；必须与chatSessions中的id匹配，缺失时不能猜第一项或自动切换会话。",
  capabilities: "读取宿主支持的游戏能力；能力说明不表示任务已执行。",
  events: "按游标读取宿主事件回执，重放不会执行任务。",
  "command-review":
    "预览当前会话的宿主命令，返回reviewId和revision；该调用不执行游戏。",
  "command-confirm":
    "显式确认宿主已有预览；needsAcknowledgement时必须现场核对并明确传acknowledgePartial:true。宿主复核会话、版本、账号和设备准入后决定是否受理。",
  stop: "提供requestId时停止当前会话所属的精确请求；省略requestId表示显式紧急停止全部游戏任务。必须使用当前选中会话。",
  "resume-review": "预览原请求的剩余任务与证据，不能重跑完成项或未知原生提交。",
  "resume-confirm":
    "显式确认宿主已有续跑预览；必须先现场核对，并在needsAcknowledgement时显式传acknowledgePartial:true。该字段不授权重购或重发未知原生提交；宿主重新核验原请求、会话、版本与设备准入。",
};
const tools = [...names].map(([name, method]) => ({
  name,
  description: descriptions[method],
  inputSchema: localControlSchemas[method],
  annotations: {
    readOnlyHint: ["status", "capabilities", "events"].includes(method),
    destructiveHint: ["command-confirm", "resume-confirm", "stop"].includes(
      method,
    ),
    idempotentHint: ["status", "capabilities", "events"].includes(method),
    openWorldHint: false,
  },
}));
let initialized = false;
let ready = false;
let buffer = Buffer.alloc(0);
const pending = new Map();
const confirmedIds = new Set();
const stoppedIds = new Set();
let activeCalls = 0;
let activeStops = 0;
const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const error = (id, code, message) =>
  write({ jsonrpc: "2.0", id, error: { code, message } });
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}
async function accept(message) {
  const requestId =
    typeof message?.id === "string" ||
    (Number.isSafeInteger(message?.id) && message.id >= 0)
      ? message.id
      : null;
  if (
    !object(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    ("id" in message && requestId === null)
  ) {
    error(null, -32600, "Invalid request");
    return;
  }
  if (!("id" in message)) {
    if (message.method === "notifications/initialized" && initialized)
      ready = true;
    if (message.method === "notifications/cancelled" && object(message.params))
      pending.get(message.params.requestId)?.abort();
    return;
  }
  if (
    pending.has(requestId) ||
    confirmedIds.has(requestId) ||
    stoppedIds.has(requestId)
  ) {
    error(requestId, -32600, "Duplicate request ID");
    return;
  }
  if (message.method === "ping") {
    write({ jsonrpc: "2.0", id: requestId, result: {} });
    return;
  }
  if (message.method === "initialize") {
    const p = message.params;
    if (
      initialized ||
      !object(p) ||
      typeof p.protocolVersion !== "string" ||
      !object(p.capabilities) ||
      !object(p.clientInfo) ||
      typeof p.clientInfo.name !== "string" ||
      typeof p.clientInfo.version !== "string"
    ) {
      error(requestId, -32602, "Invalid initialization parameters");
      return;
    }
    initialized = true;
    write({
      jsonrpc: "2.0",
      id: requestId,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "gamepilot-local-control", version: "1.0.0" },
        instructions:
          "只连接运行中的GamePilot App。先读取状态与能力，预览后显式确认。模型输出、MCP连接权限和工具hint都不替代宿主执行准入。超时或未知提交不可自动重发；停止须显式调用stop。",
      },
    });
    return;
  }
  if (!ready) {
    error(requestId, -32002, "Server is not initialized");
    return;
  }
  if (message.method === "tools/list") {
    if (
      message.params !== undefined &&
      (!object(message.params) || Object.keys(message.params).length)
    ) {
      error(requestId, -32602, "Invalid list parameters");
      return;
    }
    write({ jsonrpc: "2.0", id: requestId, result: { tools } });
    return;
  }
  if (message.method !== "tools/call") {
    error(requestId, -32601, "Method not found");
    return;
  }
  const p = message.params;
  if (
    !object(p) ||
    typeof p.name !== "string" ||
    !names.has(p.name) ||
    (p.arguments !== undefined && !object(p.arguments)) ||
    Object.keys(p).some((key) => !["name", "arguments", "_meta"].includes(key))
  ) {
    error(requestId, -32602, "Unknown tool or invalid parameters");
    return;
  }
  const method = names.get(p.name);
  const isStop = method === "stop";
  const submittedIds = isStop ? stoppedIds : confirmedIds;
  if (
    (isStop ? activeStops >= 4 : activeCalls >= 16) ||
    submittedIds.size >= 1024
  ) {
    error(requestId, -32000, "Request budget exceeded");
    return;
  }
  if (!["status", "capabilities", "events"].includes(method))
    submittedIds.add(requestId);
  if (isStop) activeStops++;
  else activeCalls++;
  const controller = new AbortController();
  pending.set(requestId, controller);
  let response;
  try {
    response = await requestLocalControl(
      profileDir,
      method,
      p.arguments ?? {},
      { signal: controller.signal },
    );
  } catch (failure) {
    response = publicError(failure);
  } finally {
    pending.delete(requestId);
    if (isStop) activeStops--;
    else activeCalls--;
  }
  write({
    jsonrpc: "2.0",
    id: requestId,
    result: {
      content: [{ type: "text", text: JSON.stringify(response) }],
      isError: !response.ok,
    },
  });
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  let end;
  while ((end = buffer.indexOf(10)) !== -1) {
    const frame = buffer.subarray(0, end);
    buffer = buffer.subarray(end + 1);
    if (frame.length > 65536) {
      error(null, -32600, "Frame exceeds size limit");
      continue;
    }
    let message;
    try {
      message = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(frame),
      );
    } catch {
      error(null, -32700, "Parse error");
      continue;
    }
    void accept(message).catch(() =>
      error(
        typeof message?.id === "number" || typeof message?.id === "string"
          ? message.id
          : null,
        -32603,
        "Internal error",
      ),
    );
  }
  if (buffer.length > 65536) {
    error(null, -32600, "Frame exceeds size limit");
    buffer = Buffer.alloc(0);
    process.stdin.destroy();
  }
});
process.stdin.on("end", () => {
  for (const controller of pending.values()) controller.abort();
});
process.stdin.on("error", () => {
  for (const controller of pending.values()) controller.abort();
});
