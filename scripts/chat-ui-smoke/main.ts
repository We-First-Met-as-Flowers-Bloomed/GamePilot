import {
  defaultArknightsAutomation,
  validateArknightsAutomation,
} from "../../packages/protocol/arknights-automation";
import {
  defaultOnmyojiAutomation,
  validateOnmyojiAutomation,
} from "../../packages/protocol/onmyoji-automation";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createFixtureSnapshot } from "../../packages/agent/fixture";
import { games } from "../../games/registry";
import { migrateAccountChannels } from "../../apps/desktop/main/channel-migration";
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
import {
  createChatPerformanceFixture,
  performanceEventPage,
} from "./performance-fixture";

const directory = __dirname;
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
const fixture = createFixtureSnapshot();
const at = () => new Date().toISOString();
fixture.lanes!.lanes.forEach((lane, index) => {
  lane.name = `测试账号${index + 1}`;
  lane.onmyoji.enabled = true;
  lane.deviceInstances = { onmyoji: index + 2 };
});
fixture.lanes = migrateAccountChannels(fixture.lanes!);
let arkPlans = defaultArknightsAutomation(fixture.lanes.lanes);
let yysPlans = defaultOnmyojiAutomation(fixture.lanes.lanes);
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
const archives = new Map<string, Session>();
const legacyArchives = new Set<string>();
const managementArchiveId = `archive-${"c".repeat(64)}`;
let managementBusy = false;
let previewReady = false;
let previewHold = false;
let releasePreview: (() => void) | undefined;
let holdLaneHydration = true;
let releaseLaneHydration: (() => void) | undefined;
const laneHydrationReady = new Promise<void>((resolve) => {
  releaseLaneHydration = () => {
    holdLaneHydration = false;
    resolve();
  };
});
const previewImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=";
function archiveEntry(id: string, session: Session) {
  return {
    version: legacyArchives.has(id) ? 1 : 2,
    id,
    sessionId: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    archivedAt: session.updatedAt,
    turnCount: session.turns.length,
    sources: [...new Set(session.turns.map((turn) => turn.source))],
  };
}
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
let releaseSlotStart: (() => void) | undefined;
let snapshotReads = 0;
let deferNextSnapshot = false;
let releaseDeferredSnapshot: (() => void) | undefined;
const snapshotRaceChecks: { name: string; passed: boolean }[] = [];
let performanceFixture:
  ReturnType<typeof createChatPerformanceFixture> | undefined;
