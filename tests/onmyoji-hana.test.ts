import { describe, it, expect, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import type { Frame, GameDevice } from "../packages/runtime/device";
import promotionFixture from "./fixtures/onmyoji/hana-promotion.json";
const frame = (...texts: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: texts.map(([text, x, y]) => ({
    text,
    box: [x, y, 100, 40],
    score: 0.99,
  })),
});
const home = frame(["探", 840, 208], ["加成", 546, 49], ["花合战", 1100, 900]);
const level = frame(
  ["花合战", 110, 30],
  ["奖励", 800, 300],
  ["任务", 1770, 500],
);
const tasks = frame(
  ["花合战", 110, 30],
  ["今日", 360, 120],
  ["全部领取", 1510, 820],
);
const empty = frame(
  ["花合战", 110, 30],
  ["今日", 360, 120],
  ["前往", 1580, 340],
  ["前往", 1580, 560],
);
const popup = frame(["获得奖励", 700, 220]);
const promotion = promotionFixture as Frame;
it("does not dismiss a promotion covered by an unknown single confirmation", () => {
  expect(
    hanaPromotionClosePoint({
      ...promotion,
      texts: [...promotion.texts, ...frame(["确定", 950, 580]).texts],
    }),
  ).toBeNull();
});
function setup(initial: Frame, start = home, stuck = false) {
  let current = start;
  const logs: string[] = [];
  const d: GameDevice = {
    observe: vi.fn(async () => current),
    click: vi.fn(async (x, y) => {
      if (current === home) current = initial;
      else if (current === promotion && x === 1700 && y === 900 && !stuck)
        current = tasks;
      else if (current === level && x > 1700) current = tasks;
      else if (current === tasks && x > 1400) current = popup;
      else if (current === popup) current = empty;
      else if (current === empty && x < 100) current = home;
      else if (current === tasks && x < 100) current = home;
    }),
    swipe: vi.fn(),
    longPress: vi.fn(),
    colorSlots: vi.fn(),
    startApp: vi.fn(),
    packages: vi.fn(),
    isAppRunning: vi.fn(),
    matchTemplate: vi.fn(async () => null),
  };
  return {
    d,
    logs,
    adapter: new OnmyojiDaily(
      d,
      (m) => logs.push(m),
      async () => {},
    ),
  };
}
describe("Hana task-page confirmation", () => {
  it("dismisses the real monthly promotion after entering before claiming", async () => {
    const { adapter, d } = setup(promotion);
    expect(await adapter.hanaClaim(new AbortController().signal)).toMatchObject(
      {
        status: "succeeded",
      },
    );
    expect(d.click).toHaveBeenCalledWith(1700, 900, expect.any(AbortSignal));
  });
  it("recovers a promotion left visible by an earlier failed request", async () => {
    const { adapter } = setup(tasks, promotion);
    expect(await adapter.hanaClaim(new AbortController().signal)).toMatchObject(
      {
        status: "succeeded",
      },
    );
  });
  it("stops after two promotion dismissals without treating the banner as claimed", async () => {
    const { adapter, d, logs } = setup(promotion, home, true);
    await expect(
      adapter.hanaClaim(new AbortController().signal),
    ).rejects.toThrow();
    expect(
      vi.mocked(d.click).mock.calls.filter(([x, y]) => x === 1700 && y === 900),
    ).toHaveLength(2);
    expect(logs).not.toContain("花合战全部奖励已领取");
  });
  it.each([
    [
      "missing close hint",
      {
        ...promotion,
        texts: promotion.texts.filter((h) => !h.text.includes("空白")),
      },
    ],
    [
      "missing dates",
      {
        ...promotion,
        texts: promotion.texts.filter((h) => !h.text.includes("10/01")),
      },
    ],
    [
      "unrelated banner",
      {
        ...promotion,
        texts: promotion.texts.filter((h) => !h.text.includes("花合战")),
      },
    ],
    [
      "impossible date",
      {
        ...promotion,
        texts: promotion.texts.map((h) =>
          h.text.includes("10/01") ? { ...h, text: "10/01-10/32" } : h,
        ),
      },
    ],
    [
      "cross-month dates",
      {
        ...promotion,
        texts: promotion.texts.map((h) =>
          h.text.includes("10/01") ? { ...h, text: "10/01-11/01" } : h,
        ),
      },
    ],
    [
      "low confidence",
      {
        ...promotion,
        texts: promotion.texts.map((h) => ({ ...h, score: 0.7 })),
      },
    ],
    [
      "purchase overlay",
      {
        ...promotion,
        texts: [
          ...promotion.texts,
          ...frame(
            ["是否购买墨染花札", 700, 430],
            ["取消", 750, 610],
            ["确认", 1080, 610],
          ).texts,
        ],
      },
    ],
    [
      "resume battle",
      {
        ...promotion,
        texts: [
          ...promotion.texts,
          ...frame(["是否继续刚才的战斗", 700, 430]).texts,
        ],
      },
    ],
  ])("does not click an unconfirmed promotion: %s", async (_label, unknown) => {
    const { adapter, d } = setup(unknown);
    await expect(
      adapter.hanaClaim(new AbortController().signal),
    ).rejects.toThrow();
    expect(d.click).toHaveBeenCalledTimes(1); // The courtyard entry only.
  });
  it("switches from level rewards to tasks before claiming and handles an overlay without the page title", async () => {
    const { adapter, d, logs } = setup(level);
    await adapter.hanaClaim(new AbortController().signal);
    expect(d.click).toHaveBeenCalledWith(1820, 520, expect.anything());
    expect(logs).toContain("花合战全部奖励已领取");
  });
  it("does not report success when only the title and generic today label are visible", async () => {
    const { adapter, logs } = setup(
      frame(["花合战", 110, 30], ["今日", 360, 120]),
    );
    await expect(
      adapter.hanaClaim(new AbortController().signal),
    ).rejects.toThrow();
    expect(logs).not.toContain("花合战没有待领取奖励");
  });
  it("accepts a confirmed task list without claimable rewards", async () => {
    const { adapter, logs } = setup(empty);
    expect(await adapter.hanaClaim(new AbortController().signal)).toMatchObject(
      { status: "skipped" },
    );
    expect(logs).toContain("花合战没有待领取奖励");
  });
});

