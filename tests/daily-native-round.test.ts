import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLocalControlServer} from '../apps/desktop/main/local-control';
const run=promisify(execFile),hosts:{close():Promise<void>}[]=[];
afterEach(async()=>{await Promise.all(hosts.splice(0).map(host=>host.close()));});
it('forwards the compatibility PowerShell entry to App due-job selection without overriding its evening steps',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gp-ark-entry-'));let calls=0;
 const host=await createLocalControlServer({profileDir:directory,handlers:{'arknights-tick':()=>{calls++;return {batches:[{batchId:'app-batch'}]};}}});hosts.push(host);
 const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/daily-arknights.ps1'),'-Evening','-Data',directory],{windowsHide:true});
 expect(JSON.parse(stdout.replace(/^\uFEFF/,''))).toMatchObject({ok:true,result:{batches:[{batchId:'app-batch'}]}});expect(calls).toBe(1);
});
it('reads saved App plans for dry-run and never starts a game',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gp-ark-entry-'));let mutations=0;
 hosts.push(await createLocalControlServer({profileDir:directory,handlers:{'arknights-automation':()=>({config:{enabled:true,jobs:[]}}),'arknights-tick':()=>{mutations++;return {};}}}));
 const {stdout}=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/daily-arknights.ps1'),'-DryRun','-Data',directory],{windowsHide:true});
 expect(JSON.parse(stdout.replace(/^\uFEFF/,''))).toMatchObject({ok:true,result:{config:{enabled:true,jobs:[]}}});expect(mutations).toBe(0);
});
it('fails when App is offline and never falls back to an external native harness',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gp-ark-entry-'));
 const error=await run(process.execPath,['scripts/arknights-app.mjs','--due','--data',directory],{windowsHide:true}).catch(error=>error);
 expect(error.code).toBe(1);expect(JSON.parse(error.stdout)).toMatchObject({ok:false,error:{code:'APP_NOT_RUNNING'}});
});
it('uses a stable caller request ID and the saved real account binding',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gp-ark-entry-'));const calls:unknown[]=[];
 await writeFile(join(directory,'device-lanes.json'),JSON.stringify({version:2,lanes:[{id:'ark-b',enabled:true,instance:1,managerPath:'D:/MuMu/MuMuManager.exe',arknights:{enabled:true},onmyoji:{enabled:false}}]}));
 hosts.push(await createLocalControlServer({profileDir:directory,handlers:{'arknights-run-channel':input=>{calls.push(input);return {batchId:input.requestId};}}}));
 const args=['scripts/arknights-app.mjs','--lane','b','--request-id','stable-manual','--data',directory];
 for(let i=0;i<2;i++){const {stdout}=await run(process.execPath,args,{windowsHide:true});expect(JSON.parse(stdout)).toMatchObject({ok:true,result:{batchId:'stable-manual'}});}
 expect(calls).toEqual([{laneId:'ark-b',requestId:'stable-manual'}]);
});