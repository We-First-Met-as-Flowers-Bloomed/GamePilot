import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { ChatService } from "../apps/desktop/main/agent-chat";
import { PlannerService } from "../apps/desktop/main/agent-planner";
import { AgentToolError } from "../packages/protocol/agent";
import type { GoalRun } from "../packages/protocol/agent-goal";
import { plannerActive } from "../packages/protocol/agent-planner";
import { GoalService } from "../apps/desktop/main/agent-goals";
import { goalResultReport } from "../games/goal-report";
import type { GoalStore } from "../packages/protocol/agent-goal";

// Exercise the real main-process closures without importing Electron or launching
// an app. Extraction fails if these production seams are renamed or removed.
const indexPath = new URL("../apps/desktop/main/index.ts", import.meta.url);
const text = readFileSync(indexPath, "utf8");
const source = parse(text, { sourceType: "module", plugins: ["typescript"] });
let notification = "",
  chatSend = "",
  startup = "";
function find(node: Node) {
  if (
    node.type === "ExpressionStatement" &&
    node.expression.type === "AwaitExpression" &&
    node.expression.argument.type === "CallExpression" &&
    node.expression.argument.callee.type === "MemberExpression" &&
    node.expression.argument.callee.object.type === "Identifier" &&
    node.expression.argument.callee.object.name === "goals" &&
    node.expression.argument.callee.property.type === "Identifier" &&
    node.expression.argument.callee.property.name === "ready"
  ) {
    const end = text.indexOf("goals.subscribe(", node.end!);
    if (end >= 0) startup = text.slice(node.start!, end);
  }
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.id.name === "notifyGoal"
  ) {
    notification = `const notifyGoal = ${text.slice(node.init!.start!, node.init!.end!)}; globalThis.notifyGoal = notifyGoal;`;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "handle" &&
    node.arguments[0]?.type === "StringLiteral" &&
    node.arguments[0].value === "gp:chat-send"
  ) {
    chatSend = text.slice(node.start!, node.end!) + ";";
  }
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && typeof child.type === "string")
        find(child as Node);
    }
  }
}
find(source);
if (!notification || !chatSend || !startup)
  throw new Error("Main notification/chat admission seam was not found");
const compiled = transformSync(notification + "\n" + chatSend, {
  loader: "ts",
  target: "node22",
}).code;
const startupCompiled = transformSync(
  `globalThis.boot = async () => { ${startup} };`,
  { loader: "ts", target: "node22" },
).code;

