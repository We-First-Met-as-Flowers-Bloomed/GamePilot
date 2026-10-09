import { expect, it } from "vitest";
import {
  isArknightsDisconnect,
  arknightsGameDay,
} from "../games/arknights/result-policy";
it("recognizes the observed disconnect stop instead of treating task-chain completion as combat success", () => {
  expect(
    isArknightsDisconnect(
      'MAA 20001: {"details":{"task":"OfflineConfirm","action":"Stop"}}',
    ),
  ).toBe(true);
  expect(
    isArknightsDisconnect(
      'MAA 20001: {"details":{"task":"Fight@OfflineConfirm"}}',
    ),
  ).toBe(true);
  expect(isArknightsDisconnect('MAA 10002: {"taskchain":"Fight"}')).toBe(false);
  expect(
    isArknightsDisconnect(
      'MAA 20001: {"details":{"task":"StartButton1TryAgain"},"pre_task":"OfflineConfirm"}',
    ),
  ).toBe(false);
});
it("uses the CN Arknights four oclock reset", () => {
  expect(arknightsGameDay(new Date("2026-09-19T19:59:59Z"))).toBe("2026-09-19");
  expect(arknightsGameDay(new Date("2026-09-19T20:00:00Z"))).toBe("2026-09-20");
});
