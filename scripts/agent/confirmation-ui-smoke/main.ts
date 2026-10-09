import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { AgentExecutionService } from "../../../apps/desktop/main/agent-execution";
import { freezeLaneExecution } from "../../../apps/desktop/main/lane-snapshot";
import { createFixtureSnapshot } from "../../../packages/agent/fixture";
import { AgentToolError } from "../../../packages/protocol/agent";

const directory = __dirname;
app.setPath("userData", join(directory, "profile"));
app.disableHardwareAcceleration();
const fixture = createFixtureSnapshot();
const snapshots = fixture.lanes!.lanes.map((lane, index) => {
  lane.onmyoji.enabled = false;
  lane.arknights.enabled = true;
  lane.name = `虚构测试设备 ${index + 1}`;
  return freezeLaneExecution(lane, fixture.profiles!, false, new Date());
});
let rejectValidation = true;
let clockOffset = 0;
let launches = 0;
let stops = 0;
const rejects: ((error: Error) => void)[] = [];
const evidence: Record<string, unknown> = {
  scope:
    "Isolated real Electron UI, preload IPC, PlannerExecution and AgentExecutionService; synthetic validation and executor; no game, emulator or model calls.",
  checks: [],
};
const service = new AgentExecutionService({
  now: () => new Date(Date.now() + clockOffset),
  validate: async () => {
    if (rejectValidation)
      throw new AgentToolError(
        "NOT_READY",
        "测试前置条件失败，请修正后重新检查",
      );
    return { fingerprint: "synthetic-stable", snapshots };
  },
  launch: async (items) => {
    launches++;
    return {
      jobs: items.map(({ lane }) => ({
        laneId: lane.id,
        job: new Promise<void>((_resolve, reject) => rejects.push(reject)),
      })),
    };
  },
  stop: async () => {
    stops++;
    for (const reject of rejects.splice(0)) {
      const error = new Error("Synthetic executor stopped");
      error.name = "AbortError";
      reject(error);
    }
  },
});
let window: BrowserWindow | undefined;
const check = (name: string, condition: unknown) => {
  assert.ok(condition, name);
  (evidence.checks as string[]).push(name);
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const js = (source: string) =>
  window!.webContents.executeJavaScript(source, true);
async function until(source: string, label: string) {
  for (let i = 0; i < 80; i++) {
    if (await js(`Boolean(${source})`)) return;
    await delay(100);
  }
  throw new Error(`Timeout: ${label}`);
}
const click = (id: string) =>
  js(`document.getElementById(${JSON.stringify(id)}).click()`);
async function ready(requestId?: string) {
  if (requestId)
    await js(`window.mountConfirmation(${JSON.stringify(requestId)})`);
  await until(
    'document.querySelector("#agent-execution-review:not(:disabled)")',
    "review enabled",
  );
  await click("agent-execution-review");
  await until(
    'document.querySelector("#agent-execution-consent")',
    "ready card",
  );
}
async function finish(code: number, error?: unknown) {
  if (error) {
    evidence.error = error instanceof Error ? error.stack : String(error);
    await writeFile(join(directory, "error.txt"), String(evidence.error));
  }
  evidence.launches = launches;
  evidence.stops = stops;
  evidence.finalState = service.snapshot();
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(evidence, null, 2),
  );
  await service.close();
  window?.destroy();
  app.exit(code);
}

