import type { BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PlannerService } from "./agent-planner";
import { createAgentTools } from "../../../packages/agent/tools";
import { createFixtureSnapshot } from "../../../packages/agent/fixture";
import { PlannerSession } from "../../../packages/agent/planner";
import { plannerProfile } from "../../../games/agent-configuration";

// Deterministic UI transport fixture. Never selected in normal or preview mode.
export function plannerUiFixture() {
  const configured = createFixtureSnapshot();
  configured.source = "configured";
  configured.historyAvailable = false;
  configured.requests = [];
  configured.tasks = [];
  configured.profiles!.profiles = configured.profiles!.profiles.map((p) =>
    plannerProfile(p, p.id),
  );
  const recorded = createFixtureSnapshot();
  recorded.source = "recorded";
  recorded.historyAvailable = true;
  return new PlannerService({
    readConfigured: async (history) => ({
      snapshot: history ? recorded : configured,
      fingerprint: "ui-replay",
    }),
    find: async () => "ui-fixture",
    run: async (options) => {
      options.onProgress?.({ phase: "thinking" });
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const tools = createAgentTools(options.snapshot);
      const session = new PlannerSession(tools, options.at);
      if (options.snapshot.source === "recorded") {
        session.call("ui-env", "get_environment", {});
        for (const request of options.snapshot.requests)
          session.call(request.id, "get_run", { requestId: request.id });
        return {
          ...session.finish(
            JSON.stringify({
              kind: "answer",
              text: "界面回放：原请求结果未知，不能判定每日任务完成。没有调用模型或运行游戏。",
              planHash: null,
            }),
          ),
          model: "ui-fixture",
          codexVersion: "replay",
          elapsedMs: 2200,
        };
      }
      const input = {
        catalogRevision: tools.call("list_capabilities").revision,
        environmentRevision: tools.call("get_environment").revision,
        at: options.at,
        lanes: ["lane-a", "lane-b"].map((laneId) => ({
          laneId,
          games: [
            { gameId: "arknights", parameters: { stage: "LS-6", mail: true } },
          ],
        })),
      };
      const compiled = JSON.parse(
        session.call("ui-fixture-plan", "compile_plan", input).contentItems[0]
          .text,
      );
      return {
        ...session.finish(
          JSON.stringify({
            kind: "draft",
            text: "界面回放：两个演练账号使用现有理智刷 LS-6，领取邮件。没有调用模型或运行游戏。",
            planHash: compiled.planHash,
          }),
        ),
        model: "ui-fixture",
        codexVersion: "replay",
        elapsedMs: 2200,
      };
    },
  });
}

