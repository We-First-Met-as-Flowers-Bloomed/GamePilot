import { expect, it } from "vitest";
import {
  assertAgentExecutionAccounts,
  assertAgentPreferenceAccounts,
  assertAgentGameMessageScope,
} from "../games/agent-message-scope";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { createAgentTools } from "../packages/agent/tools";
import { prepareAgentGame } from "../games/agent-execution";
import type { GoalScope } from "../packages/protocol/agent-goal";
import type { LaneExecutionSnapshot } from "../apps/desktop/main/lane-snapshot";

function bindings() {
  const fixture = createFixtureSnapshot();
  const lanes = fixture.lanes!.lanes;
  lanes[0].id = "private-first";
  lanes[0].name = "晨星";
  lanes[1].id = "private-second";
  lanes[1].name = "暮雨";
  return { lanes, profiles: fixture.profiles! };
}

it.each([
  "现在运行两个账号明日方舟登录任务，先检查账号是否在线",
  "先检查账号是否在线，然后仅给账号二运行明日方舟登录",
])(
  "does not parse the account online check as an unknown nickname: %s",
  (prompt) => {
    const { lanes, profiles } = bindings();
    const selected = prompt.includes("仅给")
      ? [lanes[1].id]
      : lanes.map((l) => l.id);
    expect(() =>
      assertAgentExecutionAccounts(prompt, selected, lanes, profiles),
    ).not.toThrow();
    expect(() =>
      assertAgentExecutionAccounts(prompt, [lanes[0].id], lanes, profiles),
    ).toThrow();
  },
);

it.each(["账号是否在线的备用号", "账号是否在线123", "账号陌生人"])(
  "keeps unknown account references blocked: %s",
  (account) => {
    const { lanes, profiles } = bindings();
    expect(() =>
      assertAgentExecutionAccounts(
        `现在运行两个账号明日方舟登录，先检查${account}`,
        lanes.map((l) => l.id),
        lanes,
        profiles,
      ),
    ).toThrow();
  },
);

it.each(["两个已启用账号", "所有已启用的账号", "全部已启用账户"])(
  "requires every requested enabled account in %s",
  (words) => {
    const { lanes, profiles } = bindings();
    expect(() =>
      assertAgentExecutionAccounts(
        `现在运行${words}明日方舟日常`,
        [lanes[0].id],
        lanes,
        profiles,
      ),
    ).toThrow();
    expect(() =>
      assertAgentExecutionAccounts(
        `现在运行${words}明日方舟日常`,
        lanes.map((lane) => lane.id),
        lanes,
        profiles,
      ),
    ).not.toThrow();
  },
);

it.each([
  "第二个账号",
  "第2个账户",
  "第二槽位",
  "账号二",
  "2号",
  "暮雨",
  "private-second",
  "lane-b",
])(
  "binds the explicit account word %s to the fresh private second lane",
  (word) => {
    const { lanes, profiles } = bindings();
    expect(() =>
      assertAgentExecutionAccounts(
        `只给${word}领阴阳师邮件`,
        [lanes[1].id],
        lanes,
        profiles,
      ),
    ).not.toThrow();
    expect(() =>
      assertAgentExecutionAccounts(
        `只给${word}领阴阳师邮件`,
        [lanes[0].id],
        lanes,
        profiles,
      ),
    ).toThrow();
    expect(() =>
      assertAgentExecutionAccounts(
        `只给${word}领阴阳师邮件`,
        lanes.map((lane) => lane.id),
        lanes,
        profiles,
      ),
    ).toThrow();
  },
);

it("checks fresh client bindings without trusting a model lane alias", () => {
  const { lanes, profiles } = bindings();
  profiles.profiles.forEach((profile) => {
    profile.clientType = "Official";
  });
  profiles.profiles.find(
    (profile) => profile.id === lanes[1].arknights.profileId,
  )!.clientType = "Bilibili";
  expect(() =>
    assertAgentExecutionAccounts(
      "运行B服明日方舟日常",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行B服明日方舟日常",
      [lanes[0].id],
      lanes,
      profiles,
    ),
  ).toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "只给第二个账号运行官服日常",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).toThrow();
});

