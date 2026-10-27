import { expect, it } from "vitest";
import * as patches from "../games/arknights/maa-startup-patch.mjs";

it("cancels only the observed base exit dialog within native infrastructure navigation", () => {
  const tasks = {
    InfrastBegin: {
      next: ["Infrast", "InfrastEnteredFlag", "Infrast@ReturnButtons#next"],
    },
    StartUp: { next: ["Home"] },
  };
  const result = patches.patchInfrastructureNavigation(tasks);
  expect(result.InfrastBegin.next[0]).toBe("GamePilotInfrastStay");
  expect(result.GamePilotInfrastStay).toMatchObject({
    algorithm: "OcrDetect",
    text: ["是否确认离开罗德岛基建"],
    roi: [440, 280, 410, 90],
    action: "ClickRect",
    specificRect: [425, 480, 30, 30],
    maxTimes: 3,
    exceededNext: ["InfrastEnteredFlag"],
    next: ["InfrastBegin#next"],
  });
  expect(result.StartUp).toEqual(tasks.StartUp);
  expect(tasks.InfrastBegin.next[0]).toBe("Infrast");
  expect(patches.patchInfrastructureNavigation(result)).toEqual(result);
});
it("refuses upstream navigation without an observable base state", () => {
  expect(() =>
    patches.patchInfrastructureNavigation({
      InfrastBegin: { next: ["Changed"] },
    }),
  ).toThrow("基建");
});
