import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ArknightsAutomation, {
  ArknightsAutomationControls,
  createArknightsAutomationController,
} from "../apps/desktop/renderer/components/ArknightsAutomation";
import type { DesktopAPI } from "../packages/protocol";
import type { ArknightsAutomationConfig } from "../packages/protocol/arknights-automation";
import { OnmyojiScheduleSettings } from "../apps/desktop/renderer/components/AutomationSettings";

const configuration = (): ArknightsAutomationConfig => ({
  version: 1,
  enabled: false,
  jobs: ["account-a", "account-b"].map((laneId, index) => ({
    id: `job-${index}`,
    name: `计划${index + 1}`,
    laneId,
    enabled: true,
    time: "08:00",
    weekdays: [1, 2, 3, 4, 5],
    skillIds: ["login", "fight", "award"],
    catchUp: true,
  })),
});

function fixture() {
  const api = {
    arknightsAutomation: vi.fn(async () => configuration()),
    saveArknightsAutomation: vi.fn(async (value: ArknightsAutomationConfig) =>
      structuredClone(value),
    ),
    runArknightsJob: vi.fn(async () => ({ batchId: "batch-fixture" })),
  };
  return {
    api,
    controller: createArknightsAutomationController(
      api as unknown as DesktopAPI,
    ),
  };
}

