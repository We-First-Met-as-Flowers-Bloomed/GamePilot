/**
 * 开跑前自检的修复计划（纯函数，可测）。
 *
 * 只规划**无歧义、可逆、幂等**的动作：
 *  - App 没在跑 → 用当前包拉起；
 *  - 开机自启/快捷方式指旧包 → 重指到当前包（含图标，否则旧包永远删不掉）；
 *  - 模拟器没起来 → 用 MuMuManager 拉起对应实例。
 *
 * 刻意不自动改的：定时配置（可能是大人故意关的）、未终态记录（要先核对现场）、
 * 运行的是旧包（要不要切包、切哪版是人决定的）。这些只报告。
 */
import type { PreflightFacts, PreflightReport } from "./checks";

export type FixKind = "start-app" | "repoint-references" | "start-emulators";

export interface FixAction {
  /** 对应的检查 id。 */
  check: string;
  kind: FixKind;
  label: string;
  detail: string;
  /** start-emulators 用：要拉起的实例号。 */
  instances?: number[];
}

export function planFixes(
  facts: PreflightFacts,
  report: PreflightReport,
): FixAction[] {
  const failing = new Set(
    report.checks.filter((check) => !check.ok).map((check) => check.id),
  );
  const actions: FixAction[] = [];
  if (failing.has("bridge"))
    actions.push({
      check: "bridge",
      kind: "start-app",
      label: "用当前包启动 App",
      detail: facts.expectedExe,
    });
  if (failing.has("autostart"))
    actions.push({
      check: "autostart",
      kind: "repoint-references",
      label: "把开机自启与三个快捷方式重指到当前包（含图标）",
      detail: `当前 ${facts.autostartPath || "（无）"} → ${facts.expectedExe}`,
    });
  const down = facts.devices.filter((device) => !device.reachable);
  if (down.length)
    actions.push({
      check: "devices",
      kind: "start-emulators",
      label: `拉起模拟器：${down.map((device) => device.name).join("、")}`,
      detail: down.map((device) => device.address).join("、"),
      instances: down
        .map((device) => Number(/:(?:16384|16416|16448)$/.exec(device.address)?.[0]?.slice(1)))
        .filter((port) => Number.isFinite(port))
        .map((port) => (port - 16384) / 32),
    });
  return actions;
}
