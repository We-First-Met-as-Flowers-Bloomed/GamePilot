import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Devices from "../apps/desktop/renderer/views/Devices";
import Daily from "../apps/desktop/renderer/views/Daily";
import type { DesktopController } from "../apps/desktop/renderer/hooks/useDesktop";
import type { DeviceLanes } from "../packages/protocol";
import { defaultArknightsConfig } from "../games/arknights/config";
import RoutineEditor from "../apps/desktop/renderer/components/RoutineEditor";
import OnmyojiIdentitySettings from "../apps/desktop/renderer/components/OnmyojiIdentitySettings";
import type { Routine } from "../packages/protocol/routine";
import ChannelCopy from "../apps/desktop/renderer/components/ChannelCopy";
import GameWorkspace from "../apps/desktop/renderer/components/GameWorkspace";
import ArknightsSettings from "../apps/desktop/renderer/components/ArknightsSettings";
import Workspace from "../apps/desktop/renderer/views/Workspace";
import { games } from "../games/registry";
import ArknightsAutomation, {
  ArknightsAutomationControls,
} from "../apps/desktop/renderer/components/ArknightsAutomation";

function desktop() {
  const deviceLanes = {
    version: 2,
    lanes: [0, 1, 2, 3].map((instance) => ({
      id: `account-${instance}`,
      name: `${instance < 2 ? "方舟" : "阴阳师"}账号${instance + 1}`,
      instance,
      managerPath: "D:/Fixture/MuMuManager.exe",
      enabled: true,
      arknights: {
        enabled: instance < 2,
        profileId: `profile-${instance % 2}`,
      },
      onmyoji: { enabled: instance >= 2 },
      closeEmulatorAfterSuccess: false,
    })),
  } as DeviceLanes;
  return {
    api: {},
    game: games.find((game) => game.id === "arknights"),
    daily: [],
    selected: [],
    events: [],
    hydrated: true,
    deviceLanes,
    arknightsProfiles: {
      version: 1,
      activeProfileId: "profile-0",
      profiles: [0, 1].map((instance) => ({
        ...defaultArknightsConfig,
        id: `profile-${instance}`,
        name: `方舟档案${instance + 1}`,
      })),
    },
    laneDailyStates: Object.fromEntries(
      deviceLanes.lanes.map((lane) => [lane.id, { status: null }]),
    ),
    laneStatuses: {},
    taskRecords: [],
    allEvents: [],
    today: new Date("2026-10-25T10:00:00+08:00"),
    snapshot: {},
    mumuInstances: [],
    devices: [],
    settings: { adbPath: "", address: "" },
    setDeviceLanes: vi.fn(),
    setView: vi.fn(),
    startGameSlot: vi.fn(),
    stopGameSlot: vi.fn(),
    startLane: vi.fn(),
    stopLane: vi.fn(),
  } as unknown as DesktopController;
}

