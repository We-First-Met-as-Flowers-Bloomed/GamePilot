/**
 * 开跑前自检入口：把 App 侧的事实收集齐，跑判定，写报告，可选暖机。
 *
 *   npm run daily:preflight            只检查（不碰游戏）
 *   npm run daily:preflight -- --warm  检查后用游戏模式各跑一次 --only login（会操作真实游戏）
 *
 * 收集的事实：控制桥 doctor/preflight（在线、版本、就绪、未终态、阻塞）、
 * automation.json（定时配置）、注册表 Run（开机自启）、adb（槽位设备可达）。
 * 判定与渲染在 scripts/preflight/checks.ts（纯函数，有用例）。
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { build } from "esbuild";

const run = promisify(execFile);
/** 需要把子进程输出直接接到当前终端时用 spawn（execFile+inherit 实测拿不到输出）。 */
function runInherit(command, commandArgs, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      done(1);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code ?? 1);
    });
  });
}
const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dataDir = value("data", "C:\\Users\\YOUR_NAME\\.gamepilot");
const bridge = value("bridge", "D:\\Desktop\\yys\\dsh_control\\bin\\gamepilot.mjs");
const expectedExe = value(
  "exe",
  resolve(root, `release/GamePilot-${JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version}/GamePilot.exe`),
);

