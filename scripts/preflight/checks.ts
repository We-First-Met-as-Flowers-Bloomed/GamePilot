/**
 * 开跑前自检（preflight）的判定与渲染（纯函数，可测）。
 *
 * 为什么要它：2026-10-14/15 连续两天各丢了一整条日常，原因都不是游戏不会玩，而是
 * 「开跑前就注定跑不成」——启动项指向旧包、App 没随开机起来、未终态记录挡住准入、
 * 庭场上挂着过期活动浮层、登录路径有竞态。这些在 08:00 之前五分钟就能查出来。
 *
 * 判定只用调用方喂进来的事实（App 版本、桥的 preflight、automation.json、注册表、adb），
 * 本模块不发起任何操作；可自动修的项标 fixable，交给监督回合按流程处理。
 */
export interface PreflightFacts {
  /** 仓库当前包的版本（package.json）。 */
  repoVersion: string;
  /** 运行中的 App 版本（控制桥）。 */
  appVersion?: string;
  /** 控制桥是否答得上话。 */
  bridgeOnline: boolean;
  /** App 自己的就绪判定（preflight.ready）。 */
  appReady?: boolean;
  plannerStatus?: string;
  /** 未终态请求数（会挡住整轮日常）。 */
  openRequestCount?: number;
  /** App 给出的阻塞说明。 */
  blockers?: string[];
  /** 开机自启指向的可执行文件（读不到就是空）。 */
  autostartPath?: string;
  /** 期望的可执行文件（当前运行的这个包）。 */
  expectedExe: string;
  /** automation.json 的定时配置。 */
  schedule: {
    scheduleEnabled?: boolean;
    scheduleTime?: string;
    secondScheduleEnabled?: boolean;
    secondScheduleTime?: string;
    fosterScheduleEnabled?: boolean;
  };
  /** 已启用槽位的设备可达性。 */
  devices: { lane: string; name: string; address: string; reachable: boolean }[];
}

export interface PreflightCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** 监督回合能否自己修（否则要人决定）。 */
  fixable: boolean;
}

export interface PreflightReport {
  generatedAt: string;
  go: boolean;
  checks: PreflightCheck[];
}

/**
 * 注册表 Run 的值形如 `"D:\...\GamePilot.exe" --autostart`：先取出可执行文件本身再比较，
 * 否则参数里的 ` --autostart` 会让每一次自检都误报（2026-10-15 首次真机自检就踩了）。
 */
export function normalizeExe(value: string): string {
  const trimmed = value.trim();
  const quoted = /^"([^"]+)"/.exec(trimmed)?.[1];
  if (quoted) return quoted.trim().toLowerCase();
  return trimmed.split(/\s+--?/)[0]!.trim().toLowerCase();
}

