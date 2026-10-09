import { it, expect, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import type { Frame, GameDevice } from "../packages/runtime/device";
import type { SkillResult } from "../packages/protocol";
const frame = (...rows: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: rows.map(([text, x, y]) => ({ text, box: [x, y, 100, 40], score: 1 })),
});
const home = frame(["加成", 546, 49]);
const guild = frame(["阴阳寮", 934, 35]);
const shrine = frame(
  ["神社", 1770, 545],
  ["狩猎战", 328, 639],
  ["集体任务", 310, 266],
);
const tasks = (n: number) =>
  frame(
    ["集体任务", 814, 65],
    ["提供N阶式神1个", 244, 286],
    ["提交", 410, 718],
    [`今日已完成次数${n}/30`, 1410, 850],
  );
function setup(counts: number[], increments = counts, failReturn = false) {
  let n = 10;
  let phase = "home";
  let batch = 0;
  const logs: string[] = [];
  const checkpoints: SkillResult[] = [];
  const d = {
    observe: vi.fn(async () =>
      phase === "home"
        ? home
        : phase === "guild"
          ? guild
          : phase === "shrine"
            ? shrine
            : phase === "tasks"
              ? tasks(n)
              : phase === "selection"
                ? frame(
                    ["隐藏已提升技能式神", 336, 657],
                    ["可提交的N阶式神不包括呱太", 1348, 686],
                  )
                : phase === "confirm"
                  ? frame(
                      [`将提交${counts[batch]}次任务`, 794, 43],
                      ["提交", 1100, 520],
                    )
                  : frame(["获得奖励", 720, 260]),
    ),
    click: vi.fn(async (x: number, y: number) => {
      if (phase === "home") phase = "guild";
      else if (phase === "guild") phase = x < 100 ? "home" : "shrine";
      else if (phase === "shrine") phase = x < 100 ? "guild" : "tasks";
      else if (phase === "tasks") {
        if (failReturn && x > 1700 && n === 30)
          throw Error("navigation-only-failure");
        phase = x > 1700 ? "shrine" : "selection";
      } else if (phase === "confirm") {
        n += increments[batch++];
        phase = "reward";
      } else if (phase === "reward") phase = "tasks";
    }),
    longPress: vi.fn(async () => {
      phase = "confirm";
    }),
    matchTemplate: vi.fn(async () => null),
  } as unknown as GameDevice;
  return {
    d,
    logs,
    checkpoints,
    adapter: new OnmyojiDaily(
      d,
      (m, result) => {
        logs.push(m);
        if (result) checkpoints.push(structuredClone(result));
      },
      async () => {},
    ),
  };
}
it("submits short stacks in verified batches until the daily target", async () => {
  const { d, adapter } = setup([4, 2, 14]);
  await adapter.guildQuest(new AbortController().signal);
  expect(d.longPress).toHaveBeenCalledTimes(3);
});
it("does not submit a selection exceeding the remaining quota", async () => {
  const { d, adapter } = setup([21]);
  await expect(
    adapter.guildQuest(new AbortController().signal),
  ).rejects.toThrow("批量选择数量");
  expect(d.click).not.toHaveBeenCalledWith(1150, 540, expect.anything());
});
it("stops immediately when the actual progress does not equal the submitted count", async () => {
  const { d, adapter } = setup([4, 16], [0, 16]);
  await expect(
    adapter.guildQuest(new AbortController().signal),
  ).rejects.toThrow("进度");
  expect(d.longPress).toHaveBeenCalledTimes(1);
});
it("retains an earlier confirmed batch when a later submitted batch is unconfirmed", async () => {
  const x = setup([4, 16], [4, 0]);
  await expect(
    x.adapter.guildQuest(new AbortController().signal),
  ).rejects.toThrow("进度");
  expect(x.checkpoints.at(-1)).toMatchObject({
    onmyoji: {
      skillId: "guild-quest",
      phase: "submitted",
      effects: [
        {
          kind: "guild-submit",
          summary: "已核对本批提交 4 次；集体任务进度 14/30",
        },
      ],
    },
  });
  expect(x.checkpoints.at(-1)?.onmyoji?.effects).toHaveLength(1);
  expect(x.d.longPress).toHaveBeenCalledTimes(2);
});
it("retains the full verified guild effects before failed return input", async () => {
  const x = setup([20], [20], true);
  await expect(
    x.adapter.guildQuest(new AbortController().signal),
  ).rejects.toThrow("navigation-only-failure");
  expect(x.checkpoints.at(-1)).toMatchObject({
    onmyoji: {
      phase: "confirmed",
      effects: [{ kind: "guild-submit" }, { kind: "guild-reward" }],
    },
  });
  expect(x.checkpoints.at(-1)?.goalSatisfied).not.toBe(true);
});
