import { app, BrowserWindow, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createFixtureSnapshot } from "../../../packages/agent/fixture";
import { games } from "../../../games/registry";
import { validateAutomation } from "../../../packages/protocol";
import type {
  GoalRun,
  GoalStatus,
  GoalView,
} from "../../../packages/protocol/agent-goal";

const directory = __dirname;
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
const at = "2026-10-05T04:00:00.000Z";
const fixture = createFixtureSnapshot();
fixture.lanes!.lanes.forEach((lane) => {
  lane.enabled = false;
});
const calls: { method: string; args: unknown[] }[] = [];
const result = {
  scope:
    "Full production renderer App/Chat/GoalCards and CSS, sandboxed Electron and fixed synthetic IPC. This verifies desktop components, not production main admission, native game execution or a model.",
  checks: [] as string[],
  screenshots: [] as { name: string; width: number }[],
  accessibility: [] as unknown[],
  captureRetries: [] as unknown[],
  passed: false,
};
let window: BrowserWindow;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const js = async (source: string) => {
  try {
    return await window.webContents.executeJavaScript(source, true);
  } catch (error) {
    throw Error(
      `Renderer script failed: ${source.slice(0, 450)} (${String(error)})`,
    );
  }
};
function check(name: string, condition: unknown) {
  assert.ok(condition, name);
  result.checks.push(name);
}
async function until(source: string, label: string) {
  for (let i = 0; i < 80; i++) {
    if (await js(`Boolean(${source})`)) return;
    await delay(75);
  }
  throw Error(`Timeout: ${label}`);
}
const planner = {
  revision: 1,
  status: "completed",
  requestId: "planner-goal-a",
  source: "recorded",
  prompt: "给测试账号一领取邮件，不吃药；结果回到这轮对话。",
  startedAt: at,
  finishedAt: at,
  result: {
    status: "answer",
    source: "recorded",
    modelText: "已受理邮件目标，游戏仍在执行，等待实际账本。",
    execution: "not-started",
    canExecute: false,
    model: "isolated-fixture-model",
    elapsedMs: 20,
    trace: [],
  },
};
const chat = {
  revision: 1,
  selectedSessionId: "chat-a",
  sessions: [
    {
      id: "chat-a",
      title: "邮件目标与实际结果",
      createdAt: at,
      updatedAt: at,
      turns: [
        {
          id: "turn-goal",
          prompt: planner.prompt,
          source: "recorded",
          at,
          createdAt: at,
          planner,
        },
      ],
    },
    {
      id: "chat-b",
      title: "独立会话",
      createdAt: at,
      updatedAt: at,
      turns: [
        {
          id: "turn-goal",
          prompt: "独立会话的原消息",
          source: "recorded",
          at,
          createdAt: at,
          planner: {
            ...planner,
            requestId: "planner-goal-b",
            result: {
              ...planner.result,
              modelText: "独立会话仅显示自己的目标。",
            },
          },
        },
      ],
    },
  ],
};
function makeGoal(id: string, sessionId: string, prompt: string): GoalRun {
  const scope = {
    laneId: "lane-a",
    gameId: "arknights",
    skillIds: ["login", "award"],
    resources: { medicine: 0, stone: 0 },
  };
  const review = {
    id: "internal-review",
    fingerprint: "internal-fingerprint",
    reviewedAt: at,
    expiresAt: "2026-10-05T06:00:00.000Z",
    frozenPlan: { kind: "custom" as const, hash: "internal-hash" },
    scopes: [scope],
    summary: [
      {
        laneName: "测试账号一",
        games: [
          {
            gameId: "arknights",
            title: "明日方舟",
            steps: ["登录并核验原账号", "仅领取邮件奖励；理智药与源石为零"],
          },
        ],
      },
    ],
  };
  const submission = {
    batchId: `batch-${id}`,
    requestIds: [`batch-${id}:lane-a`],
    acceptedAt: at,
    state: "received" as const,
    attempt: 0,
  };
  return {
    version: 1,
    id,
    revision: 1,
    sessionId,
    turnId: "turn-goal",
    prompt,
    selection: {
      kind: "custom",
      planHash: "internal-hash",
      plannerRequestId: planner.requestId,
    },
    grant: {
      id: "internal-grant",
      source: "user-message",
      sessionId,
      turnId: "turn-goal",
      issuedAt: at,
      expiresAt: "2026-10-05T06:00:00.000Z",
      maxRetries: 2,
      scopes: [scope],
    },
    createdAt: at,
    updatedAt: at,
    status: "waiting",
    message: "隔离测试：执行器已受理，等待实际结果。",
    originalReview: review,
    review,
    submission,
    receipt: submission,
    attempts: [{ review, submission, receipt: submission }],
    retryCount: 0,
    requests: [],
    flowComplete: false,
    goalSatisfied: null,
  };
}
const goals: GoalView = {
  revision: 1,
  goals: [
    makeGoal("goal-a", "chat-a", planner.prompt),
    makeGoal("goal-b", "chat-b", "独立会话自己的游戏目标"),
  ],
};
let releaseInitialSnapshot: (() => void) | undefined;
let holdInitialSnapshot = true;
const goal = () => goals.goals[0];
const events = [
  {
    version: 1,
    seq: 1,
    at,
    requestId: planner.requestId,
    sessionId: "chat-a",
    kind: "model-finished",
    status: "succeeded",
    text: "模型回合已结束；游戏目标仍在执行，完成需实际结果核验。",
  },
  {
    version: 1,
    seq: 2,
    at,
    requestId: "goal-a",
    sessionId: "chat-a",
    kind: "game-step",
    status: "running",
    text: "隔离测试：原目标执行已受理，正在等待实际游戏结果。",
  },
];
function goalEvent(kind: string, status: string, text: string) {
  const event = {
    version: 1,
    seq: events.length + 1,
    at,
    requestId: "goal-a",
    sessionId: "chat-a",
    kind,
    status,
    text,
  };
  events.push(event);
  window.webContents.send("goal-fixture:agent", event);
}
function publish(status: GoalStatus, message: string) {
  const current = goal();
  current.status = status;
  current.message = message;
  current.revision++;
  goals.revision++;
  window.webContents.send("goal-fixture:goal", goals);
  goalEvent(
    status === "recovering" ? "recovery" : "game-result",
    status === "completed"
      ? "succeeded"
      : status === "recovering"
        ? "running"
        : status,
    message,
  );
}
const methods: Record<string, (...args: any[]) => unknown> = {
  snapshot: () => ({
    games,
    settings: { adbPath: "", address: "", modelEndpoint: "", modelName: "" },
    engine: { connected: false, version: "isolated-fixture" },
    events: [],
    runs: [],
    executions: [],
  }),
  deviceLanes: () => fixture.lanes,
  arknights: () => fixture.profiles,
  modelProvider: () => ({
    version: 1,
    provider: "compatible",
    baseUrl: "https://invalid.test/v1",
    model: "isolated-fixture-model",
    revision: "fixture",
    hasApiKey: true,
    encryptionAvailable: true,
  }),
  automation: () => validateAutomation({}),
  plannerSnapshot: () => planner,
  agentExecutionSnapshot: () => ({
    revision: 0,
    status: "idle",
    message: "",
    lanes: [],
  }),
  incidentAgentSnapshot: () => ({ sessions: [] }),
  chatSnapshot: () => chat,
  chatCommands: () => [],
  agentEvents: (input: { requestId: string }) => ({
    events: events.filter((e) => e.requestId === input.requestId),
    cursor: events.at(-1)!.seq,
    hasMore: false,
  }),
  goalSnapshot: async () => {
    if (holdInitialSnapshot)
      await new Promise<void>((resolve) => {
        releaseInitialSnapshot = resolve;
      });
    return goals;
  },
  selectChat: (id: string) => {
    assert.ok(chat.sessions.some((s) => s.id === id));
    chat.selectedSessionId = id;
    chat.revision++;
    return chat;
  },
  newChat: () => {
    throw Error("Unexpected operation: newChat");
  },
  quit: () => undefined,
  cancelGoal: async (input: { goalId: string; sessionId: string }) => {
    assert.deepEqual(input, { goalId: "goal-stop", sessionId: "chat-a" });
    await delay(180);
    const stopped = goals.goals.find((g) => g.id === input.goalId)!;
    stopped.cancelledAt = at;
    stopped.grant.revokedAt = at;
    stopped.revision++;
    stopped.status = "cancelled";
    stopped.message = "隔离测试：停止已核对，原目标未完成。";
    stopped.publicReply = {
      text: "隔离测试：宿主确认已停止，原目标未完成；模型未提供答复。",
      at,
    };
    goals.revision++;
    window.webContents.send("goal-fixture:goal", goals);
    return stopped;
  },
};
async function auditAccessibility(name: string) {
  if (!process.env.GAMEPILOT_UI_AXE) return;
  if (!(await js("typeof axe !== 'undefined' && axe.version === '4.10.3'")))
    await js(await readFile(process.env.GAMEPILOT_UI_AXE, "utf8"));
  const scan = await js(
    "axe.run(document, {resultTypes:['violations','incomplete']}).then(result=>({version:result.testEngine.version, violations:result.violations, incomplete:result.incomplete}))",
  );
  await writeFile(
    join(directory, `${name}.axe.json`),
    JSON.stringify(scan, null, 2),
  );
  const severe = scan.violations.filter((item: { impact: string }) =>
    ["critical", "serious"].includes(item.impact),
  );
  result.accessibility.push({
    name,
    version: scan.version,
    violations: scan.violations.length,
    severe: severe.map((item: { id: string }) => item.id),
    incomplete: scan.incomplete,
  });
  check(
    `${name}: no critical or serious accessibility violations`,
    severe.length === 0,
  );
}
async function captureFrame(name: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await window.webContents.capturePage();
    } catch (error) {
      if (!String(error).includes("UnknownVizError") || attempt === 2)
        throw error;
      result.captureRetries.push({
        name,
        attempt: attempt + 1,
        reason: "UnknownVizError",
      });
      await delay(120);
    }
  }
  throw Error(`Screenshot unavailable: ${name}`);
}
async function screenshot(
  name: string,
  width: number,
  height = 900,
  panelTop = false,
) {
  window.setContentSize(width, height);
  await delay(180);
  if (panelTop)
    await js(
      'document.querySelectorAll("#workspace-panel, #workspace-panel *").forEach(el=>{if(el.scrollHeight>el.clientHeight)el.scrollTop=0})',
    );
  else
    await js(
      '{const trace=document.querySelector("#chat-trajectory-panel:not([hidden]) [data-trajectory-goal-id=goal-a]"); const target=trace?.querySelector(".agent-event-timeline li:last-child") ?? document.querySelector(".chat-goal-card[data-goal-id=goal-stop]") ?? document.querySelector(".chat-goal-card");target?.scrollIntoView({block:trace?"end":"center"});}',
    );
  window.webContents.invalidate();
  await delay(120);
  const layout = await js(
    '({page:document.documentElement.scrollWidth<=innerWidth,cards:[...document.querySelectorAll(".chat-goal-card,[data-trajectory-goal-id]")].filter(el=>el.getClientRects().length).every(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&el.scrollWidth<=el.clientWidth+1}),width:innerWidth})',
  );
  check(
    `no horizontal overflow at ${width}px (${name})`,
    layout.page && layout.cards && layout.width === width,
  );
  await writeFile(join(directory, name), (await captureFrame(name)).toPNG());
  result.screenshots.push({ name, width });
  await auditAccessibility(name);
}
async function taskPanelScreenshots(status: string) {
  await js(
    'document.getElementById("workspace-tasks-tab").click();document.querySelectorAll(".session-task-history").forEach(el=>el.open=true);document.querySelectorAll(".chat-goal-card > .chat-record-details").forEach(el=>el.open=false)',
  );
  for (const theme of ["light", "dark"]) {
    await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    for (const width of [1280, 900])
      await screenshot(
        `tasks-${status}-${theme}-${width}.png`,
        width,
        width === 1280 ? 800 : 700,
        true,
      );
  }
  await js('document.documentElement.dataset.theme="light"');
}
async function finish(error?: unknown) {
  if (error)
    Object.assign(result, {
      error: error instanceof Error ? error.stack : String(error),
    });
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(
      { ...result, calls, finalGoals: goals, finalChat: chat },
      null,
      2,
    ),
  );
  window?.destroy();
  app.exit(error ? 1 : 0);
}
void app
  .whenReady()
  .then(async () => {
    for (const [method, action] of Object.entries(methods))
      ipcMain.handle(`goal-fixture:${method}`, (_event, ...args) => {
        calls.push({ method, args });
        return action(...args);
      });
    window = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: {
        preload: join(directory, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file:")) event.preventDefault();
    });
    await window.loadFile(join(directory, "index.html"));
    window.showInactive();
    await until(
      'document.querySelector("[data-chat-session-id=chat-a]")',
      "chat loaded while initial goal snapshot is held",
    );
    await js(
      'document.querySelector("[aria-controls=workspace-panel]").click()',
    );
    await until(
      'document.getElementById("workspace-tasks-tab")',
      "right workspace open",
    );
    await js('document.getElementById("workspace-tasks-tab").click()');
    await until(
      'document.querySelector("[data-task-loading=true]")',
      "pending host snapshot loading",
    );
    check(
      "pending existing host goal never displays empty task state",
      await js(
        'document.querySelector("[data-task-loading=true]").innerText.includes("正在读取宿主任务记录") && !document.querySelector("[data-task-empty]")',
      ),
    );
    holdInitialSnapshot = false;
    releaseInitialSnapshot?.();
    await until(
      'document.querySelector(".chat-goal-card[data-goal-id=goal-a]")',
      "GoalCard mounted in production conversation",
    );
    check(
      "renderer uses sandboxed preload without Node require",
      await js('typeof require === "undefined"'),
    );
    check(
      "Goal belongs to its original conversation turn",
      await js(
        'document.querySelector(".chat-goal-card").dataset.intentTurnId === "turn-goal" && document.querySelector("[data-goal-result-id=goal-a]").closest("[data-chat-turn-id]").dataset.chatTurnId === "turn-goal"',
      ),
    );
    check(
      "details are collapsed by default",
      await js('!document.querySelector(".chat-goal-card details").open'),
    );
    check(
      "waiting does not show verified completion",
      await js(
        'document.querySelector(".chat-goal-card").innerText.includes("游戏运行中") && !document.querySelector(".chat-goal-card").innerText.includes("目标已核验完成")',
      ),
    );
    check(
      "grant secrets are absent from visible content",
      await js(
        '!document.body.innerText.includes("internal-grant") && !document.body.innerText.includes("internal-fingerprint")',
      ),
    );
    await screenshot("waiting-1440.png", 1440);
    await screenshot("waiting-900.png", 900);
    await js('document.getElementById("chat-trajectory-tab").click()');
    await until(
      'document.querySelector(".chat-trajectory").innerText.includes("模型回合已结束")',
      "model-finished event",
    );
    check(
      "trajectory separates model finish from game completion",
      await js(
        'document.querySelector(".chat-trajectory").innerText.includes("游戏完成以执行回执为准") && document.querySelector(".chat-trajectory").innerText.includes("游戏目标仍在执行")',
      ),
    );
    await screenshot("trajectory-900.png", 900);
    await js('document.getElementById("workspace-tasks-tab").click()');
    goal().requests = [
      {
        requestId: goal().submission!.requestIds[0],
        laneId: "lane-a",
        gameId: "arknights",
        status: "failed",
        flowComplete: false,
        goalSatisfied: false,
        skills: [
          {
            skillId: "award",
            status: "failed",
            goalSatisfied: false,
            summary: "隔离测试：邮件核对失败",
            evidenceTimestamp: at,
            evidenceReference: "synthetic-ledger:mail-failure",
          },
        ],
      },
    ];
    goal().goalSatisfied = false;
    publish("failed", "隔离测试：目标未满足，原失败记录保留。");
    await until(
      'document.querySelector(".chat-goal-card").dataset.status === "failed"',
      "failed goal",
    );
    check(
      "failure remains distinct from completion",
      await js(
        'document.querySelector(".chat-goal-card").innerText.includes("目标未满足") && !document.querySelector(".chat-goal-card").innerText.includes("目标已核验完成")',
      ),
    );
    await js('document.querySelector("[data-chat-session-id=chat-b]").click()');
    await until(
      'document.querySelector(".chat-goal-card[data-goal-id=goal-b]")',
      "second session",
    );
    check(
      "same turn ID in another session does not leak original Goal",
      await js(
        '!document.querySelector(".chat-goal-card[data-goal-id=goal-a]") && document.querySelectorAll(".chat-goal-card").length === 1',
      ),
    );
    goal().requests[0].status = "unknown";
    goal().requests[0].goalSatisfied = null;
    goal().requests[0].skills[0] = {
      skillId: "award",
      status: "skipped",
      goalSatisfied: null,
      skipReason: "resource-budget-zero",
      summary: "隔离测试：资源上限为零，未尝试领取",
      evidenceTimestamp: at,
      evidenceReference: "synthetic-ledger:budget-zero",
    };
    goal().goalSatisfied = null;
    publish("unknown", "隔离测试：流程尚不能证明目标已满足。");
    await delay(120);
    check(
      "background original-session Goal push keeps second session isolated",
      await js(
        '!document.querySelector(".chat-goal-card[data-goal-id=goal-a]")',
      ),
    );
    await js('document.querySelector("[data-chat-session-id=chat-a]").click()');
    await until(
      'document.querySelector(".chat-goal-card[data-goal-id=goal-a][data-status=unknown]")',
      "original unknown goal",
    );
    await js(
      'document.querySelector(".chat-goal-card details summary").click()',
    );
    check(
      "unknown shows skip reason and actual evidence timestamp",
      await js(
        'document.querySelector(".chat-goal-card").innerText.includes("resource-budget-zero") && document.querySelector(".chat-goal-card").innerText.includes("观察时间：2026-10-05T04:00:00.000Z")',
      ),
    );
    await screenshot("unknown-details-1440.png", 1440);
    await screenshot("unknown-details-900.png", 900);
    await taskPanelScreenshots("unknown");
    check(
      "unknown matrix stays neutral and unconfirmed",
      await js(
        'document.querySelector("[data-goal-id=goal-a] [data-matrix-tone=unknown]").innerText.includes("? 未确认") && !document.querySelector("[data-goal-id=goal-a] [data-matrix-tone=verified]")',
      ),
    );
    publish("needs-user", "隔离测试：需要你核对原任务记录，结果仍未确认。");
    await until(
      'document.querySelector("[data-goal-id=goal-a][data-status=needs-user]")',
      "needs user goal",
    );
    await taskPanelScreenshots("needs-user");
    const beforeResume = calls.length;
    await js(
      '[...document.querySelectorAll("[data-goal-id=goal-a] button")].find(el=>el.textContent.includes("继续沟通这个目标")).click()',
    );
    await until(
      'document.querySelector("textarea").value.includes("继续目标 goal-a")',
      "resume prompt filled",
    );
    check(
      "resume only fills goal discussion text without execution",
      calls
        .slice(beforeResume)
        .every(
          (call) =>
            !["startGoal", "sendChat", "chatCommand"].includes(call.method),
        ),
    );
    await js('document.getElementById("workspace-tasks-tab").click()');
    goal().retryCount = 1;
    publish(
      "recovering",
      "隔离测试：原授权下核对受限恢复，已完成步骤保持不变。",
    );
    await until(
      'document.querySelector(".chat-goal-card").dataset.status === "recovering"',
      "recovery goal",
    );
    check(
      "recovery remains on original turn",
      await js(
        'document.querySelector(".chat-goal-card").dataset.intentTurnId === "turn-goal"',
      ),
    );
    await screenshot("recovering-900.png", 900);
    goal().requests[0].status = "succeeded";
    goal().requests[0].flowComplete = true;
    goal().requests[0].goalSatisfied = true;
    goal().requests[0].skills = [
      {
        skillId: "login",
        status: "succeeded",
        goalSatisfied: true,
        summary: "隔离测试：原账号登录门已核验",
        evidenceTimestamp: at,
        evidenceReference: "synthetic-ledger:verified-login",
      },
      {
        skillId: "award",
        status: "succeeded",
        goalSatisfied: true,
        summary: "隔离测试：实际账本已核验邮件奖励",
        evidenceTimestamp: at,
        evidenceReference: "synthetic-ledger:verified-mail",
      },
    ];
    goal().flowComplete = true;
    goal().goalSatisfied = true;
    goal().publicReply = {
      text: "隔离测试：原目标已按实际结果核验完成，没有使用理智药或源石。",
      at,
      model: "isolated-fixture-model",
    };
    publish("completed", "隔离测试：原范围已核验，公开答复回到原会话。");
    goalEvent("model-finished", "succeeded", goal().publicReply!.text);
    await until(
      'document.querySelector(".chat-goal-card").dataset.status === "completed"',
      "completed goal",
    );
    await js(
      'document.querySelector(".chat-goal-card[data-goal-id=goal-a] > .chat-record-details").open=true',
    );
    check(
      "completed displays separate public model reply",
      await js(
        'document.querySelector(".chat-goal-card").innerText.includes("目标已核验完成") && document.querySelector(".chat-goal-card .chat-model-explanation").innerText.includes("模型答复")',
      ),
    );
    check(
      "completed Goal has no stop button",
      await js(
        '![...document.querySelectorAll(".chat-goal-card button")].some(el=>el.textContent.includes("停止目标"))',
      ),
    );
    await screenshot("completed-1440.png", 1440);
    await screenshot("completed-900.png", 900);
    await taskPanelScreenshots("completed");
    await js('document.getElementById("chat-trajectory-tab").click()');
    await until(
      'document.querySelector("[data-trajectory-goal-id=goal-a]")?.innerText.includes("没有使用理智药或源石")',
      "same-turn Goal result model event",
    );
    check(
      "Goal recovery and game result events remain on the original turn",
      await js(
        'document.querySelector("[data-trajectory-goal-id=goal-a]").closest("[data-trajectory-turn-id]").dataset.trajectoryTurnId === "turn-goal" && document.querySelector("[data-trajectory-goal-id=goal-a]").innerText.includes("受限恢复") && document.querySelector("[data-trajectory-goal-id=goal-a]").innerText.includes("原范围已核验")',
      ),
    );
    check(
      "original Goal trajectory includes its public result model event",
      await js(
        'document.querySelector("[data-trajectory-goal-id=goal-a]").innerText.includes("原目标已按实际结果核验完成")',
      ),
    );
    check(
      "trajectory excludes the other session Goal",
      await js('!document.querySelector("[data-trajectory-goal-id=goal-b]")'),
    );
    await screenshot("goal-result-trajectory-1440.png", 1440);
    await screenshot("goal-result-trajectory-900.png", 900);
    await js('document.getElementById("workspace-tasks-tab").click()');
    // Stop a separate freshly authored turn, without reviving the cancelled original grant.
    const stoppedGoal = makeGoal(
      "goal-stop",
      "chat-a",
      "隔离测试：新回合的邮件目标，可独立停止。",
    );
    stoppedGoal.turnId = "turn-stop";
    stoppedGoal.grant.turnId = "turn-stop";
    stoppedGoal.status = "cancelling";
    goals.goals.push(stoppedGoal);
    goals.revision++;
    chat.sessions[0].turns.push({
      ...chat.sessions[0].turns[0],
      id: "turn-stop",
      prompt: stoppedGoal.prompt,
      planner: { ...planner, requestId: "planner-stop" },
    });
    chat.revision++;
    window.webContents.send("goal-fixture:chat", chat);
    window.webContents.send("goal-fixture:goal", goals);
    await until(
      'document.querySelector(".chat-goal-card[data-goal-id=goal-stop]")',
      "separate stop target",
    );
    await taskPanelScreenshots("cancelling");
    stoppedGoal.status = "waiting";
    stoppedGoal.revision++;
    goals.revision++;
    window.webContents.send("goal-fixture:goal", goals);
    await until(
      'document.querySelector("[data-goal-id=goal-stop][data-status=waiting]")',
      "stop target ready",
    );
    check(
      "new Goal details start collapsed",
      await js(
        '!document.querySelector(".chat-goal-card[data-goal-id=goal-stop] details").open',
      ),
    );
    await js(
      '{const b=[...document.querySelectorAll(".chat-goal-card[data-goal-id=goal-stop] button")].find(el=>el.textContent.trim()==="停止目标");b.scrollIntoView({block:"center"});b.focus();}',
    );
    check(
      "stop target is a keyboard focusable native button",
      await js(
        'document.activeElement.tagName === "BUTTON" && document.activeElement.textContent.includes("停止目标") && document.activeElement.tabIndex === 0',
      ),
    );
    window.focus();
    window.webContents.focus();
    await delay(75);
    await js(
      '[...document.querySelectorAll("[data-goal-id=goal-stop] .goal-panel-footer button")].find(el=>el.textContent.trim()==="停止目标").focus()',
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await until(
      'document.querySelector("[data-goal-id=goal-stop] .goal-panel-footer button.button").disabled',
      "keyboard Enter submits stop",
    );
    check(
      "keyboard Enter dispatches the original stop request",
      calls.filter((call) => call.method === "cancelGoal").length === 1,
    );
    await js(
      '{const b=[...document.querySelectorAll(".chat-goal-card[data-goal-id=goal-stop] button")].find(el=>el.textContent.includes("确认停止")||el.textContent.includes("停止目标"));b.click();b.click();}',
    );
    await until(
      'document.querySelector(".chat-goal-card[data-goal-id=goal-stop]").dataset.status === "cancelled"',
      "stop acknowledged",
    );
    const stops = calls.filter((c) => c.method === "cancelGoal");
    check(
      "keyboard Enter and repeated mouse clicks stop exactly once using original session and Goal IDs",
      stops.length === 1 &&
        JSON.stringify(stops[0].args[0]) ===
          JSON.stringify({ goalId: "goal-stop", sessionId: "chat-a" }),
    );
    check(
      "cancelled is distinct from goal completion",
      await js(
        'document.querySelector(".chat-goal-card[data-goal-id=goal-stop]").innerText.includes("目标已停止") && !document.querySelector(".chat-goal-card[data-goal-id=goal-stop]").innerText.includes("目标已核验完成")',
      ),
    );
    check(
      "stopping a new Goal preserves original verified completion",
      await js(
        'document.querySelector(".chat-goal-card[data-goal-id=goal-a]").dataset.status === "completed"',
      ),
    );
    await js(
      'document.querySelector(".chat-goal-card[data-goal-id=goal-stop] details").open=true',
    );
    check(
      "host fallback is attributed to the host rather than a model",
      await js(
        'document.querySelector(".chat-goal-card[data-goal-id=goal-stop] .chat-model-explanation").innerText.includes("宿主结果摘要") && !document.querySelector(".chat-goal-card[data-goal-id=goal-stop] .chat-model-explanation").innerText.includes("模型答复")',
      ),
    );
    await screenshot("cancelled-host-summary-1440.png", 1440);
    await screenshot("cancelled-host-summary-900.png", 900);
    check(
      "no synthetic UI operation dispatched a game or model",
      calls.every((c) => Object.hasOwn(methods, c.method)),
    );
    result.passed = true;
    await finish();
  })
  .catch(finish);
