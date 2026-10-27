import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeCopilotPlan,
  readLiveCopilotBox,
} from "../games/arknights/copilot-run";
import {
  CopilotService,
  copilotPlanDigest,
} from "../apps/desktop/main/copilot-service";
import { cacheCopilotJob } from "../games/arknights/copilot-library";
import { validateCopilotJob } from "../games/arknights/copilot-policy";
import { defaultArknightsConfig } from "../games/arknights/config";
import type { SkillResult } from "../packages/protocol";
import { validArknightsEvidence } from "../games/arknights/evidence";
const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
const uid = "12345678",
  device = {
    name: "fixture",
    adbPath: "D:/fixture/adb.exe",
    address: "fixture:1",
  };
const cb = (
  code: number,
  chain: string,
  id: number,
  what?: string,
  details?: unknown,
) =>
  `MAA ${code}: ${JSON.stringify({ taskchain: chain, taskid: id, ...(what ? { what, details } : {}) })}`;
function loginResult(): SkillResult {
  const at = new Date().toISOString();
  return {
    status: "succeeded",
    arknights: {
      version: 1,
      taskType: "StartUp",
      submission: "submitted",
      completion: "native-confirmed",
      observedAt: at,
      taskId: 1,
      login: {
        expectedUid: uid,
        observedUid: uid,
        observedAt: at,
        home: true,
        method: "profile",
        homeObservedAt: at,
      },
    },
  };
}
async function harness(requirements = { elite: 0, level: 1 }) {
  const cacheDir = mkdtempSync(join(tmpdir(), "gp-copilot-run-"));
  dirs.push(cacheDir);
  const job = validateCopilotJob({
    stage_name: "stage_go_8",
    minimum_required: "v6.7.0",
    opers: [{ name: "先锋", skill: 1, requirements }],
    actions: [{ type: "SkillDaemon" }],
  });
  const summary = {
      id: 1001,
      stageName: "stage_go_8",
      title: "fixture",
      uploader: "",
      uploadTime: "",
    },
    entry = cacheCopilotJob(cacheDir, summary, job);
  const service = new CopilotService({
    cacheDir,
    account: () => ({
      profileId: "account-A",
      expectedUid: uid,
      clientType: "Official",
      revision: "a1",
    }),
    revision: () => "r1",
    resolveStage: () => ({
      id: "stage_go_8",
      code: "GO-8",
      aliases: ["stage_go_8"],
    }),
    pick: async () => ({ ...entry, summary, job }),
    execute: async () => {},
  });
  const prepared = await service.prepare({
    profileId: "account-A",
    stage: "GO-8",
    count: 2,
    skipStory: true,
  });
  const config = { ...defaultArknightsConfig, stage: "LS-6", expectedUid: uid };
  const core = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    runTask: vi.fn(
      async (
        type: string,
        params: Record<string, unknown>,
        _signal: AbortSignal,
        log: (s: string) => void,
      ) => {
        const id = type === "OperBox" ? 11 : 7;
        log(cb(10001, type, id));
        if (type === "OperBox")
          log(
            cb(20003, type, id, "OperBoxInfo", {
              done: true,
              own_opers: [
                {
                  name: "先锋",
                  own: true,
                  elite: requirements.elite,
                  level: 1,
                },
              ],
            }),
          );
        else
          for (const [index, j] of prepared.jobs.entries()) {
            log(
              cb(20003, type, id, "CopilotListLoadTaskFileSuccess", {
                id: index,
                file_name: j.file,
                stage_name: j.stageName,
              }),
            );
            const details = {
              task: "Copilot@StageDrops-Stars-3",
              exec_times: index + 1,
              algorithm: "MatchTemplate",
              action: "DoNothing",
              result: { score: 0.99 },
            };
            log(cb(20000, type, id, "ProcessTask", details));
            log(cb(20002, type, id, "ProcessTask", details));
          }
        log(cb(10002, type, id));
      },
    ),
  };
  const login = vi.fn(async () => loginResult()),
    log = vi.fn();
  const options = {
    prepared,
    cacheDir,
    config,
    device,
    signal: new AbortController().signal,
    createCore: () => core,
    login,
    log,
    checkReady: async () => {},
  };
  return { options, core, login, log, entry, prepared };
}
describe("bounded temporary native Copilot run", () => {
  it("runs fresh login/UID, live box, explicit fixed list, paired victories and bounded home+UID checks without saved config edits", async () => {
    const h = await harness(),
      before = JSON.stringify(h.options.config);
    const result = await executeCopilotPlan(h.options);
    expect(result).toMatchObject({
      status: "succeeded",
      arknights: {
        taskType: "Copilot",
        completion: "native-confirmed",
        copilot: { plannedRuns: 2, settlements: [{ stars: 3 }, { stars: 3 }] },
      },
    });
    expect(result.arknights?.copilot).toMatchObject({
      verification: {
        planHash: h.prepared.planHash,
        expectedUid: uid,
        before: {
          taskId: 1,
          expectedUid: uid,
          observedUid: uid,
          method: "profile",
          home: true,
          observedAt: expect.any(String),
          homeObservedAt: expect.any(String),
        },
        after: {
          taskId: 1,
          expectedUid: uid,
          observedUid: uid,
          method: "profile",
          home: true,
          observedAt: expect.any(String),
          homeObservedAt: expect.any(String),
        },
        submittedAt: expect.any(String),
        completedAt: expect.any(String),
      },
    });
    expect(validArknightsEvidence(result.arknights)).toBe(true);
    // Intermediate persisted logs cannot claim completion before post-home verification.
    const pending = h.log.mock.calls
      .map((call) => call[1]?.arknights)
      .filter((e) => e?.taskType === "Copilot");
    expect(pending.length).toBeGreaterThan(0);
    expect(
      pending.every(
        (e) => e!.completion === "unknown" && validArknightsEvidence(e),
      ),
    ).toBe(true);
    expect(h.login).toHaveBeenCalledTimes(3);
    expect(h.core.runTask.mock.calls.map((c) => c[0])).toEqual([
      "OperBox",
      "Copilot",
    ]);
    const params = h.core.runTask.mock.calls[1][1];
    expect(params).toMatchObject({
      copilot_list: [
        {
          id: 0,
          filename: h.entry.file,
          nav_name_override: "GO-8",
          is_raid: false,
        },
        {
          id: 1,
          filename: h.entry.file,
          nav_name_override: "GO-8",
          is_raid: false,
        },
      ],
      use_sanity_potion: false,
      formation: true,
      ignore_requirements: false,
      support_unit_usage: 0,
    });
    expect(params).not.toHaveProperty("filename");
    expect(params).not.toHaveProperty("loop_times");
    expect(JSON.stringify(h.options.config)).toBe(before);
  });
  it.each([
    "wrong-uid",
    "old-login",
    "normalization-failed",
    "hash",
    "expired",
    "version",
  ])("refuses %s before any native battle submission", async (kind) => {
    const h = await harness();
    if (kind === "wrong-uid")
      h.login.mockResolvedValue({
        ...loginResult(),
        arknights: {
          ...loginResult().arknights!,
          login: {
            ...loginResult().arknights!.login!,
            observedUid: "99999999",
          },
        },
      });
    if (kind === "old-login")
      h.login.mockResolvedValue({
        ...loginResult(),
        arknights: {
          ...loginResult().arknights!,
          login: {
            ...loginResult().arknights!.login!,
            observedAt: "2000-01-01T00:00:00.000Z",
            homeObservedAt: "2000-01-01T00:00:00.000Z",
          },
        },
      });
    if (kind === "normalization-failed")
      h.login.mockRejectedValue(
        Error("native StartUp could not normalize deep map"),
      );
    if (kind === "hash") writeFileSync(h.entry.file, "corrupt");
    if (kind === "expired") {
      h.prepared.expiresAt = "2000-01-01T00:00:00.000Z";
      h.prepared.planHash = copilotPlanDigest(h.prepared);
    }
    if (kind === "version") h.prepared.version = 2 as never;
    await expect(executeCopilotPlan(h.options)).rejects.toThrow();
    expect(h.core.runTask).not.toHaveBeenCalled();
  });
  it("does not invent mastery/module data unavailable in the pinned native box", async () => {
    const h = await harness({ elite: 1, level: 1, skill_level: 7 } as never);
    await expect(executeCopilotPlan(h.options)).rejects.toThrow(
      /预检|专精|技能/,
    );
    expect(h.core.runTask.mock.calls.map((c) => c[0])).toEqual(["OperBox"]);
  });
  it("chain completion without settlement remains unknown and publishes evidence; no retries or post-battle navigation", async () => {
    const h = await harness();
    const original = h.core.runTask.getMockImplementation()!;
    h.core.runTask.mockImplementation(async (type, params, signal, log) => {
      if (type === "OperBox") return original(type, params, signal, log);
      log(cb(10001, type, 7));
      log(cb(10002, type, 7));
    });
    await expect(executeCopilotPlan(h.options)).rejects.toThrow(/未知|结算/);
    expect(h.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arknights: expect.objectContaining({
          taskType: "Copilot",
          submission: "submitted",
          completion: "unknown",
        }),
      }),
    );
    expect(h.core.runTask).toHaveBeenCalledTimes(2);
    expect(h.login).toHaveBeenCalledTimes(2);
  });
  it("keeps observed victories but marks the overall result unknown if post-battle native home/UID fails", async () => {
    const h = await harness();
    h.login
      .mockImplementationOnce(async () => loginResult())
      .mockImplementationOnce(async () => loginResult())
      .mockRejectedValueOnce(Error("post UID unavailable"));
    await expect(executeCopilotPlan(h.options)).rejects.toThrow("post UID");
    expect(h.log).toHaveBeenCalledWith(expect.any(String), {
      arknights: expect.objectContaining({
        completion: "unknown",
        copilot: expect.objectContaining({
          settlements: [
            expect.objectContaining({ stars: 3 }),
            expect.objectContaining({ stars: 3 }),
          ],
        }),
      }),
    });
    const failed = h.log.mock.calls.at(-1)?.[1]?.arknights;
    expect(failed?.copilot?.verification).toMatchObject({
      planHash: h.prepared.planHash,
      expectedUid: uid,
      before: { observedUid: uid, method: "profile", home: true },
      submittedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(failed?.copilot?.verification).not.toHaveProperty("after");
    expect(validArknightsEvidence(failed)).toBe(true);
    expect(h.core.runTask).toHaveBeenCalledTimes(2);
  });
  it("closes the core and retains submitted unknown evidence when native execution throws", async () => {
    const h = await harness();
    const original = h.core.runTask.getMockImplementation()!;
    h.core.runTask.mockImplementation(async (type, params, signal, log) => {
      if (type === "OperBox") return original(type, params, signal, log);
      log(cb(10001, type, 7));
      throw Error("lost connection after submission");
    });
    await expect(executeCopilotPlan(h.options)).rejects.toThrow(
      "lost connection",
    );
    expect(h.core.close).toHaveBeenCalledTimes(2);
    expect(h.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arknights: expect.objectContaining({
          taskType: "Copilot",
          completion: "unknown",
        }),
      }),
    );
  });
  it.each([
    { elite: 2, level: 1, skill_level: 10 },
    { elite: 2, level: 1, module: 1 },
  ])(
    "blocks an unavailable native mastery/module requirement before battle: %j",
    async (requirements) => {
      const h = await harness(requirements);
      await expect(executeCopilotPlan(h.options)).rejects.toThrow(
        /预检|专精|技能|模组/,
      );
      expect(h.core.runTask.mock.calls.map((c) => c[0])).toEqual(["OperBox"]);
    },
  );
  it.each(["missing", "insufficient"])(
    "blocks a live %s ownership/level check before battle",
    async (kind) => {
      const h = await harness({
        elite: 0,
        level: kind === "insufficient" ? 2 : 1,
      });
      h.core.runTask.mockImplementation(async (type, _params, _signal, log) => {
        log(cb(10001, type, 11));
        log(
          cb(20003, type, 11, "OperBoxInfo", {
            done: true,
            own_opers: [
              {
                name: kind === "missing" ? "其他干员" : "先锋",
                own: true,
                elite: 0,
                level: 1,
              },
            ],
          }),
        );
        log(cb(10002, type, 11));
      });
      await expect(executeCopilotPlan(h.options)).rejects.toThrow(/预检/);
      expect(h.core.runTask.mock.calls.map((c) => c[0])).toEqual(["OperBox"]);
    },
  );
  it("rechecks frozen bytes after asynchronous connection immediately before native submission", async () => {
    const h = await harness();
    h.core.connect.mockImplementationOnce(async () => {
      writeFileSync(h.entry.file, "changed while connecting");
    });
    await expect(executeCopilotPlan(h.options)).rejects.toThrow(/哈希/);
    expect(h.core.runTask).not.toHaveBeenCalled();
    expect(h.core.close).toHaveBeenCalledOnce();
  });
  it("honors cancellation during native submission and retains unknown proof without retry or home claims", async () => {
    const h = await harness(),
      controller = new AbortController(),
      original = h.core.runTask.getMockImplementation()!;
    h.options.signal = controller.signal;
    h.core.runTask.mockImplementation(async (type, params, signal, log) => {
      if (type === "OperBox") return original(type, params, signal, log);
      log(cb(10001, type, 7));
      controller.abort();
      signal.throwIfAborted();
    });
    await expect(executeCopilotPlan(h.options)).rejects.toThrow();
    expect(h.core.runTask).toHaveBeenCalledTimes(2);
    expect(h.core.close).toHaveBeenCalledTimes(2);
    expect(h.login).toHaveBeenCalledTimes(2);
    expect(h.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arknights: expect.objectContaining({
          taskType: "Copilot",
          submission: "submitted",
          completion: "unknown",
        }),
      }),
    );
  });
  it("honors cancellation while connecting before any native submission", async () => {
    const h = await harness(),
      controller = new AbortController();
    h.options.signal = controller.signal;
    h.core.connect.mockImplementationOnce(async () => {
      controller.abort();
    });
    await expect(executeCopilotPlan(h.options)).rejects.toThrow();
    expect(h.core.runTask).not.toHaveBeenCalled();
    expect(h.core.close).toHaveBeenCalledOnce();
    expect(h.log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        arknights: expect.objectContaining({
          submission: "not-submitted",
          completion: "not-started",
        }),
      }),
    );
  });
  it.each(["stale-home", "missing-home", "missing-native"])(
    "never claims home after observed victories with %s post-login proof",
    async (kind) => {
      const h = await harness();
      h.login
        .mockImplementationOnce(async () => loginResult())
        .mockImplementationOnce(async () => loginResult())
        .mockImplementationOnce(async () => {
          const result = loginResult(),
            e = result.arknights!;
          if (kind === "stale-home")
            e.login!.homeObservedAt = "2000-01-01T00:00:00.000Z";
          if (kind === "missing-home") delete e.login!.homeObservedAt;
          if (kind === "missing-native") e.completion = "unknown";
          return result;
        });
      await expect(executeCopilotPlan(h.options)).rejects.toThrow(/主页核验/);
      expect(h.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          arknights: expect.objectContaining({
            taskType: "Copilot",
            completion: "unknown",
            copilot: expect.objectContaining({
              settlements: expect.any(Array),
            }),
          }),
        }),
      );
      expect(h.core.runTask).toHaveBeenCalledTimes(2);
    },
  );
  it("extracts only final own/elite/level fields from matching native OperBox callbacks", () => {
    const messages = [
      cb(10001, "OperBox", 11),
      cb(20003, "OperBox", 11, "OperBoxInfo", {
        done: true,
        own_opers: [
          {
            name: "先锋",
            own: true,
            elite: 2,
            level: 90,
            skill_level: 10,
            module: 4,
          },
        ],
      }),
      cb(10002, "OperBox", 11),
    ];
    expect(readLiveCopilotBox(messages)).toEqual([
      { name: "先锋", owned: true, elite: 2, level: 90 },
    ]);
    expect(() => readLiveCopilotBox(messages.slice(0, -1))).toThrow();
    expect(() =>
      readLiveCopilotBox([
        cb(10001, "OperBox", 11),
        cb(20003, "OperBox", 12, "OperBoxInfo", { done: true, own_opers: [] }),
        cb(10002, "OperBox", 11),
      ]),
    ).toThrow();
  });
});
