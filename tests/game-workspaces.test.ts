import { expect, it } from "vitest";
import { games } from "../games/registry";
import {
  groupedSkills,
  gameWorkspace,
} from "../apps/desktop/renderer/game-workspaces";

it("keeps every existing and future skill reachable exactly once", () => {
  for (const game of games) {
    const extended = {
      ...game,
      skills: [
        ...game.skills,
        { id: "future", title: "新任务", description: "", ready: false },
      ],
    };
    const ids = groupedSkills(extended).flatMap((group) =>
      group.skills.map((skill) => skill.id),
    );
    expect(ids.sort()).toEqual(extended.skills.map((skill) => skill.id).sort());
    expect(new Set(ids).size).toBe(ids.length);
  }
});

it("provides a workspace for a newly registered game without dedicated UI", () => {
  const game = {
    id: "new-game",
    name: "新游戏",
    subtitle: "正在接入",
    skills: [{ id: "login", title: "登录", description: "", ready: false }],
  };
  expect(gameWorkspace(game).settingsKey).toBeUndefined();
  expect(groupedSkills(game)[0].skills).toEqual(game.skills);
});
