import type { BrowserWindow } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionCoordinator } from "./execution-coordinator";
import type { RunLedger } from "./run-ledger";
import type { RunEvent } from "../../../packages/protocol";

/** Called only from the isolated --smoke profile. Fixtures never dispatch a game skill. */
export async function failureEvidenceUiSmoke(
  window: BrowserWindow,
  directory: string,
  output: string,
  renderer: string,
  executions: ExecutionCoordinator,
  ledger: RunLedger,
) {
  const id = `evidence-ui-${randomUUID()}`,
    runId = randomUUID();
  const lease = await executions.begin({
    id,
    source: "single",
    resources: ["ui-fixture"],
    snapshot: {
      plan: { gameId: "arknights", skillIds: ["login"], mode: "live" },
    },
  });
  const at = new Date().toISOString(),
    png = (await window.webContents.capturePage()).toPNG();
  const capturedAt = new Date().toISOString(),
    key = `${randomUUID()}.png`;
  await mkdir(join(directory, "failure-evidence"), { recursive: true });
  await writeFile(join(directory, "failure-evidence", key), png, {
    flag: "wx",
  });
  const event: RunEvent = {
    executionId: id,
    runId,
    gameId: "arknights",
    type: "status",
    status: "queued",
    message: "界面回放，无游戏动作",
    at,
    plan: { gameId: "arknights", skillIds: ["login"], mode: "live" },
  };
  await ledger.append(event);
  await ledger.append({
    ...event,
    type: "step",
    skillId: "login",
    stepStatus: "running",
  });
  const end = new Date().toISOString();
  await ledger.append({
    ...event,
    type: "step",
    at: end,
    skillId: "login",
    stepStatus: "failed",
    fault: {
      version: 1,
      code: "skill-exception",
      source: "runner",
      runId,
      skillId: "login",
      observedAt: at,
      capture: {
        status: "stored",
        key,
        bytes: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
        capturedAt,
      },
    },
  });
  await ledger.append({ ...event, status: "failed", at: end });
  await lease.finish("unknown", `界面回放：历史截图 ${id}`);
  const startup = await executions.begin({
    id: id + "-startup",
    source: "single",
    resources: ["ui-fixture"],
    snapshot: {},
  });
  await startup.finish("unknown", "界面回放：模拟器启动异常", {
    version: 1,
    source: "startup",
    code: "mumu-launch-failed",
    observedAt: new Date().toISOString(),
  });
  const before = JSON.stringify([executions.snapshot(), ledger.snapshot()]);
  await window.loadFile(renderer);
  const script = `
    const wait = () => new Promise(r => setTimeout(r, 80));
    async function until(check) { for (let i=0;i<100;i++) { if(check()) return; await wait(); } throw Error('UI condition timed out: '+check.toString()); }
    const click = async (root, text) => { const b=[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===text); if(!b||b.disabled) throw Error('UI button unavailable: '+text); b.click(); await wait(); };
    await until(()=>document.querySelector('.sidebar-tools'));
    document.querySelector('.sidebar-tools').open = true;
    await until(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='每日计划与开关'));
    await click(document, '每日计划与开关');
    await until(()=>document.body.textContent.includes(${JSON.stringify(id)}));
    const notice = document.querySelector('.execution-notice'); notice.open = true;
    const item = [...notice.querySelectorAll('li')].find(li=>li.textContent.includes(${JSON.stringify(id)}) && li.querySelector('.failure-evidence'));
    if(!item) throw Error('Fixture record missing');
  `;
  const visible = await window.webContents
    .executeJavaScript(`(async()=>{${script}
    await click(item, '查看失败证据');
    await until(()=>item.textContent.includes('任务步骤异常'));
    await click(item, '查看失败截图');
    await until(()=>{const img=item.querySelector('.failure-evidence img');return img?.complete&&img.naturalWidth>0;});
    item.querySelector('.failure-evidence').scrollIntoView({block:'start', behavior:'instant'});
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await new Promise(r=>setTimeout(r, 250));
    if(!notice.textContent.includes('启动阶段 · MuMu 启动失败')) throw Error('Startup fault missing');
    return { historicalImage: true, startupFault: true, width: item.querySelector('img').naturalWidth };
  })()`);
  await writeFile(
    join(output, "failure-evidence-ui.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  window.setSize(800, 800);
  await window.webContents.executeJavaScript(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
  );
  await writeFile(
    join(output, "failure-evidence-ui-narrow.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  const result = await window.webContents
    .executeJavaScript(`(async()=>{${script}
    await click(item, '删除本地截图'); await click(item, '保留截图');
    if(!item.querySelector('img')) throw Error('Cancel removed image');
    await click(item, '删除本地截图'); await click(item, '确认删除截图');
    await until(()=>item.textContent.includes('本地截图已删除或不存在'));
    if(item.querySelector('.failure-evidence img')) throw Error('Deleted image still displayed');
    await click(item, '查看失败截图');
    await until(()=>item.textContent.includes('本地截图已删除或不存在'));
    return { cancelPreserved: true, deleteVerified: true, overflow: document.documentElement.scrollWidth > window.innerWidth };
  })()`);
  if (
    result.overflow ||
    before !== JSON.stringify([executions.snapshot(), ledger.snapshot()])
  )
    throw Error("UI cleanup changed records or overflowed viewport");
  await writeFile(
    join(output, "failure-evidence-ui-result.json"),
    JSON.stringify(
      { ...visible, ...result, ledgersUnchanged: true, fixtureOnly: true },
      null,
      2,
    ),
  );
}
