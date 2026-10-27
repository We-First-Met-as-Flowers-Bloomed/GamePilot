import { describe, expect, it } from "vitest";
import {
  commandMatches,
  isComposingKey,
  localChatCommand,
  nextCommandIndex,
  slashCommands,
  slashSuggestions,
  slashEnterAction,
} from "../apps/desktop/renderer/slash-command-state";

describe("local command interactions", () => {
  it("sends an explicitly typed complete slash command on Enter while prefixes only fill", () => {
    for (const item of slashCommands) {
      expect(slashEnterAction(item.command, item.command)).toBe("send");
    }
    expect(slashEnterAction("/", "/daily")).toBe("fill");
    expect(slashEnterAction("/d", "/devices")).toBe("fill");
    expect(slashEnterAction("/run", "/run-daily")).toBe("fill");
    expect(slashEnterAction("/daily", "/devices")).toBe("fill");
  });
  it("offers only an unfinished slash prefix, without interpreting prose", () => {
    expect(slashSuggestions("/")).toEqual(slashCommands);
    expect(slashSuggestions("/d").map((item) => item.command)).toEqual([
      "/daily",
      "/devices",
    ]);
    expect(slashSuggestions("/run")[0].command).toBe("/run-daily");
    expect(slashSuggestions("hello /d")).toEqual([]);
    expect(slashSuggestions("/daily with extras")).toEqual([]);
    expect(slashSuggestions("/unknown")).toEqual([]);
  });
  it("keeps every explicit slash command local even when goals are available", () => {
    for (const item of slashCommands)
      expect(localChatCommand(item.command, true)).toBeDefined();
    expect(localChatCommand("/run-daily", true)).toBe("saved-daily");
    expect(localChatCommand("/continue", true)).toBe("continue");
    expect(localChatCommand("运行保存的日常", true)).toBeUndefined();
    expect(localChatCommand("继续原失败", true)).toBeUndefined();
    expect(localChatCommand("运行保存的日常", false)).toBe("saved-daily");
    expect(localChatCommand("当前步骤结束后暂停", true)).toBe("pause");
    expect(localChatCommand("/run-daily extra", true)).toBeUndefined();
  });
  it("wraps menu navigation and safely handles an empty result", () => {
    expect(nextCommandIndex(0, 3, "ArrowUp")).toBe(2);
    expect(nextCommandIndex(2, 3, "ArrowDown")).toBe(0);
    expect(nextCommandIndex(4, 0, "ArrowDown")).toBe(0);
  });
  it("finds case-insensitive fuzzy subsequences while preserving order", () => {
    expect(commandMatches("Model Connection 模型连接", "mdlcn")).toBe(true);
    expect(commandMatches("每日计划 daily", "每日")).toBe(true);
    expect(commandMatches("Devices 设备", " V S ")).toBe(true);
    expect(commandMatches("Devices", "sd")).toBe(false);
  });
  it("guards composing input including legacy keyCode 229", () => {
    expect(isComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
