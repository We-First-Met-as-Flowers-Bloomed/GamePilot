import { expect, it } from "vitest";
import { createAgentTools } from "../packages/agent/tools";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { compileGameDraft } from "../games/agent";
import { taskFor } from "../games/arknights/config";
import { prepareAgentGame } from "../games/agent-execution";

it("compiles skipped shopping and mail-only rewards to independent native flags", () => {
  const snapshot = createFixtureSnapshot();
  const lane = snapshot.lanes!.lanes[0];
  const profile = snapshot.profiles!.profiles[0];
  profile.creditShopping = true;
  profile.freeRecruit = true;
  const compiled = compileGameDraft(
    {
      gameId: "arknights",
      skillIds: ["login", "friends", "award"],
      parameters: {
        creditShopping: false,
        taskAward: false,
        mail: true,
        freeRecruit: false,
        eventOrundum: false,
        eventMining: false,
        specialAccess: false,
        signInEvent: false,
      },
    },
    lane,
    profile,
    "2026-10-05T04:00:00.000Z",
  );
  expect(compiled.parameters).toMatchObject({
    creditShopping: false,
    taskAward: false,
    mail: true,
    freeRecruit: false,
  });
  expect(compiled.effects).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "award", enabled: false }),
      expect.objectContaining({ id: "mail", enabled: true }),
      expect.objectContaining({ id: "creditShopping", enabled: false }),
    ]),
  );
  const {
    id: _id,
    name: _name,
    ...config
  } = prepareAgentGame(
    compiled,
    lane,
    profile,
    "2026-10-05T04:00:00.000Z",
  ).profile!;
  expect(taskFor("friends", config).params.shopping).toBe(false);
  expect(taskFor("award", config).params).toMatchObject({
    award: false,
    mail: true,
    recruit: false,
    orundum: false,
    mining: false,
    specialaccess: false,
  });
});

it("makes the bundled reward claim visible when compiling a mail request", () => {
  const tools = createAgentTools(createFixtureSnapshot());
  const catalog = tools.call("list_capabilities");
  const ark = catalog.games.find((game) => game.id === "arknights")!;
  expect(
    ark.parameterNotes.some(
      (note) =>
        note.includes("邮件") && note.includes("每日") && note.includes("每周"),
    ),
  ).toBe(true);
  const draft = tools.call("compile_plan", {
    catalogRevision: catalog.revision,
    environmentRevision: tools.call("get_environment").revision,
    at: "2026-09-26T00:00:00.000Z",
    lanes: [
      {
        laneId: "lane-b",
        games: [
          {
            gameId: "arknights",
            skillIds: ["login", "award"],
            parameters: { mail: true },
          },
        ],
      },
    ],
  });
  expect(
    draft.lanes[0].games[0].notes.some(
      (note) => note.includes("同时领取") && note.includes("任务奖励"),
    ),
  ).toBe(true);
});