type Node = ReactElement<Record<string, any>>;
function nodes(root: ReactNode, predicate: (node: Node) => boolean): Node[] {
  return Children.toArray(root).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [
      ...(predicate(node) ? [node] : []),
      ...nodes(node.props.children, predicate),
    ];
  });
}
function render(
  component: typeof Devices | typeof Daily,
  d: DesktopController,
) {
  let tree!: ReactElement;
  function Probe() {
    tree = component({ desktop: d });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  return { html, tree };
}

describe("four independent account channel pages", () => {
  beforeEach(() => vi.stubGlobal("document", { hidden: false }));
  afterEach(() => vi.unstubAllGlobals());
  it("shows four device configurations with exactly their own game's settings", () => {
    const { html } = render(Devices, desktop());
    const cards = html
      .split("<article")
      .slice(1)
      .map((part) => part.split("</article>")[0]);
    expect(cards).toHaveLength(4);
    cards.forEach((card, instance) => {
      expect(card).toContain(`data-device-instance="${instance}"`);
      expect(card).toContain(
        `data-game-id="${instance < 2 ? "arknights" : "onmyoji"}"`,
      );
      expect(card.includes("明日方舟账号档案")).toBe(instance < 2);
      expect(card.includes("阴阳师角色核对")).toBe(instance >= 2);
      expect(card.match(/type="checkbox"/g)).toHaveLength(1);
    });
    expect(html).not.toContain("一条渠道可保存多个游戏");
  });

  it("runs each device channel with an exact game target", () => {
    const d = desktop();
    const { tree } = render(Devices, d);
    const buttons = nodes(
      tree,
      (node) =>
        node.type === "button" &&
        String(node.props["aria-label"] ?? "").startsWith("运行账号 "),
    );
    expect(buttons).toHaveLength(4);
    buttons.forEach((button) => button.props.onClick());
    expect(vi.mocked(d.startGameSlot).mock.calls).toEqual(
      [0, 1, 2, 3].map((instance) => [
        {
          laneId: `account-${instance}`,
          gameId: instance < 2 ? "arknights" : "onmyoji",
        },
      ]),
    );
    expect(d.startLane).not.toHaveBeenCalled();
  });

  it("shows four single-game daily plans and runs only the selected account", () => {
    const d = desktop();
    const { html, tree } = render(Daily, d);
    const cards = html
      .split("<article")
      .slice(1)
      .map((part) => part.split("</article>")[0]);
    expect(cards).toHaveLength(4);
    cards.forEach((card, instance) => {
      expect(card).toContain(`data-device-instance="${instance}"`);
      expect(card).toContain(
        `data-game-id="${instance < 2 ? "arknights" : "onmyoji"}"`,
      );
      expect(card).not.toContain("继续阴阳师");
    });
    const buttons = nodes(
      tree,
      (node) =>
        node.type === "button" &&
        String(node.props["aria-label"] ?? "").startsWith("运行账号 "),
    );
    expect(buttons).toHaveLength(4);
    buttons[3].props.onClick();
    expect(d.startGameSlot).toHaveBeenCalledWith({
      laneId: "account-3",
      gameId: "onmyoji",
    });
    expect(d.startLane).not.toHaveBeenCalled();
  });

  it("mounts four account editors with separate game controllers and inert unsupported APIs", () => {
    const { html, tree } = render(Daily, desktop());
    expect(html.match(/data-arknights-automation-lane=/g)).toHaveLength(4);
    expect(html).toContain('data-arknights-automation-lane="account-0"');
    expect(html).toContain('data-arknights-automation-lane="account-1"');
    expect(html).toContain('data-arknights-automation-lane="account-2"');
    expect(html).toContain("当前版本暂不支持阴阳师自动计划");
    expect(html).toContain("当前版本暂不支持方舟自动计划");
    expect(html).not.toContain('aria-label="启用方舟自动计划"');
    const editors = nodes(tree, (node) => node.type === ArknightsAutomation);
    const controls = nodes(
      tree,
      (node) => node.type === ArknightsAutomationControls,
    );
    expect(controls).toHaveLength(2);
    expect(editors).toHaveLength(4);
    expect(editors[0].props.controller).toBe(controls[0].props.controller);
    expect(editors[1].props.controller).toBe(controls[0].props.controller);
    expect(editors[2].props.controller).toBe(controls[1].props.controller);
    expect(editors[3].props.controller).toBe(controls[1].props.controller);
  });

  it("changes only the selected Onmyoji account's identity", () => {
    const d = desktop();
    const { tree } = render(Devices, d);
    const identities = nodes(
      tree,
      (node) => node.type === OnmyojiIdentitySettings,
    );
    expect(identities).toHaveLength(2);
    const identity = { roleId: "role-2", serverName: "测试区服" };
    identities[0].props.onChange(identity);
    const updated = vi.mocked(d.setDeviceLanes).mock.calls[0][0] as DeviceLanes;
    expect(updated.lanes[2].onmyoji.identity).toEqual(identity);
    expect(updated.lanes.filter((lane) => lane.id !== "account-2")).toEqual(
      d.deviceLanes.lanes.filter((lane) => lane.id !== "account-2"),
    );
  });

  it("saves a daily routine only on its own game and channel", () => {
    const d = desktop();
    const { tree } = render(Daily, d);
    const editors = nodes(tree, (node) => node.type === RoutineEditor);
    expect(editors.map((node) => node.props.gameId)).toEqual([
      "arknights",
      "arknights",
      "onmyoji",
      "onmyoji",
    ]);
    const routine: Routine = {
      version: 1,
      steps: [{ skillId: "login", enabled: true }],
    };
    editors[3].props.onChange(routine);
    const update = vi.mocked(d.setDeviceLanes).mock.calls[0][0];
    expect(typeof update).toBe("function");
    const updated =
      typeof update === "function" ? update(d.deviceLanes) : update;
    expect(updated.version).toBe(2);
    expect(updated.lanes[3].onmyoji.routine).toEqual(routine);
    expect(updated.lanes[3].arknights).toEqual(
      d.deviceLanes.lanes[3].arknights,
    );
    expect(updated.lanes.slice(0, 3)).toEqual(d.deviceLanes.lanes.slice(0, 3));
  });

  it.each([true, false])(
    "stops the current account with the appropriate exact ownership (game slot: %s)",
    (slotOwned) => {
      const d = desktop();
      d.active = true;
      d.busy = "another-start-pending";
      d.laneStatuses = { "account-2": "running" };
      d.snapshot.executions = [
        {
          version: 1,
          id: "running-onmyoji",
          laneId: "account-2",
          batchId: "batch",
          source: "daily",
          status: "running",
          resources: [],
          fingerprint: "fixture",
          startedAt: "2026-10-25T02:00:00Z",
          message: "running",
          snapshot: {
            ...(slotOwned
              ? { gameSlot: { laneId: "account-2", gameId: "onmyoji" } }
              : {}),
            onmyojiPlan: {
              gameId: "onmyoji",
              mode: "live",
              skillIds: ["login"],
            },
          },
        },
      ];
      const { tree } = render(Daily, d);
      const stop = nodes(
        tree,
        (node) =>
          node.type === "button" &&
          node.props["aria-label"] === "停止账号 阴阳师账号3",
      )[0];
      expect(stop).toBeDefined();
      expect(stop.props.disabled).toBeFalsy();
      stop.props.onClick();
      if (slotOwned) {
        expect(d.stopGameSlot).toHaveBeenCalledWith({
          laneId: "account-2",
          gameId: "onmyoji",
        });
        expect(d.stopLane).not.toHaveBeenCalled();
      } else {
        expect(d.stopLane).toHaveBeenCalledWith("account-2");
        expect(d.stopGameSlot).not.toHaveBeenCalled();
      }
    },
  );

  it("copies a single-game source without offering a different game", () => {
    const d = desktop();
    const html = renderToStaticMarkup(
      createElement(ChannelCopy, {
        lanes: { ...d.deviceLanes, lanes: [d.deviceLanes.lanes[2]] },
        disabled: false,
        onCopy: vi.fn(),
      }),
    );
    expect(html).toContain("阴阳师");
    expect(html).not.toContain('<option value="arknights">');
    expect(html.match(/<select/g)).toHaveLength(1);
  });

  it("opens a game's account task panel without mounting every hidden tool", () => {
    const d = desktop();
    const { html, tree } = render(GameWorkspace, d);
    expect(html).toContain('aria-label="工作区账号"');
    expect(html).toContain("方舟账号1");
    expect(html).toContain("方舟账号2");
    expect(html).not.toContain("阴阳师账号3");
    expect(nodes(tree, (node) => node.type === ArknightsSettings)).toHaveLength(
      0,
    );
    expect(nodes(tree, (node) => node.type === Workspace)).toHaveLength(0);
  });

  it("edits the bound Arknights profile without switching the global current profile", () => {
    const d = desktop();
    const html = renderToStaticMarkup(
      createElement(ArknightsSettings, { desktop: d, profileId: "profile-1" }),
    );
    expect(html).toContain('value="方舟档案2"');
    expect(html).not.toContain('value="方舟档案1"');
    expect(html).not.toContain("当前账号档案");
    expect(d.arknightsProfiles.activeProfileId).toBe("profile-0");
  });

  it("merges a bound profile save with the latest other accounts instead of overwriting them", async () => {
    const d = desktop();
    const latest = structuredClone(d.arknightsProfiles);
    latest.profiles[0].stage = "fresh-other-account-stage";
    d.api = {
      arknights: vi.fn().mockResolvedValue(latest),
    } as unknown as DesktopController["api"];
    d.perform = vi.fn(async (_key, action) => {
      await action();
    });
    d.saveArknights = vi.fn().mockImplementation(async (value) => value);
    let tree!: ReactElement;
    function Probe() {
      tree = ArknightsSettings({ desktop: d, profileId: "profile-1" });
      return tree;
    }
    renderToStaticMarkup(createElement(Probe));
    (
      tree.props as { onSubmit(event: { preventDefault(): void }): void }
    ).onSubmit({ preventDefault() {} });
    await new Promise((resolve) => setImmediate(resolve));
    const saved = vi.mocked(d.saveArknights).mock.calls[0][0];
    expect(saved.activeProfileId).toBe(latest.activeProfileId);
    expect(saved.profiles[0].stage).toBe("fresh-other-account-stage");
    expect(saved.profiles[1]).toEqual(d.arknightsProfiles.profiles[1]);
  });
});
