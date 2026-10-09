import { expect, it } from "vitest";
import {
  classifyArknightsFrame,
  compareArknightsFrames,
} from "../games/arknights/inspection";
import { defaultArknightsConfig } from "../games/arknights/config";
it("does not classify a generic confirmation overlay as an actionable home", () => {
  const texts = [
    ["任务", 1064, 913],
    ["基建", 1384, 948],
    ["公开招募", 1402, 764],
    ["ID: 123456789", 84, 633],
    ["确认", 800, 700],
  ].map(([text, x, y]) => ({
    text: String(text),
    box: [Number(x), Number(y), 160, 30] as [number, number, number, number],
    score: 0.99,
  }));
  const c = { ...defaultArknightsConfig, expectedUid: "123456789" };
  const f = classifyArknightsFrame(
    { width: 1920, height: 1080, texts },
    "com.hypergryph.arknights",
    c,
  );
  expect(f.page).toBe("unknown");
  expect(compareArknightsFrames(f, f, c).accountVerified).toBe(false);
});
