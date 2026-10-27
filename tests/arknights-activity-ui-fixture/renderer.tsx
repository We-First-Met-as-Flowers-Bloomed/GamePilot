import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import ArknightsActivityStages from "../../apps/desktop/renderer/components/ArknightsActivityStages";
import ArknightsExtendedOptions from "../../apps/desktop/renderer/components/ArknightsExtendedOptions";
import ArknightsCopilotOptions from "../../apps/desktop/renderer/components/ArknightsCopilotOptions";
import type { ArknightsProfile } from "../../games/arknights/config";
import type { DesktopAPI } from "../../packages/protocol";
import type {
  ArknightsActivityCatalog,
  ArknightsActivityStage,
} from "../../packages/protocol/arknights-activity";
import "../../apps/desktop/renderer/theme.css";
import "../../apps/desktop/renderer/styles.css";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const results: { name: string; passed: boolean; error?: string }[] = [];
const roots: Root[] = [];
const assert = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
declare const axe: {
  run(
    target: Document,
    options: unknown,
  ): Promise<{
    violations: { id: string; impact?: string; nodes: { target: unknown }[] }[];
  }>;
};
const profile = (id = "account-a"): ArknightsProfile => ({
  id,
  name: id,
  stage: "1-7",
  clientType: "Official",
  accountName: "",
  expectedUid: "",
  mail: false,
  recruit: true,
  creditShopping: false,
  copilotFile: "",
  copilotLoopTimes: 1,
  freeRecruit: false,
  eventOrundum: false,
  eventMining: false,
  specialAccess: false,
  signInEvent: false,
  maxRunMinutes: 120,
});
const stage = (
  patch: Partial<ArknightsActivityStage> = {},
): ArknightsActivityStage => ({
  stage: "EV-8",
  label: "EV-8 材料关",
  activity: "测试活动",
  drop: "材料",
  startsAt: new Date(Date.now() - 3600000).toISOString(),
  endsAt: new Date(Date.now() + 3600000).toISOString(),
  available: true,
  ...patch,
});
const catalog = (stages = [stage()]): ArknightsActivityCatalog => ({
  source: "synthetic",
  stale: false,
  message: "已同步测试活动",
  stages,
});
const api = (read: NonNullable<DesktopAPI["arknightsActivity"]>) =>
  ({ arknightsActivity: read }) as DesktopAPI;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function mount(
  props: Partial<Parameters<typeof ArknightsActivityStages>[0]> = {},
) {
  const host = document.createElement("div");
  host.className = "surface game-settings-form";
  document.getElementById("fixture")!.append(host);
  const root = createRoot(host);
  roots.push(root);
  let current = {
    api: api(async () => catalog()),
    profile: profile(),
    disabled: false,
    onChange: (_patch: Partial<ArknightsProfile>) => {},
    ...props,
  };
  const render = async (patch: Partial<typeof current> = {}) => {
    current = { ...current, ...patch };
    await act(async () => {
      root.render(<ArknightsActivityStages {...current} />);
    });
    host.querySelector("details")!.open = true;
  };
  await render();
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) => item.textContent === text,
    )!;
  return {
    host,
    render,
    button,
    async sync() {
      await act(async () => {
        button("同步活动关卡").click();
      });
    },
  };
}
async function test(name: string, body: () => Promise<void>) {
  try {
    await body();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.stack : String(error),
    });
  } finally {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.getElementById("fixture")!.replaceChildren();
  }
}

