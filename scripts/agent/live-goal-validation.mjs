import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";

// Explicit development-only attachment to the normal App. No test profile,
// replacement provider, ledger deletion, coordinates or native bypasses.
const [phase, portText = "9235", releaseVersion] = process.argv.slice(2);
if (
  ![
    "readonly",
    "end-obsolete",
    "login",
    "repeat",
    "status",
    "ui",
    "quit",
  ].includes(phase)
)
  throw Error(
    "Use readonly | end-obsolete | login | repeat | status | ui | quit [loopback-port]",
  );
const port = Number(portText);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const directory = resolve("artifacts/live-goal-validation");
await mkdir(directory, { recursive: true });
const runStamp = new Date().toISOString().replaceAll(":", "-");
const version =
  releaseVersion ??
  JSON.parse(await readFile(resolve("package.json"), "utf8")).version;
assert(/^\d+\.\d+\.\d+$/.test(version));
assert(
  !releaseVersion || ["status", "quit"].includes(phase),
  "Release override is observation/quit only",
);
const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = pages.find(
  (page) =>
    page.type === "page" &&
    page.url?.startsWith("file:") &&
    /dist\/renderer\/index\.html/.test(page.url),
);
if (!target?.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`))
  throw Error(
    "Normal GamePilot renderer not available on selected loopback port",
  );
assert(target.url.includes(`GamePilot-${version}/`), "Wrong release attached");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, reject) => {
  ws.addEventListener("open", done, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
const calls = new Map();
let sequence = 0;
ws.addEventListener("message", (event) => {
  const value = JSON.parse(String(event.data));
  const call = calls.get(value.id);
  if (!call) return;
  calls.delete(value.id);
  clearTimeout(call.timer);
  value.error
    ? call.reject(Error("Desktop control evaluation failed"))
    : call.resolve(value.result);
});
function command(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(Error("Desktop control timed out"));
    }, 20000);
    calls.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw Error(
      result.exceptionDetails.exception?.description?.slice(0, 1200) ??
        "App evaluation rejected",
    );
  return result.result.value;
}
async function waitFor(read, predicate, timeout = 160000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 1500));
  }
  throw Error(
    "Normal App did not reach the required state; original request remains authoritative",
  );
}
try {
  const ready = await evaluate(
    "Boolean(window.gamepilot?.chatSnapshot && window.gamepilot?.snapshot)",
  );
  assert(ready, "GamePilot host API missing");
  if (phase === "quit") {
    const idle = await evaluate(
      "(async()=>{const p=await window.gamepilot.plannerSnapshot();const s=await window.gamepilot.snapshot();return !['running','cancelling'].includes(p.status)&&!s.executions.some(r=>r.status==='running')})()",
    );
    assert(idle, "Refuse quitting while a model or game request is running");
    await evaluate("window.gamepilot.quit()").catch(() => {});
    console.log("Normal App quit requested through its own host API");
  } else if (phase === "status") {
    const state = await evaluate(
      "(async()=>{const p=await window.gamepilot.plannerSnapshot();const s=await window.gamepilot.snapshot();const g=await window.gamepilot.goalSnapshot?.();return {planner:p.status,requests:s.executions.map(r=>({id:r.id,status:r.status,resolved:!!r.resolution})),goals:g?.goals??[]}})()",
    );
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify(state, null, 2),
    );
    console.log(
      `Normal App: ${state.requests.filter((r) => r.status === "running").length} running requests; ${state.goals.length} goals`,
    );
  } else if (phase === "ui") {
    const before = JSON.parse(
      await readFile(join(directory, "before-final-restart.json"), "utf8"),
    );
    const login = JSON.parse(
      await readFile(join(directory, "login.json"), "utf8"),
    );
    const after = await evaluate(
      "(async()=>{const p=await window.gamepilot.plannerSnapshot();const s=await window.gamepilot.snapshot();const g=await window.gamepilot.goalSnapshot();return {planner:p.status,requests:s.executions.map(r=>({id:r.id,status:r.status,resolved:!!r.resolution})),goals:g.goals}})()",
    );
    assert.deepEqual(
      after.requests,
      before.requests,
      "Restart must not replay or alter native requests",
    );
    assert(!["running", "cancelling"].includes(after.planner));
    for (const original of before.goals) {
      const restored = after.goals.find((goal) => goal.id === original.id);
      assert(restored);
      assert.equal(restored.status, original.status);
      assert.equal(restored.goalSatisfied, original.goalSatisfied);
      assert.deepEqual(restored.publicReply, original.publicReply);
      assert.deepEqual(
        restored.resultNotification,
        original.resultNotification,
      );
    }
    await writeFile(
      join(directory, "final-restart.json"),
      JSON.stringify(after, null, 2),
    );
    await evaluate(
      `window.gamepilot.selectChat(${JSON.stringify(login.owner.sessionId)})`,
    );
    const visual = await waitFor(
      () =>
        evaluate(
          `(()=>{const card=document.querySelector('[data-goal-id="${login.terminal.id}"]');if(!card)return null;card.scrollIntoView({block:'start'});const text=document.body.innerText;return {goalStatus:card.getAttribute('data-status'),accepted:text.includes('目标已受理'),legacyReadOnly:text.includes('本轮只查询'),replyWhiteSpace:getComputedStyle(card.querySelector('.chat-answer')).whiteSpace,reply:card.querySelector('.chat-answer')?.textContent}})()`,
        ),
      (value) => value?.goalStatus === "completed" && value?.accepted,
      20000,
    );
    assert.equal(visual.legacyReadOnly, false);
    assert.equal(visual.replyWhiteSpace, "pre-wrap");
    assert.equal(visual.reply, login.terminal.publicReply.text);
    const screenshot = await command("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      join(directory, "final-ui.png"),
      Buffer.from(screenshot.data, "base64"),
    );
    await writeFile(
      join(directory, "final-ui.json"),
      JSON.stringify(
        { version, visual, at: new Date().toISOString() },
        null,
        2,
      ),
    );
    console.log(
      "Final installed UI and restart passed: original results/report retained, zero native replay, correct execution label and reply paragraphs",
    );
  } else if (phase === "end-obsolete") {
    // This exact request predates today's independently completed daily. End
    // handling only: its unknown outcome and all native/step records stay intact.
    const id = "e08bda90-0a58-48cd-86d1-6a18167bab52:lane-a";
    const result = await evaluate(
      `(async()=>{const a=window.gamepilot;const s=await a.snapshot();const r=s.executions.find(r=>r.id===${JSON.stringify(id)});if(!r||r.status!=='unknown'||s.executions.some(r=>r.status==='running'))throw Error('Old request or idle state changed');const verified=s.executions.filter(r=>r.batchId==='97df152c-a6f5-44b4-9476-e8711cc7ad8f'&&r.status==='succeeded');if(verified.length!==2)throw Error('Independent daily completion missing');const next=r.resolution?r:await a.resolveExecution({id:r.id,note:'本轮开发验收结束处理：此旧请求不再续跑；12:00独立日常已完成，不重复业务。保留原unknown、步骤与证据，不声明旧请求成功。'});return {id:next.id,status:next.status,resolution:next.resolution}})()`,
    );
    assert.equal(result.status, "unknown");
    assert.equal(result.resolution?.action, "abandoned");
    await writeFile(
      join(directory, "obsolete-request.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(
      "Old request ended without changing its unknown outcome or replaying any game operation",
    );
  } else {
    assert(
      await evaluate("Boolean(window.gamepilot.goalSnapshot)"),
      "New Goal host API not deployed",
    );
    const prompt =
      phase === "readonly"
        ? "这轮只读验证：先查询能力、保存配置与今日记录，再读取两款游戏内置skill，说明两个账号今日完成情况。不要编译、启动、修改或恢复游戏；配置不能证明设备此刻在线。"
        : phase === "login"
          ? "现在只给两个已启用账号运行明日方舟登录及UID核验任务（仅login）。不运行其他日常、不领取邮件、不购物、不吃药、不用源石、不切换阴阳师。请先调用工具获取环境、能力和技能，再compile_plan获得两个账号各自只有login的计划，使用run_plan受理。游戏结果回到本轮目标。"
          : "现在运行两个账号保存的完整日常，不吃药、不用源石。请实际调用run_saved_daily让宿主检查并返回受理或防重拒绝回执，不要仅凭历史自行宣布宿主已拒绝。今天已有任务结果时接受宿主防重拒绝，不使用续跑来绕过，不处置旧记录。";
    const before = await evaluate(
      "(async()=>{const s=await window.gamepilot.snapshot();return s.executions.map(r=>r.id)})()",
    );
    const owner = await evaluate(
      `(async()=>{const a=window.gamepilot;const v=await a.newChat();const id=v.selectedSessionId;await a.sendChat({sessionId:id,prompt:${JSON.stringify(prompt)},source:'recorded',at:new Date().toISOString()});return {sessionId:id}})()`,
    );
    const turn = await waitFor(
      () =>
        evaluate(
          `(async()=>{const v=await window.gamepilot.chatSnapshot();return v.sessions.find(s=>s.id===${JSON.stringify(owner.sessionId)})?.turns.at(-1)})()`,
        ),
      (turn) =>
        turn &&
        ["completed", "failed", "cancelled"].includes(turn.planner.status),
    );
    const goals = await evaluate(
      `(async()=>{const v=await window.gamepilot.goalSnapshot();return {...v,goals:v.goals.filter(g=>g.sessionId===${JSON.stringify(owner.sessionId)})}})()`,
    );
    const events = await evaluate(
      `window.gamepilot.agentEvents({requestId:${JSON.stringify(turn.planner.requestId)},limit:500})`,
    );
    // Persist even rejected or unexpected first attempts before assertions.
    await writeFile(
      join(directory, `${phase}-${runStamp}-initial.json`),
      JSON.stringify({ version, phase, owner, turn, goals, events }, null, 2),
    );
    let terminal;
    if (phase === "login") {
      assert.equal(turn.planner.status, "completed");
      assert.equal(turn.planner.result?.execution, "managed-by-goal");
      assert.equal(goals.goals.length, 1);
      terminal = await waitFor(
        () =>
          evaluate(
            `(async()=>{const v=await window.gamepilot.goalSnapshot();return v.goals.find(g=>g.sessionId===${JSON.stringify(owner.sessionId)})})()`,
          ),
        (goal) =>
          goal &&
          [
            "completed",
            "failed",
            "unknown",
            "needs-user",
            "cancelled",
          ].includes(goal.status) &&
          goal.resultNotification?.state === "delivered",
        480000,
      );
      assert(
        terminal.grant.scopes.every(
          (s) =>
            s.gameId === "arknights" &&
            JSON.stringify(s.skillIds) === '["login"]',
        ),
      );
      assert.equal(terminal.grant.scopes.length, 2);
    }
    const after = await evaluate(
      "(async()=>{const s=await window.gamepilot.snapshot();return s.executions.map(r=>r.id)})()",
    );
    if (phase !== "login") {
      assert.equal(after.length, before.length);
      assert.equal(goals.goals.filter((g) => g.submission).length, 0);
    }
    const report = {
      version,
      scope:
        "Normal production main + configured real provider + official DSH; no test profile/native bypass. Login is identity-only; repeat verifies same-day refusal.",
      phase,
      owner,
      turn,
      goals,
      terminal,
      newRequestIds: after.filter((id) => !before.includes(id)),
      at: new Date().toISOString(),
    };
    await writeFile(
      join(directory, `${phase}.json`),
      JSON.stringify(report, null, 2),
    );
    if (phase === "login")
      await evaluate(
        `window.gamepilot.selectChat(${JSON.stringify(owner.sessionId)})`,
      );
    const screenshot = await command("Page.captureScreenshot", {
      format: "png",
    });
    await writeFile(
      join(directory, `${phase}.png`),
      Buffer.from(screenshot.data, "base64"),
    );
    assert.equal(
      turn.planner.status,
      "completed",
      "Model turn did not finish successfully",
    );
    console.log(
      `Normal App ${phase}: model ${turn.planner.status}; new requests ${report.newRequestIds.length}; goal ${terminal?.status ?? "none"}, satisfied ${terminal?.goalSatisfied ?? "unconfirmed"}`,
    );
  }
} finally {
  for (const call of calls.values()) {
    clearTimeout(call.timer);
    call.reject(Error("Desktop attachment closed"));
  }
  calls.clear();
  ws.close();
}
