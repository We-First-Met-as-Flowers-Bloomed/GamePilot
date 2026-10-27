import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";
import {
  addressForLane,
  selectCliCombos,
  selectCliLane,
} from "../scripts/shared/cli-target.mjs";

const channels = [
  {
    id: "lane-a",
    instance: 0,
    arknights: { enabled: true },
    onmyoji: { enabled: false },
    legacyBinding: {
      laneId: "lane-a",
      instance: 0,
      scope: '["mumu",0,"a",true]',
    },
  },
  {
    id: "lane-a-onmyoji",
    instance: 2,
    arknights: { enabled: false },
    onmyoji: { enabled: true },
    legacyBinding: {
      laneId: "lane-a",
      instance: 2,
      scope: '["mumu",0,"a",true]',
    },
  },
];
function declaration(script: string, name: string) {
  const source = readFileSync(
    new URL(`../scripts/${script}`, import.meta.url),
    "utf8",
  );
  const ast = parse(source, { sourceType: "module" });
  const found = ast.program.body.find(
    (node) =>
      node.type === "VariableDeclaration" &&
      node.declarations.some(
        (decl) => decl.id.type === "Identifier" && decl.id.name === name,
      ),
  );
  expect(found, `${script} ${name}`).toBeDefined();
  return source.slice(found!.start!, found!.end!);
}

it("the App compatibility runner resolves the game-specific successor and delegates device ownership", async () => {
  const { runGameMode } = await import("../scripts/game-mode.mjs");
  const calls: unknown[][] = [];
  await runGameMode(["--lane", "a", "--game", "onmyoji"], {
    read: () => JSON.stringify({ lanes: channels }),
    run: async (...args) => {
      calls.push(args);
      return { batchId: "stable", status: "succeeded" };
    },
    mkdir: () => {},
    write: () => {},
    log: () => {},
  });
  expect(calls).toHaveLength(1);
  expect(calls[0][1]).toBe("lane-a-onmyoji");
  expect(calls[0][2]).toBe("onmyoji");
});

it("the Onmyoji survey resolves the Onmyoji channel rather than the Arknights instance", () => {
  const resolve = new Function(
    "selectCliLane",
    "lanes",
    "options",
    `${declaration("game-mode/survey.mjs", "lane")} return lane;`,
  );
  expect(resolve(selectCliLane, channels, { lane: "a" })).toBe(channels[1]);
});

it("the shared CLI selector keeps real successor IDs distinct", () => {
  expect(selectCliCombos(channels, "a", "onmyoji")).toEqual([
    { lane: "lane-a-onmyoji", game: "onmyoji" },
  ]);
  expect(selectCliLane(channels, "a", "arknights").id).toBe("lane-a");
});
