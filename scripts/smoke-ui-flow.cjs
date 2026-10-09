// Isolated renderer regression: no real devices, profile files or IPC actions.
const { app, BrowserWindow } = require("electron");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const out = path.resolve("artifacts/ui-flow");
app.setPath("userData", path.join(out, "profile"));
app.whenReady().then(async () => {
  let win;
  try {
    await mkdir(out, { recursive: true });
    await writeFile(
      path.join(out, "preload.cjs"),
      `
      const {contextBridge}=require('electron');
      const calls=[]; let listener;
      let profiles={version:1,activeProfileId:'default',profiles:[{id:'default',name:'测试官服',accountName:'',clientType:'Official',stage:'LS-6',mail:false,recruit:true,creditShopping:false,copilotFile:'',copilotLoopTimes:1,freeRecruit:false,eventOrundum:false,eventMining:false,specialAccess:false,signInEvent:false,maxRunMinutes:120}]};
      let lanes={version:1,lanes:[0,1].map(i=>({id:'lane-'+i,name:'账号 '+(i+1),instance:i,managerPath:'D:/MuMu/MuMuManager.exe',enabled:true,arknights:{enabled:true,profileId:'default'},onmyoji:{enabled:false},closeEmulatorAfterSuccess:false}))};
      contextBridge.exposeInMainWorld('gamepilot',{
        snapshot:async()=>({games:[{id:'arknights',name:'明日方舟',skills:[]}],settings:{adbPath:'',address:'',modelEndpoint:'',modelName:''},engine:null,events:[]}),
        deviceLanes:async()=>lanes,arknights:async()=>profiles,
        saveDeviceLanes:async value=>{calls.push('save');lanes=value;return lanes;},
        saveArknights:async value=>{profiles=value;return profiles;},
        startLanes:async()=>{calls.push('start');return {batchId:'batch'};},
        stop:async()=>{calls.push('stop');},
        onEvent:fn=>{listener=fn;return ()=>{listener=undefined;};}
      });
      contextBridge.exposeInMainWorld('flowTest',{calls:()=>calls,lanes:()=>lanes,event:event=>listener(event)});
    `,
    );
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(out, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    const errors = [];
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2 && !message.includes("Electron Security Warning"))
        errors.push(message);
    });
    await win.loadFile(path.resolve("dist/renderer/index.html"));
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const wait=()=>new Promise(r=>setTimeout(r,150));
      const assert=(ok,message)=>{if(!ok)throw Error(message);};
      const click=async text=>{const b=[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===text);assert(b&&!b.disabled,'Missing action '+text);b.click();await wait();};
      await wait();
      document.querySelector('.sidebar-tools').open=true;
      await click('每日计划与开关');
      assert(document.querySelectorAll('.daily-lane').length===2,'Daily home must show both accounts');
      await click('设备与账号');
      const field=document.querySelector('.lane-card input[type=number]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'2');field.dispatchEvent(new Event('input',{bubbles:true}));await wait();
      await click('每日计划与开关');
      assert(document.body.innerText.includes('未保存'),'Unsaved plan not explained');
      await click('开始每日计划');
      assert(JSON.stringify(window.flowTest.calls())==='["save","start"]','Run must save current plan before starting');
      assert((await window.flowTest.lanes()).lanes[0].instance===2,'Wrong device saved');
      for(const laneId of ['lane-0','lane-1'])await window.flowTest.event({runId:'batch',batchId:'batch',laneId,gameId:'arknights',type:'status',status:'running',message:'正在执行',at:new Date().toISOString()});
      await window.flowTest.event({runId:'batch',batchId:'batch',laneId:'lane-0',gameId:'arknights',type:'status',status:'succeeded',message:'已完成',at:new Date().toISOString()});await wait();
      for(let i=0;i<600;i++)await window.flowTest.event({runId:'batch',batchId:'batch',laneId:'lane-1',gameId:'arknights',type:'log',message:'执行进度 '+i,at:new Date().toISOString()});await wait();
      const cards=[...document.querySelectorAll('.daily-lane')];
      assert(cards[0].innerText.includes('已完成')&&cards[1].innerText.includes('运行中'),'Lane completion hid active account');
      await click('停止全部任务');
      assert(window.flowTest.calls().at(-1)==='stop','Global stop not routed');
      await window.flowTest.event({runId:'batch',batchId:'batch',laneId:'lane-1',gameId:'arknights',type:'status',status:'cancelled',message:'已停止',at:new Date().toISOString()});await wait();
      assert([...document.querySelectorAll('button')].some(b=>b.textContent.includes('开始每日计划')&&!b.disabled),'Start not restored after both accounts end');
      return {passed:true,checks:['daily home','save before run','draft instance used','parallel lane status','global stop','start restored']};
    })()`);
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [900, 700],
    ]) {
      win.setSize(width, height);
      await win.webContents.executeJavaScript(
        "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
      );
      if (
        await win.webContents.executeJavaScript(
          "document.documentElement.scrollWidth>innerWidth",
        )
      )
        throw Error("Overflow " + width);
      await writeFile(
        path.join(out, `daily-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    if (errors.length) throw Error(errors.join("\n"));
    await writeFile(
      path.join(out, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