it("normal main startup reconciles a restored pre-admission goal without dispatching effects", async () => {
  const saved = terminal("goal-startup", "session-startup", "turn-startup");
  saved.status = "preparing";
  saved.flowComplete = false;
  saved.goalSatisfied = null;
  saved.resultNotification = undefined;
  let store: GoalStore = { version: 1, revision: 1, goals: [saved] };
  const submit = vi.fn(async () => {
    throw Error("No replay allowed");
  });
  const observe = vi.fn(async () => {
    throw Error("Unsubmitted goal has no device observation");
  });
  const goals = new GoalService({
    load: async () => structuredClone(store),
    save: async (v) => {
      store = structuredClone(v);
    },
    prepare: async () => {
      throw Error("No new preparation allowed");
    },
    submit,
    observe,
    stop: async () => {
      throw Error("No accepted job to stop");
    },
  });
  const context: any = createContext({ goals });
  runInContext(startupCompiled, context);
  await context.boot();
  const restored = goals.get(saved.id, { sessionId: saved.sessionId });
  expect(restored.status).toBe("unknown");
  expect(restored.waitingReason).toBe("interrupted-before-admission");
  expect(submit).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  expect(store.goals[0].status).toBe("unknown");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function terminal(id: string, sessionId: string, turnId: string): GoalRun {
  const at = "2026-10-05T00:00:00.000Z";
  return {
    version: 1,
    id,
    revision: 1,
    sessionId,
    turnId,
    prompt: "运行保存日常",
    selection: { kind: "saved-daily", dailyScope: "saved" },
    grant: {
      id: `grant-${id}`,
      source: "user-message",
      sessionId,
      turnId,
      issuedAt: at,
      expiresAt: "2026-10-05T06:00:00.000Z",
      maxRetries: 0,
      scopes: [
        {
          laneId: "lane-a",
          gameId: "onmyoji",
          skillIds: ["mail"],
          resources: {},
        },
      ],
    },
    createdAt: at,
    updatedAt: at,
    status: "completed",
    message: "宿主已核验邮件领取结果",
    attempts: [],
    retryCount: 0,
    requests: [],
    flowComplete: true,
    goalSatisfied: true,
    resultNotification: { revision: 1, state: "pending" },
  };
}

async function fixture() {
  const modelResult = {
    status: "answer" as const,
    modelText: "公开查询回复",
    source: "fixture" as const,
    execution: "not-started" as const,
    canExecute: false as const,
    trace: [],
    model: "offline",
    codexVersion: "offline",
    elapsedMs: 0,
  };
  const planner = new PlannerService({
    find: async () => "offline",
    run: async () => modelResult,
  });
  const claims = new Map<string, GoalRun>();
  const beginGate = deferred<void>(),
    modelGate = deferred<void>(),
    saveGate = deferred<void>();
  const runtime = vi.fn(async (options: any) => {
    await modelGate.promise;
    return {
      finalText: "邮件结果已由宿主核验",
      model: "offline",
      sessionId: options.sessionId,
      events: [],
    };
  });
  const begin = vi.fn(async (id: string) => {
    await beginGate.promise;
    const goal = claims.get(id)!;
    if (goal.resultNotification!.state !== "pending") return false;
    goal.resultNotification!.state = "delivering";
    return true;
  });
  const setReply = vi.fn(async (id: string, _owner: unknown, reply: any) => {
    await saveGate.promise;
    claims.get(id)!.publicReply = {
      text: reply.text,
      at: "2026-10-05T00:00:01.000Z",
    };
    claims.get(id)!.resultNotification!.state = "delivered";
  });
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const context: any = createContext({
    AbortController,
    Date,
    JSON,
    join,
    AgentToolError,
    goalResultReport,
    plannerActive,
    planner,
    modelOperation: undefined,
    quitting: false,
    goalNotifications: new Set(),
    goalNotificationJobs: new Set(),
    chatCommands: undefined,
    goals: { beginResultNotification: begin, setReply },
    modelProvider: {
      resolve: async () => ({
        provider: "compatible",
        baseUrl: "http://offline.invalid",
        model: "offline",
        apiKey: "private-test",
      }),
    },
    runWithDsh: runtime,
    app: { isPackaged: true },
    process: { resourcesPath: "C:/offline-resources" },
    dataDir: "C:/offline-profile",
    modelEventReceipt: () => undefined,
    recordAgent: async () => {},
    sendObservation: vi.fn(),
    agentJournal: { assertReady: async () => {} },
    handle: (name: string, handler: (input: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
  });
  const chat = new ChatService({
    planner,
    save: async () => {},
    available: () => !context.modelOperation,
  });
  context.chat = chat;
  runInContext(compiled, context);
  const sessionId = (await chat.newChat()).selectedSessionId!;
  const first = terminal("goal-a", sessionId, "turn-a"),
    second = terminal("goal-b", sessionId, "turn-b");
  claims.set(first.id, first);
  claims.set(second.id, second);
  const send = () =>
    handlers.get("gp:chat-send")!({
      sessionId,
      prompt: "查询邮件结果",
      source: "fixture",
      at: "2026-10-05T00:00:00.000Z",
    });
  const close = async () => {
    beginGate.resolve();
    modelGate.resolve();
    saveGate.resolve();
    await Promise.allSettled([...context.goalNotificationJobs]);
    await planner.close();
    await chat.close();
  };
  return {
    context,
    planner,
    chat,
    runtime,
    begin,
    setReply,
    beginGate,
    modelGate,
    saveGate,
    first,
    second,
    send,
    close,
  };
}

it("serializes durable result writes without waiting for another model request", async () => {
  const x = await fixture();
  try {
    x.context.notifyGoal(x.first);
    const reservation = x.context.modelOperation;
    expect(reservation).toBeInstanceOf(AbortController);
    x.context.notifyGoal(x.second);
    expect(x.begin).toHaveBeenCalledTimes(1);
    expect(x.second.resultNotification?.state).toBe("pending");
    await expect(x.send()).rejects.toThrow("请稍后发送需求");
    expect((await x.chat.snapshot()).sessions[0].turns).toHaveLength(0);
    x.beginGate.resolve();
    await vi.waitFor(() => expect(x.setReply).toHaveBeenCalledTimes(1));
    expect(x.runtime).not.toHaveBeenCalled();
    expect(x.setReply.mock.calls[0][2].text).toContain("结果未完整确认");
    expect(x.context.modelOperation).toBe(reservation);
    await expect(x.send()).rejects.toThrow("请稍后发送需求");
    expect((await x.chat.snapshot()).sessions[0].turns).toHaveLength(0);
    x.saveGate.resolve();
    await vi.waitFor(() => expect(x.context.modelOperation).toBeUndefined());
    x.context.notifyGoal(x.second);
    await vi.waitFor(() =>
      expect(x.second.resultNotification?.state).toBe("delivered"),
    );
    expect(x.runtime).not.toHaveBeenCalled();
    await x.send();
    await vi.waitFor(() =>
      expect(x.planner.snapshot().status).toBe("completed"),
    );
    const view = await x.chat.snapshot();
    expect(view.error).toBeUndefined();
    expect(view.sessions[0].turns).toHaveLength(1);
    expect(view.sessions[0].turns[0].prompt).toBe("查询邮件结果");
    expect(view.sessions[0].turns[0].planner.status).toBe("completed");
  } finally {
    await x.close();
  }
});

it("releases a result reservation when its durable notification was already claimed", async () => {
  const x = await fixture();
  try {
    x.first.resultNotification!.state = "delivered";
    x.beginGate.resolve();
    x.context.notifyGoal(x.first);
    await vi.waitFor(() => expect(x.context.modelOperation).toBeUndefined());
    expect(x.runtime).not.toHaveBeenCalled();
    expect(x.setReply).not.toHaveBeenCalled();
    await x.send();
    await vi.waitFor(() =>
      expect(x.planner.snapshot().status).toBe("completed"),
    );
    expect((await x.chat.snapshot()).sessions[0].turns).toHaveLength(1);
  } finally {
    await x.close();
  }
});

it("delivers host facts without resolving provider credentials or calling the model", async () => {
  const x = await fixture();
  try {
    const resolve = vi.fn(async () => {
      throw new Error("Provider must not be needed for host results");
    });
    x.context.modelProvider.resolve = resolve;
    x.beginGate.resolve();
    x.context.notifyGoal(x.first);
    await vi.waitFor(() => expect(x.setReply).toHaveBeenCalledOnce());
    expect(x.setReply.mock.calls[0][2].text).toContain("结果未完整确认");
    expect(resolve).not.toHaveBeenCalled();
    expect(x.runtime).not.toHaveBeenCalled();
    expect(x.context.modelOperation).toBeDefined();
    x.saveGate.resolve();
    await vi.waitFor(() => expect(x.context.modelOperation).toBeUndefined());
    expect(x.first.resultNotification?.state).toBe("delivered");
    await x.send();
    await vi.waitFor(() =>
      expect(x.planner.snapshot().status).toBe("completed"),
    );
    expect((await x.chat.snapshot()).sessions[0].turns).toHaveLength(1);
  } finally {
    await x.close();
  }
});