async function mountOptions(
  initial: ArknightsProfile = profile(),
  mode: "extended" | "copilot" = "extended",
) {
  const host = document.createElement("div");
  host.className = "surface game-settings-form";
  document.getElementById("fixture")!.append(host);
  const root = createRoot(host);
  roots.push(root);
  const changes: Partial<ArknightsProfile>[] = [];
  let current = initial;
  let replace!: (profile: ArknightsProfile) => void;
  function Editor() {
    const [draft, setDraft] = useState(initial);
    replace = setDraft;
    current = draft;
    const Options =
      mode === "copilot" ? ArknightsCopilotOptions : ArknightsExtendedOptions;
    return (
      <Options
        profile={draft}
        disabled={false}
        onChange={(patch) => {
          changes.push(patch);
          setDraft((previous) => ({ ...previous, ...patch }));
        }}
      />
    );
  }
  await act(async () => {
    root.render(<Editor />);
  });
  const open = () =>
    host.querySelectorAll("details").forEach((details) => {
      details.open = true;
    });
  open();
  const control = (label: string) =>
    [
      ...host.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >("[aria-label]"),
    ].find((item) => item.getAttribute("aria-label") === label)!;
  return {
    host,
    changes,
    control,
    profile: () => current,
    async click(label: string) {
      await act(async () => {
        control(label).click();
      });
    },
    async input(label: string, value: string) {
      const input = control(label);
      const prototype =
        input instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(
          new Event(input instanceof HTMLSelectElement ? "change" : "input", {
            bubbles: true,
          }),
        );
      });
    },
    async switchProfile(profile: ArknightsProfile) {
      await act(async () => {
        replace(profile);
      });
      open();
    },
  };
}

