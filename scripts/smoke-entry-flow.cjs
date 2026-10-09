// Renderer-only navigation regression. All APIs are in-memory; no devices,
// provider requests, production profile files, or execution paths are loaded.
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const out = path.join(
  root,
  "artifacts/entry-flow",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
app.setPath("userData", path.join(out, "profile"));
app.commandLine.appendSwitch("force-device-scale-factor", "1");
const timeout = setTimeout(() => app.exit(1), 60_000);
app.whenReady().then(async () => {
  try {
    await mkdir(out, { recursive: true });
    await build({
      entryPoints: [path.join(root, "apps/desktop/renderer/main.tsx")],
      bundle: true,
      platform: "browser",
      jsx: "automatic",
      outfile: path.join(out, "renderer.js"),
      logLevel: "warning",
    });
    await writeFile(
      path.join(out, "index.html"),
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>',
    );
    await build({
      stdin: {
        resolveDir: root,
        contents: `
      import { games } from './games/registry';
      import { defaultArknightsProfiles } from './games/arknights/config';
      const {contextBridge}=require('electron');
      const calls=[];
      let settings={adbPath:'D:/Fake/adb.exe',address:'127.0.0.1:5555',modelEndpoint:'legacy-endpoint',modelName:'legacy-model'};
      const provider={provider:'compatible',baseUrl:'https://mock.invalid',model:'mock-model',revision:'r1',hasApiKey:true,encryptionAvailable:true};
      contextBridge.exposeInMainWorld('gamepilot',{
        snapshot:async()=>({games,settings,engine:null,events:[]}),
        deviceLanes:async()=>({version:1,lanes:[0,1].map(i=>({id:'test-'+i,name:'隔离账号 '+(i+1),instance:i,managerPath:'D:/Fake/MuMuManager.exe',enabled:true,arknights:{enabled:true,profileId:'default'},onmyoji:{enabled:false},closeEmulatorAfterSuccess:false}))}),
        arknights:async()=>defaultArknightsProfiles,
        automation:async()=>undefined,
        plannerSnapshot:async()=>({revision:0,status:'idle'}),
        agentExecutionSnapshot:async()=>({revision:0,status:'idle',message:'',lanes:[]}),
        modelProvider:async()=>provider,
        testModelProvider:async()=>{calls.push('testModelProvider');return {model:'mock-model',elapsedMs:12,checkedAt:new Date().toISOString()};},
        saveSettings:async value=>{calls.push('saveSettings');settings=value;return settings;},
        connect:async()=>{calls.push('connect');throw Error('Unexpected connect');},
        start:async()=>{calls.push('start');throw Error('Unexpected execution');},
        startPlanner:async()=>{calls.push('startPlanner');throw Error('Unexpected planning');},
        onEvent:()=>()=>{}
      });
      contextBridge.exposeInMainWorld('entryTest',{calls:()=>calls,settings:()=>settings});
    `,
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      outfile: path.join(out, "preload.cjs"),
      logLevel: "warning",
    });
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(out, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    const errors = [];
    win.webContents.on("console-message", ({ level, message }) => {
      if (
        ["warning", "error"].includes(level) &&
        !message.includes("Electron Security Warning")
      ) {
        errors.push(message);
        console.error(message);
      }
    });
    await win.loadFile(path.join(out, "index.html"));
    const setup = `
      window.waitEntry=()=>new Promise(r=>setTimeout(r,120));
      window.assertEntry=(ok,message)=>{if(!ok)throw Error(message);};
      window.clickEntry=async text=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===text);assertEntry(b&&!b.disabled,'Missing action '+text);b.click();await waitEntry();};
      window.fillEntry=async(id,value)=>{const field=document.getElementById(id);assertEntry(field,'Missing field '+id);const proto=field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));await waitEntry();};
      true;
    `;
    await win.webContents.executeJavaScript(setup);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      await waitEntry();
      const planner=document.getElementById('agent-planner');
      assertEntry(planner.getBoundingClientRect().bottom<innerHeight,'AI entry must be discoverable on the first screen');
      planner.querySelector('summary').click();await waitEntry();
      assertEntry(planner.open&&document.activeElement.id==='agent-prompt','Daily AI panel must expand and focus the prompt');
      planner.querySelector('summary').click();await waitEntry();
      await clickEntry('AI 规划');
      assertEntry(planner.open,'AI action must expand the planner');
      assertEntry(document.activeElement.id==='agent-prompt','AI action must focus its actual input');
      await fillEntry('agent-prompt','只检查已保存配置，不启动游戏');
      assertEntry(document.getElementById('agent-source').value==='fixture','Navigation must preserve the safe default source');
      await clickEntry('模型连接');
      await clickEntry('测试已保存连接');
      assertEntry(document.body.innerText.includes('连接测试通过'),'Mock connection result must be visible');
      await clickEntry('进入 AI 规划');
      assertEntry(document.getElementById('agent-planner').open&&document.activeElement.id==='agent-prompt','Model success action must reach and focus the planner');
      await clickEntry('单设备工具');
      assertEntry(!document.body.innerText.includes('AI 规划尚未接入'),'Workspace must not say AI is unavailable');
      assertEntry(document.body.innerText.includes('单设备日常'),'Existing single-device functions must remain reachable');
      assertEntry(![...document.querySelectorAll('.sidebar button')].some(b=>b.textContent.trim()==='单项任务＋'),'Duplicate single task entry must be removed');
      await clickEntry('设置');
      assertEntry(![...document.querySelectorAll('label')].some(l=>l.getClientRects().length&&l.textContent.includes('ADB 程序路径')),'Settings must not duplicate the connection form');
      await clickEntry('打开高级连接');
      assertEntry(document.getElementById('device-advanced').open,'Connection deep link must expand advanced tools');
      assertEntry(document.activeElement.id==='device-adb-path','Connection deep link must focus its actual input');
      await fillEntry('device-adb-path','D:/TestOnly/adb.exe');
      await fillEntry('device-address','127.0.0.1:16666');
      await clickEntry('保存连接设置');
      const saved=window.entryTest.settings();
      assertEntry(saved.adbPath==='D:/TestOnly/adb.exe'&&saved.address==='127.0.0.1:16666','Advanced form must save the edited settings');
      assertEntry(saved.modelEndpoint==='legacy-endpoint'&&saved.modelName==='legacy-model','Saving must preserve unrelated settings');
      assertEntry(JSON.stringify(window.entryTest.calls())==='["testModelProvider","saveSettings"]','Navigation or settings saving must not connect devices or plan/execute tasks');
      return {passed:true,checks:['first-screen AI entry','daily panel expand and focus','sidebar expand and focus','safe default source','model success navigation','single-device tools retained','one connection form','settings save without connect','unrelated settings preserved','no planning or execution'],viewports:[]};
    })()`);
    for (const [width, height] of [
      [1440, 900],
      [1000, 720],
    ]) {
      win.setContentSize(width, height);
      for (const [name, action] of [
        ["daily", "await clickEntry('每日计划')"],
        ["planner", "await clickEntry('AI 规划')"],
        ["workspace", "await clickEntry('单设备工具')"],
        [
          "connection",
          "await clickEntry('设置');await clickEntry('打开高级连接')",
        ],
      ]) {
        await win.webContents.executeJavaScript(
          `(async()=>{${action};await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));assertEntry(innerWidth===${width}&&innerHeight===${height},'Wrong viewport');assertEntry(document.documentElement.scrollWidth<=innerWidth,'Horizontal overflow: ${name} ${width}');${name === "planner" ? "const rect=document.getElementById('agent-prompt').getBoundingClientRect();assertEntry(rect.top>=0&&rect.bottom<=innerHeight,'Planner input must be fully visible');" : ""}})()`,
        );
        await writeFile(
          path.join(out, `${name}-${width}.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      result.viewports.push({
        width,
        height,
        horizontalOverflow: false,
        plannerInputVisible: true,
        screenshots: ["daily", "planner", "workspace", "connection"],
      });
    }
    if (errors.length) throw Error(errors.join("\n"));
    await writeFile(
      path.join(out, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify({ ...result, evidence: out }));
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
});