export function runPreflightChecks(
  facts: PreflightFacts,
  now = new Date(),
): PreflightReport {
  const checks: PreflightCheck[] = [];
  const add = (
    id: string,
    label: string,
    ok: boolean,
    detail: string,
    fixable: boolean,
  ) => checks.push({ id, label, ok, detail, fixable });

  add(
    "bridge",
    "控制桥能连上运行中的 App",
    facts.bridgeOnline,
    facts.bridgeOnline
      ? `App ${facts.appVersion ?? "未知版本"} 在线`
      : "连不上：先确认 GamePilot.exe 在运行（必要时按启动项路径拉起）",
    true,
  );
  add(
    "build",
    "运行的是当前这个包",
    facts.bridgeOnline && facts.appVersion === facts.repoVersion,
    facts.appVersion === facts.repoVersion
      ? `版本一致：${facts.repoVersion}`
      : `运行中 ${facts.appVersion ?? "未知"}，仓库 ${facts.repoVersion}：出了新包但没切，实机跑的是旧逻辑`,
    // 切不切包、切哪版由人决定，工具不自动切。
    false,
  );
  add(
    "ready",
    "App 自检就绪",
    facts.appReady === true,
    facts.appReady === true ? "preflight.ready = true" : "App 自检未就绪",
    false,
  );
  add(
    "planner",
    "规划器空闲",
    facts.plannerStatus === "idle",
    `plannerStatus = ${facts.plannerStatus ?? "未知"}`,
    false,
  );
  add(
    "admission",
    "没有会挡准入的未终态记录",
    (facts.openRequestCount ?? 0) === 0 && !(facts.blockers ?? []).length,
    (facts.openRequestCount ?? 0) === 0 && !(facts.blockers ?? []).length
      ? "未终态请求 0"
      : `未终态 ${facts.openRequestCount ?? "?"} 条；阻塞：${(facts.blockers ?? []).join("；") || "无说明"}`,
    // 处置未终态记录要先核对现场，属于判断，不交给自动修。
    false,
  );
  const autostartOk =
    Boolean(facts.autostartPath) &&
    normalizeExe(facts.autostartPath!) === normalizeExe(facts.expectedExe);
  add(
    "autostart",
    "开机自启指向当前包",
    autostartOk,
    autostartOk
      ? facts.autostartPath!
      : `注册项是 ${facts.autostartPath || "（无）"}，应为 ${facts.expectedExe}：换包后没重指，重启会拉起旧版本或根本不起`,
    true,
  );
  const s = facts.schedule;
  const scheduleOk =
    s.scheduleEnabled === true &&
    s.scheduleTime === "08:00" &&
    s.secondScheduleEnabled === true &&
    (s.secondScheduleTime ?? "20:00") === "20:00";
  add(
    "schedule",
    "定时（08:00 主槽 / 20:00 次槽 / 寄养）都开着",
    scheduleOk,
    scheduleOk
      ? `主槽 ${s.scheduleTime} · 次槽 ${s.secondScheduleTime} · 寄养 ${s.fosterScheduleEnabled ? "开" : "关"}`
      : `主槽 ${s.scheduleEnabled ? s.scheduleTime : "关"} · 次槽 ${s.secondScheduleEnabled ? s.secondScheduleTime : "关"} · 寄养 ${s.fosterScheduleEnabled ? "开" : "关"}`,
    // 关掉定时可能是大人故意的：只报告，不自动改回去。
    false,
  );
  const unreachable = facts.devices.filter((item) => !item.reachable);
  add(
    "devices",
    "已启用槽位的模拟器都可达",
    facts.devices.length > 0 && unreachable.length === 0,
    facts.devices.length === 0
      ? "没有已启用且需要跑日常的槽位"
      : unreachable.length
        ? `不可达：${unreachable.map((item) => `${item.name}(${item.address})`).join("、")}`
        : facts.devices.map((item) => `${item.name}(${item.address})`).join("、"),
    true,
  );

  return {
    generatedAt: now.toISOString(),
    go: checks.every((check) => check.ok),
    checks,
  };
}

export function renderPreflight(report: PreflightReport): string {
  const lines = [
    `# 开跑前自检 · ${report.generatedAt}`,
    "",
    report.go
      ? "**结论：可以照常开跑**（所有检查通过）"
      : "**结论：需要处理后再开跑**",
    "",
    "| | 检查 | 说明 | 可自动修 |",
    "|---|---|---|---|",
  ];
  for (const check of report.checks)
    lines.push(
      `| ${check.ok ? "✅" : "❌"} | ${check.label} | ${check.detail.replace(/\|/g, "/")} | ${check.ok ? "—" : check.fixable ? "是" : "否，需人工"} |`,
    );
  const fixable = report.checks.filter((check) => !check.ok && check.fixable);
  const manual = report.checks.filter((check) => !check.ok && !check.fixable);
  lines.push("");
  if (fixable.length)
    lines.push(
      `**可自动修**：${fixable.map((check) => check.label).join("、")} —— 按监督流程处理后重跑本自检。`,
      "",
    );
  if (manual.length)
    lines.push(
      `**需要人工决定**：${manual.map((check) => `${check.label}（${check.detail}）`).join("、")}`,
      "",
    );
  return lines.join("\n");
}
