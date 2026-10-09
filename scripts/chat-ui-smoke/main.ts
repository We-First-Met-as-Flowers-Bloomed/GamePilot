import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createFixtureSnapshot } from "../../packages/agent/fixture";
import { games } from "../../games/registry";
import {
  deviceLanePlanKey,
  validateAutomation,
  type RunEvent,
} from "../../packages/protocol";
import type {
  PlannerResult,
  PlannerViewState,
} from "../../packages/protocol/agent-planner";
import type { AgentExecutionView } from "../../packages/protocol/agent-execution";
import { reduceTaskRecords } from "../../packages/protocol/task-record";

const directory = __dirname;
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
const fixture = createFixtureSnapshot();
const at = () => new Date().toISOString();
fixture.lanes!.lanes.forEach((lane, index) => {
  lane.name = `测试账号${index + 1}`;
  lane.onmyoji.enabled = false;
});
const calls: { method: string; args: unknown[] }[] = [];
let planner: PlannerViewState = { revision: 0, status: "idle" };
let execution: AgentExecutionView = {
  revision: 0,
  status: "idle",
  message: "",
  lanes: [],
};
type Turn = {
  id: string;
  prompt: string;
  at: string;
  source: string;
  createdAt: string;
  planner: PlannerViewState;
};
type Session = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
};
const initial: Session = {
  id: "chat-1",
  title: "新会话",
  createdAt: at(),
  updatedAt: at(),
  turns: [],
};
const chat = {
  revision: 0,
  selectedSessionId: initial.id,
  sessions: [initial],
};
const snapshot = {
  games,
  settings: { adbPath: "", address: "", modelEndpoint: "", modelName: "" },
  engine: { connected: false, version: "isolated-fixture" },
  events: [] as RunEvent[],
  runs: [] as typeof fixture.tasks,
  executions: [] as typeof fixture.requests,
};
let window: BrowserWindow | undefined;
let launches = 0;
let holdSend = true;
let nextTurn = 0;
let forbiddenCalls = 0;
let releaseStart: (() => void) | undefined;
const result: Record<string, any> = {
  scope:
    "Production React App, production CSS and sandboxed Electron preload with synthetic IPC; no real device, engine, model or production storage writes.",
  checks: [],
  screenshots: [],
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (source: string) =>
  window!.webContents.executeJavaScript(source, true);
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  result.checks.push(name);
};
async function until(source: string, label: string) {
  for (let i = 0; i < 100; i++) {
    if (await js(`Boolean(${source})`)) return;
    await delay(100);
  }
  throw new Error(`Timeout: ${label}`);
}
const click = (id: string) =>
  js(`document.getElementById(${JSON.stringify(id)}).click()`);
const clickText = (text: string) =>
  js(`{
  const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)});
  if (!button) throw new Error('Missing button: '+${JSON.stringify(text)});
  button.click(); true;
}`);
async function typePrompt(prompt: string, waitForSend = true) {
  await js(`{
    const el=document.getElementById('chat-prompt');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(prompt)});
    el.dispatchEvent(new Event('input',{bubbles:true})); true;
  }`);
  if (waitForSend)
    await until(
      'document.querySelector("#chat-send:not(:disabled)")',
      "editable composer",
    );
}
const selected = () =>
  chat.sessions.find((s) => s.id === chat.selectedSessionId)!;
