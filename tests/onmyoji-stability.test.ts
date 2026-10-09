import { describe, it, expect } from "vitest";
import { waitForStableFrame } from "../games/onmyoji/stability";
import type { Frame } from "../packages/runtime/device";
import type { GameDevice } from "../packages/runtime/device";
import { OnmyojiDaily } from "../games/onmyoji/daily";
const f = (key: string): Frame => ({
  width: 1920,
  height: 1080,
  texts: [{ text: key, box: [1, 1, 10, 10], score: 1 }],
});
describe("stable game observations", () => {
  it("rejects a transient match and requires consecutive identical relevant states", async () => {
    const frames = ["ready", "none", "moving", "ready", "ready"].map(f);
    let n = 0;
    const result = await waitForStableFrame(
      async () => frames[n++],
      (a) => (a.texts[0].text === "none" ? null : a.texts[0].text),
      new AbortController().signal,
      async () => {},
      6,
    );
    expect(result.texts[0].text).toBe("ready");
    expect(n).toBe(5);
  });
  it("stops at its frame budget without clicking", async () => {
    await expect(
      waitForStableFrame(
        async () => f("none"),
        () => null,
        new AbortController().signal,
        async () => {},
        3,
      ),
    ).rejects.toThrow("稳定");
  });
  it("checks cancellation after a pause", async () => {
    const c = new AbortController();
    await expect(
      waitForStableFrame(
        async () => f("ready"),
        () => "ready",
        c.signal,
        async () => c.abort(),
        4,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
it("allows a stable non-target card to be skipped while scanning friends", async () => {
  const selected: Frame = {
    width: 1920,
    height: 1080,
    texts: [
      ["式神育成", 100, 30],
      ["好友", 300, 150],
      ["进入好友结界寄养式神", 1000, 150],
      ["进入结界", 1200, 800],
      ["经验+100", 1200, 600],
    ].map(([text, x, y]) => ({
      text: String(text),
      box: [Number(x), Number(y), 180, 40],
      score: 1,
    })),
  };
  const adapter = new OnmyojiDaily(
    { observe: async () => selected } as unknown as GameDevice,
    () => {},
    async () => {},
  );
  const result = await (
    adapter as unknown as {
      stableFosterSelection(signal: AbortSignal): Promise<Frame>;
    }
  ).stableFosterSelection(new AbortController().signal);
  expect(result).toBe(selected);
});