const performanceReplay = new Map<string, Set<number>>();
let performanceReplayPages = 0;
const result: Record<string, any> = {
  scope:
    "Production React App, production CSS and sandboxed Electron preload with synthetic IPC; no real device, engine, model or production storage writes.",
  checks: [],
  screenshots: [],
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const js = async (source: string) => {
  try {
    return await window!.webContents.executeJavaScript(source, true);
  } catch (error) {
    throw new Error(
      `Renderer script failed: ${source.slice(0, 500)} (${String(error)})`,
      { cause: error },
    );
  }
};
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  result.checks.push(name);
};
async function captureFrame(label: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await delay(120);
    try {
      return await window!.webContents.capturePage();
    } catch (error) {
      if (!String(error).includes("UnknownVizError") || attempt === 2)
        throw new Error(`Screenshot failed: ${label}`, { cause: error });
      result.captureRetries ??= [];
      result.captureRetries.push({
        label,
        attempt: attempt + 1,
        reason: "UnknownVizError",
      });
    }
  }
  throw new Error(`Screenshot unavailable: ${label}`);
}
async function auditAccessibility(name: string) {
  if (!process.env.GAMEPILOT_UI_AXE) return;
  if (!(await js("typeof axe !== 'undefined' && axe.version === '4.10.3'"))) {
    await js(await readFile(process.env.GAMEPILOT_UI_AXE, "utf8"));
  }
  const scan = await js(
    "axe.run(document, {resultTypes:['violations','incomplete']}).then(result=>({version:result.testEngine.version, violations:result.violations, incomplete:result.incomplete}))",
  );
  await writeFile(
    join(directory, `${name}.axe.json`),
    JSON.stringify(scan, null, 2),
  );
  const severe = scan.violations.filter(
    (item: { impact: string }) =>
      item.impact === "serious" || item.impact === "critical",
  );
  result.accessibility ??= [];
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
async function openAiWorkbench() {
  if (
    await js(
      'Boolean(document.querySelector("#chat-prompt")?.getClientRects().length)',
    )
  )
    return;
  await clickText("设置");
  await until(
    '[...document.querySelectorAll("main button")].some(button=>button.textContent.trim()==="打开AI辅助")',
    "explicit advanced AI entry",
  );
  await js(`{
    const button=[...document.querySelectorAll('main button')].find(item=>item.textContent.trim()==='打开AI辅助');
    for(let parent=button?.parentElement;parent;parent=parent.parentElement) {
      if(parent instanceof HTMLDetailsElement) parent.open=true;
    }
  }`);
  await until(
    '[...document.querySelectorAll("main button")].some(button=>button.textContent.trim()==="打开AI辅助"&&button.getClientRects().length>0)',
    "advanced AI button is visibly expanded",
  );
  await clickText("打开AI辅助");
  await until(
    'document.querySelector("#chat-prompt")?.getClientRects().length>0 && document.querySelector("#chat-new")',
    "explicit AI workspace is visible",
  );
}
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
            lanes: fixture
              .lanes!.lanes.filter((lane) => lane.arknights.enabled)
              .map((lane) => ({
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
    request = snapshot.executions.find(
      (request) => request.id === "ui-batch:lane-a",
    )!;
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
async function managementSmoke() {
  const originalId = chat.selectedSessionId;
  const modelCallsBefore = calls.filter(
    (call) => call.method === "sendChat",
  ).length;
  const launchesBefore = launches;
  const session: Session = {
    id: "management-session",
    title: "会话整理夹具",
    createdAt: at(),
    updatedAt: at(),
    turns: Array.from({ length: 10 }, (_, index) => ({
      id: `management-turn-${index}`,
      prompt: `归档原文第${index + 1}轮`,
      source: "recorded",
      at: at(),
      createdAt: at(),
      planner: {
        revision: 1,
        status: "completed" as const,
        result: { ...reply("answer"), modelText: `只读回答第${index + 1}轮` },
      },
    })),
  };
  for (let index = 0; index < 9; index++) {
    const archiveId =
      index % 2 ? `catalog-${index}` : `archive-catalog-${index}`;
    if (index % 2) legacyArchives.add(archiveId);
    archives.set(archiveId, {
      ...structuredClone(session),
      id: `catalog-${index}`,
      title: `历史归档${index}`,
      turns: session.turns.slice(0, 1),
    });
  }
  chat.sessions.unshift(session);
  chat.selectedSessionId = session.id;
  chat.revision++;
  await until(
    'document.querySelector("[data-chat-session-id=management-session]")',
    "management session published",
  );
  const openMenu = async () => {
    // New session hydration scrolls history and transcript. The real menu
    // deliberately closes on scroll, so open it only after those effects settle.
    await delay(150);
    await js(
      'document.querySelector("[data-chat-session-id=management-session]").closest(".chat-session-row").querySelector(".session-menu-trigger").click()',
    );
    await until(
      'document.querySelector(".chat-session-menu")',
      "session menu open",
    );
  };
  const menuAction = (text: string) =>
    js(
      `{const menu=document.querySelector('.chat-session-menu');[...menu.querySelectorAll('[role=menuitem]')].find(button=>button.textContent.trim()===${JSON.stringify(text)}).click();}`,
    );
  await typePrompt("管理对话期间保留的草稿", false);
  await openMenu();
  check(
    "all session menu actions remain visible outside the scrollable history list",
    await js(
      '(()=>{const item=document.querySelector(".chat-session-menu [role=menuitem]:last-of-type");const rect=item.getBoundingClientRect();const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);return hit===item || item.contains(hit);})()',
    ),
  );
  await auditAccessibility("session-management-menu");
  await js(
    'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))',
  );
  check(
    "session menu keyboard End focuses deletion without acting",
    (await js('document.activeElement.textContent.trim()==="删除当前对话"')) &&
      calls.filter((call) => call.method === "deleteChat").length === 0,
  );
  await js(
    'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))',
  );
  check(
    "session menu Escape returns focus to its visible trigger",
    await js(
      'document.activeElement.matches(".session-menu-trigger") && document.activeElement.getClientRects().length>0 && !document.querySelector(".chat-session-menu")',
    ),
  );
  await openMenu();
  await menuAction("删除当前对话");
  await until(
    'document.querySelector(".chat-delete-dialog").open',
    "delete confirmation open",
  );
  check(
    "delete confirmation describes archived copy and task retention with safe default focus",
    await js(
      'document.querySelector(".chat-delete-dialog").textContent.includes("删除当前对话，已归档副本和任务记录会保留") && document.activeElement.hasAttribute("data-delete-cancel")',
    ),
  );
  await auditAccessibility("session-delete-confirmation");
  await js(
    'document.querySelector(".chat-delete-dialog [data-delete-cancel]").click()',
  );
  check(
    "cancelling deletion leaves original conversation and draft",
    chat.sessions.includes(session) &&
      calls.filter((call) => call.method === "deleteChat").length === 0 &&
      (await js(
        'document.getElementById("chat-prompt").value==="管理对话期间保留的草稿"',
      )),
  );
  managementBusy = true;
  await openMenu();
  await menuAction("删除当前对话");
  await click("chat-delete-confirm");
  await until(
    'document.querySelector(".chat-delete-dialog [role=alert]")?.textContent.includes("活动任务")',
    "busy delete rejected",
  );
  check(
    "host busy rejection preserves current session and keeps confirmation reviewable",
    chat.sessions.includes(session) &&
      (await js('document.querySelector(".chat-delete-dialog").open')),
  );
  await js(
    'document.querySelector(".chat-delete-dialog [data-delete-cancel]").click()',
  );
  await openMenu();
  await menuAction("归档对话");
  await until(
    'document.body.textContent.includes("暂不能归档")',
    "busy archive rejected",
  );
  check(
    "host busy rejection preserves session without archiving",
    chat.sessions.includes(session) && !archives.has(managementArchiveId),
  );
  managementBusy = false;
  await openMenu();
  await menuAction("归档对话");
  await until(
    '!document.querySelector("[data-chat-session-id=management-session]")',
    "session archived from sidebar",
  );
  check(
    "archive returns keyboard focus to a visible sidebar control",
    await js(
      'document.activeElement!==document.body && document.activeElement.getClientRects().length>0 && !document.activeElement.closest("[hidden], [inert]")',
    ),
  );
  await click("chat-archives-open");
  await until(
    'document.querySelector(".chat-archives-dialog .chat-archive-list button")',
    "discoverable archive browser",
  );
  await js(
    'document.querySelector(".chat-archives-dialog .chat-archive-list button").click()',
  );
  await until(
    'document.querySelectorAll(".chat-archives-dialog .chat-archive-turn").length===8',
    "first transcript page",
  );
  await clickText("继续读取归档对话");
  await until(
    'document.querySelectorAll(".chat-archives-dialog .chat-archive-turn").length===10',
    "second transcript page",
  );
  check(
    "sidebar archive browser pages complete original text with no executable transcript controls",
    await js(
      'document.querySelector(".chat-archives-dialog .chat-archive-transcript").textContent.includes("归档原文第10轮") && !document.querySelector(".chat-archives-dialog .chat-archive-transcript button")',
    ),
  );
  await js(
    '[...document.querySelectorAll(".chat-archives-dialog button")].find(button=>button.textContent.trim()==="更多归档会话").click()',
  );
  await until(
    'document.querySelectorAll(".chat-archives-dialog .chat-archive-list button").length===10',
    "archive catalog pagination",
  );
  await screenshot("sidebar-archives-1280.png", 1280, 800);
  await auditAccessibility("sidebar-archive-browser");
  check(
    "archive browser reads mixed v2 and legacy catalog entries",
    calls.some(
      (call) =>
        call.method === "loadArchivedChat" &&
        (call.args[0] as any).archiveId === managementArchiveId,
    ) && legacyArchives.has("catalog-7"),
  );
  await clickText("恢复到对话列表");
  await until(
    '!document.querySelector(".chat-archives-dialog").open && document.querySelector("[data-chat-session-id=management-session]")',
    "original archived session restored",
  );
  check(
    "restore keeps original conversation and turn IDs and prior archive",
    selected().id === session.id &&
      selected()
        .turns.map((turn) => turn.id)
        .join() === session.turns.map((turn) => turn.id).join() &&
      archives.has(managementArchiveId),
  );
  await click("chat-archives-open");
  await until(
    'document.querySelector(".chat-archives-dialog .chat-archive-list button")',
    "archive catalog refreshed",
  );
  check(
    "restored active session is excluded from archive catalog",
    !(await js(
      'document.querySelector(".chat-archives-dialog .chat-archive-list").textContent.includes("会话整理夹具")',
    )),
  );
  await js(
    '[...document.querySelectorAll(".chat-archives-dialog .chat-archive-list button")].find(button=>button.textContent.includes("历史归档7")).click()',
  );
  await until(
    'document.querySelector(".chat-archives-dialog .chat-archive-transcript header strong")?.textContent==="历史归档7"',
    "legacy archive transcript read",
  );
  check(
    "legacy archive read retains original prompt and stays readonly",
    (await js(
      'document.querySelector(".chat-archives-dialog .chat-archive-transcript").textContent.includes("归档原文第1轮") && !document.querySelector(".chat-archives-dialog .chat-archive-transcript button")',
    )) &&
      calls.filter((call) => call.method === "loadArchivedChat").at(-1)
        ?.args[0] &&
      (
        calls.filter((call) => call.method === "loadArchivedChat").at(-1)!
          .args[0] as any
      ).archiveId === "catalog-7",
  );
  await clickText("恢复到对话列表");
  await until(
    '!document.querySelector(".chat-archives-dialog").open && document.querySelector("[data-chat-session-id=catalog-7]")',
    "legacy archive restored with original session ID",
  );
  check(
    "legacy restore selects original session and preserves archive copy",
    selected().id === "catalog-7" &&
      selected().turns[0].id === "management-turn-0" &&
      archives.has("catalog-7") &&
      (
        calls.filter((call) => call.method === "restoreArchivedChat").at(-1)!
          .args[0] as any
      ).archiveId === "catalog-7",
  );
  chat.sessions = chat.sessions.filter((item) => item.id !== "catalog-7");
  chat.selectedSessionId = session.id;
  chat.revision++;
  await until(
    'document.querySelector("[data-chat-session-id=management-session]").classList.contains("selected")',
    "v2 restored session reselected",
  );
  const requestsBefore = structuredClone(snapshot.executions),
    tasksBefore = structuredClone(snapshot.runs),
    eventsBefore = structuredClone(snapshot.events);
  await openMenu();
  await menuAction("删除当前对话");
  await click("chat-delete-confirm");
  await until(
    '!document.querySelector(".chat-delete-dialog").open && !document.querySelector("[data-chat-session-id=management-session]")',
    "explicit conversation deletion",
  );
  check(
    "confirmed deletion sends exact host confirmation and retains archived copy and ledgers",
    calls.filter((call) => call.method === "deleteChat").at(-1)?.args[0] &&
      JSON.stringify(
        calls.filter((call) => call.method === "deleteChat").at(-1)!.args[0],
      ) ===
        JSON.stringify({
          sessionId: session.id,
          confirmation: "delete-chat",
        }) &&
      archives.has(managementArchiveId) &&
      JSON.stringify(snapshot.executions) === JSON.stringify(requestsBefore) &&
      JSON.stringify(snapshot.runs) === JSON.stringify(tasksBefore) &&
      JSON.stringify(snapshot.events) === JSON.stringify(eventsBefore),
  );
  check(
    "deleted-row focus moves to an existing visible control",
    await js(
      "document.activeElement!==document.body && document.activeElement.isConnected && document.activeElement.getClientRects().length>0",
    ),
  );
  chat.selectedSessionId = originalId;
  chat.revision++;
  await until(
    `document.querySelector('[data-chat-session-id="${originalId}"]').classList.contains('selected')`,
    "original smoke conversation restored",
  );
  await typePrompt("", false);
  check(
    "archive restore and deletion never invoke models or launch game tasks",
    calls.filter((call) => call.method === "sendChat").length ===
      modelCallsBefore && launches === launchesBefore,
  );
}

async function previewSmoke() {
  const [laneA, laneB] = fixture.lanes!.lanes.filter(
    (lane) => lane.arknights.enabled,
  );
  previewReady = true;
  await js(
    'document.querySelector("button[aria-label=\\"打开设备预览\\"]").click()',
  );
  await click("workspace-device-tab");
  await until(
    'document.querySelector(".device-screen img")',
    "running account device frame",
  );
  check(
    "active account preview connects while global manual engine is disconnected",
    snapshot.engine.connected === false &&
      (await js(
        `document.querySelector('.device-screen').dataset.previewLaneId===${JSON.stringify(laneA.id)} && document.querySelector('[data-preview-status]').dataset.previewStatus==='connected' && document.querySelector('.device-screen img').alt.includes('测试账号1')`,
      )),
  );
  await screenshot("running-account-preview-1280.png", 1280, 800);
  await auditAccessibility("running-account-preview");
  previewHold = true;
  for (let index = 0; index < 30 && !releasePreview; index++) await delay(100);
  assert.ok(releasePreview, "pending preview held");
  await js(
    `{const select=document.querySelector('select[aria-label="预览账号"]');select.value=${JSON.stringify(laneB.id)};select.dispatchEvent(new Event('change',{bubbles:true}));}`,
  );
  await until(
    'document.querySelector(".device-screen img")?.alt.includes("测试账号2")',
    "account switched to second frame",
  );
  releasePreview();
  releasePreview = undefined;
  await delay(100);
  check(
    "late first-account frame never overwrites the switched account",
    await js(
      'document.querySelector(".device-screen img").alt.includes("测试账号2")',
    ),
  );
  await js(
    'Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"))',
  );
  await until(
    '!document.querySelector(".device-screen img")',
    "hidden document clears frame",
  );
  const hiddenCaptures = calls.filter(
    (call) => call.method === "captureLanePreview",
  ).length;
  await delay(1200);
  check(
    "hidden document suspends account capture and clears old image",
    hiddenCaptures ===
      calls.filter((call) => call.method === "captureLanePreview").length,
  );
  await js(
    'delete document.hidden;document.dispatchEvent(new Event("visibilitychange"))',
  );
  await until(
    'document.querySelector(".device-screen img")?.alt.includes("测试账号2")',
    "visible document refreshes account",
  );
  await js(
    `{const select=document.querySelector('select[aria-label="预览账号"]');select.value=${JSON.stringify(laneA.id)};select.dispatchEvent(new Event('change',{bubbles:true}));}`,
  );
  await until(
    'document.querySelector(".device-screen img")?.alt.includes("测试账号1")',
    "account first frame refreshed",
  );
  previewHold = true;
  for (let index = 0; index < 30 && !releasePreview; index++) await delay(100);
  assert.ok(releasePreview, "pending preview held before panel hide");
  await js(
    'document.querySelector("button[aria-label=\\"关闭右侧工作面板\\"]").click()',
  );
  releasePreview();
  releasePreview = undefined;
  const closedCaptures = calls.filter(
    (call) => call.method === "captureLanePreview",
  ).length;
  await delay(1200);
  check(
    "closing preview disposes pending frame and stops refresh",
    closedCaptures ===
      calls.filter((call) => call.method === "captureLanePreview").length &&
      (await js('!document.querySelector(".device-screen img")')),
  );
  previewReady = false;
  await js(
    'document.querySelector("button[aria-label=\\"打开设备预览\\"]").click()',
  );
  await until(
    'document.querySelector("[data-preview-status=unavailable]")',
    "unavailable account remains truthful",
  );
  check(
    "running task text does not mark an unavailable account as connected",
    await js(
      '!document.querySelector(".device-screen img") && document.querySelector("[data-preview-status]").textContent.includes("暂不可用")',
    ),
  );
  await js(
    'document.querySelector("button[aria-label=\\"关闭右侧工作面板\\"]").click()',
  );
}
async function previewHydrationSmoke() {
  assert.ok(releaseLaneHydration, "initial account hydration held");
  await js(
    'document.querySelector("button[aria-label=\\"打开设备预览\\"]").click()',
  );
  await click("workspace-device-tab");
  await until(
    'document.querySelector("select[aria-label=\\"预览账号\\"]")?.value==="manual"',
    "preview mounted before accounts hydrate",
  );
  const readsBefore = snapshotReads;
  const initialRace = queueScopedFixture(
    { laneId: fixture.lanes!.lanes[0].id, gameId: "arknights" },
    "initial-hydration-race",
  );
  for (let index = 0; index < 30 && snapshotReads === readsBefore; index++)
    await delay(50);
  assert.ok(
    snapshotReads > readsBefore,
    "queued receipt requests a newer snapshot before account hydration",
  );
  // Let the newer IPC response reach the renderer while the old initial
  // snapshot is still waiting in Promise.all for deviceLanes.
  await delay(150);
  releaseLaneHydration();
  releaseLaneHydration = undefined;
  await until(
    `document.querySelector('select[aria-label="预览账号"]')?.value===${JSON.stringify(fixture.lanes!.lanes[0].id)}`,
    "hydrated enabled account becomes preview target without reopening",
  );
  check(
    "mounted preview derives account target when initial configuration hydrates",
    await js(
      `document.querySelector('.device-screen').dataset.previewLaneId===${JSON.stringify(fixture.lanes!.lanes[0].id)}`,
    ),
  );
  await click("workspace-tasks-tab");
  await js(
    'document.querySelector("button[aria-label=\\"关闭右侧工作面板\\"]").click()',
  );
  await clickText("槽位总览");
  snapshotRaceChecks.push({
    name: "new exact game receipt survives stale initial snapshot after delayed account hydration",
    passed: await js(
      `Boolean(document.querySelector('.slots-dashboard [data-slot-id="${initialRace.laneId}:arknights"] button[aria-label^="停止槽位 "]:not(:disabled)'))`,
    ),
  });
  methods.stopGameSlot({ laneId: initialRace.laneId, gameId: "arknights" });
  await until(
    `document.querySelector('.slots-dashboard [data-slot-id="${initialRace.laneId}:arknights"]')?.textContent.includes('已停止')`,
    "initial hydration fixture released without a real start",
  );
}
async function slotHomeSmoke() {
  await clickText("槽位总览");
  await until(
    `document.querySelectorAll('.slots-dashboard [data-slot-id]').length===${fixture.lanes!.lanes.length}`,
    "saved slot cards hydrate",
  );
  const cards = await js(`
    [...document.querySelectorAll('.slots-dashboard [data-slot-id]')].map(card=>{
      const games=[...card.querySelectorAll('[data-game-id]')];
      const game=games[0];
      return {id:card.dataset.slotId,laneId:card.dataset.slotLaneId,gameId:card.dataset.slotGameId,gameCount:games.length,text:card.textContent,identity:card.querySelector('h3')?.textContent+' '+game?.textContent,instance:game?.dataset.deviceInstance,profileId:game?.dataset.profileId};
    })
  `);
  check(
    "slot home presents four independent single-game channels on four physical instances",
    cards.length === 4 &&
      new Set(cards.map((card: any) => card.id)).size === 4 &&
      new Set(cards.map((card: any) => card.instance)).size === 4 &&
      fixture.lanes!.lanes.every((lane) => {
        const gameId = lane.arknights.enabled ? "arknights" : "onmyoji";
        const card = cards.find(
          (item: any) => item.id === lane.id + ":" + gameId,
        );
        const profile = fixture.profiles!.profiles.find(
          (item) => item.id === lane.arknights.profileId,
        );
        return (
          card &&
          card.gameId === gameId &&
          card.gameCount === 1 &&
          card.instance === String(lane.instance) &&
          card.text.includes(lane.name) &&
          (gameId !== "arknights" ||
            (card.profileId === lane.arknights.profileId &&
              card.text.includes(profile!.name))) &&
          (gameId !== "onmyoji" || !card.identity.includes("B服")) &&
          !card.text.includes("共享实例")
        );
      }),
  );
  check(
    "sidebar uses the same four account-channel count",
    await js(
      'document.querySelector(".sidebar-runtime").textContent.includes("4 个账号渠道")',
    ),
  );
  check(
    "ordinary slot navigation hides the chat composer and session creation controls",
    await js(
      '!document.querySelector("#chat-prompt")?.getClientRects().length && !document.querySelector("#chat-new")?.getClientRects().length && !document.querySelector(".chat-history")?.getClientRects().length',
    ),
  );
  check(
    "opening the slot home and advanced helper does not create sessions, call a model or start games",
    calls.filter((call) =>
      [
        "newChat",
        "sendChat",
        "start",
        "startLane",
        "startGameSlot",
        "startLanes",
        "startPlanner",
        "confirmAgentExecution",
      ].includes(call.method),
    ).length === 0 && launches === 0,
  );
  for (const [width, height] of [
    [1280, 900],
    [900, 760],
    [1600, 1000],
  ]) {
    window!.setContentSize(width, height);
    await delay(250);
    const layout = await js(`({
      width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,
      cards:[...document.querySelectorAll('.slots-dashboard [data-slot-lane-id]')].map(card=>{
        const rect=card.getBoundingClientRect();return {left:rect.left,right:rect.right,width:rect.width};
      })
    })`);
    check(
      `slot dashboard and visible card widths fit the ${width}px window`,
      layout.scrollWidth <= width &&
        layout.cards.every(
          (card: any) =>
            card.width > 0 && card.left >= 0 && card.right <= width + 1,
        ),
    );
    const name = `slots-default-${width}.png`;
    await writeFile(join(directory, name), (await captureFrame(name)).toPNG());
    result.screenshots.push({ name, layout });
    await auditAccessibility(name);
  }
  await openAiWorkbench();
}
async function scopedSlotControlSmoke() {
  await clickText("槽位总览");
  const legacyBefore = calls.filter((call) =>
    ["startLane", "startLanes", "stopLane", "stopLanes"].includes(call.method),
  ).length;
  for (const lane of fixture.lanes!.lanes) {
    for (const gameId of (["arknights", "onmyoji"] as const).filter(
      (game) => lane[game].enabled,
    )) {
      const selector = `.slots-dashboard [data-slot-id="${lane.id}:${gameId}"]`;
      await until(
        `document.querySelector('${selector} button[aria-label^="运行槽位 "]:not(:disabled)')`,
        `single-game start ready for ${lane.id}:${gameId}`,
      );
      await js(
        `document.querySelector('${selector} button[aria-label^="运行槽位 "]').click()`,
      );
      await until(
        `document.querySelector('${selector} button[aria-label^="停止槽位 "]:not(:disabled)')`,
        `owned single-game stop ready during held receipt for ${lane.id}:${gameId}`,
      );
      const start = calls
        .filter((call) => call.method === "startGameSlot")
        .at(-1);
      check(
        `slot ${lane.id}:${gameId} sends only its original lane and selected game`,
        Boolean(releaseSlotStart) &&
          start?.args[0] &&
          (start.args[0] as any).laneId === lane.id &&
          (start.args[0] as any).gameId === gameId,
      );
      await js(
        `document.querySelector('${selector} button[aria-label^="停止槽位 "]').click()`,
      );
      await until(
        `document.querySelector('${selector}')?.textContent.includes('已停止')`,
        `single-game stop completes without waiting for the held start receipt for ${lane.id}:${gameId}`,
      );
      const stop = calls
        .filter((call) => call.method === "stopGameSlot")
        .at(-1);
      check(
        `slot ${lane.id}:${gameId} stops the same game without a lane-wide stop`,
        (stop?.args[0] as any)?.laneId === lane.id &&
          (stop?.args[0] as any)?.gameId === gameId &&
          calls.filter((call) =>
            ["startLane", "startLanes", "stopLane", "stopLanes"].includes(
              call.method,
            ),
          ).length === legacyBefore,
      );
      releaseSlotStart!();
      await until(
        `document.querySelector('${selector} button[aria-label^="运行槽位 "]:not(:disabled)')`,
        `single-game start receipt releases for ${lane.id}:${gameId}`,
      );
    }
  }
  const first = fixture.lanes!.lanes[0],
    second = fixture.lanes!.lanes[1];
  const firstSelector = `.slots-dashboard [data-slot-id="${first.id}:arknights"]`;
  await js(
    `document.querySelector('${firstSelector} button[aria-label^="运行槽位 "]').click()`,
  );
  await until(
    `document.querySelector('${firstSelector} button[aria-label^="停止槽位 "]:not(:disabled)')`,
    "refresh race first slot active",
  );
  deferNextSnapshot = true;
  releaseSlotStart!();
  for (let index = 0; index < 30 && !releaseDeferredSnapshot; index++)
    await delay(50);
  assert.ok(
    releaseDeferredSnapshot,
    "start receipt refresh captured and deferred an older snapshot",
  );
  queueScopedFixture(
    { laneId: second.id, gameId: "onmyoji" },
    "newer-status-refresh-race",
  );
  const secondSelector = `.slots-dashboard [data-slot-id="${second.id}:onmyoji"]`;
  await until(
    `document.querySelector('${secondSelector} button[aria-label^="停止槽位 "]:not(:disabled)')`,
    "newer queued snapshot reveals second game stop",
  );
  releaseDeferredSnapshot();
  await delay(150);
  snapshotRaceChecks.push({
    name: "late start-receipt refresh cannot erase a newer game receipt or its stop control",
    passed: await js(
      `Boolean(document.querySelector('${secondSelector} button[aria-label^="停止槽位 "]:not(:disabled)'))`,
    ),
  });
  methods.stopGameSlot({ laneId: first.id, gameId: "arknights" });
  methods.stopGameSlot({ laneId: second.id, gameId: "onmyoji" });
  await until(
    `document.querySelector('${secondSelector}')?.textContent.includes('已停止')`,
    "snapshot refresh fixtures released",
  );
}
function queueScopedFixture(
  target: {
    laneId: string;
    gameId: "arknights" | "onmyoji";
    requestId?: string;
  },
  batchId: string,
) {
  const lane = fixture.lanes!.lanes.find((lane) => lane.id === target.laneId)!;
  const startedAt = at();
  const plan = {
    gameId: target.gameId,
    mode: "live" as const,
    skillIds: ["login"],
  };
  const request = {
    version: 1 as const,
    id: target.requestId ?? batchId,
    laneId: lane.id,
    batchId,
    source: "daily" as const,
    resources: [`fixture:${lane.instance}`],
    snapshot: {
      lane: structuredClone(lane),
      gameSlot: { laneId: lane.id, gameId: target.gameId },
      [target.gameId === "arknights" ? "arknightsPlan" : "onmyojiPlan"]: plan,
    },
    fingerprint: "isolated-single-game",
    status: "running" as const,
    startedAt,
    message: "隔离夹具：单游戏启动回执暂挂",
  };
  snapshot.executions.push(request);
  notify({
    type: "status",
    status: "queued",
    gameId: target.gameId,
    laneId: lane.id,
    instance: lane.instance,
    runId: batchId,
    batchId,
    executionId: request.id,
    executionSource: "daily",
    plan,
    startedAt,
    at: startedAt,
    message: request.message,
  });
  return request;
}
const methods: Record<string, (...args: any[]) => unknown> = {
  snapshot: () => {
    snapshotReads++;
    const captured = structuredClone(snapshot);
    if (!deferNextSnapshot) return captured;
    deferNextSnapshot = false;
    return new Promise((resolve) => {
      releaseDeferredSnapshot = () => {
        releaseDeferredSnapshot = undefined;
        resolve(captured);
      };
    });
  },
  deviceLanes: async () => {
    if (holdLaneHydration) await laneHydrationReady;
    return fixture.lanes;
  },
  captureLanePreview: async (laneId: string) => {
    const lane = fixture.lanes!.lanes.find((item) => item.id === laneId)!;
    const capturedAt = at();
    if (previewHold && laneId === fixture.lanes!.lanes[0].id) {
      previewHold = false;
      await new Promise<void>((resolve) => {
        releasePreview = resolve;
      });
    }
    return previewReady
      ? {
          status: "connected",
          laneId,
          laneName: lane.name,
          instance: lane.instance,
          imageDataUrl: previewImage,
          capturedAt,
          message: "当前账号设备画面",
        }
      : {
          status: "unavailable",
          laneId,
          laneName: lane.name,
          instance: lane.instance,
          message: "账号设备未连接",
        };
  },
  arknights: () => fixture.profiles,
  runArknightsJob: () => {
    forbiddenCalls++;
    throw Error("isolated UI cannot execute jobs");
  },
  runOnmyojiJob: () => {
    forbiddenCalls++;
    throw Error("isolated UI cannot execute jobs");
  },
  arknightsAutomation: () => structuredClone(arkPlans),
  onmyojiAutomation: () => structuredClone(yysPlans),
  saveArknightsAutomation: (input: unknown) => {
    arkPlans = validateArknightsAutomation(input);
    return structuredClone(arkPlans);
  },
  saveOnmyojiAutomation: (input: unknown) => {
    yysPlans = validateOnmyojiAutomation(input);
    return structuredClone(yysPlans);
  },
  saveDeviceLanes: (value: any) => {
    fixture.lanes = structuredClone(value);
    return fixture.lanes;
  },
  inspectOnmyojiIdentity: () => ({
    version: 1,
    status: "mismatch",
    reason: "candidate-mismatch",
  }),
  searchCopilot: () => [
    {
      id: 1001,
      title: "隔离作业替身",
      stageName: "main_01-07",
      uploader: "fixture",
      uploadTime: "",
    },
  ],
  prepareCopilot: (input: any) => ({
    version: 1,
    preparedId: "ui-copilot",
    planHash: "b".repeat(64),
    revision: "fixture",
    createdAt: at(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    account: {
      profileId: input.profileId,
      expectedUid: "111111111",
      clientType: "Bilibili",
      revision: "fixture",
    },
    stage: { id: "main_01-07", code: input.stage, aliases: ["main_01-07"] },
    count: input.count,
    jobs: Array.from({ length: input.count }, () => ({
      id: 1001,
      title: "隔离作业替身",
      stageName: "main_01-07",
      sha256: "c".repeat(64),
      file: "isolated-fixture",
    })),
    budget: { maxBattles: input.count, sanityPotions: 0, originite: 0 },
    skipStory: true,
    precheck: { status: "pending-live", unknown: ["fixture"] },
  }),
  confirmCopilot: (input: any) => {
    assert.deepEqual(input, {
      preparedId: "ui-copilot",
      planHash: "b".repeat(64),
      revision: "fixture",
    });
    return {
      batchId: "ui-copilot-batch",
      requestId: "ui-copilot-batch:lane-a",
      laneId: "lane-a",
    };
  },
  cancelCopilot: (input: any) => {
    assert.equal(input.batchId, "ui-copilot-batch");
    assert.equal(input.requestId, "ui-copilot-batch:lane-a");
    return { stopped: false, message: "本次作业已结束，未停止其他任务。" };
  },
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
  agentEvents: (input: {
    requestId: string;
    afterSeq?: number;
    limit?: number;
  }) => {
    if (performanceFixture?.events.has(input.requestId)) {
      const page = performanceEventPage(performanceFixture.events, input);
      const seen = performanceReplay.get(input.requestId) ?? new Set<number>();
      page.events.forEach((event) => seen.add(event.seq));
      performanceReplay.set(input.requestId, seen);
      performanceReplayPages++;
      return page;
    }
    if (input.requestId !== "ui-planner-1")
      return { events: [], cursor: 0, hasMore: false };
    const events = Array.from({ length: 12 }, (_, index) => [
      {
        seq: index * 2 + 1,
        at: at(),
        requestId: input.requestId,
        kind: "tool-started",
        tool: "get_run",
        callId: `ui-call-${index}`,
        status: "running",
        text: "读取隔离任务记录",
        details: {
          arguments: JSON.stringify({ requestId: `fixture-${index}` }),
        },
      },
      {
        seq: index * 2 + 2,
        at: at(),
        requestId: input.requestId,
        kind: "tool-result",
        tool: "get_run",
        callId: `ui-call-${index}`,
        status: index === 9 ? "failed" : index === 10 ? "unknown" : "succeeded",
        text:
          index === 10
            ? "工具响应未确认，不能据此判断游戏完成"
            : index === 9
              ? "隔离查询失败"
              : "查询返回，游戏结果另行核对",
        details: {
          result: JSON.stringify({
            recordedStatus: index === 10 ? "unknown" : "failed",
          }),
          durationMs: 15 + index,
        },
      },
    ])
      .flat()
      .filter((event) => event.seq > (input.afterSeq ?? 0));
    const page = events.slice(0, input.limit ?? 128);
    return {
      events: page,
      cursor: page.at(-1)?.seq ?? input.afterSeq ?? 0,
      hasMore: events.length > page.length,
    };
  },
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
  archiveChat: ({ sessionId }: { sessionId: string }) => {
    if (managementBusy) throw Error("该会话仍有活动任务，暂不能归档");
    const session = chat.sessions.find((item) => item.id === sessionId)!;
    assert.ok(session);
    archives.set(
      sessionId === "management-session"
        ? managementArchiveId
        : `archive-${sessionId}`,
      structuredClone(session),
    );
    chat.sessions = chat.sessions.filter((item) => item.id !== sessionId);
    if (chat.selectedSessionId === sessionId)
      chat.selectedSessionId = chat.sessions[0]?.id;
    chat.revision++;
    return chat;
  },
  listArchivedChats: ({
    cursor,
    limit = 8,
  }: {
    cursor?: string;
    limit?: number;
  }) => {
    const entries = [...archives]
      .reverse()
      .filter(
        ([, session]) => !chat.sessions.some((item) => item.id === session.id),
      )
      .map(([id, session]) => archiveEntry(id, session));
    const start = cursor ? Number(cursor.split(":")[1]) : 0;
    return {
      scope: "historical-only",
      canExecute: false,
      entries: entries.slice(start, start + limit),
      ...(start + limit < entries.length
        ? { nextCursor: `list:${start + limit}` }
        : {}),
    };
  },
  loadArchivedChat: ({
    archiveId,
    cursor,
    limit = 8,
  }: {
    archiveId: string;
    cursor?: string;
    limit?: number;
  }) => {
    const session = archives.get(archiveId)!;
    assert.ok(session);
    const start = cursor ? Number(cursor.split(":")[1]) : 0;
    return {
      scope: "historical-only",
      canExecute: false,
      archive: archiveEntry(archiveId, session),
      session: { ...session, turns: undefined },
      turns: session.turns.slice(start, start + limit),
      ...(start + limit < session.turns.length
        ? { nextCursor: `turns:${start + limit}` }
        : {}),
    };
  },
  restoreArchivedChat: ({ archiveId }: { archiveId: string }) => {
    if (managementBusy) throw Error("活动任务期间无法恢复");
    const session = archives.get(archiveId)!;
    assert.ok(session);
    if (!chat.sessions.some((item) => item.id === session.id))
      chat.sessions.unshift(structuredClone(session));
    chat.selectedSessionId = session.id;
    chat.revision++;
    return chat;
  },
  deleteChat: ({
    sessionId,
    confirmation,
  }: {
    sessionId: string;
    confirmation: string;
  }) => {
    assert.equal(confirmation, "delete-chat");
    if (managementBusy) throw Error("该会话仍有活动任务，暂不能删除");
    chat.sessions = chat.sessions.filter((item) => item.id !== sessionId);
    if (chat.selectedSessionId === sessionId)
      chat.selectedSessionId = chat.sessions[0]?.id;
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
      lanes: fixture
        .lanes!.lanes.filter((lane) => lane.arknights.enabled)
        .map((lane) => ({
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
  startGameSlot: (target: {
    laneId: string;
    gameId: "arknights" | "onmyoji";
    requestId?: string;
  }) => {
    const batchId = `isolated-slot-${calls.length}`;
    queueScopedFixture(target, batchId);
    return new Promise<{ batchId: string }>((resolve) => {
      releaseSlotStart = () => {
        releaseSlotStart = undefined;
        resolve({ batchId });
      };
    });
  },
  stopGameSlot: (target: { laneId: string; gameId: string }) => {
    const request = snapshot.executions.findLast((request) => {
      const scope = request.snapshot.gameSlot as typeof target | undefined;
      return (
        request.status === "running" &&
        scope?.laneId === target.laneId &&
        scope?.gameId === target.gameId
      );
    })!;
    request.status = "cancelled";
    request.finishedAt = at();
    notify({
      type: "status",
      status: "cancelled",
      gameId: target.gameId,
      laneId: target.laneId,
      runId: request.batchId!,
      batchId: request.batchId,
      executionId: request.id,
      executionSource: "daily",
      at: at(),
      message: "隔离夹具：此游戏请求已停止",
    });
  },
  stopLane: () => undefined,
  stopLanes: () => undefined,
};
async function screenshot(name: string, width: number, height: number) {
  window!.setContentSize(width, height);
  await delay(250);
  const layout =
    await js(`({width:innerWidth, height:innerHeight, scrollWidth:document.documentElement.scrollWidth,
    composer: (()=>{const el=document.querySelector('.chat-composer');const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,scrollWidth:el.scrollWidth,clientWidth:el.clientWidth};})()})`);
  result.lastLayout = { name, layout };
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
  check(
    `composer retains usable width at ${width}px`,
    layout.composer.clientWidth >= 400 &&
      layout.composer.scrollWidth <= layout.composer.clientWidth + 1,
  );
  const capture = await Promise.race([
    captureFrame(name),
    delay(8000).then(() => {
      throw new Error("Screenshot timeout");
    }),
  ]);
  await writeFile(join(directory, name), capture.toPNG());
  result.screenshots.push({ name, layout });
  await auditAccessibility(name);
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
async function measureConversationPerformance() {
  // Execute after every existing behavior/accessibility check, against the same production App.
  await openAiWorkbench();
  await until(
    'document.querySelector("#chat-prompt")',
    "performance chat view",
  );
  window!.setSize(1280, 800);
  await js(`{
    const toggle=document.querySelector('[aria-controls="workspace-panel"]');
    if(toggle?.getAttribute('aria-expanded')==='true') toggle.click();
  }`);
  const callsBefore = calls.length,
    forbiddenBefore = forbiddenCalls,
    launchesBefore = launches;
  await js(`{
    const supported=PerformanceObserver.supportedEntryTypes.includes('longtask');
    const state=window.__gpUiPerformance={startedAt:performance.now(),longTasks:[],longTaskSupported:supported};
    if(supported) {
      state.observer=new PerformanceObserver(list=>state.longTasks.push(...list.getEntries().map(entry=>({startTime:entry.startTime,duration:entry.duration}))));
      state.observer.observe({type:'longtask'});
    }
  }`);
  performanceFixture = createChatPerformanceFixture(at());
  chat.sessions.unshift(performanceFixture.session);
  chat.selectedSessionId = performanceFixture.session.id;
  chat.revision++;
  planner = { revision: planner.revision + 1, status: "idle" };
  await until(
    `document.querySelectorAll('.chat-turn[data-message-request-id^="ui-performance-request-"]').length===64 && document.querySelectorAll('.chat-turn[data-message-request-id^="ui-performance-request-"] .agent-event-timeline > li').length===3328`,
    "64 turns and complete grouped 4096-event journal",
  );
  // Expand real production disclosures; content-visibility remains enabled on every turn.
  await js(
    `document.querySelectorAll('.chat-turn[data-message-request-id^="ui-performance-request-"] .chat-tool-trace').forEach(details=>details.open=true)`,
  );
  await until(
    `document.querySelectorAll('.chat-turn[data-message-request-id^="ui-performance-request-"] .chat-tool-trace[open]').length===64`,
    "64 expanded production traces",
  );
  const loaded =
    await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    const state=window.__gpUiPerformance;
    state.loadedAt=performance.now();
    const turns=[...document.querySelectorAll('.chat-turn[data-message-request-id^="ui-performance-request-"]')];
    resolve({loadMs:state.loadedAt-state.startedAt,turns:turns.length,groupedRows:document.querySelectorAll('.chat-turn[data-message-request-id^="ui-performance-request-"] .agent-event-timeline > li').length,toolGroups:document.querySelectorAll('.chat-turn[data-message-request-id^="ui-performance-request-"] [data-agent-call-id]').length,contentVisibility:turns.every(turn=>getComputedStyle(turn).contentVisibility==='auto'),ownership:turns.every(turn=>{const requestId=turn.dataset.messageRequestId;return [...turn.querySelectorAll('[data-agent-call-id]')].length===12&&[...turn.querySelectorAll('[data-agent-call-id]')].every(row=>row.dataset.agentCallId.startsWith(requestId+':'));})});
  })))`);
  check(
    "performance fixture presents all 64 turns and 3328 grouped journal rows",
    loaded.turns === 64 &&
      loaded.groupedRows === 3328 &&
      loaded.toolGroups === 768,
  );
  check(
    "performance fixture preserves production content-visibility and exact turn ownership",
    loaded.contentVisibility && loaded.ownership,
  );
  check(
    "performance replay delivers every one of 4096 request-bound records across bounded pages",
    performanceReplay.size === 64 &&
      [...performanceReplay.values()].every((seen) => seen.size === 64) &&
      [...performanceReplay.values()].reduce(
        (count, seen) => count + seen.size,
        0,
      ) === 4096 &&
      performanceReplayPages >= 128,
  );
  const scrolling = await js(`new Promise(resolve=>{
    const scroll=document.querySelector('.chat-scroll'),state=window.__gpUiPerformance;
    const intervals=[],scrollStartedAt=performance.now();let previous,frames=0,maxScrollTop=0,scrollDistancePx=0,lastScrollTop=scroll.scrollTop;
    const step=timestamp=>{
      if(previous!==undefined) intervals.push(timestamp-previous);
      previous=timestamp;frames++;
      const progress=Math.min(1,(timestamp-scrollStartedAt)/5000);
      const phase=progress<0.5?progress*2:(1-progress)*2;
      scroll.scrollTop=(scroll.scrollHeight-scroll.clientHeight)*phase;
      maxScrollTop=Math.max(maxScrollTop,scroll.scrollTop);
      scrollDistancePx+=Math.abs(scroll.scrollTop-lastScrollTop);lastScrollTop=scroll.scrollTop;
      if(progress<1){requestAnimationFrame(step);return;}
      setTimeout(()=>{
        state.observer?.disconnect();
        const ordered=[...intervals].sort((a,b)=>a-b);
        resolve({durationMs:performance.now()-scrollStartedAt,frames,maxScrollTop,scrollDistancePx,frameIntervalsMs:intervals,p95Ms:ordered[Math.max(0,Math.ceil(ordered.length*0.95)-1)]??null,maxMs:ordered.at(-1)??null,longTaskSupported:state.longTaskSupported,longTasks:state.longTasks,longTaskCount:state.longTaskSupported?state.longTasks.length:null,longTaskTotalMs:state.longTaskSupported?state.longTasks.reduce((sum,task)=>sum+task.duration,0):null,documentOverflow:document.documentElement.scrollWidth>innerWidth});
      },100);
    };
    requestAnimationFrame(step);
  })`);
  result.performance = {
    workload:
      "64 historical synthetic turns; 4096 request-bound journal records; 12 tool pairs and 40 lifecycle records per turn; all process disclosures expanded",
    environment: {
      rendering: "software: app.disableHardwareAcceleration()",
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      viewport: { width: 1280, height: 800 },
    },
    load: {
      ...loaded,
      definition:
        "From fixture publication until all turns and journal groups are mounted and two RAFs have elapsed; includes the existing synthetic chatSnapshot polling delay",
    },
    scroll: scrolling,
    replay: {
      requestCount: performanceReplay.size,
      uniqueEventCount: [...performanceReplay.values()].reduce(
        (count, seen) => count + seen.size,
        0,
      ),
      pages: performanceReplayPages,
      pageLimit: 32,
    },
    interpretation:
      "Single isolated software-rendering measurement, not a universal smoothness threshold or hardware performance certification. Long tasks cover hydration, expansion and scrolling; frame intervals cover the five-second up/down scroll.",
  };
  check(
    "performance scrolling produces real RAF samples without horizontal page overflow",
    scrolling.frames > 1 &&
      scrolling.frameIntervalsMs.length > 0 &&
      scrolling.maxScrollTop > 0 &&
      scrolling.scrollDistancePx > 0 &&
      !scrolling.documentOverflow,
  );
  check(
    "performance hydration and scrolling add no business IPC or execution calls",
    calls.length === callsBefore &&
      forbiddenCalls === forbiddenBefore &&
      launches === launchesBefore,
  );
  await writeFile(
    join(directory, "performance.json"),
    JSON.stringify(result.performance, null, 2),
  );
  await writeFile(
    join(directory, "performance-64-turns.png"),
    (await captureFrame("performance-64-turns")).toPNG(),
  );
}
void app
  .whenReady()
  .then(async () => {
    // The preload's fixed method list cannot escape into production handlers.
    for (const method of [
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
    ])
      ipcMain.handle(`fixture:${method}`, (_event, ...args) => {
        if (
          ![
            "snapshot",
            "deviceLanes",
            "arknights",
            "arknightsAutomation",
            "onmyojiAutomation",
            "modelProvider",
            "automation",
            "plannerSnapshot",
            "agentEvents",
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
        backgroundThrottling: false,
      },
    });
    window.setMenu(null);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    await window.loadFile(join(directory, "index.html"));
    window.showInactive();
    await until(
      'document.querySelector(".slots-dashboard")?.getClientRects().length>0',
      "configured slots are the default workspace",
    );
    check(
      "initial ordinary view has no mounted chat composer, new-session button or Agent branding",
      await js(
        '!document.querySelector("#chat-prompt") && !document.querySelector("#chat-new") && !document.querySelector(".chat-history") && !document.querySelector(".sidebar .version")?.textContent.includes("AGENT")',
      ),
    );
    check(
      "initial slot view never creates a session, calls a model or executes a game",
      calls.filter((call) =>
        [
          "newChat",
          "sendChat",
          "start",
          "startLane",
          "startGameSlot",
          "startLanes",
          "startPlanner",
          "confirmAgentExecution",
        ].includes(call.method),
      ).length === 0 &&
        launches === 0 &&
        chat.sessions.length === 1 &&
        chat.revision === 0,
    );
    // Keep the existing late-account hydration test: explicitly open the auxiliary AI
    // workspace while deviceLanes is held, then validate the fully hydrated slot home.
    await openAiWorkbench();
    await previewHydrationSmoke();
    await slotHomeSmoke();
    check(
      "explicit AI workspace retains its accessible composer",
      await js(
        'document.querySelector("section[aria-label=\\"Agent聊天工作台\\"]") && document.querySelector("label[for=chat-prompt]")',
      ),
    );
    result.chatNavigationStyles = await js(
      "[...document.querySelectorAll('.chat-workspace-nav > button')].map(button=>{const style=getComputedStyle(button);return {id:button.id,borderTopWidth:style.borderTopWidth,display:style.display};})",
    );
    // Flex-container children blockify inline-flex to computed flex in Chromium.
    check(
      "semantic chat navigation retains the designed button styles",
      result.chatNavigationStyles.length === 2 &&
        result.chatNavigationStyles.every(
          (style: { borderTopWidth: string; display: string }) =>
            style.borderTopWidth === "0px" &&
            ["flex", "inline-flex"].includes(style.display),
        ),
    );
    check(
      "renderer has no Node require",
      await js('typeof require === "undefined"'),
    );
    check(
      "explicit AI account scope includes current records",
      await js(
        'document.querySelector("select[aria-label=\\"参考数据\\"]").value === "recorded"',
      ),
    );
    await js(
      'document.querySelector("#chat-prompt").focus();window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))',
    );
    await until(
      'document.querySelector("#command-palette-dialog").open',
      "Ctrl K palette",
    );
    check(
      "palette contains only navigation and appearance actions",
      await js(
        '![...document.querySelectorAll("[data-command-id]")].some(element=>/^(run|stop|resume|pause)/.test(element.dataset.commandId))',
      ),
    );
    await screenshot("command-palette-1280.png", 1280, 800);
    await js(
      'document.querySelector("[data-command-id=page-settings]").click()',
    );
    await until(
      'document.querySelector("select[aria-label=\\"外观主题\\"]")',
      "palette settings navigation",
    );
    await until(
      'document.activeElement!==document.body && document.activeElement.closest(".page") && document.activeElement.getClientRects().length>0',
      "palette focus enters the visible new page",
    );
    check(
      "palette navigation never restores focus to the hidden composer",
      await js('!document.activeElement.closest("[hidden], [inert]")'),
    );
    await js(
      'window.__fixtureAppearanceInput=document.querySelector("select[aria-label=\\"外观主题\\"]");window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))',
    );
    await until(
      'document.querySelector("#command-palette-dialog").open',
      "palette while settings mounted",
    );
    await js('document.querySelector("[data-command-id=theme-dark]").click()');
    check(
      "palette theme updates the mounted settings selector without remounting",
      await js(
        'document.documentElement.dataset.theme==="dark"&&document.querySelector("select[aria-label=\\"外观主题\\"]").value==="dark"&&window.__fixtureAppearanceInput===document.querySelector("select[aria-label=\\"外观主题\\"]")',
      ),
    );
    await js(
      'document.documentElement.dataset.theme="light";delete window.__fixtureAppearanceInput',
    );
    await openAiWorkbench();
    await typePrompt("/", false);
    await until('document.querySelector("#chat-slash-menu")', "slash menu");
    await js(
      'document.querySelector("#chat-prompt").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))',
    );
    await until(
      'document.querySelector("#chat-prompt").getAttribute("aria-activedescendant")==="slash-devices"',
      "slash keyboard selection committed",
    );
    await js(
      'document.querySelector("#chat-prompt").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))',
    );
    check(
      "prefix menu Enter fills a local command without submitting",
      (await js('document.querySelector("#chat-prompt").value==="/devices"')) &&
        calls.filter((call) => call.method === "sendChat").length === 0 &&
        launches === 0,
    );
    await js(
      'document.querySelector("#chat-prompt").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))',
    );
    await until(
      'document.querySelector(".chat-topbar-title").textContent.includes("设备与账号")',
      "complete slash command opens local device page",
    );
    check(
      "slash navigation does not call the model or execute games",
      calls.filter((call) => call.method === "sendChat").length === 0 &&
        launches === 0,
    );
    await openAiWorkbench();
    await typePrompt("中文输入中", false);
    await js(
      'document.querySelector("#chat-prompt").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true}));{const event=new KeyboardEvent("keydown",{key:"Enter",bubbles:true});Object.defineProperty(event,"keyCode",{value:229});document.querySelector("#chat-prompt").dispatchEvent(event);}',
    );
    check(
      "IME Enter never sends the draft",
      calls.filter((call) => call.method === "sendChat").length === 0 &&
        (await js(
          'document.querySelector("#chat-prompt").value==="中文输入中"',
        )),
    );
    await js(
      '{const select=document.querySelector("select[aria-label=\\"参考数据\\"]");select.value="fixture";select.dispatchEvent(new Event("change",{bubbles:true}));}',
    );
    await until(
      'document.querySelector("#chat-fixture-warning")',
      "fixture warning",
    );
    check(
      "reference source selector remains unique and visible",
      await js(
        'document.querySelectorAll("select[aria-label=\\"参考数据\\"]").length===1&&document.querySelector("select[aria-label=\\"参考数据\\"]").getBoundingClientRect().height>0',
      ),
    );
    await js(
      '{const select=document.querySelector("select[aria-label=\\"参考数据\\"]");select.value="recorded";select.dispatchEvent(new Event("change",{bubbles:true}));}',
    );
    await typePrompt("", false);
    await screenshot("welcome-1440.png", 1440, 960);
    await screenshot("welcome-1000.png", 1000, 760);
    for (const theme of ["light", "dark"] as const) {
      await js(
        `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
      );
      await screenshot(`theme-${theme}-1280.png`, 1280, 800);
      await screenshot(`theme-${theme}-900.png`, 900, 700);
      for (const [navigation, heading] of [
        ["每日任务", "每日"],
        ["设备与账号", "设备"],
        ["模型连接", "模型"],
        ["设置", "全局设置"],
      ]) {
        await js('document.querySelector(".sidebar-tools").open=true');
        if (navigation === "模型连接") {
          await clickText("设置");
          await until(
            'document.querySelector(".settings-ai-tools")',
            "advanced model entry",
          );
          await js('document.querySelector(".settings-ai-tools").open=true');
          await clickText("打开模型连接");
        } else await clickText(navigation);
        await until(
          `document.querySelector('main')?.textContent.includes(${JSON.stringify(heading)})`,
          `${theme} ${navigation}`,
        );
        await delay(200);
        check(
          `${theme} ${navigation} has no page overflow`,
          await js("document.documentElement.scrollWidth <= innerWidth"),
        );
        const name = `theme-${theme}-${navigation}.png`;
        await writeFile(
          join(directory, name),
          (await captureFrame(name)).toPNG(),
        );
        result.screenshots.push({ name });
        await auditAccessibility(name);
      }
      await until(
        'document.querySelector("select[aria-label=\\"外观主题\\"]")',
        "appearance control",
      );
      await js(
        `{const select=document.querySelector('select[aria-label="外观主题"]');select.value=${JSON.stringify(theme)};select.dispatchEvent(new Event('change',{bubbles:true}));}`,
      );
      check(
        `${theme} preference persists locally`,
        await js(
          `localStorage.getItem('gamepilot.appearance')===${JSON.stringify(theme)}&&document.documentElement.dataset.theme===${JSON.stringify(theme)}`,
        ),
      );
      await openAiWorkbench();
      await until('document.querySelector("#chat-prompt")', "return to chat");
    }
    await js('document.documentElement.dataset.theme="light"');
    nativeTheme.themeSource = "dark";
    await js("delete document.documentElement.dataset.theme");
    await until(
      'getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()==="#17191d"',
      "system dark applies",
    );
    nativeTheme.themeSource = "light";
    await until(
      'getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim()==="#fafbfc"',
      "system light applies",
    );
    check("system theme responds live without renderer polling", true);
    await js('document.documentElement.dataset.theme="light"');
    await typePrompt("保留三栏切换期间的草稿", false);
    await js(
      'document.querySelector("button[aria-label=\\"打开设备预览\\"]").click()',
    );
    await until(
      '!document.querySelector("#workspace-panel").hidden',
      "right workspace opens",
    );
    check(
      "right sidebar opens on tasks without device actions",
      await js(
        'document.querySelector("#workspace-tasks-tab").getAttribute("aria-selected")==="true"',
      ),
    );
    await screenshot("workspace-tasks-1280.png", 1280, 800);
    const callsBeforeTabKeys = calls.filter(
      (call) => call.method !== "captureLanePreview",
    ).length;
    for (const [key, target] of [
      ["ArrowRight", "chat-trajectory-tab"],
      ["ArrowRight", "workspace-device-tab"],
      ["ArrowLeft", "chat-trajectory-tab"],
      ["Home", "workspace-tasks-tab"],
      ["End", "workspace-device-tab"],
      ["Home", "workspace-tasks-tab"],
    ]) {
      await js(
        `{const tab=document.querySelector('#workspace-panel [role="tab"][aria-selected="true"]');tab.focus();tab.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true}));}`,
      );
      await until(
        `document.activeElement?.id===${JSON.stringify(target)} && document.getElementById(${JSON.stringify(target)}).getAttribute('aria-selected')==='true' && !document.getElementById(document.getElementById(${JSON.stringify(target)}).getAttribute('aria-controls')).hidden && document.getElementById(document.getElementById(${JSON.stringify(target)}).getAttribute('aria-controls')).getClientRects().length>0`,
        `right tab ${key} focus, selection and visible panel`,
      );
      check(
        `right tab ${key} selects ${target} with matching focus and visible panel`,
        true,
      );
    }
    check(
      "right tab keyboard navigation adds no business IPC",
      calls.filter((call) => call.method !== "captureLanePreview").length ===
        callsBeforeTabKeys,
    );
    await click("chat-trajectory-tab");
    await screenshot("workspace-trajectory-1280.png", 1280, 800);
    await click("workspace-device-tab");
    await screenshot("workspace-device-900.png", 900, 700);
    await js(
      'document.querySelector("[role=separator][aria-label=\\"调整右栏宽度\\"]").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}))',
    );
    check(
      "right width is keyboard adjustable and persisted",
      await js(
        'document.querySelector("#workspace-panel").style.width==="480px"&&JSON.parse(localStorage.getItem("gamepilot.workspace-layout.v1")).width===480',
      ),
    );
    await js(
      'document.querySelector("button[aria-label=\\"关闭右侧工作面板\\"]").click()',
    );
    check(
      "closing right sidebar preserves the session draft",
      await js(
        'document.querySelector("#chat-prompt").value==="保留三栏切换期间的草稿"',
      ),
    );
    const originalTitle = selected().title;
    await js(
      'document.querySelector(".chat-session-row .session-menu-trigger").click()',
    );
    await clickText("修改本机显示名称 F2");
    await until(
      'document.querySelector("#workspace-rename-input")',
      "local alias dialog",
    );
    await js(
      '{const input=document.querySelector("#workspace-rename-input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"本机测试名称");input.dispatchEvent(new Event("input",{bubbles:true}));}',
    );
    await js(
      'document.querySelector(".workspace-rename-dialog form").requestSubmit()',
    );
    await until(
      'document.querySelector(".chat-topbar-title").textContent.includes("本机测试名称")',
      "alias reflected",
    );
    check(
      "local rename keeps host session title and ID unchanged",
      selected().title === originalTitle && selected().id === "chat-1",
    );
    chat.sessions.push(
      ...["keyboard-a", "keyboard-b"].map((id) => ({
        id,
        title: id,
        createdAt: at(),
        updatedAt: at(),
        turns: [],
      })),
    );
    chat.revision++;
    await until(
      'document.querySelectorAll(".chat-history .chat-session").length === 3',
      "keyboard history fixture",
    );
    await js(
      '{const first=document.querySelector(".chat-history .chat-session");first.focus();first.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));}',
    );
    await delay(150);
    await js(
      'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))',
    );
    await delay(150);
    check(
      "consecutive history arrows preserve list focus and do not select a session",
      (await js(
        'document.activeElement === document.querySelectorAll(".chat-history .chat-session")[2]',
      )) && chat.selectedSessionId === "chat-1",
    );
    chat.sessions = chat.sessions.filter(
      (session) => !session.id.startsWith("keyboard-"),
    );
    chat.revision++;
    await until(
      'document.querySelectorAll(".chat-history .chat-session").length === 1',
      "keyboard fixture removed",
    );
    await typePrompt("", false);
    await managementSmoke();
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
    await until(
      'document.querySelectorAll(".agent-tool-entry").length === 12',
      "twelve recorded tool cards",
    );
    check(
      "active process opens and keeps failed and unknown tools distinct",
      await js(
        'document.querySelector(".chat-tool-trace").open&&document.querySelector(".agent-tool-entry[data-status=failed]")&&document.querySelector(".agent-tool-entry[data-status=unknown]")&&!document.querySelector(".agent-tool-entry[data-status=unknown] .lucide-circle-check")',
      ),
    );
    check(
      "result wait placeholder does not claim game completion",
      await js(
        'document.querySelector("[data-host-result-waiting]").textContent.includes("分别记录")',
      ),
    );
    await screenshot("timeline-twelve-tools-1280.png", 1280, 800);
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
      "completed model process collapses without hiding host task checks",
      await js(
        '!document.querySelector(".chat-tool-trace").open && document.querySelector(".chat-ai-disclaimer").textContent.includes("以任务记录为准")',
      ),
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
    await previewSmoke();
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
    await clickText("查看任务详情");
    await until(
      'document.querySelector("dialog[open] .execution-detail-status[data-state=unknown]")',
      "unknown task detail drawer",
    );
    for (const theme of ["light", "dark"] as const) {
      await js(
        `document.documentElement.dataset.theme=${JSON.stringify(theme)}`,
      );
      const name = `theme-${theme}-task-detail.png`;
      await writeFile(
        join(directory, name),
        (await captureFrame(name)).toPNG(),
      );
      result.screenshots.push({ name });
      await auditAccessibility(name);
      check(
        `${theme} task drawer retains unknown host status`,
        await js(
          'document.querySelector("dialog[open] .execution-detail-status").dataset.state === "unknown"',
        ),
      );
    }
    await js(
      'document.querySelector("button[aria-label=\\"关闭任务详情\\"]").click();document.documentElement.dataset.theme="light"',
    );
    await until(
      '!document.querySelector("dialog[open]")',
      "task drawer closed",
    );
    const sendsBeforeRegenerate = calls.filter(
      (call) => call.method === "sendChat",
    ).length;
    await js(
      'document.querySelector("button[aria-label=\\"重新生成需求（填回输入框，不发送）\\"]").click()',
    );
    check(
      "regenerate fills only the original prompt and never sends or runs",
      (await js(
        `document.querySelector("#chat-prompt").value===${JSON.stringify(selected().turns[0].prompt)}`,
      )) &&
        sendsBeforeRegenerate ===
          calls.filter((call) => call.method === "sendChat").length,
    );
    await js(
      '{const scroll=document.querySelector(".chat-scroll");scroll.scrollTop=0;scroll.dispatchEvent(new Event("scroll",{bubbles:true}));}',
    );
    await until(
      '[...document.querySelectorAll("button")].some(button=>button.textContent==="回到底部")',
      "reader scroll disables following",
    );
    const oldScrollTop = await js(
      'document.querySelector(".chat-scroll").scrollTop',
    );
    await js(
      'document.querySelector(".chat-answer").appendChild(document.createTextNode(" 隔离流式增量，未提供游戏完成证据。"))',
    );
    await delay(100);
    check(
      "stream mutations do not pull a reader away from history",
      (await js('document.querySelector(".chat-scroll").scrollTop')) ===
        oldScrollTop,
    );
    await clickText("回到底部");
    await until(
      '![...document.querySelectorAll("button")].some(button=>button.textContent==="回到底部")',
      "following resumed",
    );
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
      '[...document.querySelectorAll(".chat-answer")].some(element=>element.textContent.includes("模型回答：任务已完成"))',
      "query answer in new session",
    );
    await js(
      '{const answer=[...document.querySelectorAll(".chat-answer")].find(element=>element.textContent.includes("模型回答：任务已完成"));const scroll=document.querySelector(".chat-scroll");scroll.scrollTop+=answer.closest(".chat-turn").getBoundingClientRect().top-scroll.getBoundingClientRect().top;}',
    );
    await until(
      'document.body.innerText.includes("模型回答：任务已完成")',
      "virtualized query answer becomes visible after reading it",
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
      'document.querySelectorAll(".channels-page .lane-card").length===4',
      "preserved device workspace",
    );
    await openAiWorkbench();
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
    const gameStopsBeforeEscape = calls.filter((call) =>
      ["stop", "stopLanes", "cancelGoal"].includes(call.method),
    ).length;
    await js(
      '{const disclosure=document.createElement("details");disclosure.className="chat-tool-trace";disclosure.dataset.uiTestDisclosure="true";disclosure.open=true;disclosure.innerHTML="<summary>隔离过程展开项</summary>";document.querySelector(".chat-scroll").appendChild(disclosure);document.querySelector("#chat-prompt").focus();document.querySelector("#chat-prompt").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));}',
    );
    await until(
      'document.querySelector("#chat-send")',
      "cross-session planner cancelled",
    );
    check(
      "Escape cancels only the model while a process disclosure is open",
      calls.filter((call) =>
        ["stop", "stopLanes", "cancelGoal"].includes(call.method),
      ).length === gameStopsBeforeEscape,
    );
    await js('document.querySelector("[data-ui-test-disclosure]").remove()');
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
      '[...document.querySelectorAll("button")].some(el=>el.textContent.trim()==="开始全部账号日常" && !el.disabled)',
      "preserved daily start control",
    );
    await until(
      'document.querySelectorAll(".ark-automation-job").length===8',
      "four accounts show their saved daily schedules",
    );
    check(
      "two games share four account schedule editors",
      await js(
        'document.querySelectorAll(".ark-automation[data-arknights-automation-lane]").length===4 && document.body.textContent.includes("阴阳师自动计划") && document.body.textContent.includes("20:30")',
      ),
    );
    await writeFile(
      join(directory, "daily-schedules.png"),
      (await captureFrame("daily-schedules")).toPNG(),
    );
    await clickText("开始全部账号日常");
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
    await openAiWorkbench();
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
    // Mounted production workspace, synthetic bounded local-confirmation IPC only.
    await js(
      '[...document.querySelectorAll("button")].find(el=>el.textContent.includes("明日方舟")&&el.textContent.includes("工作区")).click()',
    );
    await until(
      'document.querySelector(".game-workspace")',
      "account-scoped game workspace mounted",
    );
    await js(
      '[...document.querySelectorAll(".game-workspace details")].find(el=>el.querySelector("summary")?.textContent.includes("社区作业")).open=true',
    );
    await until(
      'document.querySelector(".copilot-library")',
      "temporary job workspace visible",
    );
    await clickText("查找作业");
    await until(
      'document.querySelector(".copilot-results")',
      "bounded search rendered",
    );
    check(
      "search has no execution side effect",
      !calls.some((c) => c.method === "confirmCopilot"),
    );
    await clickText("检查本次作业");
    await until(
      'document.querySelector(".copilot-review")',
      "exact temporary confirmation rendered",
    );
    check(
      "prepare has no execution side effect",
      !calls.some((c) => c.method === "confirmCopilot"),
    );
    check(
      "temporary review shows zero refill and pending live checks",
      await js(
        'document.querySelector(".copilot-review").textContent.includes("理智药0")&&document.querySelector(".copilot-review").textContent.includes("预检尚未实机完成")',
      ),
    );
    await clickText("确认本次执行");
    await until(
      'document.querySelector(".copilot-receipt")',
      "temporary receipt visible",
    );
    check(
      "local confirmation submitted exactly once",
      calls.filter((c) => c.method === "confirmCopilot").length === 1,
    );
    check(
      "receipt is not a completion claim",
      await js(
        'document.querySelector(".copilot-library").textContent.includes("受理不代表战斗完成")',
      ),
    );
    await clickText("停止本次作业");
    await until(
      'document.querySelector(".copilot-library").textContent.includes("未停止其他任务")',
      "exact old batch cancellation remains isolated",
    );
    check(
      "temporary cancellation never stops a whole lane",
      calls.filter((c) => c.method === "cancelCopilot").length === 1 &&
        !calls.some((c) => c.method === "stopLane"),
    );
    await writeFile(
      join(directory, "copilot-workspace.png"),
      (await captureFrame("copilot-workspace")).toPNG(),
    );
    await auditAccessibility("copilot-workspace");
    // Reload hydrates only synthetic lane configuration; no production main or device.
    const identityLane = fixture.lanes!.lanes.find(
      (lane) => lane.onmyoji.enabled,
    )!;
    identityLane.onmyoji = {
      enabled: true,
      identity: { roleId: "role-A", serverName: "server-A" },
    };
    const reloaded = new Promise<void>((resolve) =>
      window!.webContents.once("did-finish-load", () => resolve()),
    );
    window!.webContents.reload();
    await reloaded;
    await until(
      'document.querySelector(".slots-dashboard")?.getClientRects().length>0',
      "reloaded app returns to its ordinary slot home",
    );
    check(
      "reload does not reopen the auxiliary chat or create a session",
      await js(
        '!document.querySelector("#chat-prompt") && !document.querySelector("#chat-new")',
      ),
    );
    await until(
      `document.querySelector('.slots-dashboard [data-slot-lane-id="${identityLane.id}"] [data-game-id="onmyoji"]')`,
      "saved second game remains represented after reload",
    );
    check(
      "a saved second game remains visible in its actual slot instead of being silently disabled or hidden",
      await js(
        `document.querySelector('.slots-dashboard [data-slot-lane-id="${identityLane.id}"] [data-game-id="onmyoji"]').closest('[data-slot-id]').querySelector('.slot-game-name').textContent.includes('阴阳师')`,
      ),
    );
    await clickText("设备与账号");
    await until(
      'document.querySelector(".lane-identity")',
      "identity settings mounted",
    );
    await js('document.querySelector(".lane-identity").open=true');
    await js(
      '{const el=document.querySelector(".lane-identity input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"role-B");el.dispatchEvent(new Event("input",{bubbles:true}));}',
    );
    await until(
      '[...document.querySelectorAll(".lane-identity button")].find(el=>el.textContent==="核对当前角色页面").disabled',
      "draft identity cannot inspect saved old binding",
    );
    check(
      "editing identity has no device inspection side effect",
      !calls.some((c) => c.method === "inspectOnmyojiIdentity"),
    );
    await clickText("设置绑定");
    await until(
      'document.querySelector(".lane-identity").textContent.includes("请点击设备区域的保存")',
      "identity save prompt survives parent update",
    );
    await clickText("核对当前角色页面");
    await until(
      'document.querySelector(".lane-identity").textContent.includes("请先保存")',
      "unsaved parent binding rejected",
    );
    check(
      "unsaved identity does not reach inspection RPC",
      !calls.some((c) => c.method === "inspectOnmyojiIdentity"),
    );
    await clickText("保存");
    await until(
      '[...document.querySelectorAll(".lane-identity button")].find(el=>el.textContent==="核对当前角色页面")&&!document.querySelector(".lane-identity input").disabled',
      "identity configuration saved",
    );
    await clickText("核对当前角色页面");
    await until(
      'document.querySelector(".lane-identity").textContent.includes("候选角色与绑定不同")',
      "uncertified mismatch wording",
    );
    check(
      "identity mismatch neither certifies anchors nor claims two matching frames",
      calls.filter((c) => c.method === "inspectOnmyojiIdentity").length === 1 &&
        (await js(
          '!document.querySelector(".lane-identity").textContent.includes("双帧不匹配")',
        )),
    );
    await writeFile(
      join(directory, "identity-settings.png"),
      (await captureFrame("identity-settings")).toPNG(),
    );
    await auditAccessibility("identity-settings");
    // The real chat card can prepare/read but execution needs this fresh turn and explicit consent.
    await openAiWorkbench();
    await until(
      'document.querySelector("#chat-prompt")',
      "chat confirmation workspace",
    );
    const copilotReview = {
      version: 1 as const,
      preparedId: "ui-copilot",
      planHash: "b".repeat(64),
      revision: "fixture",
      laneName: "隔离槽位",
      uidTail: "1111",
      clientType: "Bilibili" as const,
      stage: "1-7",
      count: 1,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      jobs: [{ id: 1001, title: "隔离作业替身", sha256: "c".repeat(64) }],
    };
    const currentCopilotTurn: Turn = {
      id: "copilot-turn",
      prompt: "准备1-7一场作业",
      at: at(),
      source: "recorded",
      createdAt: at(),
      planner: {
        revision: planner.revision + 1,
        status: "completed",
        requestId: "ui-chat-copilot",
        source: "recorded",
        result: { ...reply("answer"), copilot: copilotReview },
      },
    };
    selected().turns.push(currentCopilotTurn);
    chat.revision++;
    planner = structuredClone(currentCopilotTurn.planner);
    await until(
      'document.querySelector("section[aria-label=\\"对话临时作业确认\\"]")',
      "chat temporary confirmation mounted",
    );
    check(
      "chat confirmation requires explicit unchecked consent",
      await js(
        '!document.querySelector("section[aria-label=\\"对话临时作业确认\\"] input").checked&&[...document.querySelectorAll("section[aria-label=\\"对话临时作业确认\\"] button")].find(el=>el.textContent=== "确认本次作业").disabled',
      ),
    );
    const confirmsBeforeChat = calls.filter(
      (c) => c.method === "confirmCopilot",
    ).length;
    await clickText("确认本次作业");
    check(
      "chat read preparation cannot execute",
      calls.filter((c) => c.method === "confirmCopilot").length ===
        confirmsBeforeChat,
    );
    const copilotConsentState = () =>
      js(`(() => {
        const card=document.querySelector('section[aria-label="对话临时作业确认"]');
        const input=card.querySelector('input');
        const confirm=[...card.querySelectorAll('button')].find(button=>button.textContent==='确认本次作业');
        return {checked:input.checked,disabled:input.disabled,confirmDisabled:confirm.disabled,historicalNotice:card.textContent.includes('历史或旧会话准备记录不能执行')};
      })()`);
    result.copilotConsentReadiness = { before: await copilotConsentState() };
    // A newly mounted auxiliary Chat reads planner state independently from chat
    // history. Card presence alone does not prove its request is still current.
    await until(
      'document.querySelector("section[aria-label=\\"对话临时作业确认\\"] input:not(:disabled)")',
      "fresh host request enables the temporary-job consent control",
    );
    result.copilotConsentReadiness.after = await copilotConsentState();
    check(
      "fresh temporary-job consent remains unchecked and cannot execute before its explicit click",
      !result.copilotConsentReadiness.after.checked &&
        result.copilotConsentReadiness.after.confirmDisabled &&
        calls.filter((c) => c.method === "confirmCopilot").length ===
          confirmsBeforeChat,
    );
    await js(
      'document.querySelector("section[aria-label=\\"对话临时作业确认\\"] input").click()',
    );
    await until(
      '[...document.querySelectorAll("section[aria-label=\\"对话临时作业确认\\"] button")].find(el=>el.textContent==="确认本次作业"&&!el.disabled)',
      "chat consent enabled",
    );
    await js(
      '{const button=[...document.querySelectorAll("section[aria-label=\\"对话临时作业确认\\"] button")].find(el=>el.textContent==="确认本次作业");button.click();button.click();}',
    );
    await until(
      'document.querySelector("section[aria-label=\\"对话临时作业确认\\"]").textContent.includes("受理不代表战斗完成")',
      "chat receipt stays truthful",
    );
    check(
      "chat confirmation executes exactly once",
      calls.filter((c) => c.method === "confirmCopilot").length ===
        confirmsBeforeChat + 1,
    );
    await writeFile(
      join(directory, "copilot-chat.png"),
      (await captureFrame("copilot-chat")).toPNG(),
    );
    await auditAccessibility("copilot-chat");
    await scopedSlotControlSmoke();
    result.snapshotRaceChecks = snapshotRaceChecks;
    for (const race of snapshotRaceChecks) check(race.name, race.passed);
    await measureConversationPerformance();
    result.passed = true;
    await finish(0);
  })
  .catch((error) => finish(1, error));
