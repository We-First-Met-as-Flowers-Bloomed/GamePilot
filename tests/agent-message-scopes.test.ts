import { expect, it } from "vitest";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { prepareAgentGame } from "../games/agent-execution";
import {
  assertAgentExecutionAccounts,
  assertAgentGameMessageScope,
} from "../games/agent-message-scope";
import type { GoalScope } from "../packages/protocol/agent-goal";
import type { LaneExecutionSnapshot } from "../apps/desktop/main/lane-snapshot";

const mailOnly = {
  mail: true,
  taskAward: false,
  freeRecruit: false,
  eventOrundum: false,
  eventMining: false,
  specialAccess: false,
  signInEvent: false,
};
function check(
  prompt: string,
  matrix: {
    index: number;
    gameId: string;
    skillIds: string[];
    parameters?: Record<string, unknown>;
  }[],
) {
  const fixture = createFixtureSnapshot();
  fixture.lanes!.lanes[0].id = "private-first";
  fixture.lanes!.lanes[0].name = "晨星";
  fixture.lanes!.lanes[1].id = "private-second";
  fixture.lanes!.lanes[1].name = "暮雨";
  const tools = createAgentTools(fixture),
    at = "2026-10-05T06:00:00.000Z";
  const draft = tools.call("compile_plan", {
    catalogRevision: tools.call("list_capabilities").revision,
    environmentRevision: tools.call("get_environment").revision,
    at,
    lanes: [...new Set(matrix.map((item) => item.index))].map((index) => ({
      laneId: fixture.lanes!.lanes[index].id,
      games: matrix
        .filter((item) => item.index === index)
        .map((item) => ({
          gameId: item.gameId,
          skillIds: item.skillIds,
          parameters: {
            ...(item.gameId === "arknights" && item.skillIds.includes("award")
              ? mailOnly
              : {}),
            ...item.parameters,
          },
        })),
    })),
  });
  expect(draft.status).toBe("valid");
  const scopes: GoalScope[] = [],
    snapshots: LaneExecutionSnapshot[] = [];
  for (const entry of draft.lanes) {
    const lane = fixture.lanes!.lanes.find(
      (value) => value.id === entry.laneId,
    )!;
    const profile = fixture.profiles!.profiles.find(
      (value) => value.id === lane.arknights.profileId,
    );
    const snapshot: LaneExecutionSnapshot = { lane, startedAt: at };
    for (const game of entry.games) {
      const prepared = prepareAgentGame(game, lane, profile, at);
      if (game.plan.gameId === "arknights") {
        snapshot.arknightsPlan = prepared.plan;
        snapshot.profile = prepared.profile;
      } else snapshot.onmyojiPlan = prepared.plan;
      scopes.push({
        laneId: lane.id,
        gameId: game.plan.gameId,
        skillIds: prepared.plan.skillIds,
        resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
      });
    }
    snapshots.push(snapshot);
  }
  return () =>
    assertAgentGameMessageScope(prompt, scopes, snapshots, {
      accountLanes: fixture.lanes!.lanes,
    });
}
const splitTasks = [
  { index: 0, gameId: "arknights", skillIds: ["login", "award"] },
  { index: 1, gameId: "arknights", skillIds: ["login", "infrastructure"] },
];

