import { expect, it, vi } from "vitest";
import {
  creditShopBalance,
  verifyCreditShopping,
} from "../games/arknights/credit-shopping";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { Frame } from "../packages/runtime/device";
import type { SkillResult } from "../packages/protocol";
import aFixture from "./fixtures/arknights/credit-shop-a.json";
import bFixture from "./fixtures/arknights/credit-shop-b.json";
const a = aFixture as Frame,
  b = bFixture as Frame;

const device = {
  name: "test",
  address: "127.0.0.1:16384",
  adbPath: "D:/test/adb.exe",
};
const config = { ...defaultArknightsConfig, creditShopping: true };
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
      home.arknights.expectedUid = "864209759";
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
        { ...config, expectedUid: "864209759" },
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
