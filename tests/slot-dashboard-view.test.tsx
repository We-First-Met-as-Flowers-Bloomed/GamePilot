import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SlotDashboard from "../apps/desktop/renderer/views/SlotDashboard";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { DesktopController } from "../apps/desktop/renderer/hooks/useDesktop";

function desktop(overrides: Record<string, unknown> = {}): DesktopController {
  return {
    api: {},
    hydrated: true,
    deviceLanes: {
      version: 1,
      lanes: [0, 1].map((instance) => ({
        id: `lane-${instance === 0 ? "a" : "b"}`,
        name: `账号${instance + 1} · 双游戏`,
        enabled: true,
        instance,
        managerPath: "D:/Fixture/MuMuManager.exe",
        closeEmulatorAfterSuccess: false,
        arknights: { enabled: true, profileId: `profile-${instance}` },
        onmyoji: { enabled: true },
      })),
    },
    arknightsProfiles: {
      profiles: [0, 1].map((id) => ({
        ...defaultArknightsConfig,
        id: `profile-${id}`,
        name: `方舟档案${id + 1}`,
      })),
    },
    laneDailyStates: {},
    laneStatuses: {},
    taskRecords: [],
    allEvents: [],
    snapshot: {},
    setView: vi.fn(),
    startGameSlot: vi.fn(),
    stopGameSlot: vi.fn(),
    ...overrides,
  } as unknown as DesktopController;
}
const render = (d: DesktopController) =>
  renderToStaticMarkup(createElement(SlotDashboard, { desktop: d }));

describe("game account slot home", () => {
  it("keeps provenance in the disclosure while the latest conclusion stays visible", () => {
    const html = render(desktop());
    const cards = html.split("<article").slice(1);
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      const [summary, disclosure] = card.split("<details");
      expect(summary).toContain('role="status"');
      expect(summary).toContain("运行此游戏");
      expect(summary).not.toContain("执行范围");
      expect(summary).not.toContain("来源渠道");
      expect(disclosure).toContain("执行范围");
      expect(disclosure).toContain("来源渠道");
    }
  });
  it("renders four single-game cards with explicit slot identities and shared physical instances", () => {
    const html = render(desktop());
    const ids = [...html.matchAll(/data-slot-id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([
      "lane-a:arknights",
      "lane-a:onmyoji",
      "lane-b:arknights",
      "lane-b:onmyoji",
    ]);
    expect(
      [...html.matchAll(/data-slot-game-id="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(["arknights", "onmyoji", "arknights", "onmyoji"]);
    expect([...html.matchAll(/data-game-id="([^"]+)"/g)]).toHaveLength(4);
    expect(html).toContain("共享实例");
    expect(html).toContain("运行此游戏");
    expect(html).not.toContain("运行全部保存计划");
    expect(html).not.toContain("明日方舟视角");
    expect(html).not.toContain("chat-prompt");
  });
  it("does not label a lane-only running request as four independently stoppable game runs", () => {
    const html = render(
      desktop({
        busy: "independent-operation",
        active: true,
        laneStatuses: { "lane-a": "running" },
      }),
    );
    expect(html).toContain("停止全部槽位");
    expect(html).not.toMatch(/<button[^>]*aria-label="停止槽位 [^"]+"[^>]*>/);
  });
  it("keeps only the owned game stop enabled while a start receipt is pending", () => {
    const html = render(
      desktop({
        busy: "game-slot-start",
        active: true,
        snapshot: {
          executions: [
            {
              version: 1,
              id: "request-ark",
              laneId: "lane-a",
              batchId: "batch-ark",
              source: "daily",
              resources: [],
              fingerprint: "fixture",
              status: "running",
              startedAt: "2026-10-24T02:00:00Z",
              message: "fixture",
              snapshot: {
                gameSlot: { laneId: "lane-a", gameId: "arknights" },
                arknightsPlan: {
                  gameId: "arknights",
                  mode: "live",
                  skillIds: ["login"],
                },
              },
            },
          ],
        },
      }),
    );
    const stop = html.match(
      /<button[^>]*aria-label="停止槽位 明日方舟 · 方舟档案1"[^>]*>/,
    )?.[0];
    expect(stop).toBeDefined();
    expect(stop).not.toContain("disabled");
    expect(html).not.toMatch(/aria-label="停止槽位 阴阳师/);
    expect(html).toContain("停止全部槽位");
  });
  it("offers configuration rather than invented game accounts in an empty workspace", () => {
    const html = render(desktop({ deviceLanes: { version: 1, lanes: [] } }));
    expect(html).toContain("从第一个账号槽位开始");
    expect(html).toContain("配置设备与账号");
    expect(html).not.toContain("data-slot-id=");
  });
  it("does not mistake unread configuration for an empty workspace", () => {
    const html = render(
      desktop({ hydrated: false, deviceLanes: { version: 1, lanes: [] } }),
    );
    expect(html).toContain("正在读取已保存的槽位与账号配置");
    expect(html).not.toContain("从第一个账号槽位开始");
    expect(html).not.toContain("槽位统计");
  });
});