const active = () => selected().turns.at(-1)!;
function reply(kind: "draft" | "answer", source = "recorded"): PlannerResult {
  return {
    status: kind,
    modelText:
      kind === "draft"
        ? "已生成双账号明日方舟计划。仅完成规划，游戏尚未启动。"
        : "模型回答：任务已完成。请以独立的实际执行记录核对。",
    source: source as any,
    execution: "not-started",
    canExecute: false,
    trace: [
      { callId: "catalog", tool: "list_capabilities", success: true },
      { callId: "environment", tool: "get_environment", success: true },
      {
        callId: kind,
        tool: kind === "draft" ? "compile_plan" : "get_run",
        success: true,
      },
    ],
    model: "isolated-test-model",
    elapsedMs: 2300,
    ...(kind === "draft"
      ? {
          draft: {
            status: "valid" as const,
            canExecute: false as const,
            catalogRevision: "fixture-catalog",
            environmentRevision: "fixture-environment",
            at: active().at,
            planHash: "a".repeat(64),
            reasons: [],
            preconditions: ["核验当前设备绑定与 UID；本次测试不连接游戏"],
            lanes: fixture.lanes!.lanes.map((lane) => ({
              laneId: lane.id,
              instance: lane.instance,
              games: [
                {
                  plan: {
                    gameId: "arknights",
                    skillIds: ["login", "mail", "fight"],
                    mode: "live" as const,
                  },
                  parameters: {
                    stage: "LS-6",
                    mail: true,
                    useMedicine: false,
                    useStone: false,
                  },
                  excluded: [],
                  notes: [],
                },
              ],
            })),
          },
        }
      : {}),
  };
}
function settle(kind: "draft" | "answer") {
  const turn = active();
  planner = {
    ...turn.planner,
    revision: planner.revision + 1,
    status: "completed",
    finishedAt: at(),
    result: reply(kind, turn.source),
  };
  turn.planner = structuredClone(planner);
  chat.revision++;
  selected().updatedAt = at();
}
function notify(event: RunEvent) {
  snapshot.events.push(event);
  snapshot.runs = reduceTaskRecords(snapshot.runs, event);
  window!.webContents.send("fixture:event", event);
}
function startSyntheticTask() {
  const lane = fixture.lanes!.lanes[0];
  const requestId = "ui-batch:lane-a";
  const startedAt = at();
  const plan = {
    gameId: "arknights",
    skillIds: ["login", "mail", "fight"],
    mode: "live" as const,
  };
  snapshot.executions.push({
    version: 1,
    id: requestId,
    source: "daily",
    resources: ["isolated-test"],
    fingerprint: "isolated",
    laneId: lane.id,
    batchId: "ui-batch",
    status: "running",
    startedAt,
    message: "测试：执行中",
    snapshot: { lane: structuredClone(lane), arknightsPlan: plan },
  });
  notify({
    runId: "ui-batch",
    type: "status",
    gameId: "arknights",
    laneId: lane.id,
    batchId: "ui-batch",
    executionId: requestId,
    executionSource: "daily",
    status: "running",
    startedAt,
    planKey: deviceLanePlanKey(lane),
    at: startedAt,
    message: "测试：执行中",
  });
  const base = {
    runId: "ui-run-ark",
    gameId: "arknights",
    laneId: lane.id,
    batchId: "ui-batch",
    executionId: requestId,
    at: startedAt,
  };
  notify({
    ...base,
    type: "status",
    status: "queued",
    plan,
    message: "测试任务入队",
  });
  notify({
    ...base,
    type: "status",
    status: "running",
    message: "测试任务执行中",
  });
  for (const skillId of ["login", "mail"])
    notify({
      ...base,
      type: "step",
      skillId,
      stepStatus: "succeeded",
      stepEvidence: "adapter-return",
      message: "测试任务流程结束",
    });
  notify({
    ...base,
    type: "step",
    skillId: "fight",
    stepStatus: "running",
    message: "测试正在作战",
  });
}
function failSyntheticTask() {
  const lane = fixture.lanes!.lanes[0],
    request = snapshot.executions[0];
  request.status = "unknown";
  request.finishedAt = at();
  request.message = "测试：作战结果无法确认";
  notify({
    runId: "ui-run-ark",
    type: "status",
    gameId: "arknights",
    laneId: lane.id,
    batchId: "ui-batch",
    executionId: request.id,
    status: "failed",
    at: at(),
    message: "测试：作战结果无法确认",
    resultUncertain: true,
  });
  notify({
    runId: "ui-batch",
    type: "status",
    gameId: "arknights",
    laneId: lane.id,
    batchId: "ui-batch",
    executionId: request.id,
    executionSource: "daily",
    status: "failed",
    startedAt: request.startedAt,
    planKey: deviceLanePlanKey(lane),
    at: at(),
    message: "测试：作战结果无法确认",
    resultUncertain: true,
  });
  execution = {
    ...execution,
    revision: execution.revision + 1,
    status: "unknown",
    message: "测试：结果待核对",
    lanes: execution.lanes.map((lane) => ({ ...lane, status: "unknown" })),
  };
}
const methods: Record<string, (...args: any[]) => unknown> = {
  snapshot: () => snapshot,
  deviceLanes: () => fixture.lanes,
  arknights: () => fixture.profiles,
  modelProvider: () => ({
    provider: "compatible",
    baseUrl: "https://invalid.test/v1",
    model: "isolated-test-model",
    revision: "fixture",
    hasApiKey: true,
    encryptionAvailable: true,
  }),
  automation: () => validateAutomation({}),
  plannerSnapshot: () => planner,
  chatSnapshot: () => chat,
  incidentAgentSnapshot: () => ({ sessions: [] }),
  agentExecutionSnapshot: () => execution,
  newChat: () => {
    const session: Session = {
      id: `chat-${chat.sessions.length + 1}`,
      title: "新会话",
      createdAt: at(),
      updatedAt: at(),
      turns: [],
    };
    chat.sessions.unshift(session);
    chat.selectedSessionId = session.id;
    chat.revision++;
    return chat;
  },
  selectChat: (id: string) => {
    assert.ok(chat.sessions.some((s) => s.id === id));
    chat.selectedSessionId = id;
    chat.revision++;
    return chat;
  },
  sendChat: async (input: {
    sessionId: string;
    prompt: string;
    source: string;
    at: string;
  }) => {
    assert.equal(input.sessionId, chat.selectedSessionId);
    assert.ok(
      !["running", "cancelling"].includes(planner.status),
      "duplicate submission rejected",
    );
    const turn: Turn = {
      id: `turn-${++nextTurn}`,
      prompt: input.prompt,
      source: input.source,
      at: input.at,
      createdAt: at(),
      planner: {
        revision: planner.revision + 1,
        status: "running",
        requestId: `ui-planner-${nextTurn}`,
        prompt: input.prompt,
        source: input.source as any,
        at: input.at,
        startedAt: at(),
        progress: { phase: "tool", tool: "get_environment" },
      },
    };
    selected().turns.push(turn);
    selected().title = input.prompt.slice(0, 26);
    planner = structuredClone(turn.planner);
    chat.revision++;
    await delay(350);
    if (!holdSend) settle("answer");
    return chat;
  },
  cancelChat: (input: { sessionId: string; turnId: string }) => {
    assert.equal(input.sessionId, selected().id);
    assert.equal(input.turnId, active().id);
    planner = {
      ...planner,
      revision: planner.revision + 1,
      status: "cancelled",
      finishedAt: at(),
    };
    active().planner = structuredClone(planner);
    chat.revision++;
    return chat;
  },
  cancelPlanner: (requestId: string) => {
    assert.equal(requestId, planner.requestId);
    planner = {
      ...planner,
      revision: planner.revision + 1,
      status: "cancelled",
      finishedAt: at(),
    };
    for (const session of chat.sessions)
      for (const turn of session.turns)
        if (turn.planner.requestId === requestId)
          turn.planner = structuredClone(planner);
    chat.revision++;
    return planner;
  },
  reviewAgentExecution: (input: { requestId: string; planHash: string }) => {
    assert.equal(input.requestId, planner.requestId);
    assert.equal(input.planHash, planner.result?.draft?.planHash);
    assert.notEqual(planner.source, "fixture");
    execution = {
      revision: execution.revision + 1,
      status: "ready",
      requestId: input.requestId,
      planHash: input.planHash,
      reviewId: "ui-review",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      message: "隔离测试执行条件已检查",
      lanes: fixture.lanes!.lanes.map((lane) => ({
        laneId: lane.id,
        name: lane.name,
        instance: lane.instance,
        profileName: "测试资料",
        skillIds: ["login", "mail", "fight"],
        parameters: { stage: "LS-6" },
      })),
    };
    return execution;
  },
  confirmAgentExecution: (input: {
    requestId: string;
    planHash: string;
    reviewId: string;
  }) => {
    assert.equal(input.requestId, execution.requestId);
    assert.equal(input.planHash, execution.planHash);
    assert.equal(input.reviewId, execution.reviewId);
    if (!execution.batchId) {
      launches++;
      execution = {
        ...execution,
        revision: execution.revision + 1,
        status: "running",
        batchId: "ui-batch",
        message: "测试替身正在执行；未操作真实游戏",
        lanes: execution.lanes.map((lane) => ({
          ...lane,
          executionId: `ui-batch:${lane.laneId}`,
          status: "running",
        })),
      };
    }
    return execution;
  },
  cancelAgentExecution: () =>
    (execution = {
      ...execution,
      revision: execution.revision + 1,
      status: "cancelled",
      message: "隔离测试已停止",
    }),
  executionProgress: (requestId: string) => ({
    version: 1,
    requestId,
    rootId: requestId,
    latestId: requestId,
    laneId: "lane-a",
    source: "daily",
    originalStatus: "unknown",
    outcome: "unconfirmed",
    wholePlanComplete: false,
    startedAt: at(),
    requests: [{ id: requestId, status: "unknown", startedAt: at() }],
    steps: [
      {
        gameId: "arknights",
        skillId: "login",
        status: "succeeded",
        sourceId: requestId,
        continued: false,
      },
      {
        gameId: "arknights",
        skillId: "mail",
        status: "succeeded",
        sourceId: requestId,
        continued: false,
      },
      {
        gameId: "arknights",
        skillId: "fight",
        status: "unknown",
        sourceId: requestId,
        continued: false,
      },
    ],
    counts: { total: 2, completed: 1, skipped: 0, excluded: 0, remaining: 1 },
    warnings: [],
  }),
  executionDetail: (requestId: string) => ({
    request: snapshot.executions.find((r) => r.id === requestId),
    games: [{ plan: snapshot.runs[0]?.plan, record: snapshot.runs[0] }],
    warnings: [],
  }),
  failureEvidence: () => [],
  previewContinuation: () => ({
    canContinue: false,
    reasons: ["隔离测试不启动续跑"],
    steps: [],
    defaultSelections: [],
  }),
  mumuInstances: () => [],
  detectMuMu: () => [],
  discover: () => [],
  startLanes: () =>
    new Promise<{ batchId: string }>((resolve) => {
      const lane = fixture.lanes!.lanes[0];
      notify({
        runId: "held-receipt-batch",
        type: "status",
        gameId: "arknights",
        laneId: lane.id,
        batchId: "held-receipt-batch",
        executionSource: "daily",
        status: "running",
        startedAt: at(),
        at: at(),
        planKey: deviceLanePlanKey(lane),
        message: "测试：启动回执正在等待",
      });
      releaseStart = () => {
        releaseStart = undefined;
        resolve({ batchId: "held-receipt-batch" });
      };
    }),
  stop: () => undefined,
  stopLane: () => undefined,
  stopLanes: () => undefined,
};
async function screenshot(name: string, width: number, height: number) {
  window!.setContentSize(width, height);
  await delay(250);
  const layout =
    await js(`({width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth,
    composer: (()=>{const el=document.querySelector('.chat-composer');const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};})()})`);
  check(
    `no page horizontal overflow at ${width}px`,
    layout.scrollWidth <= layout.width,
  );
  check(
    `composer fits viewport at ${width}px`,
    layout.composer.left >= 0 &&
      layout.composer.right <= width + 1 &&
      layout.composer.bottom <= height,
  );
  const capture = await Promise.race([
    window!.webContents.capturePage(),
    delay(8000).then(() => {
      throw new Error("Screenshot timeout");
    }),
  ]);
  await writeFile(join(directory, name), capture.toPNG());
  result.screenshots.push({ name, layout });
}
async function finish(code: number, error?: unknown) {
  if (error)
    result.error = error instanceof Error ? error.stack : String(error);
  result.calls = calls;
  result.launches = launches;
  result.forbiddenCalls = forbiddenCalls;
  result.finalChat = chat;
  result.finalExecution = execution;
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(result, null, 2),
  );
  window?.destroy();
  app.exit(code);
}
void app
  .whenReady()
  .then(async () => {
    // The preload's fixed method list cannot escape into production handlers.
    for (const method of [
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
    ])
      ipcMain.handle(`fixture:${method}`, (_event, ...args) => {
        if (
          ![
            "snapshot",
            "deviceLanes",
            "arknights",
            "modelProvider",
            "automation",
            "plannerSnapshot",
            "agentExecutionSnapshot",
            "incidentAgentSnapshot",
            "chatSnapshot",
            "executionProgress",
            "executionDetail",
            "failureEvidence",
          ].includes(method)
        )
          calls.push({ method, args });
        if (!methods[method]) {
          forbiddenCalls++;
          throw new Error(`Unexpected isolated operation: ${method}`);
        }
        return methods[method](...args);
      });
    window = new BrowserWindow({
      width: 1440,
      height: 960,
      show: false,
      webPreferences: {
        preload: join(directory, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadFile(join(directory, "index.html"));
    window.showInactive();
    await until(
      'document.querySelector("#chat-prompt") && document.querySelector("#chat-new")',
      "chat is default workspace",
    );
    check(
      "default view is chat with accessible composer",
      await js(
        'document.querySelector("section[aria-label=\\"Agent聊天工作台\\"]") && document.querySelector("label[for=chat-prompt]")',
      ),
    );
    check(
      "renderer has no Node require",
      await js('typeof require === "undefined"'),
    );
    check(
      "default account scope includes current records",
      await js(
        'document.querySelector("select[aria-label=\\"参考数据\\"]").value === "recorded"',
      ),
    );
    await screenshot("welcome-1440.png", 1440, 960);
    await screenshot("welcome-1000.png", 1000, 760);
    await click("sidebar-toggle");
    await until(
      'document.querySelector(".app-shell").className.includes("collapsed")',
      "sidebar collapse",
    );
    check(
      "collapsed sidebar retains composer and toggle",
      await js(
        'document.querySelector("#chat-prompt") && document.querySelector("#sidebar-toggle")',
      ),
    );
    await screenshot("collapsed-1000.png", 1000, 760);
    await click("sidebar-toggle");
    await typePrompt("为两个测试账号安排明日方舟日常，不用理智药。");
    await js(
      '{const b=document.getElementById("chat-send");b.click();b.click();true;}',
    );
    await typePrompt("下一条需求：检查信用商店剩余信用。", false);
    await until(
      'document.querySelector(".chat-thinking")',
      "real planning progress",
    );
    check(
      "double submit sends exactly one request",
      calls.filter((c) => c.method === "sendChat").length === 1,
    );
    check(
      "pending send keeps composer editable and preserves a typed followup",
      await js(
        '!document.getElementById("chat-prompt").disabled && document.getElementById("chat-prompt").value === "下一条需求：检查信用商店剩余信用。"',
      ),
    );
    check(
      "tool progress displayed without game execution",
      launches === 0 &&
        (await js('document.body.innerText.includes("读取账号与任务配置")')),
    );
    check(
      "active planning prevents another send",
      await js('!document.querySelector("#chat-send:not(:disabled)")'),
    );
    settle("draft");
    await until(
      'document.querySelector("#agent-execution-review:not(:disabled)")',
      "inline draft review",
    );
    check(
      "draft alone does not launch or auto-review",
      launches === 0 &&
        calls.filter((c) => c.method === "reviewAgentExecution").length === 0,
    );
    await click("agent-execution-review");
    await until(
      'document.querySelector("#agent-execution-consent")',
      "inline consent",
    );
    check(
      "execution requires unchecked explicit consent",
      await js(
        '!document.querySelector("#agent-execution-consent").checked && document.querySelector("#agent-execution-confirm").disabled',
      ),
    );
    await click("agent-execution-confirm");
    check("disabled confirm cannot launch", launches === 0);
    await click("agent-execution-consent");
    await until(
      'document.querySelector("#agent-execution-confirm:not(:disabled)")',
      "consented confirmation",
    );
    await js(
      '{const b=document.getElementById("agent-execution-confirm");b.click();b.click();true;}',
    );
    await until(
      'document.querySelector("#agent-execution-stop")',
      "submitted execution controls",
    );
    check(
      "review and confirmation share exact current request and hash",
      launches === 1 &&
        calls.filter((c) => c.method === "confirmAgentExecution").length ===
          1 &&
        execution.requestId === active().planner.requestId,
    );
    await js('document.querySelector(".chat-device-tasks").open=true');
    await until(
      'document.querySelector(".chat-lane-card")',
      "expanded independent device workspace",
    );
    startSyntheticTask();
    await until(
      'document.querySelector(".chat-lane-current").innerText.includes("正在执行") && document.querySelector(".chat-global-stop")',
      "running task progress and emergency stop",
    );
    check(
      "actual task lifecycle drives running progress and emergency stop",
      await js(
        'document.querySelector(".chat-lane-state[data-state=running]") && document.querySelector(".chat-global-stop").innerText.includes("停止全部")',
      ),
    );
    failSyntheticTask();
    await until(
      'document.querySelector(".chat-lane-state[data-state=unknown]")',
      "uncertain actual task outcome",
    );
    check(
      "failure renders unknown, not model-derived success",
      await js(
        'document.querySelector(".chat-lane-state[data-state=unknown]").innerText.includes("未知")',
      ),
    );
    await js(
      'document.querySelector(".chat-lane-card[data-lane-id=\\"lane-a\\"] .chat-lane-details > summary").click()',
    );
    await until(
      'document.querySelector(".execution-progress-outcome[data-outcome=unconfirmed]")',
      "expanded original-plan progress",
    );
    check(
      "expanded results retain unknown task and incomplete original plan",
      await js(
        'document.querySelector(".execution-progress-outcome[data-outcome=unconfirmed]").innerText.includes("核对") && document.querySelector(".task-steps li[data-state=unknown]")',
      ),
    );
    await screenshot("failure-detail-1440.png", 1440, 960);
    await js(
      'document.querySelector(".chat-lane-card[data-lane-id=\\"lane-a\\"] .chat-lane-details > summary").click()',
    );
    await click("chat-new");
    await until(
      'document.querySelectorAll(".chat-turn").length === 0',
      "new session empty transcript",
    );
    check(
      "new session retains previous transcript",
      chat.sessions.length === 2 &&
        chat.sessions.find((s) => s.id === "chat-1")!.turns.length === 1,
    );
    holdSend = false;
    await typePrompt("核对今天日常任务的实际执行情况，不重跑。");
    await click("chat-send");
    await until(
      'document.body.innerText.includes("模型回答：任务已完成")',
      "query answer in new session",
    );
    check(
      "optimistic model prose cannot mark uncertain game task complete",
      await js(
        'document.querySelector(".chat-lane-state[data-state=unknown]").innerText.includes("未知")',
      ),
    );
    await js(
      'document.querySelector("[data-chat-session-id=\\"chat-1\\"]").click()',
    );
    await until(
      'document.querySelector(".chat-turn[data-message-request-id=\\"ui-planner-1\\"]")',
      "previous session restored",
    );
    await until(
      '!document.querySelector("#agent-execution-review") && document.body.innerText.includes("历史或未通过当前检查")',
      "live request refresh removes historic authority",
    );
    check(
      "old draft loses execution control when live request changes",
      await js(
        '!document.querySelector("#agent-execution-review") && document.body.innerText.includes("历史或未通过当前检查")',
      ),
    );
    await click("chat-tools-toggle");
    await until(
      'document.querySelector("#chat-tools-menu").open',
      "tools opened",
    );
    await js(
      '[...document.querySelectorAll("#chat-tools-menu button")].find(el=>el.textContent.trim()==="设备与账号").click()',
    );
    await until(
      'document.body.innerText.includes("连接你的游戏设备")',
      "preserved device workspace",
    );
    await js(
      '[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="对话工作台").click()',
    );
    await until('document.querySelector("#chat-prompt")', "return to chat");
    await click("chat-new");
    await until(
      'document.querySelectorAll(".chat-turn").length === 0',
      "cancel test session",
    );
    holdSend = true;
    await typePrompt("只查询任务，不执行游戏。");
    await click("chat-send");
    await until(
      'document.querySelector("button[aria-label=\\"停止当前规划\\"]:not(:disabled)")',
      "planning cancel available",
    );
    await js(
      'document.querySelector("button[aria-label=\\"停止当前规划\\"]").click()',
    );
    await until(
      'document.body.innerText.includes("本轮模型请求已取消")',
      "planning cancelled",
    );
    check(
      "cancelling chat binds exact live planner request and historical turn",
      calls.filter((c) => c.method === "cancelPlanner").length === 1 &&
        active().planner.status === "cancelled" &&
        launches === 1,
    );
    await click("chat-new");
    await until(
      'document.querySelectorAll(".chat-turn").length === 0',
      "cross-session cancel source",
    );
    await typePrompt("查询测试设备，等待模型返回。");
    await click("chat-send");
    await until(
      'document.querySelector(".chat-thinking")',
      "cross-session active request",
    );
    const crossRequest = planner.requestId;
    await click("chat-new");
    await until(
      'document.querySelectorAll(".chat-turn").length === 0 && document.querySelector("button.chat-cancel[data-model-request-id]:not(:disabled)")',
      "global planning cancel across sessions",
    );
    await js(
      'document.querySelector("button.chat-cancel[data-model-request-id]").click()',
    );
    await until(
      'document.querySelector("#chat-send")',
      "cross-session planner cancelled",
    );
    check(
      "new session can cancel another session's active model request",
      calls.filter((c) => c.method === "cancelPlanner").length === 2 &&
        planner.requestId === crossRequest &&
        planner.status === "cancelled",
    );
    await typePrompt("查询进度，保持模型处理中。");
    await click("chat-send");
    await until(
      'document.querySelector(".chat-thinking")',
      "local stop while planner running",
    );
    const stopRequest = planner.requestId;
    await typePrompt("/stop", false);
    await js(
      'document.getElementById("chat-prompt").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))',
    );
    await until(
      'document.body.innerText.includes("停止指令已发送")',
      "local stop bypasses active model request",
    );
    check(
      "Enter /stop stops game and exact active planner even while send is disabled",
      calls.filter((c) => c.method === "stop").length === 1 &&
        calls.filter((c) => c.method === "cancelPlanner").length === 3 &&
        planner.requestId === stopRequest &&
        planner.status === "cancelled",
    );
    await until(
      'document.querySelector("#chat-send")',
      "local stop settles planner",
    );
    await click("chat-tools-toggle");
    await js(
      '[...document.querySelectorAll("#chat-tools-menu button")].find(el=>el.textContent.trim()==="运行已保存每日计划").click()',
    );
    await until(
      '[...document.querySelectorAll("button")].some(el=>el.textContent.trim()==="开始每日计划" && !el.disabled)',
      "preserved daily start control",
    );
    await clickText("开始每日计划");
    await until(
      'document.querySelector(".chat-global-stop:not(:disabled)")',
      "emergency stop during held start receipt",
    );
    await js('document.querySelector(".chat-global-stop").click()');
    for (
      let attempt = 0;
      attempt < 20 && calls.filter((c) => c.method === "stop").length < 2;
      attempt++
    )
      await delay(50);
    check(
      "global stop bypasses pending daily-start receipt",
      Boolean(releaseStart) &&
        calls.filter((c) => c.method === "startLanes").length === 1 &&
        calls.filter((c) => c.method === "stop").length === 2,
    );
    releaseStart!();
    const lane = fixture.lanes!.lanes[0];
    notify({
      runId: "held-receipt-batch",
      type: "status",
      gameId: "arknights",
      laneId: lane.id,
      batchId: "held-receipt-batch",
      executionSource: "daily",
      status: "cancelled",
      startedAt: at(),
      at: at(),
      planKey: deviceLanePlanKey(lane),
      message: "测试：已停止",
    });
    await js(
      '[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="对话工作台").click()',
    );
    await js(
      'document.querySelector("[data-chat-session-id=\\"chat-1\\"]").click()',
    );
    await until(
      'document.querySelector(".chat-turn[data-message-request-id=\\"ui-planner-1\\"]")',
      "history screenshot ready",
    );
    await screenshot("conversation-1440.png", 1440, 960);
    await screenshot("conversation-1000.png", 1000, 760);
    check(
      "only explicit approved fixture execution path was used",
      forbiddenCalls === 0 &&
        !calls.some((c) =>
          ["start", "startLane", "startContinuation", "startPlanner"].includes(
            c.method,
          ),
        ),
    );
    result.passed = true;
    await finish(0);
  })
  .catch((error) => finish(1, error));
