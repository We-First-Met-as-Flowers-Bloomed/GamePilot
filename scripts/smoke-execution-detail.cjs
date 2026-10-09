// Real renderer with isolated in-memory IPC. Never loads the production main process.
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const out = path.join(
  root,
  "artifacts/execution-detail-ui",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
app.setPath("userData", path.join(out, "profile"));
app.commandLine.appendSwitch("force-device-scale-factor", "1");
const deadline = setTimeout(() => app.exit(1), 60_000);

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
      const actions=[],reads=[];
      const settings={adbPath:'D:/Mock/adb.exe',address:'127.0.0.1:5555',modelEndpoint:'',modelName:''};
      const plan={gameId:'arknights',mode:'live',skillIds:['login','award']};
      const lanes=['a','b'].map((id,i)=>({id,name:'当前账号'+id,instance:i,managerPath:'D:/Mock/MuMuManager.exe',enabled:true,arknights:{enabled:true,profileId:'default'},onmyoji:{enabled:false},closeEmulatorAfterSuccess:false}));
      const records=lanes.map((lane,i)=>({id:'receipt-'+lane.id,version:1,source:'daily',status:i?'unknown':'succeeded',laneId:lane.id,batchId:'shared-batch',resources:[],fingerprint:'test',startedAt:'2026-09-29T01:00:00.000Z',finishedAt:'2026-09-29T01:10:00.000Z',message:i?'执行中断，现场结果未确认':'所选流程已结束',snapshot:{lane:{...lane,name:'执行时账号'+lane.id},arknightsPlan:plan,profile:{id:'default',name:'执行时档案'},...(i?{agent:{requestId:'planner-original'}}:{})},...(i?{resolution:{action:'abandoned',at:'2026-09-29T02:00:00.000Z',note:'已核对并结束处理，保留未知结果'}}:{})}));
      const events=records.map(r=>({runId:r.batchId,executionId:r.id,laneId:r.laneId,batchId:r.batchId,type:'status',status:r.status==='unknown'?'failed':r.status,at:r.finishedAt,startedAt:r.startedAt,message:r.message,executionSource:'daily'}));
      const details=Object.fromEntries(records.map((r,i)=>{const {snapshot,resources,fingerprint,version,...request}=r;return [r.id,{request:{...request,laneName:snapshot.lane.name,instance:snapshot.lane.instance,profileName:snapshot.profile.name,agentRequestId:snapshot.agent?.requestId},games:[{plan,record:{version:1,executionId:r.id,laneId:r.laneId,batchId:r.batchId,runId:'run-'+r.laneId,gameId:'arknights',plan,startedAt:r.startedAt,updatedAt:r.finishedAt,finishedAt:r.finishedAt,status:r.status,message:r.message,steps:[{skillId:'login',status:'succeeded',evidence:'adapter-return',message:'登录已核验',diagnostics:[]},{skillId:'award',status:i?'unknown':'succeeded',evidence:'adapter-return',message:i?'奖励结果未确认':'奖励流程返回成功',diagnostics:['隔离诊断 '+r.laneId]}]}}],warnings:[]}];}));
      const summaries=records.map((r,i)=>({version:1,mode:'live',counts:{completed:i?1:2,skipped:1,failed:i?1:0,unknown:i?1:0,notRun:i?1:0,running:0,pending:0,cancelled:0},items:[{id:'fight',label:'作战结算',value:i?'未记录':'LS-6 · 已确认 5 次',note:'仅此请求的结算证据'},{id:'sanity',label:'理智',value:i?'未记录':'210 → 30',note:'记录首末值，不推断其他支出'},{id:'credit',label:'信用购物',value:i?'0 次购买确认':'5 次购买确认'},{id:'award',label:'奖励',value:i?'结果未确认':'2 次领取确认'}],issues:i?[{skillId:'award',message:'本次奖励结果未知，后续单项不改变原请求'}]:[],scopeNote:'流程返回与奖励结果分别记录。'}));
      records.forEach((r,i)=>{details[r.id].games[0].summary=summaries[i];});
      let delayNext=false,failNext=false,wrongNext=false;
      const listeners=new Set();
      const publishReceipt=(id)=>{
        const receipt=structuredClone(records[0]);receipt.id=id;receipt.batchId=id+'-batch';receipt.startedAt='2026-09-30T02:00:00.000Z';receipt.finishedAt='2026-09-30T02:10:00.000Z';
        records.push(receipt);
        details[id]=structuredClone(details['receipt-a']);details[id].request={...details[id].request,id,batchId:receipt.batchId,startedAt:receipt.startedAt,finishedAt:receipt.finishedAt};
        details[id].games[0].summary.items[0].value=id==='new-a'?'新请求 · 已确认 1 次':'新请求 · 已确认 2 次';
        const event={runId:receipt.batchId,executionId:id,laneId:'a',batchId:receipt.batchId,type:'status',status:'succeeded',at:receipt.finishedAt,startedAt:receipt.startedAt,message:'new receipt',executionSource:'daily'};
        events.push(event);listeners.forEach(fn=>fn(event));
      };
      const forbid=name=>async()=>{actions.push(name);throw Error('Unexpected action '+name);};
      contextBridge.exposeInMainWorld('gamepilot',{
        snapshot:async()=>({games,settings,engine:null,events,executions:records,runs:[]}),
        deviceLanes:async()=>({version:1,lanes}),arknights:async()=>defaultArknightsProfiles,
        plannerSnapshot:async()=>({revision:0,status:'idle'}),
        agentExecutionSnapshot:async()=>({revision:1,status:'unknown',requestId:'planner-original',planHash:'h',batchId:'shared-batch',message:'上次已提交任务',lanes:[{laneId:'b',name:'执行时账号b',instance:1,profileName:'执行时档案',skillIds:['login','award'],parameters:{},executionId:'receipt-b',status:'unknown'}]}),
        executionDetail:async id=>{reads.push(id);const value=structuredClone(details[id]);if(delayNext){delayNext=false;await new Promise(r=>setTimeout(r,1100));}if(failNext){failNext=false;throw Error('隔离读取失败');}if(wrongNext){wrongNext=false;return structuredClone(details['receipt-b']);}if(!value)throw Error('unknown id');return value;},
        onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},automation:async()=>undefined,
        start:forbid('start'),startLane:forbid('startLane'),startLanes:forbid('startLanes'),startPlanner:forbid('startPlanner'),reviewAgentExecution:forbid('reviewAgentExecution'),confirmAgentExecution:forbid('confirmAgentExecution'),inspectExecution:forbid('inspectExecution'),capture:forbid('capture'),testModelProvider:forbid('testModelProvider'),resolveExecution:forbid('resolveExecution')
      });
      contextBridge.exposeInMainWorld('detailTest',{actions:()=>actions,reads:()=>reads,delay:()=>{delayNext=true;},fail:()=>{failNext=true;},wrong:()=>{wrongNext=true;},hideSummary:()=>{delete details['receipt-a'].games[0].summary;},restoreSummary:()=>{details['receipt-a'].games[0].summary=summaries[0];},publishReceipt});
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
      )
        errors.push(message);
    });
    await win.loadFile(path.join(out, "index.html"));
    await win.webContents.executeJavaScript(`
      window.assertDetail=(ok,msg)=>{if(!ok)throw Error(msg);};
      window.waitDetail=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out waiting for UI');};
      window.findDetailButton=(text,scope=document)=>[...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
      window.closeDetail=async()=>{document.querySelector('[aria-label="关闭任务详情"]').click();await waitDetail(()=>!document.querySelector('dialog[open]'));};
      window.openDetail=async(button,name)=>{button.focus();button.click();await waitDetail(()=>document.querySelector('dialog[open]')?.innerText.includes(name));};
      true;
    `);
    const checks = await win.webContents.executeJavaScript(`(async()=>{
      await waitDetail(()=>document.querySelectorAll('.daily-lane').length===2);
      const laneA=document.querySelectorAll('.daily-lane')[0];
      const laneB=document.querySelectorAll('.daily-lane')[1];
      await waitDetail(()=>laneA.querySelector('.daily-result-summary').innerText.includes('已确认 5 次')&&laneB.querySelector('.daily-result-summary').innerText.includes('0 次购买确认'));
      assertDetail(!laneB.querySelector('.daily-result-summary').innerText.includes('210 → 30'),'Account B must not inherit account A numbers');
      assertDetail(laneB.querySelector('.daily-result-summary').innerText.includes('本次奖励结果未知'),'Failed outcomes need a visible reason');
      detailTest.fail();findDetailButton('刷新结果',laneA).click();
      await waitDetail(()=>laneA.querySelector('.result-summary-error'));
      assertDetail(laneA.innerText.includes('上次读取的结果')&&laneA.innerText.includes('已确认 5 次'),'Summary refresh failure must label retained data');
      findDetailButton('刷新结果',laneA).click();await waitDetail(()=>!laneA.querySelector('.result-summary-error'));
      detailTest.wrong();findDetailButton('刷新结果',laneA).click();await waitDetail(()=>laneA.querySelector('.result-summary-error'));
      assertDetail(!laneA.querySelector('.daily-result-summary').innerText.includes('0 次购买确认'),'A mismatched receipt must not replace account A');
      findDetailButton('刷新结果',laneA).click();await waitDetail(()=>!laneA.querySelector('.result-summary-error'));
      detailTest.hideSummary();findDetailButton('刷新结果',laneA).click();await waitDetail(()=>laneA.querySelector('.result-summary-missing'));
      assertDetail(!laneA.querySelector('.daily-result-summary').innerText.includes('已确认 5 次'),'Old records must not keep unrelated quantities');
      detailTest.restoreSummary();findDetailButton('刷新结果',laneA).click();await waitDetail(()=>laneA.querySelector('.daily-result-summary').innerText.includes('已确认 5 次'));
      const a=findDetailButton('查看本次详情',document.querySelectorAll('.daily-lane')[0]);
      const b=findDetailButton('查看本次详情',document.querySelectorAll('.daily-lane')[1]);
      assertDetail(a&&b,'Both account entry points are needed');
      await openDetail(a,'执行时账号a');
      let dialog=document.querySelector('dialog[open]');
      assertDetail(!dialog.innerText.includes('执行时账号b'),'Must not mix accounts sharing batch');
      dialog.querySelector('.task-steps details').open=true;
      assertDetail(dialog.innerText.includes('不代表每项奖励都实际产生'),'Native completion must not claim all rewards');
      await closeDetail();assertDetail(document.activeElement===a,'Close must restore focus');
      await openDetail(b,'执行时账号b');
      dialog=document.querySelector('dialog[open]');
      assertDetail(dialog.innerText.includes('结果未知')&&dialog.innerText.includes('已结束处理'),'Resolution must preserve unknown status');
      await closeDetail();
      const ai=document.getElementById('agent-planner');ai.open=true;
      await waitDetail(()=>findDetailButton('查看任务详情',ai));
      await openDetail(findDetailButton('查看任务详情',ai),'执行时账号b');
      await closeDetail();
      ai.open=false;
      const notice=document.querySelector('.execution-notice');notice.open=true;
      await openDetail(findDetailButton('查看任务详情',notice),'执行时账号b');
      await closeDetail();notice.open=false;
      const history=document.querySelector('.execution-history');
      await openDetail(findDetailButton('查看详情',history),'执行时账号a');
      detailTest.fail();findDetailButton('刷新详情',document.querySelector('dialog')).click();
      await waitDetail(()=>document.querySelector('.execution-detail-error'));
      assertDetail(document.querySelector('dialog').innerText.includes('执行时账号a'),'Failed refresh should retain old data with warning');
      findDetailButton('刷新详情',document.querySelector('dialog')).click();
      await waitDetail(()=>!document.querySelector('.execution-detail-error'));
      await closeDetail();
      detailTest.delay();a.focus();a.click();await waitDetail(()=>document.querySelector('dialog[open]'));
      await closeDetail();await openDetail(b,'执行时账号b');
      await new Promise(r=>setTimeout(r,1400));
      assertDetail(!document.querySelector('dialog').innerText.includes('执行时账号a'),'Late closed request must not replace current detail');
      await closeDetail();
      assertDetail(detailTest.actions().length===0,'Browsing must be read-only');
      return ['daily summary account isolation','summary failure keeps labelled old data','mismatched receipt rejected','old summary absent not zero','daily exact request','shared batch account isolation','native completion wording','resolved unknown preserved','AI same detail','exception same detail','recent receipt detail','refresh failure and recovery','late response ignored','focus returned','no mutation/model/device action'];
    })()`);
    // Exercise a real keyboard Escape event, not just React's handler.
    await win.webContents.executeJavaScript(
      `openDetail(findDetailButton('查看本次详情',document.querySelector('.daily-lane')),'执行时账号a')`,
    );
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await win.webContents.executeJavaScript(
      `waitDetail(()=>!document.querySelector('dialog[open]'))`,
    );
    checks.push("keyboard Escape closes");
    const viewports = [];
    for (const [width, height] of [
      [1440, 900],
      [1000, 720],
    ]) {
      win.setContentSize(width, height);
      await win.webContents.executeJavaScript(
        `(async()=>{await new Promise(r=>setTimeout(r,100));document.querySelector('.daily-lane').scrollIntoView({block:'start'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));for(const summary of document.querySelectorAll('.daily-result-summary'))assertDetail(summary.scrollWidth<=summary.clientWidth,'Summary horizontal overflow');})()`,
      );
      await writeFile(
        path.join(out, `daily-summary-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.webContents.executeJavaScript(
        `openDetail(findDetailButton('查看本次详情',document.querySelectorAll('.daily-lane')[1]),'执行时账号b')`,
      );
      await win.webContents.executeJavaScript(
        `(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const d=document.querySelector('dialog[open]');assertDetail(d.getBoundingClientRect().left>=0&&d.getBoundingClientRect().right<=innerWidth,'Drawer must fit viewport');assertDetail(d.scrollWidth<=d.clientWidth,'Drawer horizontal overflow');assertDetail(d.contains(document.activeElement),'Dialog must contain focus');})()`,
      );
      await writeFile(
        path.join(out, `detail-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.webContents.executeJavaScript(
        `(async()=>{document.querySelector('dialog .result-summary').scrollIntoView({block:'start'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));})()`,
      );
      await writeFile(
        path.join(out, `detail-summary-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await win.webContents.executeJavaScript("closeDetail()");
      viewports.push({ width, height, horizontalOverflow: false });
    }
    await win.webContents.executeJavaScript(`(async()=>{
      detailTest.delay();detailTest.publishReceipt('new-a');
      await waitDetail(()=>document.querySelectorAll('.daily-lane')[0].querySelector('.daily-result-summary').innerText.includes('正在读取结果'));
      assertDetail(!document.querySelectorAll('.daily-lane')[0].querySelector('.daily-result-summary').innerText.includes('已确认 5 次'),'Changing request must clear old metrics while loading');
      detailTest.publishReceipt('newer-a');
      await waitDetail(()=>document.querySelectorAll('.daily-lane')[0].querySelector('.daily-result-summary').innerText.includes('新请求 · 已确认 2 次'));
      await new Promise(r=>setTimeout(r,1300));
      assertDetail(!document.querySelectorAll('.daily-lane')[0].querySelector('.daily-result-summary').innerText.includes('新请求 · 已确认 1 次'),'Late result must not overwrite a newer daily receipt');
      assertDetail(detailTest.actions().length===0,'Result summaries must remain read-only');
    })()`);
    checks.push(
      "daily request change clears old metrics",
      "late daily receipt ignored",
    );
    if (errors.length) throw Error(errors.join("\n"));
    const result = {
      passed: true,
      checks,
      viewports,
      reads: await win.webContents.executeJavaScript("detailTest.reads()"),
      actions: await win.webContents.executeJavaScript("detailTest.actions()"),
      evidence: out,
    };
    await writeFile(
      path.join(out, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    clearTimeout(deadline);
    app.exit(0);
  } catch (e) {
    console.error(e);
    clearTimeout(deadline);
    app.exit(1);
  }
});