const twoArknightsDailies = [0, 1].map((index) => ({
  index,
  gameId: "arknights",
  skillIds: ["login", "recruit", "fight", "infrastructure", "friends", "award"],
  parameters: { stage: "LS-6" },
}));
it("excludes only the named game in a postposed standalone denial", () => {
  const prompt = "现在运行两个账号明日方舟日常，阴阳师先不跑";
  expect(check(prompt, twoArknightsDailies)).not.toThrow();
  expect(
    check(prompt, [
      ...twoArknightsDailies,
      { index: 0, gameId: "onmyoji", skillIds: ["login", "mail"] },
    ]),
  ).toThrow();
});
it("requires both configured accounts for 两个明日方舟号", () => {
  const prompt = "现在运行两个明日方舟号的日常";
  const fixture = createFixtureSnapshot();
  const ids = fixture.lanes!.lanes.map((lane) => lane.id);
  expect(() =>
    assertAgentExecutionAccounts(
      prompt,
      ids,
      fixture.lanes!.lanes,
      fixture.profiles!,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      prompt,
      [ids[0]],
      fixture.lanes!.lanes,
      fixture.profiles!,
    ),
  ).toThrow();
  expect(check(prompt, twoArknightsDailies)).not.toThrow();
  expect(check(prompt, [twoArknightsDailies[0]])).toThrow();
});
it("binds the explicit fight stage to each account's frozen profile", () => {
  const prompt = "现在运行两个账号明日方舟日常，理智刷LS-6";
  expect(check(prompt, twoArknightsDailies)).not.toThrow();
  expect(
    check(prompt, [
      twoArknightsDailies[0],
      { ...twoArknightsDailies[1], parameters: { stage: "1-7" } },
    ]),
  ).toThrow(expect.objectContaining({ code: "GOAL_SCOPE_EXCEEDED" }));
});
it("does not read 分别 in a shared stage request as 别", () => {
  expect(
    check(
      "现在给两个账号分别执行明日方舟日常，分别理智刷LS-6",
      twoArknightsDailies,
    ),
  ).not.toThrow();
});
it("keeps explicit stages local to their requested accounts", () => {
  const prompt =
    "现在运行账号一明日方舟日常，理智刷LS-6；账号二运行明日方舟日常，理智刷1-7";
  const matrix = [
    twoArknightsDailies[0],
    { ...twoArknightsDailies[1], parameters: { stage: "1-7" } },
  ];
  expect(check(prompt, matrix)).not.toThrow();
  expect(
    check(
      prompt,
      matrix.map((scope) => ({ ...scope, parameters: { stage: "LS-6" } })),
    ),
  ).toThrow();
});
it.each([
  "理智刷LS-6还是1-7",
  "理智刷上次那个关卡",
  "理智刷LS-6或保存关卡",
  "关卡不要LS-6",
  "理智刷LS-6，或者1-7",
  "理智刷LS-6，1-7也行",
])("does not guess an uncertain explicit stage: %s", (stage) => {
  expect(
    check(`现在运行两个账号明日方舟日常，${stage}`, twoArknightsDailies),
  ).toThrow();
});
it("admits the complete player daily sentence with exact accounts, game and stage", () => {
  const prompt =
    "帮我把两个明日方舟号今天的日常清完，理智刷LS-6，别吃药也别碎石，阴阳师先不跑。跑完告诉我信用还剩多少。";
  expect(check(prompt, twoArknightsDailies)).not.toThrow();
  expect(check(prompt, [twoArknightsDailies[0]])).toThrow();
  expect(
    check(prompt, [
      ...twoArknightsDailies,
      { index: 0, gameId: "onmyoji", skillIds: ["login", "mail"] },
    ]),
  ).toThrow();
  expect(
    check(
      prompt,
      twoArknightsDailies.map((scope) => ({
        ...scope,
        parameters: { stage: "1-7" },
      })),
    ),
  ).toThrow();
});
it("does not turn a post-login credit report into friends execution", () => {
  const prompt = "先帮我登录两个明日方舟账号，跑完告诉我信用是否满了";
  const login = [0, 1].map((index) => ({
    index,
    gameId: "arknights",
    skillIds: ["login"],
  }));
  expect(check(prompt, login)).not.toThrow();
  expect(
    check(
      prompt,
      login.map((scope) => ({
        ...scope,
        skillIds: ["login", "friends"],
      })),
    ),
  ).toThrow();
});

