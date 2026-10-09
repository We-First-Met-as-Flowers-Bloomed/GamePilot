// Isolated desktop verification. Only the loopback mock receives a fake key.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const out = resolve("artifacts/model-api-ui");
await mkdir(out, { recursive: true });
const profile = resolve(
  "artifacts/planner-preview-profile/model-provider.json",
);
const original = await readFile(profile).catch((e) => {
  if (e.code === "ENOENT") return null;
  throw e;
});
const files = [
  "automation.json",
  "device-lanes.json",
  "arknights.json",
  "history.json",
  "settings.json",
  "model-provider.json",
  "scheduler.json",
  "foster-scheduler.json",
  ...["lane-a", "lane-b"].flatMap((l) => [
    `lanes/${l}/daily-scheduler.json`,
    `lanes/${l}/foster-scheduler.json`,
  ]),
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (f) => [
        f,
        createHash("sha256")
          .update(
            await readFile(join(homedir(), ".gamepilot", f)).catch((e) => {
              if (e.code === "ENOENT" && f === "model-provider.json")
                return Buffer.from("absent");
              throw e;
            }),
          )
          .digest("hex"),
      ]),
    ),
  );
const before = await hashes();
const fakeKey = "desktop-test-only-credential";
const calls = [];
const held = [];
let hold = false;
let child, ws;
let next = 0;
const pending = new Map();
const completion = (content, tool_calls) => ({
  model: "local-test-model",
  choices: [
    {
      index: 0,
      finish_reason: tool_calls ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content,
        ...(tool_calls ? { tool_calls } : {}),
      },
    },
  ],
});
const tool = (id, name, args = {}) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(req.headers.authorization, `Bearer ${fakeKey}`);
    assert.equal(req.url, "/v1/chat/completions");
    const input = JSON.parse(body);
    calls.push({ model: input.model, tools: !!input.tools });
    let output;
    if (!input.tools) output = completion("OK");
    else {
      const results = input.messages
        .filter((m) => m.role === "tool")
        .map((m) => JSON.parse(m.content));
      if (!results.length)
        output = completion(null, [
          tool("catalog", "list_capabilities"),
          tool("environment", "get_environment"),
        ]);
      else if (results.length === 2)
        output = completion(null, [
          tool("compile", "compile_plan", {
            catalogRevision: results[0].revision,
            environmentRevision: results[1].revision,
            at: "2026-09-27T00:00:00.000Z",
            lanes: [
              {
                laneId: "lane-a",
                games: [
                  {
                    gameId: "arknights",
                    parameters: { stage: "LS-6", mail: true },
                  },
                ],
              },
            ],
          }),
        ]);
      else {
        assert.ok(results[2].planHash);
        output = completion(
          JSON.stringify({
            kind: "draft",
            text: "本地测试：已生成演练草稿，未运行游戏。",
            planHash: results[2].planHash,
          }),
        );
      }
    }
    const send = () => {
      if (!res.destroyed) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(output));
      }
    };
    if (hold) held.push(send);
    else send();
  } catch {
    res.writeHead(500);
    res.end("{}");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Timeout: " + label);
}
function cdp(method, params = {}) {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("CDP timeout: " + method));
    }, 15000);
    pending.set(id, {
      r: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      j: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.text);
  return r.result.value;
}
const click = async (text) =>
  evaluate(
    `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Button unavailable');b.click();return true})()`,
  );
