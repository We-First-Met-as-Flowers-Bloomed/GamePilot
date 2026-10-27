import { describe, expect, it, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import { isCourtyard, quitGameCancelPoint } from "../games/onmyoji/policy";
import type { Frame, GameDevice } from "../packages/runtime/device";
import fixture from "./fixtures/onmyoji/quit-confirm-20261015.json";

/**
 * 2026-10-15 实机发现的隐患：误触返回键会弹出「退出游戏」确认框，而**框后面的庭院
 * 依然被 isCourtyard 认出来** —— 技能会以为一切正常，把点击打在框上（可能点到「确认」）。
 * 现在 shot() 会先识别它并只点「取消」。夹具是当时那张真实帧。
 */
const dialog = fixture as unknown as Frame;
const frame = (...rows: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: rows.map(([text, x, y]) => ({ text, box: [x, y, 100, 40], score: 1 })),
});
const courtyard = frame(["加成", 546, 49], ["探索", 986, 206]);

describe("退出游戏确认框", () => {
  it("真实帧上认出来，并且只给「取消」的点击点", () => {
    // 先确认危险前提成立：框在时庭院判据依然为真。
    expect(isCourtyard(dialog)).toBe(true);
    const point = quitGameCancelPoint(dialog)!;
    expect(point[0]).toBe(1207);
    expect(point[1]).toBeCloseTo(659.5, 1);
    // 取消在左、确认在右：绝不能给出确认那一侧的点。
    expect(point[0]).toBeLessThan(1318);
  });

  it("缺少「确认」时不认（避免把别的对话框当成退出确认）", () => {
    const noConfirm: Frame = {
      ...dialog,
      texts: (dialog.texts ?? []).filter((hit) => hit.text !== "确认"),
    };
    expect(quitGameCancelPoint(noConfirm)).toBeUndefined();
  });

  it("普通庭院上没有误判", () => {
    expect(quitGameCancelPoint(courtyard)).toBeUndefined();
  });

  it("走真实技能路径时也只会点「取消」，并且照常完成", async () => {
    // login() 每帧都经过 shot()：第一帧是退出确认框，之后是干净庭院。
    let observed = 0;
    const clicks: [number, number][] = [];
    const device = {
      observe: vi.fn(async () => (observed++ === 0 ? dialog : courtyard)),
      click: vi.fn(async (x: number, y: number) => {
        clicks.push([x, y]);
      }),
      startApp: vi.fn(async () => {}),
      packages: vi.fn(async () => ["com.netease.onmyoji"]),
      isAppRunning: vi.fn(async () => true),
      matchTemplate: vi.fn(async () => null),
      matchFeatures: vi.fn(async () => null),
      swipe: vi.fn(async () => {}),
      longPress: vi.fn(async () => {}),
      colorSlots: vi.fn(async () => []),
    } as unknown as GameDevice;
    const logs: string[] = [];
    const adapter = new OnmyojiDaily(
      device,
      (message) => logs.push(message),
      async () => {},
    );
    const result = await adapter.login(new AbortController().signal);
    expect(result.status).toBe("succeeded");
    expect(
      clicks.some(([x, y]) => x === 1207 && Math.abs(y - 659.5) < 1),
    ).toBe(true);
    // 「确认」在 (1351,658) 附近：绝不能被点。
    for (const [x] of clicks) expect(x).toBeLessThan(1300);
    expect(logs.some((line) => line.includes("退出游戏"))).toBe(true);
  });
});