it.each([
  "我已经更新过客户端了。先帮我登录两个明日方舟账号，核对是不是保存的B服和官服账号，回到首页就停，其他日常先不做。",
  "现在运行两个账号明日方舟登录，其他日常先不做",
  "先帮我登录两个明日方舟账号，不执行其他日常",
  "先帮我登录两个明日方舟账号，其他日常不需要做",
  "先帮我登录两个明日方舟账号，其他日常不用做",
  "先帮我登录两个明日方舟账号，不必做其他日常",
])(
  "keeps the player's excluded daily work outside a login request: %s",
  (prompt) => {
    const loginOnly = [0, 1].map((index) => ({
      index,
      gameId: "arknights",
      skillIds: ["login"],
    }));
    expect(check(prompt, loginOnly)).not.toThrow();
    for (const skillId of [
      "recruit",
      "fight",
      "infrastructure",
      "friends",
      "award",
    ])
      expect(
        check(
          prompt,
          loginOnly.map((scope) => ({
            ...scope,
            skillIds: ["login", skillId],
          })),
        ),
      ).toThrow(expect.objectContaining({ code: "GOAL_SCOPE_EXCEEDED" }));
    expect(
      check(prompt, [
        ...loginOnly,
        { index: 0, gameId: "onmyoji", skillIds: ["login", "mail"] },
      ]),
    ).toThrow(expect.objectContaining({ code: "GOAL_SCOPE_EXCEEDED" }));
  },
);
it.each([
  "现在给账号一领取明日方舟邮件，给账号二运行明日方舟基建，不购物，不吃药",
  "现在只给账号一领明日方舟邮件，账号二只做明日方舟基建，不购物",
  "给晨星领取明日方舟邮件；给暮雨运行明日方舟基建",
  "现在给账号一领取明日方舟邮件然后给账号二运行明日方舟基建",
])("admits the exact account-specific task division: %s", (prompt) => {
  expect(check(prompt, splitTasks)).not.toThrow();
});
it("rejects spreading both requested tasks onto both accounts", () => {
  expect(
    check(
      "现在给账号一领取明日方舟邮件，给账号二运行明日方舟基建",
      splitTasks.map((item) => ({
        ...item,
        skillIds: ["login", "award", "infrastructure"],
      })),
    ),
  ).toThrow(expect.objectContaining({ code: "GOAL_SCOPE_EXCEEDED" }));
});
it("keeps task and game ownership when accounts select different games", () => {
  const prompt = "给账号一领取阴阳师邮件，给账号二运行明日方舟基建";
  expect(
    check(prompt, [
      { index: 0, gameId: "onmyoji", skillIds: ["login", "mail"] },
      splitTasks[1],
    ]),
  ).not.toThrow();
  expect(
    check(prompt, [
      { index: 1, gameId: "onmyoji", skillIds: ["login", "mail"] },
      { ...splitTasks[1], index: 0 },
    ]),
  ).toThrow();
});
it("does not apply an account's denied task to another account", () => {
  expect(
    check(
      "账号一只领明日方舟邮件，不要基建；账号二只运行明日方舟基建",
      splitTasks,
    ),
  ).not.toThrow();
  expect(
    check("账号一只领明日方舟邮件，不要基建；账号二只运行明日方舟基建", [
      { ...splitTasks[0], skillIds: ["login", "award", "infrastructure"] },
      splitTasks[1],
    ]),
  ).toThrow();
});
it("does not derive scope from quoted other-account instructions", () => {
  expect(
    check("「账号一运行明日方舟基建」；现在只给账号二领取阴阳师邮件", [
      { index: 1, gameId: "onmyoji", skillIds: ["login", "mail"] },
    ]),
  ).not.toThrow();
  expect(
    check("现在可以给账号一领取明日方舟邮件，给账号二运行基建吗？", splitTasks),
  ).toThrow(expect.objectContaining({ code: "CURRENT_MESSAGE_REQUIRED" }));
});

it("keeps an unqualified no-shopping constraint across every requested account", () => {
  const prompt = "现在运行账号一明日方舟日常，账号二运行明日方舟日常，不购物";
  const matrix = [0, 1].map((index) => ({
    index,
    gameId: "arknights",
    skillIds: ["login", "friends"],
    parameters: { creditShopping: false },
  }));
  expect(check(prompt, matrix)).not.toThrow();
  expect(
    check(prompt, [
      { ...matrix[0], parameters: { creditShopping: true } },
      matrix[1],
    ]),
  ).toThrow();
});
it("can scope a no-shopping condition to the account that explicitly owns it", () => {
  expect(
    check("现在运行账号一明日方舟日常但不购物，账号二运行明日方舟日常", [
      {
        index: 0,
        gameId: "arknights",
        skillIds: ["login", "friends"],
        parameters: { creditShopping: false },
      },
      {
        index: 1,
        gameId: "arknights",
        skillIds: ["login", "friends"],
        parameters: { creditShopping: true },
      },
    ]),
  ).not.toThrow();
});
it("keeps separate game tasks on one account and common tasks on explicitly shared accounts", () => {
  expect(
    check("给账号一领取明日方舟邮件；阴阳师只领取每日礼包", [
      splitTasks[0],
      { index: 0, gameId: "onmyoji", skillIds: ["login", "daily-gift"] },
    ]),
  ).not.toThrow();
  expect(
    check(
      "只给账号一和账号二领取阴阳师邮件",
      [0, 1].map((index) => ({
        index,
        gameId: "onmyoji",
        skillIds: ["login", "mail"],
      })),
    ),
  ).not.toThrow();
});
