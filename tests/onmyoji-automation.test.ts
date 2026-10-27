import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defaultDeviceLanes } from "../packages/protocol";
import { defaultArknightsProfiles } from "../games/arknights/config";

async function modules() {
  const protocol =
    await import("../packages/protocol/onmyoji-automation").catch(
      () => undefined,
    );
  const service = await import("../apps/desktop/main/onmyoji-automation").catch(
    () => undefined,
  );
  expect(protocol?.defaultOnmyojiAutomation).toBeTypeOf("function");
  expect(service?.OnmyojiAutomationService).toBeTypeOf("function");
  return { ...protocol!, ...service! };
}
function lanes() {
  return defaultDeviceLanes({
    managerPath: "D:/MuMu/MuMuManager.exe",
    instance: 2,
    closeEmulatorAfterSuccess: false,
  }).lanes.map((lane, index) => ({
    ...lane,
    id: `yys-${index}`,
    enabled: true,
    instance: index + 2,
    arknights: { ...lane.arknights, enabled: false },
    onmyoji: { ...lane.onmyoji, enabled: true },
  }));
}
it("proposes independent inert plans matching the legacy morning and weekday evening steps", async () => {
  const m = await modules();
  const config = m.defaultOnmyojiAutomation(lanes());
  expect(config.enabled).toBe(false);
  expect(config.jobs).toHaveLength(lanes().length * 2);
  expect(config.jobs[0]).toMatchObject({
    time: "09:00",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    skillIds: [
      "login",
      "check-in",
      "mail",
      "daily-gift",
      "guild-kirin",
      "realm-raid",
      "hana-claim",
    ],
  });
  expect(config.jobs[1]).toMatchObject({
    time: "20:30",
    weekdays: [1, 2, 3, 4],
    skillIds: ["login", "guild-kirin", "hana-claim"],
  });
  expect(() =>
    m.validateOnmyojiAutomation({
      ...config,
      jobs: [{ ...config.jobs[0], skillIds: ["fight"] }],
    }),
  ).toThrow();
});
it("freezes only the chosen onmyoji steps and device without changing saved lanes", async () => {
  const m = await modules();
  const account = lanes()[0];
  const original = structuredClone(account);
  const job = m.defaultOnmyojiAutomation([account]).jobs[1];
  const frozen = m.freezeOnmyojiJob(
    account,
    defaultArknightsProfiles,
    job,
    new Date(2026, 9, 27, 20, 30),
  );
  expect(frozen.arknightsPlan).toBeUndefined();
  expect(frozen.onmyojiPlan?.skillIds).toEqual(job.skillIds);
  expect(account).toEqual(original);
  expect(() =>
    m.freezeOnmyojiJob(
      { ...account, enabled: false },
      defaultArknightsProfiles,
      job,
    ),
  ).toThrow(/渠道/);
});
it("cuts over atomically without replaying past morning, preserves claims across restart and permits future evening", async () => {
  const m = await modules();
  const config = m.defaultOnmyojiAutomation(lanes());
  const dir = await mkdtemp(join(tmpdir(), "gp-yys-schedule-"));
  const store = new m.OnmyojiAutomationStore(
    join(dir, "schedule.json"),
    config,
  );
  const run = vi.fn(async (_job, _due, _signal, requestId) => ({
    batchId: requestId,
    completion: Promise.resolve({ status: "succeeded" as const }),
  }));
  let now = new Date(2026, 9, 27, 12);
  const service = new m.OnmyojiAutomationService({
    store,
    run,
    now: () => now,
  });
  await service.enableWithCutover();
  await service.enableWithCutover();
  await service.tick();
  expect(run).not.toHaveBeenCalled();
  expect((await service.state()).runs).toHaveLength(lanes().length);
  expect(
    (await service.state()).runs.every(
      (item) => item.status === "skipped" && !item.batchId,
    ),
  ).toBe(true);
  const restarted = new m.OnmyojiAutomationService({
    store,
    run,
    now: () => now,
  });
  await restarted.tick();
  expect(run).not.toHaveBeenCalled();
  now = new Date(2026, 9, 27, 20, 30);
  await restarted.tick();
  expect(run).toHaveBeenCalledTimes(lanes().length);
  expect(run.mock.calls[0][3]).toMatch(/^yys-auto-/);
  await restarted.tick();
  expect(run).toHaveBeenCalledTimes(lanes().length);
});

it("applies the same cutover to the first UI enable/save", async () => {
  const m = await modules();
  const config = m.defaultOnmyojiAutomation(lanes());
  const store = new m.OnmyojiAutomationStore(
    join(await mkdtemp(join(tmpdir(), "gp-yys-ui-enable-")), "schedule.json"),
    config,
  );
  const run = vi.fn();
  const service = new m.OnmyojiAutomationService({
    store,
    run,
    now: () => new Date(2026, 9, 27, 12),
  });
  await service.save({ ...config, enabled: true });
  await service.tick();
  expect(run).not.toHaveBeenCalled();
  expect(
    (await service.state()).runs.every((item) => item.status === "skipped"),
  ).toBe(true);
});
