import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import ArknightsCopilotOptionsPanel from "../apps/desktop/renderer/components/ArknightsCopilotOptions";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { ArknightsCopilotOptions } from "../games/arknights/copilot-options";

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
function render(options?: ArknightsCopilotOptions, disabled = false) {
  const onChange = vi.fn();
  const tree = ArknightsCopilotOptionsPanel({
    profile: {
      ...defaultArknightsConfig,
      id: "a",
      name: "方舟A",
      copilotFile: "D:/plans/single.json",
      copilotOptions: options,
    },
    disabled,
    onChange,
  });
  return {
    tree,
    html: renderToStaticMarkup(tree),
    onChange,
    control: (label: string) =>
      nodes(tree, (node) => node.props["aria-label"] === label)[0],
  };
}

it("keeps ordinary copilot settings folded, retains the legacy source, and defaults potion consent off", () => {
  const view = render();
  expect(view.html).not.toContain('open=""');
  expect(view.html).toContain("待本机实机验证");
  expect(view.html).toContain("不能限定药数量");
  expect(view.control("普通作业使用理智药").props).toMatchObject({
    type: "checkbox",
    checked: false,
  });
  expect(view.control("普通作业 JSON 路径").props.value).toBe(
    "D:/plans/single.json",
  );
  expect(view.onChange).not.toHaveBeenCalled();
  view
    .control("普通作业使用理智药")
    .props.onChange({ target: { checked: true } });
  expect(view.onChange.mock.calls[0][0]).toEqual({
    copilotOptions: { useSanityPotion: true },
  });
});

it("bounds formation, single-file loops and the App time budget", () => {
  const view = render();
  expect(view.control("普通作业循环次数").props).toMatchObject({
    min: 1,
    max: 99,
  });
  expect(view.control("普通作业编队编号").props).toMatchObject({
    min: 0,
    max: 4,
  });
  expect(view.control("普通作业最长运行分钟").props).toMatchObject({
    min: 5,
    max: 360,
  });
  view.control("普通作业循环次数").props.onChange({ target: { value: "3" } });
  expect(view.onChange.mock.calls[0][0]).toEqual({
    copilotLoopTimes: 3,
    copilotOptions: { loopTimes: 3 },
  });
});

it("switches to native navigation with a one-pass budget and preserves formation options", () => {
  const view = render({ loopTimes: 3, supportUnitUsage: 1, addTrust: true });
  view
    .control("普通作业关卡导航")
    .props.onChange({ target: { checked: true } });
  expect(view.onChange.mock.calls[0][0]).toEqual({
    copilotLoopTimes: 1,
    copilotOptions: {
      loopTimes: 1,
      supportUnitUsage: 1,
      addTrust: true,
      stageNavigation: true,
    },
  });
  const navigation = render({ stageNavigation: true });
  expect(navigation.control("普通作业循环次数").props.disabled).toBe(true);
  expect(navigation.control("普通作业突袭模式").props.disabled).toBe(false);
});

it("edits ordered queue entries without replacing the compatible single-file source", () => {
  const view = render({
    formationIndex: 2,
    list: [
      { filename: "first.json" },
      { filename: "second.json", stageName: "1-7", isRaid: true },
    ],
  });
  expect(view.html).toContain("队列按顺序导航并逐项执行一遍");
  view.control("上移普通作业2").props.onClick();
  expect(view.onChange.mock.calls[0][0]).toEqual({
    copilotOptions: {
      formationIndex: 2,
      list: [
        { filename: "second.json", stageName: "1-7", isRaid: true },
        { filename: "first.json" },
      ],
    },
  });
  view
    .control("普通作业2导航关卡")
    .props.onChange({ target: { value: "H12-4" } });
  expect(view.onChange.mock.calls[1][0].copilotOptions.list[1]).toMatchObject({
    filename: "second.json",
    stageName: "H12-4",
    isRaid: true,
  });
  expect(
    view.onChange.mock.calls.every(
      ([patch]) => patch.copilotFile === undefined,
    ),
  ).toBe(true);
});

it("edits additional operators and support selection without altering potion consent", () => {
  const view = render({
    userAdditional: [{ name: "芬", skill: 0 }],
    useSanityPotion: false,
  });
  view.control("追加干员1技能").props.onChange({ target: { value: "3" } });
  expect(view.onChange.mock.calls[0][0].copilotOptions).toMatchObject({
    userAdditional: [{ name: "芬", skill: 3 }],
    useSanityPotion: false,
  });
  const modes = nodes(
    view.tree,
    (node) =>
      node.type === "select" && node.props["aria-label"] === "普通作业助战策略",
  )[0];
  expect(
    nodes(modes, (node) => node.type === "option").map(
      (node) => node.props.value,
    ),
  ).toEqual([0, 1, 2, 3]);
});

it("locks every edit during a pending save and bounds queue/operator additions", () => {
  const view = render(
    {
      list: Array.from({ length: 20 }, () => ({ filename: "battle.json" })),
      userAdditional: Array.from({ length: 12 }, (_, index) => ({
        name: `干员${index}`,
        skill: 0,
      })),
    },
    true,
  );
  const controls = nodes(view.tree, (node) =>
    ["input", "select", "button"].includes(String(node.type)),
  );
  expect(controls.length).toBeGreaterThan(20);
  expect(controls.every((node) => node.props.disabled === true)).toBe(true);
  const bounded = render({
    list: Array.from({ length: 20 }, () => ({ filename: "battle.json" })),
    userAdditional: Array.from({ length: 12 }, (_, index) => ({
      name: `干员${index}`,
      skill: 0,
    })),
  });
  expect(bounded.control("添加普通作业").props.disabled).toBe(true);
  expect(bounded.control("添加追加干员").props.disabled).toBe(true);
});
