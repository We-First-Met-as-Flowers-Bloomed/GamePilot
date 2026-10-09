import { expect, it } from "vitest";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

it("uses the mounted Electron chat controls without replaying models, games or archived turns", async () => {
  const directory = resolve(
    "artifacts/chat-command-ui",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  await mkdir(join(directory, "profile"), { recursive: true });
  await build({
    entryPoints: ["tests/chat-ui-fixture/renderer.tsx"],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: join(directory, "renderer.js"),
    jsx: "automatic",
    logLevel: "warning",
  });
  await writeFile(
    join(directory, "index.html"),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>',
  );
  const main = String.raw`
const {app,BrowserWindow}=require('electron'); const {writeFile}=require('node:fs/promises'); const {join}=require('node:path'); const assert=require('node:assert/strict');
app.setPath('userData',join(__dirname,'profile'));app.disableHardwareAcceleration();
let window,lastSource;const checks=[];const delay=ms=>new Promise(r=>setTimeout(r,ms));
const js=source=>{lastSource=source;return window.webContents.executeJavaScript(source,true);};
async function until(source){for(let i=0;i<100;i++){if(await js('Boolean('+source+')'))return;await delay(30);}throw Error('Timeout '+source);}
async function check(label,source){assert.ok(await js(source),label);checks.push(label);}
const click=text=>js('([...document.querySelectorAll("button")].find(el=>el.textContent.trim()==='+JSON.stringify(text)+')||(()=>{throw Error("missing button")})()).click()');
async function input(text){await js('{const e=document.getElementById("chat-prompt");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,'+JSON.stringify(text)+');e.dispatchEvent(new Event("input",{bubbles:true}));}');await delay(30);}
const select=(label,id)=>js('{const e=document.querySelector('+JSON.stringify('select[aria-label="'+label+'"]')+');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(e,'+JSON.stringify(id)+');e.dispatchEvent(new Event("change",{bubbles:true}));}');
async function menu(text){await js('document.querySelector("#chat-tools-menu").open=true');await click(text);}
const callCount=method=>'window.__chatFixture.calls.filter(x=>x.method==='+JSON.stringify(method)+').length';
async function capture(name,width,target){window.setContentSize(width,850);if(target)await js('document.querySelector('+JSON.stringify(target)+').scrollIntoView({block:"end"})');window.webContents.invalidate();await delay(150);await check('No horizontal overflow at '+width,'document.documentElement.scrollWidth<=innerWidth');await writeFile(join(__dirname,name),(await window.webContents.capturePage()).toPNG());}
async function finish(code,error){await writeFile(join(__dirname,'result.json'),JSON.stringify({passed:!error,checks,error:error?.stack,lastSource},null,2));window?.destroy();app.exit(code);}
app.whenReady().then(async()=>{
 window=new BrowserWindow({show:false,width:1440,height:850,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});window.setMenu(null);await window.loadFile(join(__dirname,'index.html'));
 await until('document.querySelector("#chat-send")');
 await check('Chat and trajectory share one accessible workspace','document.querySelector("[role=tablist][aria-label=\\"对话与轨迹\\"]") && document.querySelectorAll("#chat-prompt").length===1');
 await click('轨迹');await until('document.querySelector("#chat-trajectory-panel:not([hidden])")');await check('Empty trajectory never invents model or game work','document.querySelector("#chat-trajectory-panel").innerText.includes("还没有调用记录") && '+callCount('model')+'===0 && '+callCount('review')+'===0');
 await input('运行保存的日常');await click('对话');await check('Switching tabs preserves the single composer draft','document.querySelector("#chat-prompt").value==="运行保存的日常"');
 await js('document.getElementById("chat-send").click()');await until('document.querySelector(".chat-command-card")');
 await check('Saved command is reviewed without model or execution',callCount('review')+'===1 && '+callCount('model')+'===0 && '+callCount('confirm')+'===0');
 await check('Host defaults precede confirmation','document.querySelector(".chat-command-card").innerText.includes("LS-6，零药零源石") && document.querySelector(".chat-command-card").innerText.includes("花合战最后")');
 await until('document.querySelector(".chat-command-card [data-agent-event-seq]")');await check('Saved command mounts the host timeline','document.querySelector(".chat-command-card .chat-tool-trace").textContent.includes("宿主已核对默认步骤清单")');
 await capture('review-1440.png',1440);
 await js('window.__chatFixture.journalError("合成过程记录写入失败，请以原账本核对")');await until('document.querySelector(".chat-command-card [role=alert]")');await check('Journal write failure is immediately visible','document.querySelector(".chat-command-card [role=alert]").textContent.includes("合成过程记录写入失败")');
 await js('{const b=[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="确认运行保存日常");b.click();b.click();}');await until('document.querySelector(".chat-command-card[data-status=submitted]")');
 await check('Double click submits exactly one confirmation',callCount('confirm')+'===1');
 await menu('继续原失败请求');await until('document.querySelector("select[aria-label=\\"选择需要续跑的原请求\\"]")');
 await check('Continuation never defaults to an arbitrary request','document.querySelector("select[aria-label=\\"选择需要续跑的原请求\\"]").value==="" && [...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="检查原请求剩余步骤").disabled');
 await select('选择需要续跑的原请求','original-a');await delay(30);await click('检查原请求剩余步骤');await until('document.querySelector(".chat-command-acknowledgement")');
 await check('Partial step acknowledgement is mandatory','[...document.querySelectorAll("button")].find(el=>el.textContent.trim()==="确认续跑原请求").disabled');
 await js('document.querySelector(".chat-command-acknowledgement input").click()');await delay(30);await click('确认续跑原请求');await until(callCount('confirm')+'===2');
 await check('Continuation confirmation carries exact parent and acknowledgement','window.__chatFixture.calls.filter(x=>x.method==="review")[1].input.requestId==="original-a" && window.__chatFixture.calls.filter(x=>x.method==="confirm")[1].input.acknowledgePartial===true');
 await until('document.querySelectorAll(".chat-command-card[data-status=submitted]").length===2');
 await js('window.__chatFixture.busy(true)');await until('document.querySelector(".chat-thinking")');await menu('当前步骤结束后暂停');await until('document.querySelector("select[aria-label=\\"选择暂停请求\\"]")');await select('选择暂停请求','running-b');await delay(30);await click('请求步骤结束后暂停');await until('document.querySelector(".chat-pause-receipt")');
 await check('Busy pause names exact request and remains queued','window.__chatFixture.calls.find(x=>x.method==="pause").input.requestId==="running-b" && document.querySelector(".chat-pause-receipt").dataset.pauseStatus==="queued" && document.querySelector(".chat-pause-receipt").innerText.includes("尚未确认暂停生效")');
 await js('window.__chatFixture.correction("wrong-request","running-b");window.__chatFixture.correction("running-b","wrong-run");window.__chatFixture.correction("running-b","running-b","cancelled","game-result")');await delay(40);await check('Unrelated or cancelled events cannot apply queued pause','document.querySelector(".chat-pause-receipt").dataset.pauseStatus==="queued"');
 await js('window.__chatFixture.correction("running-b","running-b")');await until('document.querySelector(".chat-pause-receipt").dataset.pauseStatus==="applied"');await check('Exact succeeded boundary correction applies pause','document.querySelector(".chat-pause-receipt").innerText.includes("已在步骤边界暂停")');
 await input('/stop');await js('document.getElementById("chat-prompt").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');await until(callCount('stop')+'===1');await check('Stop bypasses model busy and cancels exact request','window.__chatFixture.calls.find(x=>x.method==="cancel").input==="model-busy"');
 await js('document.querySelector(".chat-archives").open=true');await until('document.querySelector(".chat-archive-list button")');await click('更多归档会话');await until('document.querySelectorAll(".chat-archive-list button").length===2');
 await check('Archive index cursor is passed exactly','window.__chatFixture.calls.filter(x=>x.method==="list")[1].input.cursor==="list-next"');
 await js('document.querySelector(".chat-archive-list button").click()');await until('document.querySelector(".chat-archive-turn")');await click('继续读取归档对话');await until('document.querySelectorAll(".chat-archive-turn").length===2');
 await check('Archive turn pagination appends original text without executable controls','document.querySelector(".chat-archive-transcript").innerText.includes("归档原文 turn-one") && document.querySelector(".chat-archive-transcript").innerText.includes("归档原文 turn-two") && !document.querySelector(".chat-archive-transcript button") && '+callCount('model')+'===0 && '+callCount('confirm')+'===2');
 await js('window.__chatFixture.failLoad(true);document.querySelectorAll(".chat-archive-list button")[1].click()');await until('document.querySelector(".chat-archives [role=alert]")');await check('Read failure preserves live original turn','document.querySelector(".chat-archives [role=alert]").innerText.includes("合成归档读取失败") && window.__chatFixture.current().sessions[0].turns.length===1');
 await js('window.__chatFixture.failArchive(true)');await click('归档当前会话');await until('document.querySelector(".chat-archives [role=alert]").innerText.includes("归档未完成")');await check('Write failure retains current session','window.__chatFixture.current().selectedSessionId==="session-a" && window.__chatFixture.current().sessions[0].turns.length===1');
 await capture('archives-1440.png',1440,'.chat-archives');await capture('archives-900.png',900,'.chat-archives');
 await js('window.__chatFixture.failArchive(false)');await click('归档当前会话');await until('window.__chatFixture.current().selectedSessionId==="session-b"');await until('!document.querySelector(".chat-command-card")');
 await check('Committed archive opens clean session without replay','window.__chatFixture.current().sessions[0].turns.length===0 && '+callCount('confirm')+'===2 && '+callCount('model')+'===0');
 await input('请运行保存的日常，并说明当前账号任务差异。');await js('document.querySelector("#chat-send").click()');await until(callCount('model')+'===1');await check('A complete sentence still goes to model',callCount('review')+'===2');
 await js('window.__chatFixture.intent()');await until(callCount('intentReview')+'===1');await until('document.querySelector(".chat-command-card[data-intent-turn-id]")');
 await check('Natural intent asks the host to resolve one exact model turn without rewriting text','JSON.stringify(window.__chatFixture.calls.find(x=>x.method==="intentReview").input)===JSON.stringify({sessionId:"session-b",turnId:"intent-current",requestId:"model-intent-current"}) && '+callCount('confirm')+'===2');
 await js('window.__chatFixture.replayCurrent()');await delay(80);await check('Repeated snapshots never repeat an intent review',callCount('intentReview')+'===1');
 await input('继续看看当前进度');await click('轨迹');await until('document.querySelector("#chat-trajectory-panel [data-agent-call-id=\\"real-public-call\\"]")');
 await js('document.querySelector("#chat-trajectory-panel .agent-call-details").open=true');
 await check('Trajectory joins public arguments, returned facts and measured duration','document.querySelector("#chat-trajectory-panel").innerText.includes("调用参数") && document.querySelector("#chat-trajectory-panel").innerText.includes("enabledLanes") && document.querySelector("#chat-trajectory-panel").innerText.includes("1.25 秒") && document.querySelectorAll("#chat-trajectory-panel [data-agent-call-id=\\"real-public-call\\"]").length===1');
 await check('Historic duration stays explicitly unrecorded','document.querySelector("#chat-trajectory-panel [data-agent-call-id=\\"historic-call\\"]").innerText.includes("耗时未记录")');
 await js('window.__chatFixture.publishGameProgress()');await until('document.querySelector(".trajectory-turn[data-trajectory-turn-id=\\"intent-current\\"]").innerText.includes("本轮账号一正在执行 LS-6")');
 await check('Trajectory links game children through the exact origin review','document.querySelector(".trajectory-turn[data-trajectory-turn-id=\\"intent-current\\"] [data-command-review-id]") && !document.querySelector("#chat-trajectory-panel [data-command-review-id=\\"review-1\\"]")');
 await until('document.querySelector(".trajectory-host-commands")');await check('Legacy standalone commands stay visible without pretending to belong to a model turn','document.querySelector(".trajectory-host-commands").innerText.includes("宿主指令") && document.querySelector(".trajectory-host-commands").innerText.includes("旧精确保存日常命令")');
 await check('Non-tool event text starts next to its icon and leaves its time on the right','(()=>{const row=[...document.querySelectorAll("#chat-trajectory-panel .agent-event-timeline > li")].find(e=>e.querySelector(":scope > span")?.textContent.includes("本轮账号一正在执行 LS-6"));const icon=row.querySelector(":scope > svg").getBoundingClientRect(),text=row.querySelector(":scope > span").getBoundingClientRect(),time=row.querySelector(":scope > time").getBoundingClientRect();return text.left-icon.right<=12 && time.left>=text.right && parseFloat(getComputedStyle(row.querySelector(":scope > span")).fontSize)>=11;})()');
 await capture('event-rows-1440.png',1440,'.trajectory-command');await capture('event-rows-900.png',900,'.trajectory-command');
 await js('document.querySelector(".chat-scroll").scrollTop=0');await capture('trajectory-1440.png',1440);await capture('trajectory-900.png',900);
 await check('Trajectory scrolling keeps the shared composer in the window','document.querySelector(".chat-composer-wrap").getBoundingClientRect().bottom<=innerHeight && document.getElementById("chat-prompt").getBoundingClientRect().height>0');
 await js('document.getElementById("chat-trajectory-tab").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}))');await until('document.getElementById("chat-conversation-tab").getAttribute("aria-selected")==="true"');
 await check('Keyboard navigation returns to conversation without losing draft or confirming','document.activeElement.id==="chat-conversation-tab" && document.getElementById("chat-prompt").value==="继续看看当前进度" && '+callCount('confirm')+'===2');
 await js('window.__chatFixture.intent("saved-daily","fixture")');await delay(120);await check('Rehearsal model intents never obtain a host review',callCount('intentReview')+'===1');
 await finish(0);
}).catch(error=>finish(1,error));
`;
  await writeFile(join(directory, "main.cjs"), main);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const processResult = await new Promise<{
    code: number | null;
    output: string;
  }>((done, fail) => {
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
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const timer = setTimeout(() => {
      child.kill();
      fail(Error(`Isolated chat DOM test timed out: ${output}`));
    }, 45000);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({ code, output });
    });
  });
  const result = JSON.parse(
    await readFile(join(directory, "result.json"), "utf8"),
  );
  expect(
    result.passed,
    `${result.error ?? processResult.output}\nEvidence: ${directory}`,
  ).toBe(true);
  expect(processResult.code).toBe(0);
  expect(result.checks.length).toBeGreaterThanOrEqual(15);
}, 60000);
