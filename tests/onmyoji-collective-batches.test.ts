import { it, expect, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import type { Frame, GameDevice } from "../packages/runtime/device";
import type { SkillResult } from "../packages/protocol";

/**
 * 新版集体任务（2026-10-15 实机适配）：寮境 → 集体任务面板 → 领走已获得的奖励。
 *
 * 与旧版的关键差别：**不再自动「提交」**。提交卡要提供 N 阶式神（消耗式神），做不做由玩家决定；
 * 技能只识别它并在摘要里说明。所以这里的用例除了覆盖领奖，还要钉住"绝不点提交"这条边界。
 */
const frame = (...rows: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: rows.map(([text, x, y]) => ({ text, box: [x, y, 100, 40], score: 1 })),
});
const courtyard = frame(["加成", 546, 49], ["阴阳寮", 806, 984]);
const realm = frame(
  ["集体任务", 100, 260],
  ["狩猎战", 100, 400],
  ["结界突破", 14, 512],
  ["寮信息", 1744, 1010],
);
const collective = (claimable: boolean, completed = 10, card = 1): Frame =>
  frame(
    ["集体任务", 814, 65],
    ["提交", 410, 718],
    // 三张卡横排：可领卡自己的按钮在它那一列（不同卡按钮位置不同，技能据此区分"同一张卡"）。
    ...(claimable
      ? ([[
          "领取奖励",
          878 - (card - 2) * 470,
          720,
        ]] as [string, number, number][])
      : []),
    ["进行中", 900, 718],
    [`今日已完成次数${completed}/30`, 1420, 851],
  );

function setup(options: { claimable: boolean[]; failReturn?: boolean; stuck?: boolean }) {
  let phase = "home";
  let claimIndex = 0;
  const logs: string[] = [];
  const checkpoints: SkillResult[] = [];
  const current = (): Frame => {
    if (phase === "home") return courtyard;
    if (phase === "realm") return realm;
    if (phase === "tasks")
      return collective(
        options.stuck === true ? true : (options.claimable[claimIndex] ?? false),
        10,
        claimIndex + 1,
      );
    return collective(options.stuck === true);
  };
  const d = {
    observe: vi.fn(async () => current()),
    click: vi.fn(async (x: number, y: number) => {
      if (phase === "home") phase = "realm"; // 底部「阴阳寮」
      else if (phase === "realm" && y > 150) phase = "tasks"; // 左栏「集体任务」行
      else if (phase === "realm") phase = "home"; // 左上返回（courtyard 逃生）
      else if (phase === "tasks" && x < 700) phase = "submitted"; // 提交卡：技能不该点
      else if (phase === "tasks" && x > 1700) {
        // 面板右上角的 ×：返回失败由这条腿触发。
        if (options.failReturn) throw Error("navigation-only-failure");
        phase = "realm";
      } else if (phase === "tasks") {
        // stuck = 同一张卡领完仍显示可领：按钮位置不动，技能应当停止而不是反复点。
        if (options.stuck !== true) claimIndex++;
        phase = "tasks";
      }
    }),
    longPress: vi.fn(async () => {
      phase = "submitted";
    }),
    matchTemplate: vi.fn(async () => null),
  } as unknown as GameDevice;
  return {
    d,
    logs,
    checkpoints,
    adapter: new OnmyojiDaily(
      d,
      (message, result) => {
        logs.push(message);
        if (result) checkpoints.push(structuredClone(result));
      },
      async () => {},
    ),
  };
}

it("claims the earned reward, reports progress and never touches the submit card", async () => {
  const x = setup({ claimable: [true, false] });
  const result = await x.adapter.guildQuest(new AbortController().signal);
  expect(result?.status).toBe("succeeded");
  expect(result?.summary).toContain("10/30");
  expect(result?.summary).toContain("领取 1 项奖励");
  expect(result?.summary).toContain("未自动提交");
  // 提交是玩家的取舍：既不长按，也不点提交按钮。
  expect(x.d.longPress).not.toHaveBeenCalled();
  expect(x.d.click).not.toHaveBeenCalledWith(460, 738, expect.anything());
  expect(x.logs.some((line) => line.includes("不自动提交"))).toBe(true);
});

it("claims every claimable card, up to the bounded limit", async () => {
  const x = setup({ claimable: [true, true, false] });
  const result = await x.adapter.guildQuest(new AbortController().signal);
  expect(result?.summary).toContain("领取 2 项奖励");
  expect(x.checkpoints.at(-1)?.onmyoji?.effects?.[0]?.summary).toContain(
    "已领取 2 项集体任务奖励",
  );
});

it("stops instead of re-clicking when the reward is still claimable after settlement", async () => {
  const x = setup({ claimable: [true], stuck: true });
  await expect(
    x.adapter.guildQuest(new AbortController().signal),
  ).rejects.toThrow("停止重复点击");
  // 只点过一次领奖按钮：绝不反复点。
  expect(x.d.click).toHaveBeenCalledTimes(3);
});

it("reports honestly when there is nothing to claim and clicks no reward button", async () => {
  const x = setup({ claimable: [false] });
  const result = await x.adapter.guildQuest(new AbortController().signal);
  expect(result?.summary).toContain("暂无可领取奖励");
  expect(result?.summary).toContain("未自动提交");
  expect(x.d.click).not.toHaveBeenCalledWith(960, 741, expect.anything());
});

it("keeps the confirmed claim before a failed return leg", async () => {
  const x = setup({ claimable: [true, false], failReturn: true });
  await expect(
    x.adapter.guildQuest(new AbortController().signal),
  ).rejects.toThrow("navigation-only-failure");
  // 领奖已经确认过，证据必须留在记录里（即便后面的返回腿失败）。
  const withReward = x.checkpoints.filter((item) =>
    item.onmyoji?.effects?.some((effect) => effect.kind === "guild-reward"),
  );
  expect(withReward.length).toBeGreaterThan(0);
  // 返回腿失败时还来不及调用 completedEffects，所以 phase 停在 submitted；关键是奖励已在记录里。
  expect(withReward.at(-1)?.onmyoji?.phase).toBe("submitted");
  expect(x.checkpoints.at(-1)?.goalSatisfied).not.toBe(true);
});