it("allows saved enabled account scope when this message names no account", () => {
  const { lanes, profiles } = bindings();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行保存的日常",
      lanes.map((lane) => lane.id),
      lanes,
      profiles,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行保存的日常",
      ["missing"],
      lanes,
      profiles,
    ),
  ).toThrow();
});

it("does not expand current execution authority from quoted account names", () => {
  const { lanes, profiles } = bindings();
  expect(() =>
    assertAgentExecutionAccounts(
      "之前说“账号一也跑”。现在只给第二个账号领邮件。",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "之前说“账号一也跑”。现在只给第二个账号领邮件。",
      lanes.map((lane) => lane.id),
      lanes,
      profiles,
    ),
  ).toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "历史：`账号一`。现在只给第二个账号领邮件。",
      [lanes[0].id],
      lanes,
      profiles,
    ),
  ).toThrow();
});

it("shares account alias parsing with preference authority", () => {
  const { lanes, profiles } = bindings();
  expect(() =>
    assertAgentPreferenceAccounts(
      "以后lane-b只领阴阳师邮件",
      [1],
      lanes,
      profiles,
      "onmyoji",
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentPreferenceAccounts(
      "以后lane-b只领阴阳师邮件",
      [0],
      lanes,
      profiles,
      "onmyoji",
    ),
  ).toThrow();
});

it("rejects an unavailable explicit ordinal and excludes an explicitly denied account", () => {
  const { lanes, profiles } = bindings();
  expect(() =>
    assertAgentExecutionAccounts(
      "只给第三个账号领邮件",
      [lanes[0].id],
      lanes,
      profiles,
    ),
  ).toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行保存日常，但不要给账号二执行",
      [lanes[0].id],
      lanes,
      profiles,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行保存日常，但不要给账号二执行",
      lanes.map((lane) => lane.id),
      lanes,
      profiles,
    ),
  ).toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "只给账号二执行日常，不购物",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).not.toThrow();
});

it("requires every explicitly requested account, including public aliases and client groups", () => {
  const { lanes, profiles } = bindings();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行双账号日常",
      [lanes[0].id],
      lanes,
      profiles,
    ),
  ).toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行账号一和账号二日常",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "运行lane-a和lane-b日常",
      lanes.map((lane) => lane.id),
      lanes,
      profiles,
    ),
  ).not.toThrow();
});

it("validates actual compiled two-account, two-game scope without losing an account or game", () => {
  const fixture = createFixtureSnapshot(),
    lanes = fixture.lanes!.lanes,
    profiles = fixture.profiles!;
  const prompt = "现在运行双账号明日方舟和阴阳师日常";
  const freeze = (matrix: [number, string[]][]) => {
    const tools = createAgentTools(fixture);
    const at = "2026-10-05T06:00:00Z";
    const draft = tools.call("compile_plan", {
      catalogRevision: tools.call("list_capabilities").revision,
      environmentRevision: tools.call("get_environment").revision,
      at,
      lanes: matrix.map(([index, gameIds]) => ({
        laneId: lanes[index].id,
        games: gameIds.map((gameId) => ({
          gameId,
          skillIds: ["login", gameId === "arknights" ? "award" : "mail"],
        })),
      })),
    });
    expect(draft.status).toBe("valid");
    const scopes: GoalScope[] = [],
      snapshots: LaneExecutionSnapshot[] = [];
    for (const laneDraft of draft.lanes) {
      const lane = lanes.find((lane) => lane.id === laneDraft.laneId)!;
      const profile = profiles.profiles.find(
        (profile) => profile.id === lane.arknights.profileId,
      );
      const snapshot: LaneExecutionSnapshot = { lane, startedAt: at };
      for (const game of laneDraft.games) {
        const frozen = prepareAgentGame(game, lane, profile, at);
        if (game.plan.gameId === "arknights") {
          snapshot.arknightsPlan = frozen.plan;
          snapshot.profile = frozen.profile;
        } else snapshot.onmyojiPlan = frozen.plan;
        scopes.push({
          laneId: lane.id,
          gameId: game.plan.gameId,
          skillIds: frozen.plan.skillIds,
          resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
        });
      }
      snapshots.push(snapshot);
    }
    return () => {
      assertAgentExecutionAccounts(
        prompt,
        snapshots.map((snapshot) => snapshot.lane.id),
        lanes,
        profiles,
      );
      assertAgentGameMessageScope(prompt, scopes, snapshots);
    };
  };
  expect(
    freeze([
      [0, ["arknights", "onmyoji"]],
      [1, ["arknights", "onmyoji"]],
    ]),
  ).not.toThrow();
  expect(freeze([[0, ["arknights", "onmyoji"]]])).toThrow();
  expect(
    freeze([
      [0, ["arknights"]],
      [1, ["arknights"]],
    ]),
  ).toThrow();
  expect(
    freeze([
      [0, ["arknights"]],
      [1, ["onmyoji"]],
    ]),
  ).toThrow();
});