it("opens a resized closed scroll via feature recognition and then uses the courtyard text entry", async () => {
  let opened = false;
  let phase = "home";
  const log: string[] = [];
  const d: any = {
    observe: async () =>
      phase === "home"
        ? opened
          ? frame(["加成", 546, 49], ["合战", 1172, 988], ["阴阳寮", 806, 984])
          : frame(["加成", 546, 49])
        : empty,
    click: vi.fn(async (x: number) => {
      if (x > 1750) opened = true;
      else if (x > 1100) phase = "task";
      else phase = "home";
    }),
    matchTemplate: async () => null,
    matchFeatures: vi.fn(async (name: string) =>
      name === "courtyard-menu-closed.png"
        ? { box: [1700, 849, 217, 231], score: 13 }
        : null,
    ),
  };
  const a = new OnmyojiDaily(
    d,
    (m) => log.push(m),
    async () => {},
  );
  await a.hanaClaim(new AbortController().signal);
  expect(d.matchFeatures).toHaveBeenCalled();
  expect(opened).toBe(true);
  expect(log).toContain("花合战没有待领取奖励");
});

import {
  isHanaPage,
  hanaPromotionClosePoint,
  hanaTaskState,
  hanaClaimAction,
} from "../games/onmyoji/policy";
it("accepts a later month's introduction but never the task page or a wrong prompt location", () => {
  const later = {
    ...promotion,
    texts: promotion.texts.map((h) => ({
      ...h,
      text: h.text
        .replace("神无月", "霜月")
        .replace("10/01-10/31", "11/01-11/30"),
    })),
  };
  expect(hanaPromotionClosePoint(later)).toEqual([1700, 900]);
  expect(hanaPromotionClosePoint(tasks)).toBeNull();
  expect(
    hanaPromotionClosePoint({
      ...promotion,
      texts: promotion.texts.map((h) =>
        h.text.includes("空白") ? { ...h, box: [752, 300, 374, 34] } : h,
      ),
    } as Frame),
  ).toBeNull();
  expect(
    hanaPromotionClosePoint({
      ...promotion,
      texts: [
        ...promotion.texts,
        ...frame(["确定", 900, 540], ["取消", 750, 610], ["确认", 1080, 610])
          .texts,
      ],
    }),
  ).toBeNull();
});
it("recognizes the two-line claim-all label only when both lines form the same button", () => {
  const split = frame(
    ["花合战", 150, 35],
    ["今日", 770, 260],
    ["全部", 1370, 901],
    ["领取", 1366, 943],
  );
  expect(hanaTaskState(split)).toBe("claim");
  expect(hanaClaimAction(split)?.text).toBe("领取");
  expect(
    hanaClaimAction(
      frame(
        ["花合战", 150, 35],
        ["今日", 770, 260],
        ["全部", 1370, 901],
        ["领取", 1630, 943],
      ),
    ),
  ).toBeUndefined();
  expect(
    hanaClaimAction(
      frame(["花合战", 150, 35], ["今日", 770, 260], ["领取", 1366, 943]),
    ),
  ).toBeUndefined();
});
it("does not treat mixed rows as empty when claim-all OCR is missing", () => {
  expect(
    hanaTaskState(
      frame(
        ["花合战", 110, 30],
        ["今日", 360, 120],
        ["前往", 1580, 340],
        ["前往", 1580, 560],
        ["领取", 1580, 740],
      ),
    ),
  ).toBeNull();
});
it("recognizes the real level page with right-side vertical tabs outside the task list region", () => {
  expect(
    isHanaPage(
      frame(
        ["花合战", 148, 31],
        ["普通花札", 810, 291],
        ["奖励", 1790, 283],
        ["任务", 1796, 486],
      ),
    ),
  ).toBe(true);
});
