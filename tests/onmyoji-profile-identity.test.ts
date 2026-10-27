import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame, GameDevice } from "../packages/runtime/device";
import type { OnmyojiIdentityPorts } from "../games/onmyoji/identity";
import * as identity from "../games/onmyoji/identity";
import profileA from "./fixtures/onmyoji/own-settings-a-20261027.json";
import profileB from "./fixtures/onmyoji/own-settings-b-20261027.json";
import {
  validateOnmyojiIdentityBinding,
  validOnmyojiIdentityEvidence,
  publicOnmyojiIdentityInspection,
  type OnmyojiIdentityEvidence,
} from "../packages/protocol/onmyoji-identity";

type ProfilePorts = Omit<OnmyojiIdentityPorts, "device"> & {
  device: Pick<GameDevice, "observe" | "packages" | "click">;
};
const api = identity as typeof identity & {
  parseOnmyojiSettingsUid(frame: Frame): string | undefined;
  verifyOnmyojiProfile(ports: ProfilePorts): Promise<OnmyojiIdentityEvidence>;
};
const own = () => structuredClone(profileA) as Frame;
const home = (): Frame => ({
  width: 1920,
  height: 1080,
  texts: [
    { text: "测试角色", box: [194, 45, 126, 36], score: 0.99 },
    { text: "加成", box: [550, 55, 32, 56], score: 0.99 },
    { text: "召唤", box: [1578, 262, 60, 107], score: 0.99 },
  ],
});
function harness(frames = [home(), home(), own(), own(), home(), home()]) {
  let clock = Date.parse("2026-10-27T11:00:00Z"),
    index = 0;
  let connected = {
    name: "fixture",
    adbPath: "D:/fixture/adb.exe",
    address: "fixture:2",
  };
  const engine = {
    observe: vi.fn(async () =>
      structuredClone(frames[Math.min(index++, frames.length - 1)]),
    ),
    packages: vi.fn(async () => ["com.netease.onmyoji"]),
    click: vi.fn(async () => {}),
  };
  const options: ProfilePorts = {
    identity: { roleId: "106123456" },
    device: engine,
    connectedDevice: () => connected,
    appProcessRunning: vi.fn(async () => true),
    now: () => clock,
    wait: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    signal: new AbortController().signal,
  };
  return {
    engine,
    options,
    changeDevice: () => {
      connected = { ...connected, address: "other:3" };
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("current Onmyoji profile UID proof", () => {
  it("allows an exact UID binding without inventing an unobserved server", () => {
    expect(validateOnmyojiIdentityBinding({ roleId: "106123456" })).toEqual({
      roleId: "106123456",
    });
    expect(() =>
      validateOnmyojiIdentityBinding({ roleId: "106123456", serverName: "" }),
    ).toThrow();
  });

  const matched = () => ({
    version: 1,
    certification: "profile-uid-v1",
    status: "matched",
    reason: "identity-matched",
    candidateMatch: true,
    expected: { roleId: "106123456" },
    device: { adbPath: "D:/fixture/adb.exe", address: "fixture:2" },
    packageName: "com.netease.onmyoji",
    startedAt: "2026-10-27T11:00:00.000Z",
    observedAt: "2026-10-27T11:00:06.000Z",
    frames: [
      {
        observedAt: "2026-10-27T11:00:02.000Z",
        identity: { roleId: "106123456" },
      },
      {
        observedAt: "2026-10-27T11:00:03.000Z",
        identity: { roleId: "106123456" },
      },
    ],
    courtyardFrames: ["2026-10-27T11:00:05.000Z", "2026-10-27T11:00:06.000Z"],
  });

  it("accepts two matching full profile UIDs only after two returned courtyard observations", () => {
    const proof = matched();
    expect(validOnmyojiIdentityEvidence(proof)).toBe(true);
    expect(publicOnmyojiIdentityInspection(proof as never)).toMatchObject({
      status: "matched",
      certified: true,
      configured: true,
    });
    expect(
      JSON.stringify(publicOnmyojiIdentityInspection(proof as never)),
    ).not.toContain("106123456");
  });

  it("rejects partial, conflicting, missing-return and legacy manufactured matches", () => {
    for (const proof of [
      { ...matched(), courtyardFrames: [] },
      { ...matched(), frames: matched().frames.slice(0, 1) },
      {
        ...matched(),
        frames: [
          matched().frames[0],
          { ...matched().frames[1], identity: { roleId: "123456" } },
        ],
      },
      { ...matched(), certification: "experimental" },
      { ...matched(), observedAt: "2026-10-27T11:00:01.000Z" },
      {
        ...matched(),
        courtyardFrames: [
          "2026-10-27T10:59:59.000Z",
          "2026-10-27T11:00:06.000Z",
        ],
      },
    ])
      expect(validOnmyojiIdentityEvidence(proof)).toBe(false);
  });
});

describe("own-avatar settings UID navigation", () => {
  it("reads the current 编号 from both real settings layouts, never 曾用编号", () => {
    expect(typeof api.parseOnmyojiSettingsUid).toBe("function");
    expect(api.parseOnmyojiSettingsUid(own())).toBe("106123456");
    expect(api.parseOnmyojiSettingsUid(profileB as Frame)).toBe("102987654");
    const oldOnly = own();
    oldOnly.texts = oldOnly.texts.filter((h) => !h.text.startsWith("编号"));
    expect(api.parseOnmyojiSettingsUid(oldOnly)).toBeUndefined();
  });

  it.each([
    "no-title",
    "low-confidence",
    "different-field",
    "ambiguous",
    "confirmation",
    "broken-frame",
  ])("refuses %s as UID proof", (kind) => {
    expect(typeof api.parseOnmyojiSettingsUid).toBe("function");
    const frame = own();
    if (kind === "no-title")
      frame.texts = frame.texts.filter((h) => h.text !== "设置");
    if (kind === "low-confidence")
      frame.texts.find((h) => h.text.startsWith("编号"))!.score = 0.8;
    if (kind === "different-field")
      frame.texts.find((h) => h.text.startsWith("编号"))!.text =
        "昵称106123456";
    if (kind === "ambiguous")
      frame.texts.push({
        ...frame.texts.find((h) => h.text.startsWith("编号"))!,
        text: "编号999999999",
      });
    if (kind === "confirmation")
      frame.texts.push({
        text: "确认购买",
        box: [700, 450, 300, 50],
        score: 0.99,
      });
    if (kind === "broken-frame") frame.texts.push(null as never);
    expect(api.parseOnmyojiSettingsUid(frame)).toBeUndefined();
  });

  it("supports a separate 编号 label and exactly one aligned complete digit field", () => {
    expect(typeof api.parseOnmyojiSettingsUid).toBe("function");
    const frame = own();
    frame.texts = frame.texts.filter((h) => !h.text.startsWith("编号"));
    frame.texts.push(
      { text: "编号", box: [256, 601, 70, 40], score: 0.99 },
      { text: "106123456", box: [348, 601, 180, 40], score: 0.99 },
    );
    expect(api.parseOnmyojiSettingsUid(frame)).toBe("106123456");
    frame.texts.at(-1)!.text = "106 123456";
    expect(api.parseOnmyojiSettingsUid(frame)).toBeUndefined();
  });

  it.each([0.99, 0.6])(
    "refuses a full UID split into a plausible prefix and a trailing digit with confidence %s",
    (score) => {
      const frame = own();
      frame.texts = frame.texts.filter((hit) => !hit.text.startsWith("编号"));
      frame.texts.push(
        { text: "编号", box: [256, 601, 70, 40], score: 0.99 },
        { text: "106123456", box: [348, 601, 180, 40], score: 0.99 },
        { text: "7", box: [530, 601, 20, 40], score },
      );
      expect(api.parseOnmyojiSettingsUid(frame)).toBeUndefined();
    },
  );

  it.each(["O", "?"])(
    "refuses an unknown trailing OCR fragment %s rather than trusting the readable prefix",
    (suffix) => {
      const frame = own();
      frame.texts = frame.texts.filter((hit) => !hit.text.startsWith("编号"));
      frame.texts.push(
        { text: "编号", box: [256, 601, 70, 40], score: 0.99 },
        { text: "106123456", box: [348, 601, 180, 40], score: 0.99 },
        { text: suffix, box: [530, 601, 20, 40], score: 0.6 },
      );
      expect(api.parseOnmyojiSettingsUid(frame)).toBeUndefined();
    },
  );

  it("opens the avatar once, verifies two fresh profile UIDs, and closes only the known panel", async () => {
    expect(typeof api.verifyOnmyojiProfile).toBe("function");
    const h = harness();
    const proof = await api.verifyOnmyojiProfile(h.options);
    expect(proof).toMatchObject({
      status: "matched",
      certification: "profile-uid-v1",
      reason: "identity-matched",
      candidateMatch: true,
    });
    expect(h.engine.click.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [95, 80],
      [1660, 150],
    ]);
    expect(validOnmyojiIdentityEvidence(proof)).toBe(true);
    expect(proof.courtyardFrames).toHaveLength(2);
  });

  it("can verify a panel already open without clicking the avatar behind it", async () => {
    expect(typeof api.verifyOnmyojiProfile).toBe("function");
    const h = harness([own(), own(), home(), home()]);
    expect((await api.verifyOnmyojiProfile(h.options)).status).toBe("matched");
    expect(h.engine.click).toHaveBeenCalledTimes(1);
  });

  it("recognizes the observed vertically split summon lantern without weakening the profile check", async () => {
    const split = home();
    split.texts = split.texts.filter((hit) => hit.text !== "召唤");
    split.texts.push(
      { text: "召", box: [1592, 260, 40, 61], score: 0.93 },
      { text: "唤", box: [1586, 305, 48, 50], score: 0.99 },
    );
    const h = harness([split, split, own(), own(), split, split]);
    expect((await api.verifyOnmyojiProfile(h.options)).status).toBe("matched");
  });

  it("uses two independent courtyard landmarks when one animated OCR anchor is temporarily missing", async () => {
    const noBuff = home();
    noBuff.texts = noBuff.texts.filter((hit) => hit.text !== "加成");
    noBuff.texts.push({ text: "探", box: [992, 218, 28, 34], score: 0.99 });
    const h = harness([noBuff, noBuff, own(), own(), noBuff, noBuff]);
    expect((await api.verifyOnmyojiProfile(h.options)).status).toBe("matched");
    const onlyName = home();
    onlyName.texts = onlyName.texts.slice(0, 1);
    expect(
      (await api.verifyOnmyojiProfile(harness([onlyName]).options)).status,
    ).toBe("unknown");
  });

  it("supports shifted lanterns only with the observed expanded courtyard bottom menu", async () => {
    const expanded = home();
    expanded.texts = expanded.texts.filter((hit) => hit.text !== "召唤");
    expanded.texts.push(
      { text: "探索", box: [738, 196, 50, 109], score: 0.99 },
      { text: "召唤", box: [1332, 256, 54, 103], score: 0.99 },
      { text: "图鉴", box: [144, 982, 68, 40], score: 0.99 },
      { text: "阴阳术", box: [1478, 982, 102, 42], score: 0.99 },
      { text: "式神录", box: [1648, 986, 98, 38], score: 0.99 },
    );
    expect(
      (
        await api.verifyOnmyojiProfile(
          harness([expanded, expanded, own(), own(), expanded, expanded])
            .options,
        )
      ).status,
    ).toBe("matched");
    expanded.texts = expanded.texts.filter(
      (hit) => !["图鉴", "阴阳术", "式神录"].includes(hit.text),
    );
    expect(
      (await api.verifyOnmyojiProfile(harness([expanded]).options)).status,
    ).toBe("unknown");
  });

  it("keeps the original lantern layout valid when the bottom menu is also expanded", async () => {
    const expanded = home();
    expanded.texts.push(
      { text: "图鉴", box: [152, 988, 56, 30], score: 0.99 },
      { text: "阴阳术", box: [1480, 986, 98, 38], score: 0.99 },
    );
    expect(
      (
        await api.verifyOnmyojiProfile(
          harness([expanded, expanded, own(), own(), expanded, expanded])
            .options,
        )
      ).status,
    ).toBe("matched");
  });

  it("verifies the actually installed NetEase emulator channel package", async () => {
    const h = harness();
    h.engine.packages.mockResolvedValue(["com.netease.onmyoji.wyzymnqsd_cps"]);
    const proof = await api.verifyOnmyojiProfile(h.options);
    expect(proof.status).toBe("matched");
    expect(proof.packageName).toBe("com.netease.onmyoji.wyzymnqsd_cps");
    expect(validOnmyojiIdentityEvidence(proof)).toBe(true);
    expect(h.options.appProcessRunning).toHaveBeenCalledWith(
      expect.anything(),
      "com.netease.onmyoji.wyzymnqsd_cps",
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["com.netease.onmyoji.unknown"],
    ["com.netease.onmyoji", "com.netease.onmyoji.wyzymnqsd_cps"],
  ])("refuses unknown or ambiguous installed packages %j", async (...names) => {
    const h = harness();
    h.engine.packages.mockResolvedValue(names);
    expect((await api.verifyOnmyojiProfile(h.options)).reason).toBe(
      "package-unavailable",
    );
    expect(h.engine.click).not.toHaveBeenCalled();
  });

  it.each(["first", "second"])(
    "stops on a foreign UID in the %s profile frame without further input",
    async (where) => {
      expect(typeof api.verifyOnmyojiProfile).toBe("function");
      const h = harness(
        where === "first" ? [profileB as Frame] : [own(), profileB as Frame],
      );
      const proof = await api.verifyOnmyojiProfile(h.options);
      expect(proof.status).toBe("mismatch");
      expect(validOnmyojiIdentityEvidence(proof)).toBe(true);
      expect(h.engine.click).not.toHaveBeenCalled();
    },
  );

  it("never certifies matching UID when the panel did not close", async () => {
    expect(typeof api.verifyOnmyojiProfile).toBe("function");
    const h = harness([own(), own()]);
    const proof = await api.verifyOnmyojiProfile(h.options);
    expect(proof).toMatchObject({
      status: "unknown",
      reason: "profile-return-failed",
      candidateMatch: false,
    });
    expect(h.engine.click).toHaveBeenCalledTimes(1);
    expect(validOnmyojiIdentityEvidence(proof)).toBe(true);
  });

  it("does not click through an unknown confirmation over the courtyard", async () => {
    expect(typeof api.verifyOnmyojiProfile).toBe("function");
    const overlay = home();
    overlay.texts.push({ text: "确认", box: [800, 500, 100, 50], score: 0.99 });
    const h = harness([overlay]);
    expect((await api.verifyOnmyojiProfile(h.options)).status).toBe("unknown");
    expect(h.engine.click).not.toHaveBeenCalled();
  });

  it("stops before input if the physical device changes while sampling", async () => {
    expect(typeof api.verifyOnmyojiProfile).toBe("function");
    const h = harness();
    h.options.wait = async () => h.changeDevice();
    expect((await api.verifyOnmyojiProfile(h.options)).reason).toBe(
      "device-changed",
    );
    expect(h.engine.click).not.toHaveBeenCalled();
  });

  it("bounds a stalled read and propagates caller cancellation", async () => {
    expect(typeof api.verifyOnmyojiProfile).toBe("function");
    vi.useFakeTimers();
    const h = harness();
    h.engine.observe.mockImplementation(() => new Promise<Frame>(() => {}));
    const pending = api.verifyOnmyojiProfile(h.options);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await pending).toMatchObject({
      status: "unknown",
      reason: "observation-timeout",
    });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      api.verifyOnmyojiProfile({ ...h.options, signal: cancelled.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.engine.click).not.toHaveBeenCalled();
  });
});
