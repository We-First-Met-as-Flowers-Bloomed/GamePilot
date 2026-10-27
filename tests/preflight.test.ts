import { describe, expect, it } from "vitest";
import {
  normalizeExe,
  renderPreflight,
  runPreflightChecks,
  type PreflightFacts,
} from "../scripts/preflight/checks";
import { planFixes } from "../scripts/preflight/fix";

/**
 * 这些用例来自 2026-10-14/15 真丢过日常的两种情形：换包没重指启动项、以及运行的是旧包。
 */
const facts = (overrides: Partial<PreflightFacts> = {}): PreflightFacts => ({
  repoVersion: "0.16.9",
  appVersion: "0.16.9",
  bridgeOnline: true,
  appReady: true,
  plannerStatus: "idle",
  openRequestCount: 0,
  blockers: [],
  autostartPath: "D:\\Projects\\GamePilot\\release\\GamePilot-0.16.9\\GamePilot.exe",
  expectedExe: "D:\\Projects\\GamePilot\\release\\GamePilot-0.16.9\\GamePilot.exe",
  schedule: {
    scheduleEnabled: true,
    scheduleTime: "08:00",
    secondScheduleEnabled: true,
    secondScheduleTime: "20:00",
    fosterScheduleEnabled: true,
  },
  devices: [
    { lane: "lane-a", name: "账号一", address: "127.0.0.1:16384", reachable: true },
    { lane: "lane-b", name: "账号二", address: "127.0.0.1:16416", reachable: true },
  ],
  ...overrides,
});

describe("开跑前自检", () => {
  it("全部正常时判定可以照常开跑", () => {
    const report = runPreflightChecks(facts());
    expect(report.go).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(renderPreflight(report)).toContain("可以照常开跑");
  });

  it("运行的是旧包时拦住（出了新包没切，实机跑的是旧逻辑）", () => {
    const report = runPreflightChecks(facts({ appVersion: "0.16.8" }));
    const build = report.checks.find((check) => check.id === "build")!;
    expect(build.ok).toBe(false);
    // 切不切包由人决定：工具只报告，不自动切。
    expect(build.fixable).toBe(false);
    expect(build.detail).toContain("没切");
    expect(report.go).toBe(false);
    expect(renderPreflight(report)).toContain("需要人工决定");
  });

  it("换包后没重指启动项时拦住，并说明重启会怎样", () => {
    const report = runPreflightChecks(
      facts({
        autostartPath:
          "D:\\Projects\\GamePilot\\release\\GamePilot-0.16.3\\GamePilot.exe",
      }),
    );
    const check = report.checks.find((item) => item.id === "autostart")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("重启会拉起旧版本");
    expect(renderPreflight(report)).toContain("可自动修");
  });

  it("注册表值带 --autostart 参数时不算失败（首次真机自检的误报）", () => {
    const report = runPreflightChecks(
      facts({
        autostartPath:
          '"D:\\Projects\\GamePilot\\release\\GamePilot-0.16.9\\GamePilot.exe" --autostart',
      }),
    );
    expect(report.checks.find((item) => item.id === "autostart")!.ok).toBe(true);
    expect(normalizeExe('"D:\\a\\GamePilot.exe" --autostart')).toBe(
      "d:\\a\\gamepilot.exe",
    );
    expect(normalizeExe("D:\\a\\GamePilot.exe --autostart")).toBe(
      "d:\\a\\gamepilot.exe",
    );
  });

  it("未终态记录会挡住准入，点名报出来", () => {
    const report = runPreflightChecks(
      facts({ openRequestCount: 2, blockers: ["账号一 有未确认请求"] }),
    );
    const check = report.checks.find((item) => item.id === "admission")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("未终态 2 条");
    expect(check.detail).toContain("账号一 有未确认请求");
  });

  it("定时被关掉或时间被改走时报出来", () => {
    const report = runPreflightChecks(
      facts({ schedule: { scheduleEnabled: false, secondScheduleEnabled: true } }),
    );
    const check = report.checks.find((item) => item.id === "schedule")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("主槽 关");
  });

  it("模拟器不可达时报出具体槽位与地址", () => {
    const report = runPreflightChecks(
      facts({
        devices: [
          { lane: "lane-a", name: "账号一", address: "127.0.0.1:16384", reachable: true },
          { lane: "lane-b", name: "账号二", address: "127.0.0.1:16416", reachable: false },
        ],
      }),
    );
    const check = report.checks.find((item) => item.id === "devices")!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("账号二(127.0.0.1:16416)");
  });

  it("App 自检未就绪属于需要人工决定的项", () => {
    const report = runPreflightChecks(facts({ appReady: false }));
    const check = report.checks.find((item) => item.id === "ready")!;
    expect(check.fixable).toBe(false);
    expect(renderPreflight(report)).toContain("需要人工决定");
  });
});

describe("自检的修复计划", () => {
  it("只在无歧义的三类问题上出手：拉起 App、重指引用、拉起模拟器", () => {
    const broken = facts({
      bridgeOnline: false,
      autostartPath:
        "D:\\Projects\\GamePilot\\release\\GamePilot-0.16.3\\GamePilot.exe",
      devices: [
        { lane: "lane-a", name: "账号一", address: "127.0.0.1:16384", reachable: false },
        { lane: "lane-b", name: "账号二", address: "127.0.0.1:16416", reachable: false },
      ],
    });
    const actions = planFixes(broken, runPreflightChecks(broken));
    expect(actions.map((action) => action.kind)).toEqual([
      "start-app",
      "repoint-references",
      "start-emulators",
    ]);
    // 地址 → MuMu 实例号（16384+32×n）。
    expect(actions.at(-1)?.instances).toEqual([0, 1]);
  });

  it("定时被关、有未终态记录、跑的是旧包：只报告，不自动改", () => {
    const risky = facts({
      appVersion: "0.16.8",
      openRequestCount: 1,
      blockers: ["账号一 有未确认请求"],
      schedule: { scheduleEnabled: false, secondScheduleEnabled: false },
    });
    const report = runPreflightChecks(risky);
    expect(report.go).toBe(false);
    expect(planFixes(risky, report)).toEqual([]);
    for (const id of ["build", "admission", "schedule"])
      expect(report.checks.find((check) => check.id === id)!.fixable).toBe(false);
  });

  it("一切正常时没有可修项", () => {
    const healthy = facts();
    expect(planFixes(healthy, runPreflightChecks(healthy))).toEqual([]);
  });
});
