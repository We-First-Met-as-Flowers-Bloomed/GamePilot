import { expect, it } from "vitest";
import { desktopLaunchMode } from "../apps/desktop/main/launch-mode";
it("rejects every preview combination with direct game startup before profile initialization", () => {
  for (const flag of ["--planner-preview", "--planner-ui-test"])
    expect(() => desktopLaunchMode([flag, "--run-device-lanes-once"])).toThrow(
      /预览/,
    );
  expect(desktopLaunchMode(["--planner-preview"])).toMatchObject({
    smoke: true,
    plannerPreview: true,
  });
  expect(desktopLaunchMode(["--run-device-lanes-once"])).toMatchObject({
    smoke: false,
    plannerPreview: false,
  });
});
