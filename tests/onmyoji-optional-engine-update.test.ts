import { expect, it, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import type { Frame, GameDevice } from "../packages/runtime/device";
import captured from "./fixtures/onmyoji/login-optional-engine-update-20261008.json";
import mergedFooter from "./fixtures/onmyoji/login-optional-engine-update-merged-20261008.json";

const update = captured as Frame;
const landing: Frame = {
  ...update,
  texts: update.texts.filter((hit) => hit.box[1] < 380 || hit.box[1] > 700),
};
const courtyard: Frame = {
  width: 1920,
  height: 1080,
  texts: [{ text: "加成", box: [546, 49, 100, 40], score: 0.99 }],
};
const blank: Frame = { width: 1920, height: 1080, texts: [] };
function harness(first = update, afterSkip = landing) {
  let current = first;
  const log = vi.fn();
  const device: GameDevice = {
    observe: vi.fn(async () => current),
    click: vi.fn(async (x, y) => {
      const skip = current.texts.find((hit) => hit.text === "暂不更新");
      if (
        skip &&
        x === skip.box[0] + skip.box[2] / 2 &&
        y === skip.box[1] + skip.box[3] / 2
      )
        current = afterSkip;
      else if (current === landing && x === 956 && y === 889)
        current = courtyard;
    }),
    swipe: vi.fn(async () => {}),
    longPress: vi.fn(async () => {}),
    startApp: vi.fn(async () => {}),
    packages: vi.fn(async () => ["com.netease.onmyoji.test"]),
    isAppRunning: vi.fn(async () => true),
    matchTemplate: vi.fn(async () => null),
    colorSlots: vi.fn(async () => []),
  };
  return {
    device,
    log,
    setFrame: (value: Frame) => {
      current = value;
    },
    adapter: new OnmyojiDaily(device, log, async () => {}),
  };
}
const points = (device: GameDevice) =>
  vi.mocked(device.click).mock.calls.map(([x, y]) => [x, y]);

it("dismisses the captured optional update at its OCR skip button before entering the game", async () => {
  const h = harness();
  await expect(
    h.adapter.login(new AbortController().signal),
  ).resolves.toMatchObject({
    status: "succeeded",
    goalSatisfied: true,
    evidenceReference: "onmyoji:login:two-frames",
  });
  expect(points(h.device)).toEqual([
    [833, 633],
    [956, 889],
  ]);
  expect(h.device.observe).toHaveBeenCalledTimes(5);
});
it("handles the same observed dialog when it first appears after app startup", async () => {
  const h = harness(blank);
  vi.mocked(h.device.startApp).mockImplementation(async () => {
    h.setFrame(update);
  });
  await expect(
    h.adapter.login(new AbortController().signal),
  ).resolves.toMatchObject({ status: "succeeded" });
  expect(points(h.device)).toEqual([
    [833, 633],
    [956, 889],
  ]);
});
it("recognizes the other captured frame with merged footer text and partial copyright", async () => {
  const h = harness(mergedFooter as Frame);
  await expect(
    h.adapter.login(new AbortController().signal),
  ).resolves.toMatchObject({ status: "succeeded" });
  expect(points(h.device)).toEqual([
    [833, 633],
    [956, 889],
  ]);
});
it("uses the recognized skip box rather than fixed click coordinates", async () => {
  const shifted = structuredClone(update);
  shifted.texts.find((hit) => hit.text === "暂不更新")!.box = [
    790, 620, 120, 30,
  ];
  const h = harness(shifted);
  await h.adapter.login(new AbortController().signal);
  expect(points(h.device)).toEqual([
    [850, 635],
    [956, 889],
  ]);
});
it.each([
  "missing-body",
  "missing-skip",
  "missing-download",
  "missing-title",
  "missing-enter",
  "missing-agreement",
  "missing-client",
  "missing-copyright",
  "low-confidence",
  "wrong-position",
  "duplicate-button",
  "mandatory-update",
  "credentials",
  "wide-credentials",
  "confirmation",
  "wrong-size",
])(
  "sends no input for an unreliable or different update dialog: %s",
  async (kind) => {
    const frame = structuredClone(update);
    const drop = (pattern: RegExp) => {
      frame.texts = frame.texts.filter((hit) => !pattern.test(hit.text));
    };
    if (kind === "missing-body") drop(/发现全新/);
    if (kind === "missing-skip") drop(/^暂不更新$/);
    if (kind === "missing-download") drop(/^后台下载$/);
    if (kind === "missing-title") drop(/^提示$/);
    if (kind === "missing-enter") drop(/^进入游戏$/);
    if (kind === "missing-agreement") drop(/^用户协议/);
    if (kind === "missing-client") drop(/^客户端/);
    if (kind === "missing-copyright") drop(/^著作权人/);
    if (kind === "low-confidence")
      frame.texts.find((hit) => hit.text === "暂不更新")!.score = 0.6;
    if (kind === "wrong-position")
      frame.texts.find((hit) => hit.text === "暂不更新")!.box[0] = 1050;
    if (kind === "duplicate-button")
      frame.texts.push(
        structuredClone(frame.texts.find((hit) => hit.text === "暂不更新")!),
      );
    if (kind === "mandatory-update")
      frame.texts.find((hit) => hit.text.includes("建议更新"))!.text =
        "必须更新后才能进入游戏。";
    if (kind === "credentials")
      frame.texts.push({
        text: "请输入验证码",
        box: [760, 550, 250, 35],
        score: 0.99,
      });
    if (kind === "wide-credentials")
      frame.texts.push({
        text: "请输入验证码完成账号验证",
        box: [250, 500, 1400, 40],
        score: 0.99,
      });
    if (kind === "confirmation")
      frame.texts.push({
        text: "确认支付",
        box: [1040, 620, 120, 35],
        score: 0.99,
      });
    if (kind === "wrong-size") frame.width = 1280;
    const h = harness(frame);
    await expect(
      h.adapter.login(new AbortController().signal),
    ).rejects.toThrow();
    expect(h.device.click).not.toHaveBeenCalled();
  },
);
it("stops after two attempts when the recognized dialog remains in front", async () => {
  const h = harness(update, update);
  await expect(h.adapter.login(new AbortController().signal)).rejects.toThrow(
    /两次|2/,
  );
  expect(points(h.device)).toEqual([
    [833, 633],
    [833, 633],
  ]);
  expect(h.device.startApp).not.toHaveBeenCalled();
});
it.each([
  "wide-update-body",
  "update-body-crossing-top",
  "unknown-prompt-only",
  "unknown-prompt-missing-client",
  "unknown-prompt-missing-copyright",
])(
  "does not click background enter through an unrecognized central dialog: %s",
  async (kind) => {
    const frame = structuredClone(landing);
    if (kind !== "update-body-crossing-top")
      frame.texts.push({ text: "提示", box: [930, 418, 60, 32], score: 0.99 });
    if (!kind.startsWith("unknown-prompt"))
      frame.texts.push({
        text: "引擎版本需要更新，请处理更新提示",
        box:
          kind === "wide-update-body"
            ? [600, 470, 720, 40]
            : [720, 340, 400, 80],
        score: 0.99,
      });
    if (kind === "unknown-prompt-missing-client")
      frame.texts = frame.texts.filter((hit) => !hit.text.includes("客户端"));
    if (kind === "unknown-prompt-missing-copyright")
      frame.texts = frame.texts.filter((hit) => !hit.text.includes("著作权人"));
    const h = harness(frame);
    await expect(
      h.adapter.login(new AbortController().signal),
    ).rejects.toThrow();
    expect(h.device.click).not.toHaveBeenCalled();
  },
);
it("keeps the two-dismissal budget across separate login-page observations", async () => {
  const h = harness();
  vi.mocked(h.device.startApp).mockImplementation(async () => {
    h.setFrame(update);
  });
  const click = vi.mocked(h.device.click).getMockImplementation()!;
  vi.mocked(h.device.click).mockImplementation(async (x, y, signal) => {
    await click(x, y, signal);
    if (x === 956 && y === 889) h.setFrame(update);
  });
  await expect(h.adapter.login(new AbortController().signal)).rejects.toThrow(
    /两次|2/,
  );
  expect(points(h.device)).toEqual([
    [833, 633],
    [833, 633],
    [956, 889],
  ]);
});
it.each(["blank", "credentials", "unknown-confirmation", "unknown-prompt"])(
  "requires a reliable postcondition after dismissing the update: %s",
  async (kind) => {
    const after =
      kind === "blank"
        ? blank
        : {
            ...courtyard,
            texts: [
              ...courtyard.texts,
              ...landing.texts,
              {
                text:
                  kind === "credentials"
                    ? "请输入验证码"
                    : kind === "unknown-prompt"
                      ? "提示"
                      : "确认支付",
                box: [760, 540, 300, 40] as [number, number, number, number],
                score: 0.99,
              },
            ],
          };
    const h = harness(update, after);
    await expect(
      h.adapter.login(new AbortController().signal),
    ).rejects.toThrow();
    expect(points(h.device)).toEqual([[833, 633]]);
    expect(h.device.startApp).not.toHaveBeenCalled();
  },
);
it("waits for fresh observations through dismissal animation before entering", async () => {
  const h = harness();
  const observe = vi.mocked(h.device.observe).getMockImplementation()!;
  let delayed = 2;
  vi.mocked(h.device.observe).mockImplementation(async (signal) =>
    vi.mocked(h.device.click).mock.calls.length === 1 && delayed-- > 0
      ? update
      : observe(signal),
  );
  await expect(
    h.adapter.login(new AbortController().signal),
  ).resolves.toMatchObject({ status: "succeeded" });
  expect(points(h.device)).toEqual([
    [833, 633],
    [956, 889],
  ]);
});
it("honors cancellation before the optional-update input", async () => {
  const h = harness();
  const controller = new AbortController();
  vi.mocked(h.device.observe).mockImplementation(async () => {
    controller.abort();
    return update;
  });
  await expect(h.adapter.login(controller.signal)).rejects.toThrow();
  expect(h.device.click).not.toHaveBeenCalled();
});
it("does not retry when the skip click itself fails", async () => {
  const h = harness();
  vi.mocked(h.device.click).mockRejectedValue(Error("input failed"));
  await expect(h.adapter.login(new AbortController().signal)).rejects.toThrow(
    "input failed",
  );
  expect(points(h.device)).toEqual([[833, 633]]);
});
