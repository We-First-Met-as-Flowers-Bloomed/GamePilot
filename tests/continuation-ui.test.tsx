import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import RoutineEditor from "../apps/desktop/renderer/components/RoutineEditor";
import ContinuationPanel, {
  ContinuationReview,
  continuationSelections,
} from "../apps/desktop/renderer/components/ContinuationPanel";
import { dailySkills, games } from "../games/registry";
import type { ContinuationPreview } from "../packages/protocol/continuation";

const preview = (): ContinuationPreview => ({
  parentId: "old-failed",
  fingerprint: "frozen",
  laneName: "原账号",
  canContinue: true,
  reasons: [],
  needsAcknowledgement: true,
  defaults: [{ gameId: "arknights", skillIds: ["friends", "award"] }],
  steps: [
    {
      gameId: "arknights",
      skillId: "login",
      status: "retained",
      message: "旧登录成功",
    },
    {
      gameId: "arknights",
      skillId: "fight",
      status: "retained",
      message: "已有完成记录",
    },
    {
      gameId: "arknights",
      skillId: "friends",
      status: "retry",
      message: "信用页面失败",
    },
    {
      gameId: "arknights",
      skillId: "award",
      status: "pending",
      message: "未执行",
    },
  ],
});
const renderReview = (
  value: ContinuationPreview,
  selections = value.defaults,
  acknowledged = false,
) =>
  renderToStaticMarkup(
    createElement(ContinuationReview, {
      preview: value,
      selections,
      acknowledged,
      disabled: false,
      onToggle: () => {},
      onAcknowledge: () => {},
      onSubmit: () => {},
    }),
  );

it("shows every daily switch before any folded date/order options", () => {
  for (const game of games) {
    const html = renderToStaticMarkup(
      createElement(RoutineEditor, {
        gameId: game.id,
        disabled: false,
        onChange: () => {},
      }),
    );
    for (const skillId of dailySkills(game.id)) {
      const title = game.skills.find((skill) => skill.id === skillId)!.title;
      const toggle = html.indexOf(`aria-label="启用${title}"`);
      expect(toggle).toBeGreaterThan(-1);
      const preceding = html.slice(0, toggle);
      expect((preceding.match(/<details/g) ?? []).length).toBe(
        (preceding.match(/<\/details>/g) ?? []).length,
      );
    }
    expect(html).toContain(
      game.id === "arknights" ? "上号 / UID 核验必需" : "上号 / 登录核对必需",
    );
    expect(html).toMatch(
      /type="checkbox"[^>]*aria-label="启用启动与上号"[^>]*disabled=""[^>]*checked=""/,
    );
    expect(html).not.toContain('aria-label="启用结界寄养"');
  }
});

it("disables continuation when the desktop API is unavailable", () => {
  const html = renderToStaticMarkup(
    createElement(ContinuationPanel, { requestId: "failed" }),
  );
  expect(html).toContain("继续未完成任务");
  expect(html).toMatch(/<button[^>]*disabled=""/);
});

it("preserves successful steps and exposes default retry and pending switches", () => {
  const html = renderReview(preview());
  expect(html).toContain("已有完成记录");
  expect(html).toContain("保留已完成");
  expect(html).toContain("续跑前重新核对登录状态；明日方舟同时核验 UID");
  expect(html).not.toContain('aria-label="续跑启动与上号"');
  expect(html).not.toContain('aria-label="续跑理智作战"');
  expect(html).toMatch(/aria-label="续跑好友与信用商店"[^>]*checked=""/);
  expect(html).toMatch(/aria-label="续跑领取任务奖励"[^>]*checked=""/);
  expect(html).toContain("失败步骤可能已部分执行");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>确认继续所选任务/);
});

it("allows excluding failed steps and requires at least one business step", () => {
  const value = preview();
  const pendingOnly = [{ gameId: "arknights", skillIds: ["award"] }];
  const html = renderReview(value, pendingOnly, true);
  expect(html).not.toMatch(/aria-label="续跑好友与信用商店"[^>]*checked=""/);
  expect(html).toContain("所选 1 项");
  expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>确认继续所选任务/);
  expect(renderReview(value, [], true)).toMatch(
    /<button[^>]*disabled=""[^>]*>确认继续所选任务/,
  );
});

it("filters login, retained, blocked and unknown selections from the submitted business scope", () => {
  const value = preview();
  value.steps.push({
    gameId: "arknights",
    skillId: "recruit",
    status: "blocked",
    message: "缺少记录",
  });
  expect(
    continuationSelections(value, [
      {
        gameId: "arknights",
        skillIds: ["login", "fight", "recruit", "friends", "award", "future"],
      },
    ]),
  ).toEqual([{ gameId: "arknights", skillIds: ["friends", "award"] }]);
});

it("blocks submission when preview has reasons or an existing successor", () => {
  const value = preview();
  value.reasons = ["槽位正在运行"];
  expect(renderReview(value, value.defaults, true)).toMatch(
    /<button[^>]*disabled=""[^>]*>确认继续所选任务/,
  );
  value.reasons = [];
  value.successorId = "already-created";
  expect(renderReview(value, value.defaults, true)).toContain(
    "already-created",
  );
  expect(renderReview(value, value.defaults, true)).not.toContain(
    "确认继续所选任务",
  );
});
