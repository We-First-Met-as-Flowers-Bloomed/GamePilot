import { expect, it } from "vitest";
import {
  defaultPlannerTime,
  plannerTime,
  draftMatchesInput,
} from "../apps/desktop/renderer/planner-form";
import { presentAgentParameters } from "../games/agent-presentation";
import type { PlannerViewState } from "../packages/protocol/agent-planner";
it("freezes planner form time in Beijing regardless of local timezone", () => {
  expect(defaultPlannerTime(new Date("2026-09-25T13:00:00Z"))).toBe(
    "2026-09-26T08:00",
  );
  expect(defaultPlannerTime(new Date("2026-09-25T23:00:00Z"))).toBe(
    "2026-09-26T08:00",
  );
  expect(plannerTime("2026-09-26T08:00")).toBe("2026-09-26T00:00:00.000Z");
  expect(plannerTime("2026-02-30T08:00")).toBeUndefined();
});
it("does not present a draft as current after input or time changes", () => {
  const state: PlannerViewState = {
    revision: 1,
    status: "completed",
    prompt: "两个账号",
    at: "2026-09-26T00:00:00.000Z",
  };
  expect(draftMatchesInput(state, " 两个账号 ", "2026-09-26T08:00")).toBe(true);
  expect(draftMatchesInput(state, "一个账号", "2026-09-26T08:00")).toBe(false);
  expect(draftMatchesInput(state, "两个账号", "2026-09-27T08:00")).toBe(false);
  expect(
    draftMatchesInput(state, "两个账号", "2026-09-26T08:00", "configured"),
  ).toBe(false);
  expect(
    draftMatchesInput(
      { ...state, source: "configured" },
      "两个账号",
      "2026-09-26T08:00",
      "configured",
    ),
  ).toBe(true);
});
it("shows the actual compiled resource values instead of assuming safe defaults", () => {
  const fields = presentAgentParameters("arknights", {
    stage: "LS-6",
    mail: true,
    medicine: 0,
    stone: 0,
    expiringMedicine: 0,
    clientType: "Official",
    creditShopping: false,
  });
  expect(fields).toContainEqual({ label: "关卡", value: "LS-6" });
  expect(fields).toContainEqual({ label: "邮件", value: "领取" });
  expect(presentAgentParameters("arknights", { medicine: 3 })).toContainEqual({
    label: "理智药",
    value: "3",
  });
  expect(presentAgentParameters("arknights", {})).toContainEqual({
    label: "理智药",
    value: "未提供",
  });
});
