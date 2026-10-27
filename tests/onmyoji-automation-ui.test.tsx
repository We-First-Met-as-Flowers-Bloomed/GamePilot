import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { DesktopAPI } from "../packages/protocol";
import type { OnmyojiAutomationConfig } from "../packages/protocol/onmyoji-automation";
import Automation, {
  ArknightsAutomationControls as Controls,
} from "../apps/desktop/renderer/components/ArknightsAutomation";
it("edits both onmyoji accounts independently with the shared editor and submits only saved job IDs", async () => {
  const m =
    await import("../apps/desktop/renderer/hooks/useGameAutomation").catch(
      () => undefined,
    );
  expect(m?.createGameAutomationController).toBeTypeOf("function");
  const config: OnmyojiAutomationConfig = {
    version: 1,
    enabled: true,
    jobs: ["yys-a", "yys-b"].map((laneId, index) => ({
      id: `job-${index}`,
      laneId,
      name: laneId,
      enabled: true,
      time: "09:00",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      skillIds: ["login", "mail", "hana-claim"],
      catchUp: true,
    })),
  };
  const api = {
    onmyojiAutomation: vi.fn(async () => config),
    saveOnmyojiAutomation: vi.fn(async (input) => input),
    runOnmyojiJob: vi.fn(async () => ({ batchId: "receipt" })),
    arknightsAutomation: vi.fn(),
  };
  const c = m!.createGameAutomationController(
    api as unknown as DesktopAPI,
    "onmyoji",
  );
  await c.load();
  c.patchJob("yys-a", "job-0", { time: "10:15" });
  c.patchJob("yys-b", "job-1", { weekdays: [1, 2, 3, 4] });
  await c.runNow("yys-a", "job-0");
  expect(api.runOnmyojiJob).not.toHaveBeenCalled();
  await c.save();
  await c.runNow("yys-a", "job-0");
  expect(api.saveOnmyojiAutomation.mock.calls[0][0].jobs[1].weekdays).toEqual([
    1, 2, 3, 4,
  ]);
  expect(api.runOnmyojiJob).toHaveBeenCalledWith({ jobId: "job-0" });
  expect(api.arknightsAutomation).not.toHaveBeenCalled();
  const controller = { ...c, ...c.getSnapshot() };
  const html = renderToStaticMarkup(
    createElement(Automation, {
      controller,
      laneId: "yys-a",
      laneName: "阴阳师一",
      onOpenSettings: () => {},
    }),
  );
  expect(html).toContain("地域鬼王");
  expect(html).toContain("邮件附件");
  expect(html).not.toContain("公开招募");
  expect(
    renderToStaticMarkup(createElement(Controls, { controller })),
  ).toContain("阴阳师自动计划");
});