// 判定与修复计划是 TS：打成 bundle 再 import（与本仓库其它工具一致）。
const outfile = resolve(root, "artifacts/preflight/checks.mjs");
await build({
  absWorkingDir: root,
  entryPoints: ["scripts/preflight/harness.ts"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
const { runPreflightChecks, renderPreflight, planFixes } = await import(
  `file://${outfile.replace(/\\/g, "/")}`
);

const repoVersion = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).version;
const adbPath =
  (() => {
    try {
      return JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"))
        .adbPath;
    } catch {
      return undefined;
    }
  })() ?? "D:\\mumu12\\MuMu Player 12\\nx_main\\adb.exe";
const lanes = (() => {
  try {
    return (
      JSON.parse(readFileSync(join(dataDir, "device-lanes.json"), "utf8")).lanes ??
      []
    );
  } catch {
    return [];
  }
})();

async function json(commandArgs) {
  try {
    const { stdout } = await run(process.execPath, [bridge, ...commandArgs], {
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    });
    return JSON.parse(stdout.slice(stdout.indexOf("{")));
  } catch {
    return undefined;
  }
}

/** 收集一次事实（--fix 修完会重新收集，因为 App 版本/自启/设备都可能刚变过）。 */
async function collectFacts() {
  const doctor = await json(["doctor", "--json"]);
  const appPreflight = await json(["preflight", "--json"]);
  let automation = {};
  try {
    automation = JSON.parse(readFileSync(join(dataDir, "automation.json"), "utf8"));
  } catch {
    automation = {};
  }
  let autostartPath = "";
  try {
    const { stdout } = await run(
      "reg",
      [
        "query",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        "GamePilot",
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    autostartPath = /GamePilot\s+REG_SZ\s+(.+)/.exec(stdout)?.[1]?.trim() ?? "";
  } catch {
    autostartPath = "";
  }
  const adb = await adbDevices();
  const wanted = lanes
    .filter(
      (lane) => lane.enabled && (lane.arknights?.enabled || lane.onmyoji?.enabled),
    )
    .map((lane) => ({
      lane: lane.id,
      name: lane.name,
      address: `127.0.0.1:${16384 + 32 * (lane.instance ?? 0)}`,
    }));
  return {
    repoVersion,
    appVersion: appPreflight?.appVersion ?? doctor?.app?.version,
    bridgeOnline: Boolean(doctor?.ok || appPreflight?.ok),
    appReady: appPreflight?.ready,
    plannerStatus: appPreflight?.plannerStatus,
    openRequestCount: appPreflight?.openRequestCount,
    blockers: (appPreflight?.blockers ?? []).map((item) =>
      typeof item === "string" ? item : (item?.message ?? JSON.stringify(item)),
    ),
    autostartPath,
    expectedExe,
    schedule: automation,
    devices: wanted.map((device) => ({
      ...device,
      reachable: new RegExp(
        `^${device.address.replace(/\./g, "\\.")}\\s+device`,
        "m",
      ).test(adb),
    })),
  };
}

const facts = await collectFacts();

const report = runPreflightChecks(facts);
const markdown = renderPreflight(report);
const day = new Date().toLocaleDateString("sv-SE");
const outDir = resolve(root, "artifacts/preflight", day);
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "preflight.md"), markdown);
console.log(markdown);
console.error(`报告：${resolve(outDir, "preflight.md")}`);

/* ---------- --fix：只做无歧义、可逆、幂等的修复，然后重跑自检 ---------- */
const SHORTCUTS = [
  "D:\\Desktop\\GamePilot.lnk",
  "C:\\Users\\YOUR_NAME\\Desktop\\GamePilot.lnk",
  `${process.env.APPDATA}\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar\\Electron.lnk`,
];
const MUMU = "D:\\mumu12\\MuMu Player 12\\nx_main\\MuMuManager.exe";

async function adbDevices() {
  try {
    return (await run(adbPath, ["devices"], { windowsHide: true, timeout: 30_000 })).stdout;
  } catch {
    return "";
  }
}

async function applyFix(action) {
  console.error(`[fix] ${action.label} —— ${action.detail}`);
  if (action.kind === "start-app") {
    spawn(expectedExe, ["--autostart"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    await new Promise((done) => setTimeout(done, 15_000));
    return;
  }
  if (action.kind === "repoint-references") {
    await run(
      "reg",
      [
        "add",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        "/v",
        "GamePilot",
        "/t",
        "REG_SZ",
        "/d",
        `"${expectedExe}" --autostart`,
        "/f",
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    const script = [
      "$shell = New-Object -ComObject WScript.Shell",
      ...SHORTCUTS.map(
        (path) =>
          `if (Test-Path '${path}') { $l = $shell.CreateShortcut('${path}'); $l.TargetPath = '${expectedExe}'; $l.WorkingDirectory = '${resolve(expectedExe, "..")}'; $l.IconLocation = '${expectedExe},0'; $l.Save() }`,
      ),
    ].join("; ");
    await run("powershell", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 60_000,
    });
    return;
  }
  if (action.kind === "start-emulators") {
    const addresses = (action.detail ?? "").split("、").filter(Boolean);
    const allUp = async () => {
      const devices = await adbDevices();
      return addresses.every((address) =>
        new RegExp(`^${address.replace(/\./g, "\\.")}\\s+device`, "m").test(devices),
      );
    };
    // 2026-10-15 实测：模拟器明明在跑（player_state = start_finished）、adb devices 却是空的
    // ——"不可达"最常见的原因是 **adb 掉线**，不是实例没起来。所以先重启 adb 服务器并逐个 connect，
    // 只有这一步不够时才去拉起实例。
    try {
      await run(adbPath, ["start-server"], { windowsHide: true, timeout: 60_000 });
    } catch {
      // adb 起不来就继续走后面的拉起实例流程。
    }
    for (const address of addresses) {
      try {
        await run(adbPath, ["connect", address], {
          windowsHide: true,
          timeout: 30_000,
        });
      } catch (error) {
        console.error(
          `[fix] adb connect ${address} 失败：${error instanceof Error ? error.message : error}`,
        );
      }
    }
    if (await allUp()) return;
    for (const instance of action.instances ?? []) {
      console.error(`[fix] MuMuManager 拉起实例 ${instance}`);
      try {
        await run(
          MUMU,
          ["control", "--vmindex", String(instance), "launch"],
          { windowsHide: true, timeout: 120_000 },
        );
      } catch (error) {
        console.error(`[fix] 拉起实例 ${instance} 失败：${error instanceof Error ? error.message : error}`);
      }
    }
    // 等设备上线（最多 4 分钟），再交给上层重跑自检。
    for (let attempt = 0; attempt < 24; attempt++) {
      if (await allUp()) return;
      if (attempt === 2) {
        // 实例可能刚起来但 adb 还没接上，再 connect 一轮。
        for (const address of addresses)
          await run(adbPath, ["connect", address], {
            windowsHide: true,
            timeout: 30_000,
          }).catch(() => {});
      }
      await new Promise((done) => setTimeout(done, 10_000));
    }
    console.error("[fix] 等待模拟器上线超时；下次自检会如实报告");
  }
}

let finalReport = report;
let finalMarkdown = markdown;
if (args.includes("--fix") && !report.go) {
  for (let round = 1; round <= 2 && !finalReport.go; round++) {
    const actions = planFixes(facts, finalReport);
    const executable = actions.filter((action) =>
      ["start-app", "repoint-references", "start-emulators"].includes(action.kind),
    );
    if (!executable.length) {
      console.error(
        `[fix] 第 ${round} 轮：没有可自动修的项，剩下的需要人工决定`,
      );
      break;
    }
    console.error(`\n[fix] 第 ${round} 轮：${executable.length} 项`);
    for (const action of executable) await applyFix(action);
    // 重新收集事实（App 版本、自启、设备都可能刚变过）。
    const again = await collectFacts();
    finalReport = runPreflightChecks(again);
    finalMarkdown = renderPreflight(finalReport);
  }
  writeFileSync(resolve(outDir, "preflight.md"), finalMarkdown);
  console.log("\n" + finalMarkdown);
}

if (args.includes("--warm")) {
  // 暖机：用游戏模式各跑一次登录（只核对登录态、会顺带关掉已知浮层）。
  // 注意用 facts.devices（带 reachable），wanted 上没有这个字段——2026-10-15 首次跑就踩了。
  for (const device of facts.devices.filter((item) => item.reachable)) {
    for (const game of ["onmyoji", "arknights"]) {
      const config = lanes.find((item) => item.id === device.lane)?.[game];
      if (!config?.enabled) continue;
      console.error(`\n=== 暖机 ${device.lane} · ${game} ===`);
      const code = await runInherit(
        process.execPath,
        [
          resolve(root, "scripts/game-mode.mjs"),
          "--lane",
          device.lane.replace(/^lane-/, ""),
          "--game",
          game,
          "--only",
          "login",
        ],
        600_000,
      );
      if (code !== 0) console.error(`暖机 ${device.lane}·${game} 退出码 ${code}`);
    }
  }
}
process.exit(finalReport.go ? 0 : 1);