it("excludes a game explicitly denied in an otherwise two-game request", () => {
  const fixture = createFixtureSnapshot(),
    lane = fixture.lanes!.lanes[0],
    plan = { gameId: "arknights", mode: "live" as const, skillIds: ["login"] };
  const scopes = [
    {
      laneId: lane.id,
      gameId: "arknights",
      skillIds: plan.skillIds,
      resources: { medicine: 0, stone: 0, expiringMedicine: 0 },
    },
  ];
  expect(() =>
    assertAgentGameMessageScope("运行双游戏日常，跳过阴阳师", scopes, [
      { lane, profile: fixture.profiles!.profiles[0], arknightsPlan: plan },
    ]),
  ).not.toThrow();
});

it.each([
  "账号12",
  "账号0",
  "账号张三",
  "第十二个账号",
  "0号",
  "账号1a",
  "账号1.5",
])(
  "rejects an unresolved explicit account instead of truncating or falling back: %s",
  (words) => {
    const { lanes, profiles } = bindings();
    for (const selected of [[lanes[0].id], lanes.map((lane) => lane.id)])
      expect(() =>
        assertAgentExecutionAccounts(
          `现在运行${words}明日方舟日常`,
          selected,
          lanes,
          profiles,
        ),
      ).toThrow();
  },
);
it.each(["两个号", "账号都", "所有账号"])(
  "keeps an explicit all-account expression exact: %s",
  (words) => {
    const { lanes, profiles } = bindings();
    const prompt = `现在${words}运行明日方舟日常`;
    expect(() =>
      assertAgentExecutionAccounts(
        prompt,
        lanes.map((lane) => lane.id),
        lanes,
        profiles,
      ),
    ).not.toThrow();
    expect(() =>
      assertAgentExecutionAccounts(prompt, [lanes[0].id], lanes, profiles),
    ).toThrow();
  },
);
it("allows registered names after the account word while ignoring quoted old names", () => {
  const { lanes, profiles } = bindings();
  expect(() =>
    assertAgentExecutionAccounts(
      "现在运行账号暮雨明日方舟日常",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "「账号张三运行日常」；现在只给账号二领阴阳师邮件",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).not.toThrow();
});

it("retains a known client account group with its fresh profile binding", () => {
  const { lanes, profiles } = bindings();
  profiles.profiles.forEach((profile) => {
    profile.clientType = "Official";
  });
  profiles.profiles.find(
    (profile) => profile.id === lanes[1].arknights.profileId,
  )!.clientType = "Bilibili";
  expect(() =>
    assertAgentExecutionAccounts(
      "现在运行B服账号明日方舟日常",
      [lanes[1].id],
      lanes,
      profiles,
    ),
  ).not.toThrow();
  expect(() =>
    assertAgentExecutionAccounts(
      "现在运行B服账号明日方舟日常",
      [lanes[0].id],
      lanes,
      profiles,
    ),
  ).toThrow();
});
