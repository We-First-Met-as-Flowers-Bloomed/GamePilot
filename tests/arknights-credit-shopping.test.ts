import { expect, it, vi } from "vitest";
import {
  creditShopBalance,
  verifyCreditShopping,
  dismissCreditRewardBeforeLogin,
} from "../games/arknights/credit-shopping";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { Frame } from "../packages/runtime/device";
import type { SkillResult } from "../packages/protocol";
import aFixture from "./fixtures/arknights/credit-shop-a.json";
import bFixture from "./fixtures/arknights/credit-shop-b.json";
import popupFixture from "./fixtures/arknights/credit-reward-popup.json";
import productFixture from "./fixtures/arknights/credit-shop-product-detail-20261027.json";
const a = aFixture as Frame,
  b = bFixture as Frame;

const device = {
  name: "test",
  address: "127.0.0.1:16384",
  adbPath: "D:/test/adb.exe",
};
const config = { ...defaultArknightsConfig, creditShopping: true };
it("can close the verified leftover reward before a fresh login without starting shopping", async () => {
  const ports = harness([193, 193]);
  let reads = 0;
  ports.inspect.mockImplementation(async () => ({
    frame: popupFixture as Frame,
    address: device.address,
    foregroundPackage: "com.hypergryph.arknights",
    observedAt: new Date().toISOString(),
    rewardConfirmation: {
      box: [624, 624, 32, 32] as [number, number, number, number],
      score: 0.99,
    },
  }));
  const dismissReward = vi.fn(async () => {
    reads++;
  });
  expect(
    await dismissCreditRewardBeforeLogin(
      device,
      config,
      new AbortController().signal,
      { ...ports, dismissReward },
    ),
  ).toBe(true);
  expect(reads).toBe(1);
  expect(ports.returnHome).toHaveBeenCalledOnce();
  const unknown = harness([193, 193]);
  expect(
    await dismissCreditRewardBeforeLogin(
      device,
      config,
      new AbortController().signal,
      { ...unknown, dismissReward },
    ),
  ).toBe(false);
  expect(reads).toBe(1);
});
const native = (): SkillResult => ({
  status: "succeeded",
  arknights: {
    version: 1,
    taskType: "Mall",
    submission: "submitted",
    completion: "native-confirmed",
    taskId: 1,
    observedAt: new Date().toISOString(),
    statistics: {
      version: 1,
      mall: { purchaseConfirmations: 3, creditCollected: false },
    },
  },
});
function frame(credit: number): Frame {
  return {
    ...b,
    texts: b.texts.map((h) =>
      /^613\/300$/.test(h.text) ? { ...h, text: `${credit}/300` } : h,
    ),
  };
}
function harness(credits: number[], overrides: object = {}) {
  let index = 0;
  const publish = vi.fn();
  const inspect = vi.fn(async () => {
    const n = index++;
    return {
      frame: frame(credits[Math.min(n, credits.length - 1)]),
      address: device.address,
      foregroundPackage: "com.hypergryph.arknights",
      observedAt: new Date().toISOString(),
      ...overrides,
    };
  });
  return {
    publish,
    inspect,
    returnHome: vi.fn(async () => ({
      address: device.address,
      foregroundPackage: "com.hypergryph.arknights",
      observedAt: new Date().toISOString(),
      image: "test",
      pageVerified: true,
      accountVerified: false,
      arknights: {
        page: "home" as const,
        pageVerified: true,
        accountVerified: false,
        account: "unbound" as const,
        expectedUid: config.expectedUid,
        message: "home",
        frames: [
          {
            page: "home" as const,
            anchors: [],
            uid: undefined as string | undefined,
          },
          {
            page: "home" as const,
            anchors: [],
            uid: undefined as string | undefined,
          },
        ],
      },
    })),
    wait: async () => {
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}
it("reads the two actual shop OCR layouts without confusing prices or the 300 limit", () => {
  expect(creditShopBalance(a)).toBe(893);
  expect(creditShopBalance(b)).toBe(613);
});
it("backs out of the observed product detail once before reading two wallet frames", async () => {
  const ports = harness([147, 147]);
  const wallet = ports.inspect.getMockImplementation()!;
  let observations = 0;
  ports.inspect.mockImplementation(async () =>
    observations++ < 2
      ? {
          frame: productFixture as Frame,
          address: device.address,
          foregroundPackage: "com.hypergryph.arknights",
          observedAt: new Date().toISOString(),
        }
      : wallet(),
  );
  const dismissProductDetail = vi.fn(async () => {});
  const result = await verifyCreditShopping(
    native(),
    config,
    device,
    new AbortController().signal,
    { ...ports, dismissProductDetail },
  );
  expect(dismissProductDetail).toHaveBeenCalledOnce();
  expect(result.arknights?.statistics?.mall?.finalCredit).toBe(147);
  expect(ports.returnHome).toHaveBeenCalledOnce();
});

it("dismisses an observed leftover product detail before fresh login without shopping", async () => {
  const ports = harness([147, 147], { frame: productFixture as Frame });
  const dismissProductDetail = vi.fn(async () => {});
  const dismissed = await dismissCreditRewardBeforeLogin(
    device,
    config,
    new AbortController().signal,
    { ...ports, dismissReward: vi.fn(), dismissProductDetail },
  );
  expect(dismissed).toBe(true);
  expect(dismissProductDetail).toHaveBeenCalledOnce();
  expect(ports.returnHome).toHaveBeenCalledOnce();
});

it.each(["changed-price", "confirmation", "outside-wallet", "repeated"])(
  "refuses unsafe or persistent product detail navigation: %s",
  async (change) => {
    const changed = structuredClone(productFixture) as Frame;
    if (change === "changed-price")
      changed.texts.find((h) => h.text === "200")!.text = "300";
    if (change === "confirmation")
      changed.texts.push({
        text: "是否确认购买",
        score: 0.99,
        box: [700, 430, 300, 40],
      });
    if (change === "outside-wallet")
      changed.texts.find((h) => h.text === "147/300")!.box[0] = 1200;
    const ports = harness([147, 147]);
    let observations = 0;
    ports.inspect.mockImplementation(async () => ({
      frame: observations++ % 2 === 0 ? (productFixture as Frame) : changed,
      address: device.address,
      foregroundPackage: "com.hypergryph.arknights",
      observedAt: new Date().toISOString(),
    }));
    const dismissProductDetail = vi.fn(async () => {});
    await expect(
      verifyCreditShopping(
        native(),
        config,
        device,
        new AbortController().signal,
        { ...ports, dismissProductDetail },
      ),
    ).rejects.toThrow();
    expect(dismissProductDetail).toHaveBeenCalledTimes(
      change === "repeated" ? 1 : 0,
    );
    expect(ports.returnHome).not.toHaveBeenCalled();
  },
);
it("dismisses one matching native shopping reward overlay then verifies the wallet without repurchasing", async () => {
  const ports = harness([193, 193]);
  const wallet = ports.inspect.getMockImplementation()!;
  let n = 0;
  ports.inspect.mockImplementation(async () =>
    n++ < 2
      ? {
          address: device.address,
          foregroundPackage: "com.hypergryph.arknights",
          observedAt: new Date().toISOString(),
          frame: popupFixture as Frame,
          rewardConfirmation: {
            box: [608, 608, 64, 64] as [number, number, number, number],
            score: 0.99,
          },
        }
      : wallet(),
  );
  const dismissReward = vi.fn(async () => {});
  const result = await verifyCreditShopping(
    native(),
    config,
    device,
    new AbortController().signal,
    { ...ports, dismissReward },
  );
  expect(dismissReward).toHaveBeenCalledOnce();
  expect(dismissReward).toHaveBeenCalledWith([640, 640]);
  expect(ports.inspect).toHaveBeenCalledTimes(4);
  expect(result.arknights?.statistics?.mall?.finalCredit).toBe(193);
});
it.each([
  "no-button",
  "weak-button",
  "wrong-button",
  "different-overlay",
  "still-overlay",
])(
  "does not use an unsafe second input for %s shopping overlays",
  async (kind) => {
    const ports = harness([193, 193]);
    let n = 0;
    const dismissReward = vi.fn(async () => {});
    ports.inspect.mockImplementation(async () => ({
      address: device.address,
      foregroundPackage: "com.hypergryph.arknights",
      observedAt: new Date().toISOString(),
      frame:
        kind === "different-overlay" && n++ > 0
          ? ({ ...popupFixture, texts: [] } as Frame)
          : (popupFixture as Frame),
      rewardConfirmation:
        kind === "no-button"
          ? undefined
          : {
              box:
                kind === "wrong-button"
                  ? ([100, 100, 64, 64] as [number, number, number, number])
                  : ([608, 608, 64, 64] as [number, number, number, number]),
              score: kind === "weak-button" ? 0.7 : 0.99,
            },
    }));
    await expect(
      verifyCreditShopping(
        native(),
        config,
        device,
        new AbortController().signal,
        { ...ports, dismissReward },
      ),
    ).rejects.toThrow();
    expect(dismissReward).toHaveBeenCalledTimes(
      kind === "still-overlay" ? 1 : 0,
    );
  },
);
it("requires shop anchors and rejects conflicting, low-score and misplaced balance text", () => {
  expect(
    creditShopBalance({
      ...b,
      texts: b.texts.filter((h) => h.text !== "信用获取规则"),
    }),
  ).toBeUndefined();
  expect(
    creditShopBalance({
      ...b,
      texts: [
        ...b.texts,
        { text: "999/300", score: 1, box: [1735, 42, 150, 36] },
      ],
    }),
  ).toBeUndefined();
  expect(
    creditShopBalance({
      ...b,
      texts: b.texts.map((h) =>
        h.text === "613/300" ? { ...h, score: 0.8 } : h,
      ),
    }),
  ).toBeUndefined();
  expect(
    creditShopBalance({
      ...b,
      texts: b.texts.map((h) =>
        h.text === "613/300"
          ? { ...h, box: [100, 40, 150, 36] as Frame["texts"][number]["box"] }
          : h,
      ),
    }),
  ).toBeUndefined();
});
it("persists fresh matching post-shopping credit and preserves native purchases", async () => {
  const ports = harness([293, 293]);
  const result = await verifyCreditShopping(
    native(),
    config,
    device,
    new AbortController().signal,
    ports,
  );
  expect(result.arknights?.statistics?.mall).toMatchObject({
    purchaseConfirmations: 3,
    finalCredit: 293,
  });
  expect(result.summary).toContain("293");
  expect(ports.inspect).toHaveBeenCalledTimes(2);
  expect(ports.returnHome).toHaveBeenCalledTimes(1);
});
it("retains observed excess credit before stopping instead of accepting native chain completion", async () => {
  const ports = harness([493, 493]);
  await expect(
    verifyCreditShopping(
      native(),
      config,
      device,
      new AbortController().signal,
      ports,
    ),
  ).rejects.toThrow(/493.*300/);
  expect(
    ports.publish.mock.calls.at(-1)?.[0].arknights.statistics.mall.finalCredit,
  ).toBe(493);
  expect(ports.returnHome).not.toHaveBeenCalled();
});
it("rechecks mismatched frames at most twice and never places another purchase", async () => {
  const ports = harness([893, 613, 413, 213, 193, 193]);
  const result = await verifyCreditShopping(
    native(),
    config,
    device,
    new AbortController().signal,
    ports,
  );
  expect(result.arknights?.statistics?.mall?.finalCredit).toBe(193);
  expect(ports.inspect).toHaveBeenCalledTimes(6);
  const unknown = harness([400, 200]);
  unknown.inspect.mockImplementation(async () => ({
    frame: { ...b, texts: [] },
    address: device.address,
    foregroundPackage: "com.hypergryph.arknights",
    observedAt: new Date().toISOString(),
  }));
  await expect(
    verifyCreditShopping(
      native(),
      config,
      device,
      new AbortController().signal,
      unknown,
    ),
  ).rejects.toThrow(/余额/);
  expect(unknown.inspect).toHaveBeenCalledTimes(6);
});
it.each([
  { address: "other" },
  { foregroundPackage: "other" },
  { observedAt: "2026-01-01T00:00:00Z" },
])("rejects stale or different device evidence %j", async (overrides) => {
  await expect(
    verifyCreditShopping(
      native(),
      config,
      device,
      new AbortController().signal,
      harness([193, 193], overrides),
    ),
  ).rejects.toThrow();
});
it("recognizes exactly 300 as the safe carryover boundary and bypasses inspection when shopping is disabled", async () => {
  const result = await verifyCreditShopping(
    native(),
    config,
    device,
    new AbortController().signal,
    harness([300, 300]),
  );
  expect(result.summary).toContain("300");
  expect(result.summary).not.toContain("低于");
  const ports = harness([893, 893]);
  await verifyCreditShopping(
    native(),
    { ...config, creditShopping: false },
    device,
    new AbortController().signal,
    ports,
  );
  expect(ports.inspect).not.toHaveBeenCalled();
});

it("does not inspect after cancellation or accept unconfirmed native shopping", async () => {
  const ports = harness([293, 293]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    verifyCreditShopping(native(), config, device, controller.signal, ports),
  ).rejects.toThrow();
  expect(ports.inspect).not.toHaveBeenCalled();
  const result = native();
  result.arknights!.completion = "unknown";
  await expect(
    verifyCreditShopping(
      result,
      config,
      device,
      new AbortController().signal,
      ports,
    ),
  ).rejects.toThrow(/原生/);
  expect(ports.inspect).not.toHaveBeenCalled();
});

it.each([
  "wrong-address",
  "stale",
  "unknown-page",
  "wrong-package",
  "uid-conflict",
])(
  "keeps verified shopping evidence when home return is %s",
  async (failure) => {
    const ports = harness([293, 293]);
    const original = ports.returnHome.getMockImplementation()!;
    ports.returnHome.mockImplementation(async () => {
      const home = await original();
      home.arknights.expectedUid = "123456789";
      if (failure === "wrong-address") home.address = "other";
      if (failure === "stale") home.observedAt = "2026-01-01T00:00:00Z";
      if (failure === "unknown-page") home.pageVerified = false;
      if (failure === "wrong-package") home.foregroundPackage = "other";
      if (failure === "uid-conflict")
        home.arknights.frames[0].uid = "999999999";
      return home;
    });
    await expect(
      verifyCreditShopping(
        native(),
        { ...config, expectedUid: "123456789" },
        device,
        new AbortController().signal,
        ports,
      ),
    ).rejects.toThrow(/返回主页/);
    expect(
      ports.publish.mock.calls.at(-1)?.[0].arknights.statistics.mall
        .finalCredit,
    ).toBe(293);
  },
);
