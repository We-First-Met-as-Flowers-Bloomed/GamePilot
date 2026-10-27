import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameDevice } from "../packages/runtime/device";
import type { Plan, SkillResult } from "../packages/protocol";
import { createOnmyojiWorkerAdapter } from "../games/onmyoji/worker-adapter";
import { validOnmyojiIdentityEvidence } from "../packages/protocol/onmyoji-identity";
import profile from "./fixtures/onmyoji/own-settings-a-20261027.json";
const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  mail: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("../games/onmyoji/daily", () => ({
  OnmyojiDaily: class {
    login = mocks.login;
    mail = mocks.mail;
    prepareIdentityCourtyard = mocks.prepare;
  },
}));
afterEach(() => vi.clearAllMocks());
const plan: Plan = {
  gameId: "onmyoji",
  skillIds: ["login", "mail"],
  mode: "live",
};
const bound = {
  name: "fixture",
  adbPath: "D:/fixture/adb.exe",
  address: "fixture:1",
};
const binding = { roleId: "106123456", serverName: "local-server" };
function engine() {
  return {
    observe: vi.fn(async () => ({ width: 1920, height: 1080, texts: [] })),
    packages: vi.fn(async () => ["com.netease.onmyoji"]),
    isAppRunning: vi.fn(async () => true),
    click: vi.fn(),
    startApp: vi.fn(),
  } as unknown as GameDevice;
}

describe("Onmyoji worker identity admission", () => {
  it("keeps unbound legacy login compatible but explicitly stores no identity proof", async () => {
    mocks.login.mockResolvedValue({ status: "succeeded", summary: "legacy" });
    const device = engine();
    const adapter = createOnmyojiWorkerAdapter(async () => device);
    adapter.validate(plan);
    const result = await adapter.run(
      "login",
      new AbortController().signal,
      vi.fn(),
      plan,
    );
    expect(mocks.login).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      summary: "legacy",
      onmyojiIdentity: { status: "unconfigured", candidateMatch: false },
    });
    expect(
      validOnmyojiIdentityEvidence((result as SkillResult).onmyojiIdentity),
    ).toBe(true);
    expect(device.observe).not.toHaveBeenCalled();
  });

  it.each(["login", "mail"])(
    "blocks bound %s without UID proof and retains the actual evidence",
    async (skillId) => {
      const device = engine();
      let clock = Date.parse("2026-10-11T12:00:00Z");
      const log = vi.fn();
      const adapter = createOnmyojiWorkerAdapter(async () => device, {
        config: () => ({ identity: binding }),
        connectedDevice: () => bound,
        appProcessRunning: async () => true,
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      });
      adapter.validate(plan);
      await expect(
        adapter.run(skillId, new AbortController().signal, log, plan),
      ).rejects.toThrow("UID 核验未通过");
      expect(mocks.login).toHaveBeenCalledTimes(skillId === "login" ? 1 : 0);
      expect(mocks.mail).not.toHaveBeenCalled();
      expect(device.click).not.toHaveBeenCalled();
      expect(device.startApp).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.any(String), {
        onmyojiIdentity: expect.objectContaining({
          status: "unknown",
          expected: binding,
        }),
      });
      expect(
        log.mock.calls.map(([message]) => message).join(" "),
      ).not.toContain(binding.roleId);
    },
  );

  it("freezes the admitted identity before the caller can change its config", async () => {
    const device = engine();
    const config = { identity: { ...binding } };
    let clock = Date.parse("2026-10-11T12:00:00Z");
    const adapter = createOnmyojiWorkerAdapter(async () => device, {
      config: () => config,
      connectedDevice: () => bound,
      appProcessRunning: async () => true,
      now: () => clock,
      wait: async (milliseconds) => {
        clock += milliseconds;
      },
    });
    adapter.validate(plan);
    config.identity.roleId = "changed";
    const log = vi.fn();
    await expect(
      adapter.run("login", new AbortController().signal, log, plan),
    ).rejects.toThrow();
    expect(log).toHaveBeenCalledWith(expect.any(String), {
      onmyojiIdentity: expect.objectContaining({ expected: binding }),
    });
  });

  it.each(["login", "mail"])(
    "allows bound %s only after the real profile UID and courtyard return",
    async (skillId) => {
      const device = engine();
      const home = {
        width: 1920,
        height: 1080,
        texts: [
          { text: "测试角色", box: [194, 45, 126, 36], score: 0.99 },
          { text: "加成", box: [550, 55, 32, 56], score: 0.99 },
          { text: "召唤", box: [1578, 262, 60, 107], score: 0.99 },
        ],
      };
      const frames = [home, home, profile, profile, home, home];
      let index = 0,
        clock = Date.parse("2026-10-27T11:00:00Z");
      vi.mocked(device.observe).mockImplementation(
        async () =>
          structuredClone(
            frames[Math.min(index++, frames.length - 1)],
          ) as never,
      );
      mocks.login.mockResolvedValue({
        status: "succeeded",
        summary: "legacy login",
      });
      mocks.mail.mockResolvedValue({
        status: "succeeded",
        summary: "mail checked",
      });
      const adapter = createOnmyojiWorkerAdapter(async () => device, {
        config: () => ({ identity: binding }),
        connectedDevice: () => bound,
        appProcessRunning: async () => true,
        now: () => clock,
        wait: async (ms) => {
          clock += ms;
        },
      });
      adapter.validate(plan);
      const result = (await adapter.run(
        skillId,
        new AbortController().signal,
        vi.fn(),
        plan,
      )) as SkillResult;
      expect(result.onmyojiIdentity).toMatchObject({
        status: "matched",
        certification: "profile-uid-v1",
      });
      expect(validOnmyojiIdentityEvidence(result.onmyojiIdentity)).toBe(true);
      expect(mocks.mail).toHaveBeenCalledTimes(skillId === "mail" ? 1 : 0);
      if (skillId === "login") expect(result.summary).toContain("UID");
    },
  );
});
