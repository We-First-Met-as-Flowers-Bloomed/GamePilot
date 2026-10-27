import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";
import ArknightsSettings from "../apps/desktop/renderer/components/ArknightsSettings";
import { defaultArknightsProfiles } from "../games/arknights/config";
import type { DesktopController } from "../apps/desktop/renderer/hooks/useDesktop";

const hooks = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[],
  effects: [] as (() => unknown)[],
  deps: [] as unknown[][],
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState(initial: unknown) {
      const index = hooks.index++;
      if (!(index in hooks.values))
        hooks.values[index] =
          typeof initial === "function" ? initial() : initial;
      return [
        hooks.values[index],
        (next: unknown) => {
          hooks.values[index] =
            typeof next === "function" ? next(hooks.values[index]) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const index = hooks.index++;
      hooks.values[index] ??= { current: initial };
      return hooks.values[index];
    },
    useEffect(effect: () => unknown, deps: unknown[]) {
      const index = hooks.index++;
      if (
        !hooks.deps[index] ||
        deps.some((item, i) => item !== hooks.deps[index][i])
      )
        hooks.effects.push(effect);
      hooks.deps[index] = deps;
    },
  };
});
beforeEach(() => {
  hooks.index = 0;
  hooks.values = [];
  hooks.effects = [];
  hooks.deps = [];
});
function findStage(
  tree: ReactNode,
): ReactElement<{
  value: string;
  onChange(event: { target: { value: string } }): void;
}> {
  for (const child of Children.toArray(tree))
    if (isValidElement<{ children?: ReactNode; placeholder?: string }>(child)) {
      if (child.props.placeholder === "例如 1-7")
        return child as ReturnType<typeof findStage>;
      try {
        return findStage(child.props.children);
      } catch {
        /* Continue sibling search. */
      }
    }
  throw Error("stage input missing");
}
it("keeps a dirty stage when the initial asynchronous settings request returns late", async () => {
  let resolve!: (profiles: typeof defaultArknightsProfiles) => void;
  const pending = new Promise<typeof defaultArknightsProfiles>((done) => {
    resolve = done;
  });
  const desktop = {
    api: { arknights: vi.fn(() => pending) },
    arknightsProfiles: structuredClone(defaultArknightsProfiles),
    active: false,
  } as unknown as DesktopController;
  const render = () => {
    hooks.index = 0;
    return ArknightsSettings({ desktop });
  };
  const tree = render();
  hooks.effects.splice(0).forEach((effect) => effect());
  findStage(tree).props.onChange({ target: { value: "LS-6" } });
  expect(findStage(render()).props.value).toBe("LS-6");
  const stale = structuredClone(defaultArknightsProfiles);
  stale.profiles[0].stage = "LS-5";
  resolve(stale);
  await pending;
  await Promise.resolve();
  expect(findStage(render()).props.value).toBe("LS-6");
});
it("loads the remote saved stage when the editor has no changes", async () => {
  const remote = structuredClone(defaultArknightsProfiles);
  remote.profiles[0].stage = "AP-5";
  const desktop = {
    api: { arknights: vi.fn(async () => remote) },
    arknightsProfiles: structuredClone(defaultArknightsProfiles),
    active: false,
  } as unknown as DesktopController;
  hooks.index = 0;
  ArknightsSettings({ desktop });
  hooks.effects.splice(0).forEach((effect) => effect());
  await Promise.resolve();
  hooks.index = 0;
  expect(findStage(ArknightsSettings({ desktop })).props.value).toBe("AP-5");
});
