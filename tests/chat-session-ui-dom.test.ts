import { expect, it } from "vitest";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

it("uses one session workspace, preserves drafts and opens device diagnostics only on demand", async () => {
  const directory = resolve(
    "artifacts/chat-session-ui",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(join(directory, "profile"), { recursive: true });
  await build({
    entryPoints: ["tests/chat-session-fixture/renderer.tsx"],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: join(directory, "renderer.js"),
    jsx: "automatic",
    logLevel: "warning",
  });
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; connect-src \'none\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>',
  );
  const main = String.raw`
const {app,BrowserWindow}=require('electron');const {writeFile}=require('node:fs/promises');const {join}=require('node:path');const assert=require('node:assert/strict');
app.setPath('userData',join(__dirname,'profile'));app.disableHardwareAcceleration();
let window,lastSource;const checks=[],screenshots=[],captureErrors=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=source=>{lastSource=source;return window.webContents.executeJavaScript(source,true);};
async function until(source){for(let i=0;i<100;i++){if(await js('Boolean('+source+')'))return;await delay(35);}throw Error('Timeout '+source);}
async function check(label,source){assert.ok(await js(source),label);checks.push(label);}
async function input(text){await js('{const e=document.getElementById("chat-prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(text)+');e.dispatchEvent(new Event("input",{bubbles:true}));}');await delay(35);}
async function select(id){await js('window.__sessionFixture.select('+JSON.stringify(id)+')');await until('document.querySelector('+JSON.stringify('.session-task-workspace[data-session-id="'+id+'"]')+')');}
async function screenshot(name,width){window.setContentSize(width,900);await js('document.querySelector(".chat-scroll").scrollTop=0');window.webContents.invalidate();await delay(160);await check('No horizontal overflow '+name,'document.documentElement.scrollWidth<=innerWidth');await check('Composer stays visible '+name,'document.getElementById("chat-prompt").getBoundingClientRect().bottom<=innerHeight');for(let i=0;i<2;i++){try{await writeFile(join(__dirname,name),(await window.webContents.capturePage()).toPNG());screenshots.push(name);return;}catch(e){captureErrors.push({name,attempt:i+1,error:String(e)});if(i||!String(e).includes('UnknownVizError'))throw e;await delay(200);}}}
async function finish(code,error){await writeFile(join(__dirname,'result.json'),JSON.stringify({passed:!error,checks,screenshots,captureErrors,error:error?.stack,lastSource},null,2));window?.destroy();app.exit(code);}
app.whenReady().then(async()=>{
window=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});window.setMenu(null);window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}));await window.loadFile(join(__dirname,'index.html'));
await until('document.querySelector(".slots-dashboard")');
await check('Ordinary startup does not mount the chat workspace','!document.querySelector("#chat-prompt")');
await js('window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",ctrlKey:true,bubbles:true}))');
await until('[...document.querySelectorAll("dialog[open] button")].some(b=>b.textContent.includes("打开AI辅助"))');
await js('[...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent.includes("打开AI辅助")).click()');
await until('document.querySelector("[data-goal-id=own-goal]")');
await check('Twelve turns share one goal snapshot and subscriber','window.__sessionFixture.calls.filter(c=>c.method==="goalRead").length===1 && window.__sessionFixture.subscribers()===1');
await check('A session never borrows another same-turn goal','document.querySelectorAll("[data-goal-id=own-goal]").length===1 && !document.querySelector("[data-goal-id=foreign-goal]")');
await check('Independent device state is not mounted as the current chat task','!document.querySelector(".chat-lane-card") && !document.querySelector(".incident-agent-panel")');
await js('window.__sessionFixture.cancelAcceptedTurn()');await until('document.body.textContent.includes("本轮模型请求已取消")');
await check('Model cancellation never claims an accepted game goal did not start or stop','!document.body.textContent.includes("没有通过这条需求启动游戏") && document.querySelector("[data-goal-id=own-goal]").dataset.status==="waiting" && window.__sessionFixture.calls.filter(c=>c.method==="cancelGoal").length===0');
await screenshot('waiting-1440.png',1440);await screenshot('waiting-1000.png',1000);
await js('document.getElementById("chat-trajectory-tab").click()');await until('document.querySelector("#chat-trajectory-panel:not([hidden])")');
await check('Trajectory reuses the one goal controller','window.__sessionFixture.calls.filter(c=>c.method==="goalRead").length===1 && window.__sessionFixture.subscribers()===1');
await js('document.getElementById("chat-conversation-tab").click()');
await input('账号一的未发送草稿');await select('session-b');await input('账号二的未发送草稿');await select('session-a');
await check('Switching sessions restores its own draft','document.getElementById("chat-prompt").value==="账号一的未发送草稿"');
await js('document.getElementById("chat-send").click()');await until('window.__sessionFixture.calls.some(c=>c.method==="send")');
await select('session-b');await js('window.__sessionFixture.releaseSend()');await delay(100);
await check('A send receipt only clears the submitted session draft','document.getElementById("chat-prompt").value==="账号二的未发送草稿"');await select('session-a');
await check('Submitted A draft clears after its successful receipt','document.getElementById("chat-prompt").value===""');
await js('window.__sessionFixture.busyInB()');await until('document.body.innerText.includes("查看正在处理的会话")');
await check('Stop action identifies the other model session','document.querySelector("button[aria-label=\\"停止“另一条会话的任务”的模型请求\\"]") && !document.querySelector("button[aria-label=\\"停止当前规划\\"]")');
await js('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("查看正在处理的会话")).click()');await until('document.querySelector(".session-task-workspace[data-session-id=\\"session-b\\"]")');
await check('Busy-session jump changes only the selected conversation','window.__sessionFixture.calls.filter(c=>["cancelModel","cancelGoal"].includes(c.method)).length===0');
await js('document.querySelector("button[aria-label=\\"停止当前规划\\"]").click()');await until('window.__sessionFixture.calls.some(c=>c.method==="cancelModel")');await select('session-a');
await js('window.__sessionFixture.publish("needs-user")');await until('document.querySelector(".session-task-workspace[data-task-tone=attention]")');
await check('Needs-user shows host result and a correction action','document.querySelector(".session-task-workspace").innerText.includes("需要你处理") && [...document.querySelectorAll(".session-task-workspace button")].some(b=>b.textContent.includes("继续沟通"))');
await screenshot('needs-user-compact-1440.png',1440);await screenshot('needs-user-compact-1000.png',1000);
await js('document.querySelector(".session-task-workspace").scrollIntoView({block:"start"});document.querySelector("[data-goal-id=own-goal] .chat-record-details").open=true');await delay(100);
await check('Observed reward effect never becomes whole-task completion','document.querySelector("[data-goal-id=own-goal] .chat-effect-evidence > summary").textContent.includes("已观察到的业务效果") && document.querySelector("[data-goal-id=own-goal]").dataset.resultVerified==="false"');
await screenshot('needs-user-1440.png',1440);await screenshot('needs-user-1000.png',1000);
await js('window.__sessionFixture.publish("completed",null)');await until('document.querySelector(".session-task-workspace[data-task-tone=attention]")');
await check('Completed flow with unknown satisfaction stays unconfirmed','document.querySelector("[data-goal-id=own-goal]").dataset.resultVerified==="false" && !document.querySelector(".session-task-workspace[data-task-tone=success]")');
await js('window.__sessionFixture.publish("completed",true)');await until('document.querySelector(".session-task-workspace[data-task-tone=success]")');
await check('Only verified completion receives success styling','document.querySelector("[data-goal-id=own-goal]").dataset.resultVerified==="true"');
await js('document.querySelector(".chat-device-tasks > summary").click()');await until('document.querySelector(".chat-lane-card[data-lane-id=lane-b]")');
await check('Closed per-device details do not poll diagnosis','window.__sessionFixture.calls.filter(c=>c.method==="diagnosticRead").length===0');
await js('document.querySelector(".chat-lane-card[data-lane-id=lane-b] .chat-lane-details > summary").click()');await until('document.querySelector(".incident-agent-panel")');await until('window.__sessionFixture.calls.some(c=>c.method==="diagnosticRead")');
await js('document.querySelector(".chat-lane-card[data-lane-id=lane-b] .chat-lane-details > summary").click()');await until('!document.querySelector(".incident-agent-panel")');const before=await js('window.__sessionFixture.calls.filter(c=>c.method==="diagnosticRead").length');await delay(1100);
await check('Closing diagnostics removes its polling timer','window.__sessionFixture.calls.filter(c=>c.method==="diagnosticRead").length==='+before);
await check('Advanced reference data retains all original data modes','document.querySelector("select[aria-label=\\"参考数据\\"]").options.length===3 && !document.querySelector("select[aria-label=\\"任务范围\\"]")');
await js('window.__sessionFixture.publish("waiting")');await until('[...document.querySelectorAll("[data-goal-id=own-goal] button")].some(b=>b.textContent.includes("停止目标"))');
await js('[...document.querySelectorAll("[data-goal-id=own-goal] button")].find(b=>b.textContent.includes("停止目标")).click()');await until('window.__sessionFixture.calls.some(c=>c.method==="cancelGoal")');
await select('session-b');await select('session-a');await js('window.__sessionFixture.releaseCancel()');
await until('[...document.querySelectorAll("[data-goal-id=own-goal] button")].some(b=>b.textContent.includes("停止目标") && !b.disabled)');
await check('A pending Stop never stays disabled after A to B to A and its receipt','window.__sessionFixture.calls.filter(c=>c.method==="cancelGoal").length===1 && [...document.querySelectorAll("[data-goal-id=own-goal] button")].some(b=>b.textContent.includes("停止目标") && !b.disabled)');
await check('Renderer has no Node access or unsupported execution calls','typeof require==="undefined" && window.__sessionFixture.calls.filter(c=>c.method==="forbidden").length===0');
await finish(0);
}).catch(error=>finish(1,error));
`;
  await writeFile(join(directory, "main.cjs"), main);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const result = await new Promise<{ code: number | null; output: string }>(
    (done, fail) => {
      const child = spawn(
        createRequire(import.meta.url)("electron"),
        [join(directory, "main.cjs")],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: environment,
        },
      );
      let output = "";
      child.stdout.on("data", (v) => (output += v));
      child.stderr.on("data", (v) => (output += v));
      const timer = setTimeout(() => {
        child.kill();
        fail(Error(`Isolated session UI timed out: ${output}`));
      }, 45000);
      child.once("error", (e) => {
        clearTimeout(timer);
        fail(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        done({ code, output });
      });
    },
  );
  const evidence = JSON.parse(
    await readFile(join(directory, "result.json"), "utf8"),
  );
  expect(
    evidence.passed,
    `${evidence.error ?? result.output}\nEvidence: ${directory}`,
  ).toBe(true);
  expect(result.code).toBe(0);
  expect(evidence.checks.length).toBeGreaterThanOrEqual(25);
}, 60000);