void app
  .whenReady()
  .then(async () => {
    ipcMain.handle("review", (_event, input) => service.review(input));
    ipcMain.handle("confirm", (_event, input) => service.confirm(input));
    ipcMain.handle("snapshot", () => service.snapshot());
    ipcMain.handle("cancel", (_event, input) => service.cancel(input));
    window = new BrowserWindow({
      width: 1440,
      height: 1000,
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
    window.show();
    window.focus();
    await until(
      'document.querySelector("#agent-execution-review:not(:disabled)")',
      "initial snapshot",
    );
    check(
      "preload exposes exactly four confirmation methods",
      (await js("Object.keys(window.gamepilot).length")) === 4,
    );
    check(
      "renderer has no Node require",
      await js('typeof require === "undefined"'),
    );
    await click("agent-execution-review");
    await until(
      'document.body.innerText.includes("测试前置条件失败")',
      "blocked card",
    );
    check(
      "failed precondition displays actionable review control without launching",
      launches === 0 && service.snapshot().status === "blocked",
    );
    rejectValidation = false;
    await ready();
    check(
      "review renders two compiled account cards without launching",
      launches === 0 &&
        (await js('document.querySelectorAll(".agent-draft-lane").length')) ===
          2,
    );
    check(
      "consent required",
      await js('document.querySelector("#agent-execution-confirm").disabled'),
    );
    await click("agent-execution-confirm");
    check("disabled confirm does not launch", launches === 0);

    await js('document.querySelector("#agent-execution-consent").focus()');
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await until(
      'document.querySelector("#agent-execution-consent").checked',
      "keyboard consent",
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await until(
      'document.activeElement.id === "agent-execution-review"',
      "keyboard focus order",
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
    await until(
      'document.activeElement.id === "agent-execution-confirm"',
      "confirm keyboard focus",
    );
    check(
      "keyboard space selects consent and Tab reaches confirmation with visible focus",
      await js(
        'getComputedStyle(document.activeElement).outlineStyle !== "none"',
      ),
    );

    const layouts = [];
    for (const width of [900, 1440]) {
      window.setContentSize(width, 1000);
      await delay(200);
      const layout = await js(
        '({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll(".agent-draft-lane")].map(el => ({width:el.getBoundingClientRect().width, scrollWidth:el.scrollWidth, clientWidth:el.clientWidth}))})',
      );
      check(
        `no horizontal overflow at ${width}px`,
        layout.scrollWidth <= layout.width &&
          layout.cards.every(
            (card: any) => card.scrollWidth <= card.clientWidth + 1,
          ),
      );
      layouts.push(layout);
    }
    evidence.layouts = layouts;
    evidence.readyState = service.snapshot();
    // One capture of a visible window, bounded so GPU failures cannot strand Electron.
    try {
      const screenshot = await Promise.race([
        window.webContents.capturePage(),
        delay(8000).then(() => {
          throw new Error("Visible screenshot timeout");
        }),
      ]);
      await writeFile(join(directory, "ready-1440.png"), screenshot.toPNG());
      evidence.screenshot = "ready-1440.png";
    } catch (error) {
      evidence.screenshotError = String(error);
    }

    const confirmation = {
      requestId: service.snapshot().requestId,
      planHash: service.snapshot().planHash,
      reviewId: service.snapshot().reviewId,
    };
    await js(
      'const button = document.querySelector("#agent-execution-confirm"); button.click(); button.click();',
    );
    await until(
      'document.body.innerText.includes("停止本次任务") && !document.querySelector("#agent-execution-confirm")',
      "running controls",
    );
    await js(
      `Promise.all([window.gamepilot.confirmAgentExecution(${JSON.stringify(confirmation)}), window.gamepilot.confirmAgentExecution(${JSON.stringify(confirmation)})])`,
    );
    check(
      "double click and duplicate IPC confirmations launch one batch",
      launches === 1 && service.snapshot().status === "running",
    );
    await js("window.mountConfirmation()");
    await until(
      'document.body.innerText.includes("停止本次任务") && document.body.innerText.includes("任务记录：")',
      "running restored after remount",
    );
    check(
      "component remount restores running state and execution records",
      (await js('document.querySelectorAll(".agent-execution-id").length')) ===
        2,
    );
    await click("agent-execution-stop");
    await until(
      'document.body.innerText.includes("本次任务已停止")',
      "cancelled jobs",
    );
    check(
      "stop reaches real service and both synthetic jobs settle cancelled",
      stops === 1 &&
        service.snapshot().status === "cancelled" &&
        service.snapshot().lanes.every((lane) => lane.status === "cancelled"),
    );
    evidence.cancelledState = service.snapshot();

    await ready("ui-expiry-2");
    clockOffset = 121000;
    await js(
      "window.originalDateNow = Date.now; Date.now = () => window.originalDateNow() + 121000; true",
    );
    await until(
      'document.body.innerText.includes("确认卡已过期，请重新检查。")',
      "expired UI",
    );
    check(
      "expired card disables consent and confirm",
      await js(
        'document.querySelector("#agent-execution-consent").disabled && document.querySelector("#agent-execution-confirm").disabled',
      ),
    );
    const expired = service.snapshot();
    await js(
      `window.gamepilot.confirmAgentExecution(${JSON.stringify({ requestId: expired.requestId, planHash: expired.planHash, reviewId: expired.reviewId })})`,
    );
    check(
      "real service blocks expired IPC confirmation",
      service.snapshot().status === "blocked" && launches === 1,
    );
    clockOffset = 0;
    await js("Date.now = window.originalDateNow; true");
    await until(
      'document.querySelector("#agent-execution-review:not(:disabled)")',
      "recheck after expiry",
    );
    await ready();
    check(
      "recheck refreshes expiry ticket and clears consent",
      service.snapshot().reviewId !== expired.reviewId &&
        !(await js(
          'document.querySelector("#agent-execution-consent").checked',
        )),
    );
    await click("agent-execution-stop");
    await until(
      'document.body.innerText.includes("确认已取消")',
      "cancel ready card",
    );
    check("cancelling review does not launch executor", launches === 1);
    evidence.passed = true;
    await finish(0);
  })
  .catch((error) => finish(1, error));
