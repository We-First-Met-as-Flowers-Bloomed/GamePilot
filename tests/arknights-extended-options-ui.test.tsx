import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import {
  defaultArknightsConfig,
  type ArknightsProfile,
} from "../games/arknights/config";

const component = () =>
  import("../apps/desktop/renderer/components/ArknightsExtendedOptions").catch(
    () => undefined,
  );
const profile = (): ArknightsProfile => ({
  ...defaultArknightsConfig,
  id: "ark-a",
  name: "方舟A",
});
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
async function render(current = profile(), disabled = false) {
  const Panel = (await component())?.default;
  expect(Panel).toBeTypeOf("function");
  const onChange = vi.fn();
  let tree!: ReactElement;
  function Probe() {
    tree = Panel!({ profile: current, disabled, onChange });
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  return { html, tree, onChange };
}

it("keeps advanced configuration folded and does not enable or execute tasks on mount", async () => {
  const { html, onChange } = await render();
  expect(html).toContain("内核已接入，待本机实机验证");
  expect(html).toContain("肉鸽启动次数");
  expect(html).toContain("保全作业 JSON 路径");
  expect(html).toContain("悖论模拟作业 JSON 路径");
  expect(html).toContain("本地录像文件路径");
  expect(html).not.toContain('open=""');
  expect(html).not.toContain("立即运行");
  expect(html).not.toContain('type="submit"');
  expect(onChange).not.toHaveBeenCalled();
});

it("bounds long-running options and presents only valid modes for the selected theme", async () => {
  const { tree, html } = await render();
  const input = (label: string) =>
    nodes(
      tree,
      (node) => node.type === "input" && node.props["aria-label"] === label,
    )[0];
  expect(input("肉鸽启动次数").props).toMatchObject({ min: 1, max: 999 });
  expect(input("肉鸽投资上限").props).toMatchObject({ min: 0, max: 99999 });
  expect(input("肉鸽难度").props).toMatchObject({ min: -1, max: 99 });
  expect(input("肉鸽最长运行分钟").props).toMatchObject({ min: 5, max: 360 });
  expect(input("生息制作批数").props).toMatchObject({ min: 1, max: 99 });
  expect(html).toContain("账号总时长上限");
  const modes = nodes(
    tree,
    (node) =>
      node.type === "button" &&
      String(node.props["aria-label"]).startsWith("肉鸽模式 "),
  );
  expect(modes.map((node) => node.props["aria-label"])).toEqual([
    "肉鸽模式 0",
    "肉鸽模式 1",
    "肉鸽模式 30001",
    "肉鸽模式 30003",
  ]);
});

it("changes only the selected typed group while retaining the other advanced settings", async () => {
  const current = {
    ...profile(),
    extendedOptions: {
      roguelike: { startsCount: 2, investmentsCount: 100 },
      sssCopilot: { filename: "D:/plans/sss.json", loopTimes: 2 },
    },
  };
  const { tree, onChange } = await render(current);
  nodes(
    tree,
    (node) =>
      node.type === "input" && node.props["aria-label"] === "肉鸽启动次数",
  )[0].props.onChange({ target: { value: "3" } });
  expect(onChange).toHaveBeenCalledWith({
    extendedOptions: {
      ...current.extendedOptions,
      roguelike: { ...current.extendedOptions.roguelike, startsCount: 3 },
    },
  });
});

it("resets theme-specific mode flags when moving to an incompatible theme", async () => {
  const current = {
    ...profile(),
    extendedOptions: {
      roguelike: {
        theme: "Sami" as const,
        mode: 4 as const,
        squad: "生活至上分队",
        startWithEliteTwo: true,
        onlyStartWithEliteTwo: true,
        startFoldartalList: ["测试密文板"],
      },
    },
  };
  const { tree, onChange } = await render(current);
  nodes(
    tree,
    (node) =>
      node.type === "button" &&
      node.props["aria-label"] === "肉鸽主题 BlackFlow",
  )[0].props.onClick();
  expect(onChange.mock.calls[0][0].extendedOptions.roguelike).toMatchObject({
    theme: "BlackFlow",
    mode: 0,
    startWithEliteTwo: false,
    onlyStartWithEliteTwo: false,
    startFoldartalList: [],
  });
});

it("honors the busy lock on every parameter input and choice", async () => {
  const { tree } = await render(
    {
      ...profile(),
      extendedOptions: {
        customActivity: { route: "OfficialMiniGame" },
        operProgress: { plans: [{ name: "芬", elite: 1 }] },
      },
    },
    true,
  );
  const controls = nodes(tree, (node) =>
    ["input", "button", "textarea", "select"].includes(String(node.type)),
  );
  expect(controls.length).toBeGreaterThan(10);
  expect(controls.every((node) => node.props.disabled === true)).toBe(true);
});

it("starts operator upgrade consent off and explains material consumption without an item budget", async () => {
  const { tree, html, onChange } = await render();
  const consent = nodes(
    tree,
    (node) => node.props["aria-label"] === "同意按目标消耗已有材料",
  )[0];
  expect(consent).toBeDefined();
  expect(consent.props["aria-checked"]).toBe(false);
  expect(html).toContain("没有逐物品数量上限");
  expect(html).toContain("添加养成目标");
  expect(onChange).not.toHaveBeenCalled();
});

it("edits finite operator upgrade targets while preserving other groups and consent", async () => {
  const current = {
    ...profile(),
    extendedOptions: {
      customActivity: { route: "OfficialMiniGame", maxRunMinutes: 10 },
      operProgress: {
        plans: [
          {
            name: "芬",
            elite: 1 as const,
            skillLevel: 4,
            skillMastery: [0, 1, 0] as [number, number, number],
          },
        ],
        allowMaterialConsumption: false,
      },
    },
  };
  const { tree, onChange } = await render(current);
  const elite = nodes(
    tree,
    (node) =>
      node.type === "input" && node.props["aria-label"] === "目标1精英化",
  )[0];
  expect(elite.props).toMatchObject({ min: 1, max: 2 });
  const skill = nodes(
    tree,
    (node) =>
      node.type === "input" && node.props["aria-label"] === "目标1技能等级",
  )[0];
  expect(skill.props).toMatchObject({ min: 2, max: 7 });
  const mastery = nodes(
    tree,
    (node) =>
      node.type === "input" && node.props["aria-label"] === "目标1技能2专精",
  )[0];
  expect(mastery.props).toMatchObject({ min: 0, max: 3 });
  mastery.props.onChange({ target: { value: "2" } });
  expect(onChange.mock.calls[0][0].extendedOptions).toMatchObject({
    customActivity: current.extendedOptions.customActivity,
    operProgress: {
      allowMaterialConsumption: false,
      plans: [{ name: "芬", elite: 1, skillLevel: 4, skillMastery: [0, 2, 0] }],
    },
  });
});

it("requires an explicit click to consent and never offers a free-form activity route", async () => {
  const { tree, onChange } = await render();
  const consent = nodes(
    tree,
    (node) => node.props["aria-label"] === "同意按目标消耗已有材料",
  )[0];
  expect(consent).toBeDefined();
  expect(onChange).not.toHaveBeenCalled();
  consent.props.onClick();
  expect(onChange).toHaveBeenCalledWith({
    extendedOptions: { operProgress: { allowMaterialConsumption: true } },
  });
  expect(
    nodes(
      tree,
      (node) =>
        node.type === "input" &&
        String(node.props["aria-label"]).includes("小游戏路由"),
    ),
  ).toHaveLength(0);
});

it("adds and removes upgrade targets without granting consent or dropping the activity route", async () => {
  const current = {
    ...profile(),
    extendedOptions: {
      customActivity: { route: "OfficialMiniGame" },
      operProgress: {
        allowMaterialConsumption: false,
        plans: [{ name: "芬", elite: 1 as const }],
      },
    },
  };
  const { tree, onChange } = await render(current);
  const add = nodes(
    tree,
    (node) =>
      node.type === "button" && node.props["aria-label"] === "添加养成目标",
  )[0];
  add.props.onClick();
  const next = onChange.mock.calls[0][0].extendedOptions;
  expect(next.customActivity).toEqual(current.extendedOptions.customActivity);
  expect(next.operProgress).toMatchObject({
    allowMaterialConsumption: false,
    plans: [
      { name: "芬", elite: 1 },
      { name: "", elite: 1 },
    ],
  });
  const afterAdd = await render({ ...current, extendedOptions: next });
  nodes(
    afterAdd.tree,
    (node) =>
      node.type === "button" && node.props["aria-label"] === "移除养成目标1",
  )[0].props.onClick();
  expect(
    afterAdd.onChange.mock.calls[0][0].extendedOptions.operProgress,
  ).toMatchObject({
    allowMaterialConsumption: false,
    plans: [{ name: "", elite: 1 }],
  });
});

it("allows optional upgrade goals to be cleared and limits the number of targets", async () => {
  const current = {
    ...profile(),
    extendedOptions: {
      operProgress: {
        plans: Array.from({ length: 20 }, (_, index) => ({
          name: `干员${index}`,
          elite: 1 as const,
          skillLevel: 4,
        })),
      },
    },
  };
  const { tree, onChange } = await render(current);
  const add = nodes(
    tree,
    (node) =>
      node.type === "button" && node.props["aria-label"] === "添加养成目标",
  )[0];
  expect(add.props.disabled).toBe(true);
  const elite = nodes(
    tree,
    (node) =>
      node.type === "input" && node.props["aria-label"] === "目标1精英化",
  )[0];
  elite.props.onChange({ target: { value: "" } });
  expect(
    onChange.mock.calls[0][0].extendedOptions.operProgress.plans[0],
  ).toMatchObject({ name: "干员0", skillLevel: 4, elite: undefined });
});

it("keeps the chosen official activity read-only and edits only its time limit", async () => {
  const current = {
    ...profile(),
    extendedOptions: {
      customActivity: { route: "OfficialMiniGame", maxRunMinutes: 15 },
      operProgress: { allowMaterialConsumption: false },
    },
  };
  const { tree, html, onChange } = await render(current);
  expect(html).toContain("OfficialMiniGame");
  const time = nodes(
    tree,
    (node) =>
      node.type === "input" &&
      node.props["aria-label"] === "小游戏最长运行分钟",
  )[0];
  expect(time.props).toMatchObject({ min: 5, max: 360 });
  time.props.onChange({ target: { value: "20" } });
  expect(onChange.mock.calls[0][0]).toEqual({
    extendedOptions: {
      ...current.extendedOptions,
      customActivity: { route: "OfficialMiniGame", maxRunMinutes: 20 },
    },
  });
});