/** Explicit isolated developer test. Model calls occur only with --planner-ui-test. */
export async function runPlannerUiSmoke(
  window: BrowserWindow,
  evidence: string,
  liveModel: boolean,
  configuredMode = false,
  recordedMode = false,
) {
  const sourceMode = recordedMode
    ? "recorded"
    : configuredMode
      ? "configured"
      : "fixture";
  const resultSelector = recordedMode ? ".agent-records" : ".agent-draft";
  await mkdir(evidence, { recursive: true });
  const first = await window.webContents.executeJavaScript(`(async () => {
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const wait = async (check, timeout = 15000) => { const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw Error('UI condition timed out'); await pause(100); } };
    const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
    await wait(() => button('每日计划与开关'));
    button('每日计划与开关').click();
    await wait(() => button('双账号方舟日常') && !button('双账号方舟日常').disabled);
    const api = window.gamepilot;
    const before = JSON.stringify([await api.deviceLanes(), await api.arknights()]);
    if (!(await api.snapshot()).plannerPreview) throw Error('not isolated preview');
    let gameRejected = false;
    try { await api.startLanes('planner-ui-forbidden'); } catch { gameRejected = true; }
    if (!gameRejected) throw Error('preview allows game execution');
    const executionTarget = { requestId: 'preview-confirmation-check', planHash: 'a'.repeat(64) };
    const checkedExecution = await api.reviewAgentExecution(executionTarget);
    if (checkedExecution.status !== 'blocked') throw Error('preview permits execution review');
    let confirmationRejected = false;
    try { await api.confirmAgentExecution({...executionTarget, reviewId:'forbidden'}); } catch { confirmationRejected = true; }
    if (!confirmationRejected || (await api.agentExecutionSnapshot()).batchId) throw Error('preview allows confirmed execution');
    document.querySelector('#agent-planner').open = true;
    const source = document.querySelector('#agent-source');
    source.value = ${JSON.stringify(sourceMode)}; source.dispatchEvent(new Event('change', {bubbles:true})); await pause(100);
    button(${JSON.stringify(recordedMode ? "查询最近执行结果" : "双账号方舟日常")}).click(); await pause(100);
    button('发送需求').click();
    await wait(() => button('取消规划') && !button('取消规划').disabled);
    button('取消规划').click();
    await wait(async () => (await api.plannerSnapshot()).status === 'cancelled');
    await wait(() => button('发送需求') && !button('发送需求').disabled);
    button('发送需求').click();
    await wait(async () => (await api.plannerSnapshot()).status === 'running');
    const requestId = (await api.plannerSnapshot()).requestId;
    button('设备与账号').click(); await pause(250); button('每日计划与开关').click(); await pause(1200);
    document.querySelector('#agent-planner').open = true;
    await wait(() => button('取消规划'));
    if ((await api.plannerSnapshot()).requestId !== requestId) throw Error('navigation replaced planning job');
    if (document.querySelector('#agent-source').value !== ${JSON.stringify(sourceMode)}) throw Error('source not restored');
    document.querySelector('#agent-planner').scrollIntoView({block:'start'});
    return { requestId, before, gameRejected, confirmationRejected, cancelVerified: true, navigationVerified: true };
  })()`);
  const capture = async (name: string) => {
    // Hidden Chromium windows can return the previous composited frame first.
    await window.webContents.capturePage();
    await window.webContents.executeJavaScript(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await writeFile(
      join(evidence, name),
      (await window.webContents.capturePage()).toPNG(),
    );
  };
  await capture("planning.png");
  // Preserve non-draft answers too, so a model clarification is diagnosable.
  const observed = await window.webContents.executeJavaScript(`(async () => {
    const start = Date.now(); let state;
    do { state = await window.gamepilot.plannerSnapshot(); if (!['running','cancelling'].includes(state.status)) break; await new Promise(r => setTimeout(r, 500)); } while (Date.now() - start < 210000);
    return state;
  })()`);
  await writeFile(
    join(evidence, "planner-result.json"),
    JSON.stringify(observed, null, 2),
  );
  const result = await window.webContents.executeJavaScript(`(async () => {
    const api = window.gamepilot;
    const start = Date.now();
    let state;
    do { state = await api.plannerSnapshot(); if (!['running','cancelling'].includes(state.status)) break; await new Promise(r => setTimeout(r, 500)); } while (Date.now() - start < 210000);
    if (state.status !== 'completed' || state.result?.status !== ${JSON.stringify(recordedMode ? "answer" : "draft")}) throw Error('Model did not produce expected result: ' + JSON.stringify(state.error ?? {status: state.result?.status, text: state.result?.modelText}));
    if (state.result.source !== ${JSON.stringify(sourceMode)}) throw Error('incorrect result source');
    await new Promise(r => setTimeout(r, 1400));
    const cards = document.querySelectorAll('.agent-draft-lane');
    if (${recordedMode} ? cards.length < 1 || !state.result.records?.length || state.result.draft || state.result.trace.some(t => t.tool === 'compile_plan') : cards.length !== 2 || !document.querySelector('.agent-checks')) throw Error('Result cards/checks missing or query compiled a plan');
    if (!${recordedMode} && state.result.draft.lanes.some(l => l.games.some(g => g.plan.gameId !== 'arknights' || g.parameters.medicine !== 0 || g.parameters.stone !== 0 || g.parameters.expiringMedicine !== 0 || (!${configuredMode} && (g.parameters.stage !== 'LS-6' || g.parameters.mail !== true))))) throw Error('Incorrect draft parameters');
    if (${configuredMode} && !document.querySelector('.agent-draft').textContent.includes('当前配置')) throw Error('missing configured label');
    const after = JSON.stringify([await api.deviceLanes(), await api.arknights()]);
    document.querySelector(${JSON.stringify(resultSelector)}).scrollIntoView({block:'start'});
    return { state, after, cards: cards.length, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  if (first.before !== result.after)
    throw new Error("Planning changed account configuration");
  if (result.overflow) throw new Error("Wide layout overflows");
  await capture("draft-wide.png");
  window.setSize(1000, 900);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const narrow = await window.webContents.executeJavaScript(`(() => {
    document.querySelector(${JSON.stringify(resultSelector)}).scrollIntoView({block:'start'});
    return { overflow: document.documentElement.scrollWidth > innerWidth, columns: getComputedStyle(document.querySelector(${JSON.stringify(recordedMode ? ".agent-records" : ".agent-draft-lanes")})).gridTemplateColumns.split(' ').length };
  })()`);
  if (narrow.overflow || narrow.columns !== 1)
    throw new Error("Narrow layout failed");
  await capture("draft-narrow.png");
  const edits = await window.webContents.executeJavaScript(`(async () => {
    const source = document.querySelector('#agent-source');
    const original = source.value;
    source.value = original === 'fixture' ? 'configured' : 'fixture'; source.dispatchEvent(new Event('change', {bubbles:true}));
    await new Promise(r => setTimeout(r, 100));
    if (document.querySelector(${JSON.stringify(resultSelector)})) throw Error('Source switch kept old result');
    source.value = original; source.dispatchEvent(new Event('change', {bubbles:true}));
    await new Promise(r => setTimeout(r, 100));
    if (!document.querySelector(${JSON.stringify(resultSelector)})) throw Error('Result not restored for unchanged original source');
    const field = document.querySelector('#agent-prompt');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(field, field.value + ' 只安排一个账号'); field.dispatchEvent(new Event('input', {bubbles:true}));
    await new Promise(r => setTimeout(r, 100));
    const hidden = !document.querySelector(${JSON.stringify(resultSelector)});
    if (!hidden || !document.body.textContent.includes('需求或时间已修改')) throw Error('Stale draft still visible');
    const summary = document.querySelector('#agent-planner > summary'); summary.focus();
    return { staleHidden: hidden, sourceSwitchVerified: true, keyboardFocus: document.activeElement === summary };
  })()`);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        validation: liveModel ? "live-model" : "ui-replay",
        ...first,
        before: undefined,
        ...result,
        after: undefined,
        narrow,
        ...edits,
      },
      null,
      2,
    ),
  );
}