describe("Arknights account automation editor", () => {
  it("keeps the configuration absent until loaded and supports old desktop APIs", async () => {
    const { controller } = fixture();
    expect(controller.getSnapshot().loaded).toBe(false);
    expect(controller.getSnapshot().config).toBeUndefined();
    const legacy = createArknightsAutomationController({} as DesktopAPI);
    await legacy.load();
    expect(legacy.getSnapshot().available).toBe(false);
    expect(legacy.getSnapshot().config).toBeUndefined();
  });

  it("preserves edits to both accounts when either account changes", async () => {
    const { controller, api } = fixture();
    await controller.load();
    controller.patchJob("account-a", "job-0", {
      time: "09:30",
      weekdays: [0, 6],
    });
    controller.patchJob("account-b", "job-1", {
      skillIds: ["login", "recruit", "award"],
      catchUp: false,
    });
    controller.patchJob("account-a", "job-1", { time: "01:00" });
    await controller.save();
    expect(api.saveArknightsAutomation.mock.calls[0][0].jobs).toEqual([
      { ...configuration().jobs[0], time: "09:30", weekdays: [0, 6] },
      {
        ...configuration().jobs[1],
        skillIds: ["login", "recruit", "award"],
        catchUp: false,
      },
    ]);
    expect(controller.getSnapshot().dirty).toBe(false);
  });

  it("requires saved changes before running and allows manual runs with scheduling disabled", async () => {
    const { controller, api } = fixture();
    await controller.load();
    controller.patchJob("account-a", "job-0", { time: "10:00" });
    await controller.runNow("account-a", "job-0");
    expect(api.runArknightsJob).not.toHaveBeenCalled();
    expect(controller.getSnapshot().message).toContain("先保存");
    await controller.save();
    await controller.runNow("account-a", "job-0");
    expect(api.runArknightsJob).toHaveBeenCalledWith({ jobId: "job-0" });
    await controller.runNow("account-b", "job-0");
    expect(api.runArknightsJob).toHaveBeenCalledTimes(1);
  });

  it("adds and deletes independent jobs without enabling global scheduling", async () => {
    const { controller } = fixture();
    await controller.load();
    controller.addJob("account-a", "方舟A");
    controller.addJob("account-a", "方舟A");
    const added = controller.getSnapshot().config!.jobs.slice(2);
    expect(added).toHaveLength(2);
    expect(added[0].id).not.toBe(added[1].id);
    expect(added.every((job) => job.laneId === "account-a")).toBe(true);
    expect(added[0].skillIds).toEqual([
      "login",
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ]);
    expect(controller.getSnapshot().config!.enabled).toBe(false);
    controller.removeJob("account-b", added[0].id);
    expect(controller.getSnapshot().config!.jobs).toHaveLength(4);
    controller.removeJob("account-a", added[0].id);
    expect(controller.getSnapshot().config!.jobs).toHaveLength(3);
    controller.setEnabled(true);
    expect(controller.getSnapshot().config!.enabled).toBe(true);
    expect(controller.getSnapshot().config!.jobs[1]).toEqual(
      configuration().jobs[1],
    );
  });

  it("keeps invalid drafts editable and prevents saving an empty weekday or step selection", async () => {
    const { controller, api } = fixture();
    await controller.load();
    controller.patchJob("account-a", "job-0", { weekdays: [] });
    await controller.save();
    expect(api.saveArknightsAutomation).not.toHaveBeenCalled();
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.getSnapshot().message).toContain("星期");
    controller.patchJob("account-a", "job-0", { weekdays: [1], skillIds: [] });
    await controller.save();
    expect(api.saveArknightsAutomation).not.toHaveBeenCalled();
    expect(controller.getSnapshot().message).toContain("步骤");
  });

  it("keeps a failed load inert and exposes a retry", async () => {
    const { controller, api } = fixture();
    api.arknightsAutomation.mockRejectedValueOnce(Error("读取失败"));
    await controller.load();
    expect(controller.getSnapshot()).toMatchObject({
      loaded: false,
      config: undefined,
      message: "读取失败",
    });
    await controller.load();
    expect(controller.getSnapshot().loaded).toBe(true);
  });

  it("retains unsaved edits after a failed save and keeps run disabled", async () => {
    const { controller, api } = fixture();
    await controller.load();
    controller.patchJob("account-a", "job-0", { time: "12:30" });
    api.saveArknightsAutomation.mockRejectedValueOnce(Error("写入失败"));
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      dirty: true,
      error: true,
      message: "写入失败",
    });
    expect(controller.getSnapshot().config!.jobs[0].time).toBe("12:30");
    await controller.runNow("account-a", "job-0");
    expect(api.runArknightsJob).not.toHaveBeenCalled();
  });

  it("locks all account edits and run requests while a save is pending", async () => {
    const { controller, api } = fixture();
    await controller.load();
    controller.patchJob("account-a", "job-0", { time: "12:30" });
    let finish!: (value: ArknightsAutomationConfig) => void;
    api.saveArknightsAutomation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = controller.save();
    const submitted = structuredClone(
      api.saveArknightsAutomation.mock.calls[0][0],
    );
    expect(controller.getSnapshot().busy).toBe(true);
    controller.patchJob("account-b", "job-1", { time: "22:00" });
    controller.removeJob("account-a", "job-0");
    await controller.runNow("account-b", "job-1");
    expect(api.runArknightsJob).not.toHaveBeenCalled();
    finish(submitted);
    await saving;
    expect(controller.getSnapshot().config).toEqual(submitted);
    expect(controller.getSnapshot()).toMatchObject({
      busy: false,
      dirty: false,
    });
  });

  it("renders only the selected account and blocks run while any draft is unsaved", async () => {
    const { controller } = fixture();
    await controller.load();
    controller.patchJob("account-b", "job-1", { name: "账号B的修改" });
    const value = { ...controller.getSnapshot(), ...controller };
    const html = renderToStaticMarkup(
      createElement(ArknightsAutomation, {
        laneId: "account-a",
        laneName: "方舟A",
        controller: value,
        onOpenSettings() {},
      }),
    );
    expect(html).toContain("计划1");
    expect(html).not.toContain("账号B的修改");
    expect(html).toMatch(/disabled=""[^>]*>[^<]*立即运行/);
    expect(html).toContain("星期");
    expect(html).toContain("错过后当天补跑");
    expect(html).toContain("高级任务");
    expect(html).toContain("录像识别");
    expect(html).toContain("活动小游戏");
    expect(html).toContain("干员养成");
    expect(html).toContain("需先配置账号参数");
    const controls = renderToStaticMarkup(
      createElement(ArknightsAutomationControls, { controller: value }),
    );
    expect(controls).toContain('aria-label="启用方舟自动计划"');
    expect(controls).toContain("保存自动计划");
  });

  it("separates the legacy Onmyoji schedule from account-specific Arknights plans", () => {
    const html = renderToStaticMarkup(
      createElement(OnmyojiScheduleSettings, {
        enabled: true,
        time: "10:00",
        disabled: false,
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain("阴阳师每天定时执行");
    expect(html).toContain("明日方舟自动计划请在每日任务页按账号编辑");
    expect(html).not.toContain("第二轮");
    expect(html.match(/type="time"/g)).toHaveLength(1);
  });
});
