import { expect, it } from "vitest";
import { resolveCopilotStage } from "../games/arknights/copilot-stage";
it("joins the pinned normal catalog without authorizing a challenge alias", () => {
  expect(
    resolveCopilotStage(
      [{ code: "1-7", stageId: "main_01-07" }],
      {
        a: { code: "1-7", stageId: "main_01-07#f#", levelId: "same" },
        b: { code: "1-7", stageId: "main_01-07", levelId: "same" },
      },
      "1-7",
    ),
  ).toEqual({ id: "main_01-07", code: "1-7", aliases: ["main_01-07"] });
});
it("refuses missing, conflicting or ambiguous stage catalogs", () => {
  const stage = [{ code: "LS-6", stageId: "s" }],
    tile = { a: { code: "LS-6", stageId: "s", levelId: "l" } };
  expect(resolveCopilotStage(stage, tile, "LS-6")).toBeDefined();
  expect(resolveCopilotStage(stage, {}, "LS-6")).toBeUndefined();
  expect(
    resolveCopilotStage(
      [...stage, { code: "LS-6", stageId: "other" }],
      tile,
      "LS-6",
    ),
  ).toBeUndefined();
  expect(
    resolveCopilotStage(stage, { ...tile, b: tile.a }, "LS-6"),
  ).toBeUndefined();
});
it("refuses a challenge map even if both catalogs agree", () => {
  expect(
    resolveCopilotStage(
      [{ code: "1-7", stageId: "main_01-07#f#" }],
      { a: { code: "1-7", stageId: "main_01-07#f#", levelId: "l" } },
      "1-7",
    ),
  ).toBeUndefined();
});
