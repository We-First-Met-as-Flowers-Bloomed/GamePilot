import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame, GameDevice } from "../packages/runtime/device";
import {
  deviceLanePlanKey,
  defaultDeviceLanes,
  validateDeviceLanes,
  validStructuredSkillOutcome,
} from "../packages/protocol";
import {
  validateOnmyojiIdentityBinding,
  validateOnmyojiConfig,
  validOnmyojiIdentityEvidence,
  publicOnmyojiIdentityInspection,
} from "../packages/protocol/onmyoji-identity";
import {
  parseOnmyojiProfileCandidate,
  inspectOnmyojiIdentity,
} from "../games/onmyoji/identity";
import { onmyojiLaneContract } from "../games/onmyoji/lane-plugin";

const binding = { roleId: "12345678901234567890", serverName: "测试服务器" };
const device = {
  name: "fixture",
  adbPath: "D:/fixture/adb.exe",
  address: "fixture:1",
};
const frame = (
  roleId = binding.roleId,
  serverName = binding.serverName,
): Frame => ({
  width: 1920,
  height: 1080,
  texts: [
    { text: "角色资料", box: [650, 130, 180, 45], score: 0.99 },
    { text: "角色编号", box: [650, 310, 180, 40], score: 0.99 },
    { text: roleId, box: [850, 310, 430, 40], score: 0.99 },
    { text: "服务器", box: [650, 410, 180, 40], score: 0.99 },
    { text: serverName, box: [850, 410, 300, 40], score: 0.99 },
  ],
});
function captureHarness(frames = [frame(), frame()]) {
  let clock = Date.parse("2026-10-11T12:00:00.000Z");
  let index = 0;
  let connected: typeof device | undefined = structuredClone(device);
  const engine = {
    observe: vi.fn(async () => frames[Math.min(index++, frames.length - 1)]),
    packages: vi.fn(async () => ["com.netease.onmyoji"]),
    isAppRunning: vi.fn(async () => true),
  };
  const wait = vi.fn(async (milliseconds: number) => {
    clock += milliseconds;
  });
  return {
    engine,
    wait,
    options: {
      identity: binding,
      device: engine,
      appProcessRunning: engine.isAppRunning,
      connectedDevice: () => connected,
      now: () => clock,
      wait,
      signal: new AbortController().signal,
    },
    setConnected: (value: typeof device | undefined) => {
      connected = value;
    },
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("experimental Onmyoji identity boundary", () => {
  it("preserves opaque binding strings and rejects controls, oversized values and extra keys", () => {
    expect(
      validateOnmyojiIdentityBinding({ roleId: "role-A", serverName: "一区" }),
    ).toEqual({ roleId: "role-A", serverName: "一区" });
    for (const input of [
      null,
      { ...binding, roleId: "" },
      { ...binding, roleId: "1\n2" },
      { ...binding, roleId: "x".repeat(129) },
      { ...binding, serverName: "" },
      { ...binding, nickname: "not an ID" },
    ])
      expect(() => validateOnmyojiIdentityBinding(input)).toThrow();
    expect(validateOnmyojiConfig({})).toEqual({});
    expect(() => validateOnmyojiConfig({ identity: null })).toThrow();
    expect(() => validateOnmyojiConfig({ certified: true })).toThrow();
  });

  it("reads a whole label-associated role number and server only within a profile candidate", () => {
    expect(parseOnmyojiProfileCandidate(frame())).toEqual(binding);
    const inline = frame();
    inline.texts = [
      inline.texts[0],
      {
        text: `角色编号：${binding.roleId}`,
        box: [650, 310, 650, 40],
        score: 0.99,
      },
      {
        text: `服务器：${binding.serverName}`,
        box: [650, 410, 650, 40],
        score: 0.99,
      },
    ];
    expect(parseOnmyojiProfileCandidate(inline)).toEqual(binding);
  });

  it("never treats nickname, level, distant digits, ambiguous rows or a missing title as identity", () => {
    const samples = [frame(), frame(), frame(), frame(), frame()];
    samples[0].texts[1].text = "昵称";
    samples[1].texts[1].text = "等级";
    samples[2].texts[2].box[1] = 810;
    samples[3].texts.push({
      ...samples[3].texts[2],
      text: "999",
      box: [1050, 310, 100, 40],
    });
    samples[4].texts.shift();
    for (const sample of samples)
      expect(parseOnmyojiProfileCandidate(sample)).toBeUndefined();
  });

  it("rejects malformed OCR input and low-confidence or partially normalized numbers", () => {
    const malformed = frame();
    malformed.texts.push(null as never);
    expect(parseOnmyojiProfileCandidate(malformed)).toBeUndefined();
    const partial = frame("1,234");
    expect(parseOnmyojiProfileCandidate(partial)).toBeUndefined();
    const low = frame();
    low.texts[2].score = 0.79;
    expect(parseOnmyojiProfileCandidate(low)).toBeUndefined();
  });

  it("captures two fresh read-only frames but never certifies synthetic profile anchors", async () => {
    const h = captureHarness();
    const result = await inspectOnmyojiIdentity(h.options);
    expect(result).toMatchObject({
      status: "unknown",
      reason: "anchors-not-certified",
      certification: "experimental",
      candidateMatch: true,
      expected: binding,
      device: { adbPath: device.adbPath, address: device.address },
      packageName: "com.netease.onmyoji",
    });
    expect(result.frames).toHaveLength(2);
    expect(h.engine.observe).toHaveBeenCalledTimes(2);
    expect(h.wait).toHaveBeenCalledWith(800, expect.any(AbortSignal));
    expect(h.engine.packages).toHaveBeenCalledTimes(2);
    expect(h.engine.isAppRunning).toHaveBeenCalledTimes(2);
    expect(validOnmyojiIdentityEvidence(result)).toBe(true);
    expect(validStructuredSkillOutcome({ onmyojiIdentity: result })).toBe(true);
    const publicResult = publicOnmyojiIdentityInspection(result);
    expect(publicResult).toMatchObject({
      status: "unknown",
      configured: true,
      certified: false,
    });
    expect(JSON.stringify(publicResult)).not.toContain(binding.roleId);
    expect(JSON.stringify(publicResult)).not.toContain(binding.serverName);
  });

  it("records an exact conflicting profile candidate as mismatch without logging its ID", async () => {
    const h = captureHarness([frame("999")]);
    const result = await inspectOnmyojiIdentity(h.options);
    expect(result.status).toBe("mismatch");
    expect(result.candidateMatch).toBe(false);
    expect(validOnmyojiIdentityEvidence(result)).toBe(true);
    expect(
      JSON.stringify(publicOnmyojiIdentityInspection(result)),
    ).not.toContain("999");
  });

  it.each([
    "not-running",
    "wrong-package",
    "connection-changed",
    "missing-profile",
    "interval",
  ])("fails closed for %s", async (kind) => {
    const h = captureHarness();
    if (kind === "not-running") h.engine.isAppRunning.mockResolvedValue(false);
    if (kind === "wrong-package")
      h.engine.packages.mockResolvedValue(["com.netease.other"]);
    if (kind === "connection-changed")
      h.wait.mockImplementation(async () => {
        h.advance(800);
        h.setConnected({ ...device, address: "changed" });
      });
    if (kind === "missing-profile")
      h.engine.observe.mockResolvedValue({
        width: 1920,
        height: 1080,
        texts: [],
      });
    if (kind === "interval")
      h.wait.mockImplementation(async () => {
        h.advance(1700);
      });
    const result = await inspectOnmyojiIdentity(h.options);
    expect(result.status).toBe("unknown");
    expect(result.candidateMatch).toBe(false);
    expect(validOnmyojiIdentityEvidence(result)).toBe(true);
    if (["not-running", "wrong-package"].includes(kind))
      expect(h.engine.observe).not.toHaveBeenCalled();
  });

  it("bounds a stalled passive read to five seconds and preserves cancellation", async () => {
    vi.useFakeTimers();
    const h = captureHarness();
    h.engine.observe.mockImplementation(() => new Promise<Frame>(() => {}));
    const reading = inspectOnmyojiIdentity(h.options);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reading).toMatchObject({
      status: "unknown",
      reason: "observation-timeout",
      candidateMatch: false,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      inspectOnmyojiIdentity({ ...h.options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects manufactured matched/certified proof and inconsistent candidate claims", async () => {
    const result = await inspectOnmyojiIdentity(captureHarness().options);
    expect(validOnmyojiIdentityEvidence({ ...result, status: "matched" })).toBe(
      false,
    );
    expect(
      validOnmyojiIdentityEvidence({ ...result, certification: "certified" }),
    ).toBe(false);
    expect(
      validOnmyojiIdentityEvidence({
        ...result,
        frames: result.frames.slice(0, 1),
      }),
    ).toBe(false);
    expect(
      validStructuredSkillOutcome({
        onmyojiIdentity: { ...result, status: "matched" } as never,
      }),
    ).toBe(false);
  });

  it("freezes lane identity and refuses a changed binding while preserving legacy keys", () => {
    const lane = defaultDeviceLanes({
      managerPath: "D:/MuMu/MuMuManager.exe",
      instance: 0,
      closeEmulatorAfterSuccess: false,
    }).lanes[0];
    const before = deviceLanePlanKey(lane);
    const input = {
      version: 1,
      lanes: [{ ...lane, onmyoji: { enabled: true, identity: binding } }],
    };
    const frozen = validateDeviceLanes(input).lanes[0];
    expect(frozen.onmyoji.identity).toEqual(binding);
    binding.roleId = "changed-after-freeze";
    expect(frozen.onmyoji.identity?.roleId).toBe("12345678901234567890");
    binding.roleId = "12345678901234567890";
    expect(deviceLanePlanKey(frozen)).not.toBe(before);
    expect(deviceLanePlanKey(lane)).toBe(before);
    expect(() =>
      onmyojiLaneContract.assertBinding(
        frozen,
        {
          ...frozen,
          onmyoji: {
            ...frozen.onmyoji,
            identity: { ...binding, roleId: "other" },
          },
        },
        undefined,
        0,
      ),
    ).toThrow("身份");
  });
});