async function fill(id, value) {
  await evaluate(
    `(()=>{const e=document.getElementById(${JSON.stringify(id)});const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`,
  );
}
async function measure(name, width) {
  await cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 920,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(150);
  const layout = await evaluate(
    '({viewport:innerWidth,document:document.documentElement.scrollWidth,heading:document.querySelector("h1")?.textContent})',
  );
  assert.ok(layout.document <= layout.viewport);
  await writeFile(
    join(out, name + "-layout.json"),
    JSON.stringify(layout, null, 2),
  );
}
const release = () => {
  hold = false;
  while (held.length) held.shift()();
};
let success = false;
try {
  // Existing development-only connection is restored in finally, never copied to evidence.
  if (original) await rm(profile);
  child = spawn(
    require("electron"),
    [".", "--planner-preview", "--hidden", "--remote-debugging-port=9226"],
    { windowsHide: true, stdio: "ignore" },
  );
  let page;
  await until(async () => {
    try {
      page = (await (await fetch("http://127.0.0.1:9226/json")).json()).find(
        (p) => p.type === "page" && p.url.includes("index.html"),
      );
      return !!page;
    } catch {
      return false;
    }
  }, "isolated app");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.j(Error(m.error.message)) : p.r(m.result);
    }
  };
  await until(() => evaluate("!!window.gamepilot"), "preload");
  assert.equal(
    await evaluate(
      "(async()=> (await window.gamepilot.snapshot()).plannerPreview)()",
    ),
    true,
  );
  await until(
    () => evaluate("!!document.querySelector('.nav-item')"),
    "navigation",
  );
  const snapshot = await evaluate("window.gamepilot.snapshot()");
  const eventCount = snapshot.events?.length ?? 0;
  await click("模型连接");
  await until(
    () => evaluate("document.body.innerText.includes('Codex 本机登录')"),
    "provider loaded",
  );
  await evaluate(
    "[...document.querySelectorAll('.provider-choice')].find(b=>b.textContent.includes('兼容 API')).click()",
  );
  await fill("model-base-url", endpoint);
  await fill("model-name", "test-model");
  assert.equal(
    await evaluate(
      "(()=>{const e=document.getElementById('model-api-key');e.focus();return document.activeElement===e && e.type==='password'})()",
    ),
    true,
  );
  await fill("model-api-key", fakeKey);
  await click("保存配置");
  await until(
    () => evaluate("document.body.innerText.includes('配置已保存')"),
    "saved",
  );
  assert.equal(
    await evaluate("document.getElementById('model-api-key').value"),
    "",
  );
  let view = await evaluate("window.gamepilot.modelProvider()");
  assert.equal(view.hasApiKey, true);
  assert.equal(view.encryptionAvailable, true);
  assert.ok(!JSON.stringify(view).includes(fakeKey));
  assert.ok(!(await readFile(profile, "utf8")).includes(fakeKey));
  await click("测试已保存连接");
  await until(
    () => evaluate("!!document.querySelector('.provider-test-result')"),
    "authenticated test",
  );
  await measure("model-connected-wide", 1440);
  await measure("model-connected-narrow", 900);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth<=innerWidth"),
    true,
  );
  // While connection test is pending, saving/starting a planner is rejected by main.
  hold = true;
  await evaluate(
    "window.__connectionTest=window.gamepilot.testModelProvider().then(()=>true,()=>false);true",
  );
  await until(() => held.length > 0, "held connection test");
  assert.equal(
    await evaluate(
      "(async()=>{try{await window.gamepilot.saveModelProvider(await window.gamepilot.modelProvider());return false}catch{return true}})()",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      '(async()=>{try{await window.gamepilot.startPlanner({prompt:"test",at:"2026-09-27T00:00:00.000Z"});return false}catch{return true}})()',
    ),
    true,
  );
  await click("设置");
  await click("模型连接");
  release();
  assert.equal(await evaluate("window.__connectionTest"), true);
  await until(
    () => evaluate("document.body.innerText.includes('兼容 API')"),
    "navigation reload",
  );
  assert.equal(
    await evaluate("document.getElementById('model-api-key').value"),
    "",
  );
  // Active planning owns its connection; no concurrent edits or testing.
  hold = true;
  await evaluate(
    'window.gamepilot.startPlanner({prompt:"演练账号一安排明日方舟日常，不用理智药",at:"2026-09-27T00:00:00.000Z",source:"fixture"})',
  );
  await until(() => held.length > 0, "held planner");
  assert.equal(
    await evaluate(
      "(async()=>{try{await window.gamepilot.testModelProvider();return false}catch{return true}})()",
    ),
    true,
  );
  assert.equal(
    await evaluate(
      "(async()=>{try{await window.gamepilot.saveModelProvider(await window.gamepilot.modelProvider());return false}catch{return true}})()",
    ),
    true,
  );
  await evaluate(
    "(async()=>{const s=await window.gamepilot.plannerSnapshot();await window.gamepilot.cancelPlanner(s.requestId)})()",
  );
  await until(
    () =>
      evaluate(
        '(async()=> (await window.gamepilot.plannerSnapshot()).status==="cancelled")()',
      ),
    "cancel",
  );
  release();
  await click("每日计划");
  await evaluate("document.querySelector('#agent-planner').open=true");
  await fill(
    "agent-prompt",
    "为演练账号一安排明日方舟日常，LS-6，领取邮件，不用理智药和源石。",
  );
  await fill("agent-at", "2026-09-27T08:00");
  await click("发送需求");
  await until(
    () =>
      evaluate(
        '(async()=> (await window.gamepilot.plannerSnapshot()).status==="completed")()',
      ),
    "planner completed",
  );
  await until(
    () => evaluate("!!document.querySelector('.agent-draft')"),
    "draft rendered",
  );
  const plan = await evaluate("window.gamepilot.plannerSnapshot()");
  assert.equal(plan.result.status, "draft");
  assert.equal(plan.result.canExecute, false);
  assert.equal(plan.result.transport, "compatible");
  assert.equal(plan.result.trace.length, 3);
  await measure("planner-draft", 1440);
  await writeFile(
    join(out, "planner-result.json"),
    JSON.stringify(plan, null, 2),
  );
  view = await evaluate("window.gamepilot.modelProvider()");
  await evaluate(
    `window.gamepilot.saveModelProvider(${JSON.stringify({ ...view, model: "edited-model" })})`,
  );
  assert.equal(
    (await evaluate("window.gamepilot.plannerSnapshot()")).error.code,
    "MODEL_CONFIG_CHANGED",
  );
  await click("模型连接");
  await until(
    () => evaluate("!!document.querySelector('#model-api-key')"),
    "models return",
  );
  await click("清除已存密钥");
  await click("保存配置");
  await until(
    () =>
      evaluate(
        "(async()=> !(await window.gamepilot.modelProvider()).hasApiKey)()",
      ),
    "key cleared",
  );
  assert.ok(!JSON.parse(await readFile(profile, "utf8")).encryptedKey);
  const afterSnapshot = await evaluate("window.gamepilot.snapshot()");
  assert.equal(afterSnapshot.events?.length ?? 0, eventCount);
  assert.deepEqual(await hashes(), before);
  await writeFile(
    join(out, "result.json"),
    JSON.stringify(
      {
        version: "0.13.0",
        realElectronEncryption: true,
        savedReadback: true,
        keyCleared: true,
        connectionTest: true,
        plannerTools: plan.result.trace.length,
        canExecute: false,
        cancellation: true,
        ipcMutualExclusion: true,
        navigationRestored: true,
        keyboardFocus: true,
        staleResultInvalidated: true,
        productionHashesUnchanged: true,
        gameActions: 0,
        requests: calls.length,
        service: "loopback mock only",
      },
      null,
      2,
    ),
  );
  success = true;
  console.log(
    "Compatible desktop smoke passed: encrypted storage, UI, authenticated mock, tool draft, cancellation, IPC exclusion; production unchanged.",
  );
} finally {
  release();
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      await evaluate("window.gamepilot.quit()");
    } catch {}
    ws.close();
  }
  if (child) {
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      sleep(4000),
    ]);
    if (child.exitCode === null) child.kill();
  }
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (original) await writeFile(profile, original);
  else await rm(profile, { force: true });
  if (!success)
    await writeFile(
      join(out, "failed.txt"),
      "Desktop integration did not complete; see command error.",
    );
}
