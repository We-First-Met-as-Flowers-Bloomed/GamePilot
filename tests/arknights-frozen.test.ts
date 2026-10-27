import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 方舟日常模块冻结锁（2026-10-15）。
 *
 * 背景：双账号冷启动并行实跑 6/6（login/recruit/fight/infrastructure/friends/award）
 * 全部通过后，用户要求"锁定方舟日常，后面只开发阴阳师"。这个测试就是那把锁：
 * 冻结清单里的任何文件一旦改动，CI 会红，必须显式说明理由并更新 `frozen.json`。
 *
 * 这不是禁止修改，而是禁止**无意识**修改：方舟日常涉及真实账号的作战、公招与信用购物，
 * 静默改动比什么都危险。要改就请同时更新清单，让改动可见、可追溯。
 */
const manifest = JSON.parse(
  readFileSync(new URL("../games/arknights/frozen.json", import.meta.url), "utf8"),
) as { version: number; frozenAt: string; reason: string; files: Record<string, string> };

/** 冻结范围包含日常执行、typed 参数及导入边界；新增执行文件需显式进入清单。 */
const expected = [
  "award-flags.ts",
  "capabilities.ts",
  "config.ts",
  "copilot-options.ts",
  "credit-shopping.ts",
  "daily-plan.ts",
  "evidence.ts",
  "execution.ts",
  "extended-options.ts",
  "fight-queue.ts",
  "index.ts",
  "inspection.ts",
  "inspect-device.ts",
  "lane-plugin.ts",
  "maa-gui-import.ts",
  "navigation.ts",
  "profile-login.ts",
  "recognition.ts",
  "result-policy.ts",
  "startup-recovery.ts",
  "startup-reconciliation.ts",
  "task-options.ts",
  "worker-adapter.ts",
];

describe("arknights daily module freeze", () => {
  it("lists exactly the daily execution files", () => {
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.files).sort()).toEqual([...expected].sort());
  });

  it("keeps every frozen file byte-identical", () => {
    const changed: string[] = [];
    for (const [file, hash] of Object.entries(manifest.files)) {
      const actual = createHash("sha256")
        .update(readFileSync(new URL(`../games/arknights/${file}`, import.meta.url)))
        .digest("hex");
      if (actual !== hash) changed.push(file);
    }
    expect(
      changed,
      `方舟日常模块已冻结（${manifest.frozenAt}）：${changed.join("、")} 与冻结清单不一致。` +
        `如确需修改，请说明理由并更新 games/arknights/frozen.json。`,
    ).toEqual([]);
  });
});
