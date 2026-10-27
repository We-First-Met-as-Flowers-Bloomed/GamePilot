import { expect, it } from "vitest";
import { nearConversationEnd } from "../apps/desktop/renderer/conversation-scroll";
it("keeps following near the end and stops when the reader scrolls into history", () => {
  expect(
    nearConversationEnd({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 595,
    }),
  ).toBe(true);
  expect(
    nearConversationEnd({
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTop: 200,
    }),
  ).toBe(false);
  expect(
    nearConversationEnd({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }),
  ).toBe(true);
});
it("does not turn invalid layout metrics into permission to move the reader", () => {
  expect(
    nearConversationEnd({ scrollHeight: NaN, clientHeight: 400, scrollTop: 0 }),
  ).toBe(false);
  expect(
    nearConversationEnd(
      { scrollHeight: 500, clientHeight: 400, scrollTop: 20 },
      -1,
    ),
  ).toBe(false);
});
