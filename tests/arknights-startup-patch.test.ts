import { expect, it } from "vitest";
import { patchStartupAnnouncements } from "../games/arknights/maa-startup-patch.mjs";

it("extends only the known announcement chain and leaves task parameters intact", () => {
  const tasks = {
    CloseAnnos: {
      algorithm: "JustReturn",
      next: ["CloseAnno", "TodaysSupplies"],
    },
    StartUp: { next: ["StartUp@CloseAnnos#next"] },
    Fight: { medicine: 0 },
  };
  const patched = patchStartupAnnouncements(tasks);
  expect(patched.CloseAnnos.next).toEqual([
    "GamePilotMooncakeAnnouncement",
    "CloseAnno",
    "TodaysSupplies",
  ]);
  expect(patched.GamePilotMooncakeAnnouncement).toMatchObject({
    algorithm: "OcrDetect",
    text: ["月饼烘焙小教程"],
    roi: [530, 165, 240, 45],
    action: "ClickRect",
    specificRect: [1158, 83, 21, 21],
  });
  expect(patched.Fight).toEqual(tasks.Fight);
  expect(patched.GamePilotMooncakeAnnouncement.maxTimes).toBe(3);
  expect(patched.GamePilotMooncakeAnnouncement.exceededNext).toEqual([
    "MainThemes#next",
  ]);
  expect(patched.StartUp).toEqual(tasks.StartUp);
  expect(tasks.CloseAnnos.next).toHaveLength(2);
  expect(patchStartupAnnouncements(patched)).toEqual(patched);
});
it("refuses an incompatible upstream resource instead of silently dropping its navigation", () => {
  expect(() =>
    patchStartupAnnouncements({ CloseAnnos: { next: ["ChangedInNewMAA"] } }),
  ).toThrow("公告");
});