async function run() {
  await test("does not sync until the user requests it", async () => {
    let calls = 0;
    const view = await mount({
      api: api(async () => {
        calls++;
        return catalog();
      }),
    });
    await view.render({ profile: { ...profile(), stage: "LS-6" } });
    assert(
      calls === 0,
      "mounting, opening details and editing a profile must not sync",
    );
    await view.sync();
    assert(calls === 1, "explicit sync must call the API once");
  });
  await test("supports missing and null desktop APIs", async () => {
    const view = await mount({ api: undefined });
    assert(
      view.button("同步活动关卡").disabled,
      "missing API must disable sync",
    );
    await view.render({ api: null as unknown as undefined });
    assert(view.button("同步活动关卡").disabled, "null API must disable sync");
  });
  await test("shows sync failures and allows retry", async () => {
    let calls = 0;
    const view = await mount({
      api: api(async () => {
        if (!calls++) throw Error("活动同步失败");
        return catalog();
      }),
    });
    await view.sync();
    assert(
      view.host
        .querySelector('[role="alert"]')
        ?.textContent?.includes("活动同步失败"),
      "sync failure must be visible",
    );
    assert(
      !view.button("同步活动关卡").disabled,
      "sync failure must release the busy state",
    );
    await view.sync();
    assert(
      !view.host.querySelector('[role="alert"]'),
      "successful retry must clear the error",
    );
  });
  await test("disables expired future and incompatible stages", async () => {
    const view = await mount({
      api: api(async () =>
        catalog([
          stage({
            stage: "OLD-8",
            endsAt: new Date(Date.now() - 1000).toISOString(),
            available: true,
          }),
          stage({
            stage: "NEW-8",
            startsAt: new Date(Date.now() + 100000).toISOString(),
            available: true,
          }),
          stage({
            stage: "HIGH-8",
            available: false,
            reason: "需要 MaaCore v99.0.0",
          }),
          stage(),
        ]),
      ),
    });
    await view.sync();
    const buttons = [
      ...view.host.querySelectorAll<HTMLButtonElement>(".setting-row button"),
    ];
    assert(buttons.length === 4, "all four catalog entries should be visible");
    assert(
      buttons.slice(0, 3).every((item) => item.disabled),
      "expired, future and incompatible entries must be disabled",
    );
    assert(!buttons[3].disabled, "open compatible stage should be selectable");
  });
  await test("preserves the original stage and deduplicates the fight queue", async () => {
    let patch: Partial<ArknightsProfile> | undefined;
    const current = {
      ...profile(),
      taskOptions: {
        fight: { stages: ["1-7", "LS-6", "EV-8", "LS-6"], medicine: 2 },
        recruit: { times: 3 },
      },
    };
    const view = await mount({
      profile: current,
      onChange: (value) => {
        patch = value;
      },
    });
    await view.sync();
    await act(async () => {
      view.button("加入队列").click();
    });
    assert(
      patch?.stage === "1-7",
      "adding activity stage must preserve the primary stage",
    );
    assert(
      JSON.stringify(patch?.taskOptions?.fight?.stages) ===
        JSON.stringify(["1-7", "LS-6", "EV-8"]),
      "queue should keep existing order without duplicates",
    );
    assert(
      patch?.taskOptions?.fight?.medicine === 2 &&
        patch?.taskOptions?.recruit?.times === 3,
      "unrelated options must be preserved",
    );
  });
  await test("does not apply late catalog responses to another profile on the same client", async () => {
    const old = deferred<ArknightsActivityCatalog>();
    let calls = 0;
    const view = await mount({
      api: api(async () =>
        ++calls === 1
          ? old.promise
          : catalog([stage({ stage: "NEW-8", label: "新账号活动关" })]),
      ),
    });
    await view.sync();
    await view.render({ profile: profile("account-b") });
    assert(
      !view.button("同步活动关卡").disabled,
      "switching profile must release the old account's loading state",
    );
    await view.sync();
    await act(async () => {
      old.resolve(
        catalog([stage({ stage: "OLD-8", label: "旧账号晚到关卡" })]),
      );
    });
    assert(
      view.host.textContent?.includes("新账号活动关"),
      "new account catalog should remain selected",
    );
    assert(
      !view.host.textContent?.includes("旧账号晚到关卡"),
      "late old-account catalog must be ignored",
    );
  });
  await test("clears cached catalog and old callback when switching accounts", async () => {
    const oldPatches: Partial<ArknightsProfile>[] = [],
      newPatches: Partial<ArknightsProfile>[] = [];
    const view = await mount({ onChange: (patch) => oldPatches.push(patch) });
    await view.sync();
    await view.render({
      profile: { ...profile("account-b"), stage: "CE-6" },
      onChange: (patch) => newPatches.push(patch),
    });
    assert(
      !view.host.textContent?.includes("EV-8 材料关"),
      "new account should not inherit the previous account catalog",
    );
    await view.sync();
    await act(async () => {
      view.button("加入队列").click();
    });
    assert(
      oldPatches.length === 0 && newPatches.length === 1,
      "only the current profile callback may receive the change",
    );
    assert(
      newPatches[0].stage === "CE-6",
      "the current profile must keep its own primary stage",
    );
  });
  await test("ignores stale errors when changing game clients", async () => {
    const old = deferred<ArknightsActivityCatalog>();
    const view = await mount({
      api: api(async ({ clientType }) =>
        clientType === "Official"
          ? old.promise
          : catalog([stage({ label: "B服活动关" })]),
      ),
    });
    await view.sync();
    await view.render({ profile: { ...profile(), clientType: "Bilibili" } });
    await view.sync();
    await act(async () => {
      old.reject(Error("旧官服请求失败"));
    });
    assert(
      view.host.textContent?.includes("B服活动关"),
      "new client catalog must remain visible",
    );
    assert(
      !view.host.querySelector('[role="alert"]'),
      "old-client failure must not appear on the new client",
    );
  });
  await test("selects only open compatible official mini-games and preserves other options", async () => {
    const changes: Partial<ArknightsProfile>[] = [];
    const current = {
      ...profile(),
      extendedOptions: {
        customActivity: { route: "PreviousGame", maxRunMinutes: 15 },
        operProgress: { allowMaterialConsumption: false, plans: [] },
      },
    };
    const view = await mount({
      profile: current,
      api: api(async () => ({
        ...catalog(),
        miniGames: [
          stage({
            stage: "OfficialMiniGame",
            label: "开放小游戏",
            tip: "从活动首页开始",
          }),
          stage({
            stage: "FutureMiniGame",
            startsAt: new Date(Date.now() + 100000).toISOString(),
          }),
          stage({
            stage: "ExpiredMiniGame",
            endsAt: new Date(Date.now() - 1000).toISOString(),
          }),
          stage({
            stage: "UnsupportedMiniGame",
            available: false,
            reason: "内核不兼容",
          }),
          stage({ stage: "invalid/route" }),
        ],
      })),
      onChange: (patch) => changes.push(patch),
    });
    await view.sync();
    const buttons = [
      ...view.host.querySelectorAll<HTMLButtonElement>(
        "[data-activity-mini-game] button",
      ),
    ];
    assert(
      buttons.length === 5,
      "official mini-games must appear separately from fight stages",
    );
    assert(
      !buttons[0].disabled &&
        buttons.slice(1).every((button) => button.disabled),
      "only open compatible routes may be selected",
    );
    assert(
      view.host.textContent?.includes("从活动首页开始"),
      "official tips must remain visible",
    );
    await act(async () => {
      buttons.slice(1).forEach((button) => button.click());
      buttons[0].click();
    });
    assert(
      changes.length === 1,
      "unavailable games must not change the profile",
    );
    assert(
      JSON.stringify(changes[0]) ===
        JSON.stringify({
          extendedOptions: {
            ...current.extendedOptions,
            customActivity: {
              ...current.extendedOptions.customActivity,
              route: "OfficialMiniGame",
            },
          },
        }),
      "selection must only change the custom activity route and retain consent and time limits",
    );
    await view.render({ profile: { ...current, ...changes[0] } });
    assert(
      view.host
        .querySelector('[data-activity-mini-game="OfficialMiniGame"] button')
        ?.getAttribute("aria-pressed") === "true",
      "selected route must be announced",
    );
  });
  await test("rejects a mini-game that expires after the catalogue was rendered", async () => {
    const changes: Partial<ArknightsProfile>[] = [];
    const expiresAt = Date.now() + 100000;
    const view = await mount({
      api: api(async () => ({
        ...catalog(),
        miniGames: [
          stage({
            stage: "TimedGame",
            endsAt: new Date(expiresAt).toISOString(),
          }),
        ],
      })),
      onChange: (patch) => changes.push(patch),
    });
    await view.sync();
    const button = view.host.querySelector<HTMLButtonElement>(
      "[data-activity-mini-game] button",
    );
    assert(button && !button.disabled, "game must be open when rendered");
    const originalNow = Date.now;
    try {
      Date.now = () => expiresAt + 1;
      await act(async () => {
        button!.click();
      });
    } finally {
      Date.now = originalNow;
    }
    assert(changes.length === 0, "expired cached route must not be selected");
  });
  await test("does not apply late mini-game catalogues to another account", async () => {
    const old = deferred<ArknightsActivityCatalog>();
    let calls = 0;
    const changes: Partial<ArknightsProfile>[] = [];
    const view = await mount({
      api: api(async () =>
        ++calls === 1
          ? old.promise
          : {
              ...catalog(),
              miniGames: [
                stage({ stage: "NewAccountGame", label: "新账号小游戏" }),
              ],
            },
      ),
      onChange: (patch) => changes.push(patch),
    });
    await view.sync();
    await view.render({ profile: profile("account-b") });
    await view.sync();
    await act(async () => {
      old.resolve({
        ...catalog(),
        miniGames: [stage({ stage: "OldAccountGame", label: "旧账号小游戏" })],
      });
    });
    assert(
      view.host.textContent?.includes("新账号小游戏") &&
        !view.host.textContent?.includes("旧账号小游戏"),
      "late catalogue must not cross account boundaries",
    );
    await act(async () => {
      view.host
        .querySelector<HTMLButtonElement>("[data-activity-mini-game] button")!
        .click();
    });
    assert(
      changes[0]?.extendedOptions?.customActivity?.route === "NewAccountGame",
      "only the current account catalogue may supply the route",
    );
  });
  await test("edits operator upgrade targets through real React state without granting implicit consent", async () => {
    const view = await mountOptions({
      ...profile(),
      extendedOptions: {
        customActivity: { route: "OfficialMiniGame", maxRunMinutes: 15 },
      },
    });
    assert(
      view.changes.length === 0,
      "mount must not create targets or grant consent",
    );
    assert(
      view.control("同意按目标消耗已有材料").getAttribute("aria-checked") ===
        "false",
      "material consent must default off",
    );
    await view.click("添加养成目标");
    await view.input("目标1干员名称", "芬");
    await view.input("目标1职业", "Pioneer");
    await view.input("目标1技能等级", "7");
    await view.input("目标1技能2专精", "2");
    await view.input("目标1精英化", "");
    const progress = view.profile().extendedOptions?.operProgress;
    assert(
      progress?.allowMaterialConsumption !== true,
      "editing targets must not imply consent",
    );
    assert(
      JSON.stringify(progress?.plans) ===
        JSON.stringify([
          {
            name: "芬",
            role: "Pioneer",
            skillLevel: 7,
            skillMastery: [0, 2, 0],
          },
        ]),
      "every target field must persist across successive renders and support skipping elite upgrades",
    );
    assert(
      view.profile().extendedOptions?.customActivity?.route ===
        "OfficialMiniGame",
      "editing targets must preserve selected activity",
    );
    await view.click("同意按目标消耗已有材料");
    assert(
      view.profile().extendedOptions?.operProgress?.allowMaterialConsumption ===
        true,
      "only an explicit click grants consent",
    );
    await view.click("移除养成目标1");
    assert(
      view.profile().extendedOptions?.operProgress?.plans?.length === 0,
      "target removal must survive the next React render",
    );
  });
  await test("switches operator upgrade accounts without retaining another account targets or consent", async () => {
    const view = await mountOptions({
      ...profile(),
      extendedOptions: {
        operProgress: {
          plans: [{ name: "芬", elite: 1 }],
          allowMaterialConsumption: true,
        },
      },
    });
    await view.switchProfile(profile("account-b"));
    assert(
      view.control("同意按目标消耗已有材料").getAttribute("aria-checked") ===
        "false",
      "new account must not inherit material consent",
    );
    assert(
      !view.host.querySelector('[aria-label="目标1干员名称"]'),
      "new account must not inherit old targets",
    );
    await view.click("添加养成目标");
    assert(
      view.profile().id === "account-b" &&
        view.profile().extendedOptions?.operProgress?.plans?.[0].name === "",
      "new target must belong to current account",
    );
  });
  await test("has no serious accessibility violations in operator upgrade settings", async () => {
    await mountOptions({
      ...profile(),
      extendedOptions: {
        operProgress: {
          plans: [
            { name: "芬", elite: 1, skillLevel: 7, skillMastery: [0, 0, 0] },
          ],
          allowMaterialConsumption: false,
        },
      },
    });
    const audit = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
    const violations = audit.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    );
    assert(!violations.length, JSON.stringify(violations));
  });
  await test("edits ordinary copilot queues and explicit potion consent through real React state", async () => {
    const view = await mountOptions(
      { ...profile(), copilotFile: "D:/plans/first.json", copilotLoopTimes: 3 },
      "copilot",
    );
    assert(
      view.changes.length === 0 &&
        view.control("普通作业使用理智药").getAttribute("type") ===
          "checkbox" &&
        !(view.control("普通作业使用理智药") as HTMLInputElement).checked,
      "potion use must remain opt-in on mount",
    );
    await view.click("普通作业关卡导航");
    assert(
      view.profile().copilotOptions?.loopTimes === 1 &&
        view.profile().copilotLoopTimes === 1,
      "navigation must reset the single-file loop count before saving",
    );
    await view.input("普通作业导航关卡", "1-7");
    await view.click("普通作业突袭模式");
    await view.click("添加普通作业");
    await view.click("添加普通作业");
    await view.input("普通作业2 JSON 路径", "D:/plans/second.json");
    await view.click("上移普通作业2");
    assert(
      view.profile().copilotOptions?.list?.[0].filename ===
        "D:/plans/second.json",
      "queue reordering must persist after a React render",
    );
    assert(
      view.profile().copilotFile === "D:/plans/first.json",
      "the legacy source must survive queue edits",
    );
    assert(
      view
        .profile()
        .copilotOptions?.list?.every(
          (entry) => entry.isRaid === true && entry.stageName === "1-7",
        ),
      "per-entry navigation settings must survive reordering",
    );
    assert(
      !view.profile().copilotOptions?.useSanityPotion,
      "editing queues must not grant potion consent",
    );
    await view.click("普通作业使用理智药");
    assert(
      view.profile().copilotOptions?.useSanityPotion === true,
      "an explicit checkbox click may grant consent",
    );
  });
  await test("does not retain ordinary copilot drafts or potion consent when switching accounts", async () => {
    const view = await mountOptions(
      {
        ...profile(),
        copilotFile: "old.json",
        copilotOptions: {
          useSanityPotion: true,
          list: [{ filename: "old.json" }],
        },
      },
      "copilot",
    );
    await view.switchProfile(profile("account-b"));
    assert(
      !(view.control("普通作业使用理智药") as HTMLInputElement).checked,
      "the current account must use its own potion consent",
    );
    assert(
      !view.host.querySelector('[aria-label="普通作业1 JSON 路径"]'),
      "old queue must not remain on the new account",
    );
    await view.input("普通作业 JSON 路径", "new.json");
    assert(
      view.profile().id === "account-b" &&
        view.profile().copilotFile === "new.json",
      "the edit must target the current account",
    );
  });
  await test("has no serious accessibility violations in ordinary copilot settings", async () => {
    await mountOptions(
      {
        ...profile(),
        copilotFile: "D:/plans/battle.json",
        copilotOptions: {
          supportUnitUsage: 2,
          supportUnitName: "艾雅法拉",
          userAdditional: [{ name: "芬", skill: 0 }],
          list: [{ filename: "D:/plans/battle.json", stageName: "1-7" }],
          useSanityPotion: false,
        },
      },
      "copilot",
    );
    const audit = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
    const violations = audit.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    );
    assert(!violations.length, JSON.stringify(violations));
  });
  await test("has no serious accessibility violations", async () => {
    const view = await mount({
      api: api(async () => ({
        ...catalog(),
        miniGames: [
          stage({
            stage: "OfficialMiniGame",
            label: "开放小游戏",
            tip: "从活动首页开始",
          }),
        ],
      })),
    });
    await view.sync();
    const audit = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
    const violations = audit.violations.filter((item) =>
      ["serious", "critical"].includes(item.impact ?? ""),
    );
    assert(
      !violations.length,
      JSON.stringify(
        violations.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        })),
      ),
    );
  });
  // Leave a normal, expanded view for screenshot review.
  await mount({
    profile: {
      ...profile(),
      extendedOptions: { customActivity: { route: "OfficialMiniGame" } },
    },
    api: api(async () => ({
      ...catalog(),
      miniGames: [
        stage({
          stage: "OfficialMiniGame",
          label: "开放小游戏",
          tip: "从活动首页开始",
        }),
        stage({
          stage: "FutureMiniGame",
          label: "下期小游戏",
          startsAt: new Date(Date.now() + 100000).toISOString(),
        }),
      ],
    })),
  });
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent === "同步活动关卡")!;
  await act(async () => {
    button.click();
  });
  Object.assign(window, {
    __showCopilotSettings: async () => {
      await act(async () => {
        for (const root of roots.splice(0)) root.unmount();
      });
      document.getElementById("fixture")!.replaceChildren();
      await mountOptions(
        {
          ...profile(),
          copilotFile: "D:/plans/first.json",
          copilotOptions: {
            list: [
              {
                filename: "D:/plans/first.json",
                stageName: "1-7",
                isRaid: false,
              },
              {
                filename: "D:/plans/second.json",
                stageName: "H12-4",
                isRaid: true,
              },
            ],
            userAdditional: [{ name: "芬", skill: 0 }],
            useSanityPotion: false,
          },
        },
        "copilot",
      );
    },
    __showUpgradeSettings: async () => {
      await act(async () => {
        for (const root of roots.splice(0)) root.unmount();
      });
      document.getElementById("fixture")!.replaceChildren();
      const view = await mountOptions({
        ...profile(),
        extendedOptions: {
          customActivity: { route: "OfficialMiniGame", maxRunMinutes: 15 },
          operProgress: {
            plans: [
              {
                name: "芬",
                role: "Pioneer",
                elite: 1,
                skillLevel: 7,
                skillMastery: [0, 2, 0],
              },
            ],
            allowMaterialConsumption: false,
          },
        },
      });
      view.host.querySelectorAll("details").forEach((details, index) => {
        details.open = index <= 2;
      });
    },
  });
  return { results };
}
Object.assign(window, { __activityTests: run() });
