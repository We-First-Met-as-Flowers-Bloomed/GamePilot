import { describe, it, expect, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import type { Frame, GameDevice } from "../packages/runtime/device";
import illustrationFirst from "./fixtures/onmyoji/mail-illustration-first.json";
import illustrationLast from "./fixtures/onmyoji/mail-illustration-last.json";
import kirinCompleted from "./fixtures/onmyoji/kirin-completed-20261008.json";
const frame = (...a: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: a.map(([text, x, y]) => ({ text, box: [x, y, 100, 40], score: 0.99 })),
});
const map = frame(
  ["今日挑战", 40, 640],
  ["筛选", 1650, 95],
  ["12440", 1770, 91],
);
const detail = (name: string, score = 123) =>
  frame(
    [name, 196, 71],
    ["难度选择", 210, 182],
    ["挑战", 1664, 790],
    [`评分${score}`, 1474, 651],
  );
function harness(frames: Frame[]) {
  let n = 0;
  const d: GameDevice = {
    observe: vi.fn(async () => frames[Math.min(n++, frames.length - 1)]),
    click: vi.fn(async () => {}),
    swipe: vi.fn(async () => {}),
    longPress: vi.fn(async () => {}),
    colorSlots: vi.fn(async () => []),
    startApp: vi.fn(async () => {}),
    packages: vi.fn(async () => ["com.netease.onmyoji.test"]),
    isAppRunning: vi.fn(async () => true),
    matchTemplate: vi.fn(async () => null),
  };
  const logs: string[] = [];
  return {
    d,
    logs,
    adapter: new OnmyojiDaily(
      d,
      (m) => logs.push(m),
      async () => {},
    ),
  };
}
describe("daily state machine", () => {
  const courtyard = frame(["探", 840, 208], ["加成", 546, 49]);
  it("reconnects a disconnected courtyard before accepting login", async () => {
    const disconnected = frame(
      ["探", 840, 208],
      ["加成", 546, 49],
      ["已断开游戏服务器，需要重新连接", 662, 472],
      ["确定", 914, 581],
    );
    const { adapter, d } = harness([
      disconnected,
      disconnected,
      courtyard,
      courtyard,
    ]);
    await adapter.login(new AbortController().signal);
    expect(d.click).toHaveBeenCalledTimes(1);
    expect(d.click).toHaveBeenCalledWith(964, 601, expect.any(AbortSignal));
  });
  it("stops after two confirmed login reconnect attempts", async () => {
    const disconnected = frame(
      ["探", 840, 208],
      ["加成", 546, 49],
      ["已断开游戏服务器，需要重新连接", 662, 472],
      ["确定", 914, 581],
    );
    const { adapter, d } = harness([disconnected]);
    await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
      "重连两次",
    );
    expect(d.click).toHaveBeenCalledTimes(2);
  });

  describe("login popup recovery", () => {
    const sign = frame(["第818签", 706, 168], ["解签", 1400, 555]);
    const buff = frame(
      ["加成", 546, 49],
      ["是否打开大人之前被自动关", 680, 430],
      ["闭的加成？", 850, 480],
      ["取消", 750, 610],
      ["确认", 1080, 610],
    );
    const emptyMailbox = frame(["邮箱", 910, 81], ["删除已读", 530, 915]);
    const unknown = frame(
      ["加成", 546, 49],
      ["是否购买加成", 700, 430],
      ["取消", 750, 610],
      ["确认", 1080, 610],
    );
    // Cropped text evidence from lane-b 2026-09-29 12:42:24.386, 1920x1080.
    const extraction: Frame = {
      width: 1920,
      height: 1080,
      texts: [
        {
          text: "您在结界中放置的式神已满",
          box: [676, 424, 564, 46],
          score: 0.996259,
        },
        {
          text: "级，请确认是否提取？",
          box: [736, 480, 444, 42],
          score: 0.984359,
        },
        { text: "取消", box: [754, 609, 100, 54], score: 0.999709 },
        { text: "确认", box: [1064, 609, 100, 52], score: 0.999994 },
      ],
    };

    it("cancels the observed max-level realm extraction prompt during chores without replaying claim", async () => {
      const tasks = frame(
        ["庭院事务", 400, 61],
        ["一键", 1690, 875],
        ["完成", 1676, 950],
      );
      const claimed = frame(["领取成功", 456, 39], ["完成啦", 106, 536]);
      const completed = frame(
        ["庭院事务", 400, 61],
        ["每日一签", 590, 428],
        ["已完成", 1478, 406],
      );
      const { adapter, d } = harness([
        courtyard,
        tasks,
        extraction,
        claimed,
        completed,
      ]);
      vi.mocked(d.matchTemplate).mockResolvedValue({
        box: [1470, 548, 68, 70],
        score: 0.99,
      });
      await adapter.checkIn(new AbortController().signal);
      expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
        [1504, 583],
        [1740, 940],
        [804, 636],
        [960, 1030],
      ]);
    });

    it("bounds repeated realm extraction cancellation", async () => {
      const { adapter, d } = harness([extraction]);
      await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
        "提取提示未能关闭",
      );
      expect(d.click).toHaveBeenCalledTimes(3);
      expect(d.startApp).not.toHaveBeenCalled();
    });

    it("honors cancellation before dismissing the realm extraction prompt", async () => {
      const control = new AbortController();
      const { adapter, d } = harness([extraction]);
      const observe = d.observe;
      d.observe = vi.fn(async (signal) => {
        const f = await observe(signal);
        control.abort();
        return f;
      });
      await expect(adapter.login(control.signal)).rejects.toThrow();
      expect(d.click).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "closes a recognized sign scroll before accepting login (during startup=%s)",
      async (duringStartup) => {
        const { adapter, d } = harness([
          ...(duringStartup ? [frame()] : []),
          sign,
          courtyard,
          courtyard,
        ]);
        await adapter.login(new AbortController().signal);
        expect(d.click).toHaveBeenCalledExactlyOnceWith(
          1310,
          160,
          expect.anything(),
        );
        expect(d.startApp).toHaveBeenCalledTimes(duringStartup ? 1 : 0);
      },
    );

    it.each([false, true])(
      "cancels a recognized restore-buff prompt before accepting login (during startup=%s)",
      async (duringStartup) => {
        const { adapter, d } = harness([
          ...(duringStartup ? [frame()] : []),
          buff,
          courtyard,
          courtyard,
        ]);
        await adapter.login(new AbortController().signal);
        expect(d.click).toHaveBeenCalledExactlyOnceWith(
          800,
          630,
          expect.anything(),
        );
        expect(d.click).not.toHaveBeenCalledWith(1130, 630, expect.anything());
      },
    );

    it("closes known mail rewards that appear after startup begins", async () => {
      const { adapter, d } = harness([
        frame(),
        illustrationFirst as Frame,
        emptyMailbox,
        emptyMailbox,
        courtyard,
        courtyard,
      ]);
      await adapter.login(new AbortController().signal);
      expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
        [960, 1050],
        [1765, 185],
      ]);
    });

    it("returns from a verified mailbox instead of restarting a logged-in game", async () => {
      const { adapter, d } = harness([emptyMailbox, courtyard, courtyard]);
      await adapter.login(new AbortController().signal);
      expect(d.startApp).not.toHaveBeenCalled();
      expect(d.click).toHaveBeenCalledExactlyOnceWith(
        1765,
        185,
        expect.anything(),
      );
    });

    it.each([false, true])(
      "does not accept courtyard labels behind an unknown confirmation (during startup=%s)",
      async (duringStartup) => {
        const { adapter, d } = harness([
          ...(duringStartup ? [frame()] : []),
          unknown,
        ]);
        await expect(
          adapter.login(new AbortController().signal),
        ).rejects.toThrow("未识别的确认");
        expect(d.click).not.toHaveBeenCalled();
      },
    );

    it("bounds repeated known login popup dismissal", async () => {
      const { adapter, d } = harness([sign]);
      await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
        "登录弹层未能关闭",
      );
      expect(d.click).toHaveBeenCalledTimes(3);
      expect(d.startApp).not.toHaveBeenCalled();
    });

    it("honors cancellation before dismissing a recognized login popup", async () => {
      const control = new AbortController();
      const { adapter, d } = harness([sign]);
      const observe = d.observe;
      d.observe = vi.fn(async (signal) => {
        const f = await observe(signal);
        control.abort();
        return f;
      });
      await expect(adapter.login(control.signal)).rejects.toThrow();
      expect(d.click).not.toHaveBeenCalled();
    });

    it("does not use courtyard controls beneath an unknown confirmation", async () => {
      const { adapter, d } = harness([unknown]);
      await expect(adapter.mail(new AbortController().signal)).rejects.toThrow(
        "未识别的确认",
      );
      expect(d.click).not.toHaveBeenCalled();
    });

    it("does not dismiss a reward behind an unknown confirmation", async () => {
      const f: Frame = {
        ...unknown,
        texts: [...unknown.texts, ...frame(["获得奖励", 720, 280]).texts],
      };
      const { adapter, d } = harness([f]);
      await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
        "未识别的确认",
      );
      expect(d.click).not.toHaveBeenCalled();
    });

    it("does not dismiss a mail reward behind an unknown confirmation", async () => {
      const f: Frame = {
        ...unknown,
        texts: [
          ...unknown.texts,
          ...frame(["获得奖励", 720, 280], ["邮箱", 910, 81]).texts,
        ],
      };
      const { adapter, d } = harness([f]);
      await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
        "未识别的确认",
      );
      expect(d.click).not.toHaveBeenCalled();
    });

    it("keeps an unfinished battle prompt ahead of any incidental extraction dismissal", async () => {
      const f: Frame = {
        ...extraction,
        texts: [
          ...extraction.texts,
          ...frame(["是否继续刚才的战斗？", 740, 452]).texts,
        ],
      };
      const { adapter, d } = harness([f]);
      await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
        "未结束的战斗",
      );
      expect(d.click).not.toHaveBeenCalled();
    });

    it("does not blindly tap through an unknown confirmation after chores claim", async () => {
      const taskList = frame(
        ["庭院事务", 400, 61],
        ["一键", 1690, 875],
        ["完成", 1676, 950],
      );
      const claimed = frame(["领取成功", 456, 39], ["完成啦", 106, 536]);
      const { adapter, d } = harness([courtyard, taskList, claimed, unknown]);
      vi.mocked(d.matchTemplate).mockResolvedValue({
        box: [1470, 548, 68, 70],
        score: 0.99,
      });
      await expect(
        adapter.checkIn(new AbortController().signal),
      ).rejects.toThrow("未识别的确认");
      expect(d.click).toHaveBeenCalledTimes(3);
    });

    it.each(["paper-reward", "task-list", "task-list-after-paper-reward"])(
      "blocks an unknown confirmation before the first chores action (%s)",
      async (stage) => {
        const tasks = frame(
          ["庭院事务", 400, 61],
          ["一键", 1690, 875],
          ["完成", 1676, 950],
        );
        const paperReward = frame(["加成", 546, 49], ["获得奖励", 720, 280]);
        const overlay: Frame = {
          ...unknown,
          texts: [
            ...unknown.texts,
            ...(stage === "paper-reward" ? paperReward : tasks).texts,
          ],
        };
        const { adapter, d } = harness([
          courtyard,
          ...(stage === "task-list-after-paper-reward"
            ? [
                paperReward,
                frame(
                  ["加成", 546, 49],
                  ["探索", 1000, 200],
                  ["召唤", 1560, 250],
                ),
              ]
            : []),
          overlay,
        ]);
        vi.mocked(d.matchTemplate).mockResolvedValue({
          box: [1470, 548, 68, 70],
          score: 0.99,
        });
        await expect(
          adapter.checkIn(new AbortController().signal),
        ).rejects.toThrow("未识别的确认");
        expect(d.click).toHaveBeenCalledTimes(
          stage === "task-list-after-paper-reward" ? 3 : 1,
        );
        expect(d.click).not.toHaveBeenCalledWith(1740, 940, expect.anything());
      },
    );
  });
  const templateHit = {
    box: [1470, 548, 68, 70] as [number, number, number, number],
    score: 0.99,
  };
  const shopDistrict = frame(
    ["周边屋", 112, 1026],
    ["魂玉屋", 1490, 1024],
    ["礼包屋", 1700, 1026],
  );

  it("closes the compact sign reward before confirming daily check-in", async () => {
    const tasks = frame(
      ["庭院事务", 400, 61],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const claimed = frame(["领取成功", 456, 39], ["完成啦", 106, 536]);
    const sign = frame(
      ["第818签", 706, 168],
      ["解签", 1400, 555],
      ["签到999天领取", 1678, 236],
    );
    const completed = frame(
      ["庭院事务", 400, 61],
      ["每日一签", 590, 428],
      ["已完成", 1478, 406],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      tasks,
      claimed,
      sign,
      completed,
    ]);
    vi.mocked(d.matchTemplate).mockResolvedValue(templateHit);
    await adapter.checkIn(new AbortController().signal);
    expect(d.click).toHaveBeenCalledWith(1310, 160, expect.anything());
    expect(logs.at(-1)).toContain("每日一签已完成");
  });
  it("dismisses the known restore-buff dialog before using courtyard controls", async () => {
    const popup = frame(
      ["加成", 546, 49],
      ["是否打开大人之前被自动关", 680, 430],
      ["闭的加成？", 850, 480],
      ["取消", 750, 610],
      ["确认", 1080, 610],
    );
    const mailbox = frame(["邮箱", 910, 81], ["删除已读", 530, 915]);
    const { adapter, d } = harness([popup, courtyard, mailbox]);
    await adapter.mail(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 800, 630, expect.anything());
    expect(d.click).not.toHaveBeenCalledWith(1130, 630, expect.anything());
  });
  it("recovers a compact sign reward left by an interrupted earlier run", async () => {
    const sign = frame(
      ["第818签", 706, 168],
      ["解签", 1400, 555],
      ["签到999天领取", 1678, 236],
    );
    const claimed = frame(["领取成功", 456, 39], ["完成啦", 106, 536]);
    const mailbox = frame(["邮箱", 910, 81], ["删除已读", 530, 915]);
    const { adapter, d } = harness([sign, claimed, courtyard, mailbox]);
    await adapter.mail(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 1310, 160, expect.anything());
    expect(d.click).toHaveBeenNthCalledWith(2, 960, 1030, expect.anything());
  });

  it("rejects unknown chores instead of assuming check-in is complete", async () => {
    const { adapter, d, logs } = harness([courtyard]);
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未找到庭院事务入口",
    );
    expect(d.click).not.toHaveBeenCalled();
    expect(d.matchTemplate).toHaveBeenCalledWith(
      "courtyard-tasks.png",
      [1180, 420, 500, 360],
      0.78,
      expect.anything(),
    );
    expect(logs.some((m) => m.includes("无需处理"))).toBe(false);
  });

  it("opens a closed courtyard scroll before looking for pending chores", async () => {
    const taskList = frame(
      ["庭院事务", 400, 61],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const claimed = frame(
      ["领取成功", 456, 39],
      ["完成啦", 106, 536],
      ["点击空白处关闭", 856, 1020],
    );
    const completed = frame(
      ["庭院事务", 400, 61],
      ["每日一签", 590, 428],
      ["已完成", 1478, 406],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      taskList,
      claimed,
      completed,
    ]);
    let taskChecks = 0;
    vi.mocked(d.matchTemplate).mockImplementation(async (name) => {
      if (name === "courtyard-tasks.png")
        return taskChecks++ === 0 ? null : templateHit;
      if (name === "courtyard-menu-closed.png")
        return { box: [1780, 870, 120, 120], score: 0.99 };
      return null;
    });
    await adapter.checkIn(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 1840, 930, expect.anything());
    expect(logs).toContain("庭院卷宗已关闭，已自动展开");
  });

  it("returns from a known hunting page before checking courtyard chores", async () => {
    const hunting = frame(["狩猎战", 226, 29], ["挑战", 1700, 903]);
    const { adapter, d } = harness([hunting, courtyard]);
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未找到庭院事务入口",
    );
    expect(d.click).toHaveBeenCalledTimes(1);
    expect(d.click).toHaveBeenCalledWith(65, 60, expect.anything());
  });

  it("leaves the textless courtyard scenery view only with both visual anchors", async () => {
    const { adapter, d, logs } = harness([frame(), courtyard]);
    vi.mocked(d.matchTemplate).mockImplementation(async (name) => {
      if (name === "courtyard-scene-back.png")
        return { box: [42, 37, 90, 87], score: 0.99 };
      if (name === "courtyard-scene-music.png")
        return { box: [1750, 925, 135, 130], score: 0.99 };
      return null;
    });
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未找到庭院事务入口",
    );
    expect(d.click).toHaveBeenCalledTimes(1);
    expect(d.click).toHaveBeenCalledWith(87, 80.5, expect.anything());
    expect(logs.some((m) => m.includes("无需处理"))).toBe(false);
  });

  it("recovers a previous collective-task screen before the next daily", async () => {
    const collective = frame(
      ["集体任务", 814, 65],
      ["今日已完成次数30/30", 1410, 850],
    );
    const shrine = frame(["神社", 1770, 545], ["狩猎战", 328, 639]);
    const guild = frame(["阴阳寮", 934, 35]);
    const { adapter, d } = harness([collective, shrine, guild, courtyard]);
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未找到庭院事务入口",
    );
    expect(d.click).toHaveBeenNthCalledWith(1, 1755, 180, expect.anything());
    expect(d.click).toHaveBeenCalledTimes(3);
  });

  it("does not dereference a missing exploration label in courtyard", async () => {
    const incompleteCourtyard = frame(["加成", 546, 49]);
    const lowMap = frame(
      ["今日挑战", 40, 640],
      ["筛选", 1650, 95],
      ["1000", 1770, 91],
    );
    const { adapter, d, logs } = harness([
      incompleteCourtyard,
      courtyard,
      lowMap,
      lowMap,
      lowMap,
      detail("少林寺藏经阁", 100),
      detail("少林寺藏经阁", 100),
      lowMap,
    ]);
    await adapter.realmRaid(new AbortController().signal);
    expect(d.click).toHaveBeenCalledWith(890, 228, expect.anything());
    expect(logs.at(-1)).toContain("未重复消耗体力");
  });

  it("uses the configured one-key chores and verifies daily check-in", async () => {
    const taskList = frame(
      ["庭院事务", 400, 61],
      ["每日首抽免费", 590, 234],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const claimed = frame(
      ["领取成功", 456, 39],
      ["完成啦", 106, 536],
      ["点击空白处关闭", 856, 1020],
    );
    const completed = frame(
      ["庭院事务", 400, 61],
      ["每日一签", 590, 428],
      ["已领取", 892, 428],
      ["已完成", 1478, 406],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      taskList,
      claimed,
      completed,
    ]);
    vi.mocked(d.matchTemplate).mockResolvedValue(templateHit);
    await adapter.checkIn(new AbortController().signal);
    expect(d.click).toHaveBeenCalledTimes(3);
    expect(d.click).toHaveBeenNthCalledWith(2, 1740, 940, expect.anything());
    expect(logs.at(-1)).toContain("每日一签已完成");
  });

  it("dismisses the daily sign scroll before verifying the chores page", async () => {
    const taskList = frame(
      ["庭院事务", 400, 61],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const claimed = frame(
      ["领取成功", 456, 39],
      ["完成啦", 106, 536],
      ["点击空白处关闭", 856, 1020],
    );
    const signScroll = frame(
      ["第811签", 1100, 120],
      ["解签", 1640, 680],
      ["点击空白处关闭", 856, 1020],
    );
    const completed = frame(
      ["庭院事务", 400, 61],
      ["每日一签", 590, 428],
      ["已完成", 1478, 406],
    );
    const { adapter, d } = harness([
      courtyard,
      taskList,
      claimed,
      signScroll,
      completed,
    ]);
    vi.mocked(d.matchTemplate).mockResolvedValue(templateHit);
    await adapter.checkIn(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(3, 1860, 900, expect.anything());
    expect(d.click).toHaveBeenNthCalledWith(4, 1605, 105, expect.anything());
  });

  it.each([true, false])(
    "checks the final allowed overlay dismissal without assuming daily completion (%s)",
    async (signed) => {
      const taskList = frame(
        ["庭院事务", 400, 61],
        ["一键", 1690, 875],
        ["完成", 1676, 950],
      );
      const claimed = frame(["领取成功", 456, 39], ["完成啦", 106, 536]);
      const transition = frame(["点击屏幕继续", 836, 1014]);
      const scroll = frame(["第820签", 708, 168], ["解签", 1300, 671]);
      const completed = frame(
        ["庭院事务", 400, 61],
        ["每日一签", 590, 428],
        ["已完成", 1480, signed ? 408 : 788],
      );
      const { adapter, d, logs } = harness([
        courtyard,
        taskList,
        claimed,
        transition,
        scroll,
        claimed,
        completed,
      ]);
      vi.mocked(d.matchTemplate).mockResolvedValue(templateHit);
      const result = adapter.checkIn(new AbortController().signal);
      if (signed) {
        await result;
        expect(logs.at(-1)).toContain("每日一签已完成");
      } else {
        await expect(result).rejects.toThrow("未能确认每日一签");
      }
      expect(d.click).toHaveBeenCalledTimes(6);
    },
  );

  it("does not click beyond the four-dismissal budget when overlays remain", async () => {
    const taskList = frame(
      ["庭院事务", 400, 61],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const claimed = frame(["领取成功", 456, 39], ["完成啦", 106, 536]);
    const { adapter, d } = harness([courtyard, taskList, claimed]);
    vi.mocked(d.matchTemplate).mockResolvedValue(templateHit);
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      "未能关闭签到奖励",
    );
    expect(d.click).toHaveBeenCalledTimes(6);
  });

  it("rejects a claim result when another row is complete but daily check-in is not", async () => {
    const taskList = frame(
      ["庭院事务", 400, 61],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const claimed = frame(["领取成功", 456, 39], ["完成啦", 106, 536]);
    const wrongRow = frame(
      ["庭院事务", 400, 61],
      ["每日一签", 590, 428],
      ["永久勾玉卡", 590, 810],
      ["已完成", 1478, 788],
    );
    const { adapter, d } = harness([courtyard, taskList, claimed, wrongRow]);
    vi.mocked(d.matchTemplate).mockResolvedValue(templateHit);
    await expect(adapter.checkIn(new AbortController().signal)).rejects.toThrow(
      /未能确认每日一签/,
    );
  });

  it("uses feature recognition and accepts an already-complete task page without a reward overlay", async () => {
    const completed = frame(
      ["庭院事务", 400, 61],
      ["每日一签", 590, 238],
      ["已完成", 1478, 214],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const { adapter, d, logs } = harness([courtyard, completed, completed]);
    d.matchFeatures = vi.fn(async () => ({
      box: [1161, 556, 68, 73] as [number, number, number, number],
      score: 15,
    }));
    const result = await adapter.checkIn(new AbortController().signal);
    expect(result).toMatchObject({
      status: "succeeded",
      summary: "已确认每日一签完成，并核对庭院一键事务",
    });
    expect(d.click).toHaveBeenNthCalledWith(1, 1195, 592.5, expect.anything());
    expect(logs.at(-1)).toContain("每日一签已完成");
  });

  it("skips mail when the verified mailbox has no one-key claim", async () => {
    const mailbox = frame(["邮箱", 910, 81], ["删除已读", 530, 915]);
    const { adapter, d, logs } = harness([courtyard, mailbox]);
    expect(await adapter.mail(new AbortController().signal)).toMatchObject({
      status: "skipped",
    });
    expect(d.click).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toContain("没有待领取邮件");
  });

  it("returns from the completed chores page before opening mail", async () => {
    const { adapter, d } = harness([
      frame(["庭院事务", 400, 61]),
      courtyard,
      frame(["邮箱", 910, 81], ["删除已读", 530, 915]),
    ]);
    await adapter.mail(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 75, 60, expect.anything());
  });

  it("reopens the paper doll after its pending icon disappears on the verified layout", async () => {
    const layout = frame(
      ["加成", 550, 50],
      ["探索", 984, 204],
      ["召唤", 1582, 258],
    );
    const completed = frame(
      ["庭院事务", 400, 61],
      ["每日一签", 590, 238],
      ["已完成", 1478, 214],
      ["一键", 1690, 875],
      ["完成", 1676, 950],
    );
    const { adapter, d } = harness([layout, layout, completed, completed]);
    await adapter.checkIn(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 1170, 690, expect.anything());
  });

  it.each([false, true])(
    "handles a courtyard reward before opening chores (repeat=%s)",
    async (repeat) => {
      const layout = frame(
        ["加成", 550, 50],
        ["探索", 984, 204],
        ["召唤", 1582, 258],
      );
      const reward = frame(
        ["加成", 550, 50],
        ["探索", 984, 204],
        ["召唤", 1582, 258],
        ["获得奖励", 720, 280],
      );
      const completed = frame(
        ["庭院事务", 400, 61],
        ["每日一签", 590, 238],
        ["已完成", 1478, 214],
        ["一键", 1690, 875],
        ["完成", 1676, 950],
      );
      const { adapter, d } = harness([
        layout,
        layout,
        reward,
        layout,
        ...(repeat ? [reward] : [completed, completed]),
      ]);
      if (repeat)
        await expect(
          adapter.checkIn(new AbortController().signal),
        ).rejects.toThrow();
      else await adapter.checkIn(new AbortController().signal);
      expect(d.click).toHaveBeenNthCalledWith(2, 960, 1030, expect.anything());
      expect(d.click).toHaveBeenNthCalledWith(3, 1170, 690, expect.anything());
      if (repeat)
        expect(d.click).not.toHaveBeenCalledWith(1740, 940, expect.anything());
    },
  );

  it("claims all mail only after mailbox and confirmation verification", async () => {
    const mailbox = frame(
      ["邮箱", 910, 81],
      ["删除已读", 530, 915],
      ["键", 160, 875],
      ["领取", 118, 903],
    );
    const confirm = frame(
      ["全部领取", 834, 67],
      ["取消", 734, 833],
      ["确定", 1106, 833],
    );
    const reward = frame(["获得奖励", 720, 206], ["邮箱", 916, 89]);
    const after = frame(
      ["邮箱", 910, 81],
      ["删除已读", 530, 915],
      ["已读", 654, 385],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      mailbox,
      confirm,
      reward,
      after,
    ]);
    await adapter.mail(new AbortController().signal);
    expect(d.click).toHaveBeenCalledWith(1155, 860, expect.anything());
    expect(logs.at(-1)).toContain("邮件附件已领取");
  });

  it("never claims mail from an unverified page", async () => {
    const { adapter, d } = harness([courtyard, frame(["全部领取", 834, 67])]);
    await expect(adapter.mail(new AbortController().signal)).rejects.toThrow();
    expect(vi.mocked(d.click).mock.calls).toHaveLength(1);
  });

  describe("mail illustration rewards", () => {
    const mailbox = frame(
      ["邮箱", 910, 81],
      ["删除已读", 530, 915],
      ["键", 160, 875],
      ["领取", 118, 903],
    );
    const confirm = frame(["全部领取", 834, 67], ["确定", 1106, 833]);
    // Mailbox anchors may still be visible behind a reward overlay.
    const reward = frame(
      ["获得奖励", 720, 206],
      ["邮箱", 916, 89],
      ["删除已读", 530, 915],
    );
    const empty = frame(["邮箱", 910, 81], ["删除已读", 530, 915]);
    const illustration = illustrationFirst as Frame;

    it("closes real animated illustration frames and verifies the empty mailbox without reclaiming", async () => {
      const { adapter, d } = harness([
        courtyard,
        mailbox,
        confirm,
        reward,
        illustration,
        illustrationLast as Frame,
        empty,
      ]);
      await expect(
        adapter.mail(new AbortController().signal),
      ).resolves.toMatchObject({ status: "succeeded" });
      expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
        [1733, 55],
        [160, 920],
        [1155, 860],
        [960, 1020],
        [960, 1050],
        [960, 1050],
      ]);
    });

    it("also accepts illustration as the first reward after verified confirmation", async () => {
      const { adapter, d } = harness([
        courtyard,
        mailbox,
        confirm,
        illustration,
        empty,
      ]);
      await expect(
        adapter.mail(new AbortController().signal),
      ).resolves.toMatchObject({ status: "succeeded" });
      expect(d.click).not.toHaveBeenCalledWith(960, 1020, expect.anything());
    });

    it("stops after three reward dismissals when the overlay persists", async () => {
      const { adapter, d } = harness([
        courtyard,
        mailbox,
        confirm,
        reward,
        illustration,
      ]);
      await expect(adapter.mail(new AbortController().signal)).rejects.toThrow(
        "奖励弹层未能关闭",
      );
      expect(vi.mocked(d.click).mock.calls).toHaveLength(6);
    });

    it("waits on an unknown overlay without clicking or claiming again", async () => {
      const { adapter, d } = harness([
        courtyard,
        mailbox,
        confirm,
        reward,
        frame(["分享", 1600, 900]),
      ]);
      await expect(
        adapter.mail(new AbortController().signal),
      ).rejects.toThrow();
      expect(vi.mocked(d.click).mock.calls).toHaveLength(4);
    });

    it.each([false, true])(
      "rejects unknown confirmation over mailbox or reward after dismissal (reward=%s)",
      async (withReward) => {
        const overlay: Frame = {
          ...empty,
          texts: [
            ...empty.texts,
            ...frame(
              ["是否购买加成", 700, 430],
              ["取消", 750, 610],
              ["确认", 1080, 610],
              ...(withReward
                ? [["获得奖励", 720, 280] as [string, number, number]]
                : []),
            ).texts,
          ],
        };
        const { adapter, d } = harness([
          courtyard,
          mailbox,
          confirm,
          reward,
          overlay,
        ]);
        await expect(
          adapter.mail(new AbortController().signal),
        ).rejects.toThrow("未识别的确认");
        expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
          [1733, 55],
          [160, 920],
          [1155, 860],
          [960, 1020],
        ]);
      },
    );

    it("does not report success or submit again when attachments remain", async () => {
      const { adapter, d } = harness([
        courtyard,
        mailbox,
        confirm,
        reward,
        illustration,
        mailbox,
      ]);
      await expect(adapter.mail(new AbortController().signal)).rejects.toThrow(
        "不重复确认",
      );
      expect(
        vi
          .mocked(d.click)
          .mock.calls.filter(([x, y]) => x === 1155 && y === 860),
      ).toHaveLength(1);
    });

    it("recovers an orphan illustration before reopening and checking mail", async () => {
      const { adapter, d } = harness([
        illustration,
        empty,
        empty,
        courtyard,
        empty,
      ]);
      await expect(
        adapter.mail(new AbortController().signal),
      ).resolves.toMatchObject({ status: "skipped" });
      expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
        [960, 1050],
        [1765, 185],
        [1733, 55],
      ]);
    });

    it("recovers an orphan illustration when a new run starts with login", async () => {
      const { adapter, d } = harness([
        illustration,
        empty,
        empty,
        courtyard,
        courtyard,
      ]);
      await adapter.login(new AbortController().signal);
      expect(d.startApp).not.toHaveBeenCalled();
      expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
        [960, 1050],
        [1765, 185],
      ]);
    });

    it("honors cancellation between recognition and dismissal", async () => {
      const control = new AbortController();
      const { adapter, d } = harness([courtyard, mailbox, confirm, reward]);
      const observe = d.observe;
      d.observe = vi.fn(async (signal) => {
        const result = await observe(signal);
        if (result === reward) control.abort();
        return result;
      });
      await expect(adapter.mail(control.signal)).rejects.toThrow();
      expect(vi.mocked(d.click).mock.calls).toHaveLength(3);
    });
  });

  it.each([true, false])(
    "opens a recognized closed scroll and verifies the shop layout (label=%s)",
    async (label) => {
      const opened = label
        ? frame(["加成", 546, 49], ["商店", 1000, 995])
        : frame(
            ["加成", 546, 49],
            ["阴阳寮", 808, 986],
            ["纳物库", 472, 990],
            ["式神录", 1648, 986],
          );
      const shop = frame(["热门推荐", 234, 27], ["礼包屋", 1698, 1024]);
      const house = frame(
        ["礼包屋", 1698, 1026],
        ["限时", 1784, 140],
        ["特权", 1788, 696],
        ["日常", 1760, 575],
      );
      const claimed = frame(
        ["每日礼包", 300, 206],
        ["礼包屋", 1698, 1026],
        ["推荐", 226, 123],
      );
      const { adapter, d } = harness([
        courtyard,
        opened,
        shop,
        house,
        claimed,
        courtyard,
      ]);
      vi.mocked(d.matchTemplate).mockImplementation(async (name) =>
        name === "courtyard-menu-closed.png"
          ? { box: [1730, 880, 150, 190], score: 0.99 }
          : null,
      );
      await adapter.dailyGift(new AbortController().signal);
      expect(d.click).toHaveBeenNthCalledWith(1, 1805, 975, expect.anything());
      expect(d.click).toHaveBeenNthCalledWith(
        2,
        label ? 1050 : 1025,
        label ? 1015 : 955,
        expect.anything(),
      );
    },
  );

  describe("shop restores the previous gift-house tab", () => {
    // Navigation anchors from lane-b 2026-10-04 18:07:19, 1920x1080.
    // The shop reopened its limited-time gift list, without 热门推荐.
    const restored: Frame = {
      width: 1920,
      height: 1080,
      texts: [
        { text: "周边屋", box: [110, 1026, 94, 36], score: 0.94701 },
        { text: "魂玉屋", box: [1490, 1022, 104, 44], score: 0.99109 },
        { text: "礼包屋", box: [1698, 1026, 96, 36], score: 0.999382 },
        { text: "限时", box: [1780, 136, 64, 112], score: 0.99264 },
        { text: "特权", box: [1788, 696, 52, 108], score: 0.978247 },
        { text: "印", box: [1798, 555, 30, 46], score: 0.791086 },
        { text: "常", box: [1790, 591, 48, 62], score: 0.999803 },
        { text: "648", box: [1324, 857, 108, 48], score: 0.996777 },
      ],
    };

    it.each([
      ["popular shop", frame(["热门推荐", 234, 27], ["礼包屋", 1698, 1024])],
      ["gift house", restored],
      [
        "daily gifts",
        frame(
          ["每日礼包", 300, 206],
          ["领取", 326, 448],
          ["礼包屋", 1698, 1026],
          ["推荐", 226, 123],
        ),
      ],
      ["shop district", shopDistrict],
    ] as const)(
      "returns from the verified %s before recognizing existing login without restarting",
      async (_pageName, initial) => {
        const { adapter, d } = harness([initial]);
        let current: Frame = initial;
        d.observe = vi.fn(async () => current);
        vi.mocked(d.click).mockImplementation(async (x, y) => {
          if (x === 75 && y === 60) current = courtyard;
        });

        await adapter.login(new AbortController().signal);

        expect(d.startApp).not.toHaveBeenCalled();
        expect(d.packages).not.toHaveBeenCalled();
        expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
          [75, 60],
        ]);
        expect(d.observe).toHaveBeenCalledTimes(4);
        await expect(
          vi.mocked(d.observe).mock.results.at(-2)?.value,
        ).resolves.toBe(courtyard);
        await expect(
          vi.mocked(d.observe).mock.results.at(-1)?.value,
        ).resolves.toBe(courtyard);
      },
    );

    it("does not return or restart when an unknown confirmation covers the shop at login", async () => {
      const overlay: Frame = {
        ...restored,
        texts: [
          ...restored.texts,
          ...frame(
            ["是否执行未识别的操作", 780, 400],
            ["取消", 750, 610],
            ["确认", 1080, 610],
          ).texts,
        ],
      };
      const { adapter, d } = harness([overlay]);

      await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
        "未识别的确认弹窗",
      );

      expect(d.click).not.toHaveBeenCalled();
      expect(d.startApp).not.toHaveBeenCalled();
    });

    it.each(["请输入密码", "请输入验证码", "实名认证", "扫码登录"])(
      "does not return from shop anchors beneath the %s identity screen",
      async (identity) => {
        const overlay: Frame = {
          ...restored,
          texts: [...restored.texts, ...frame([identity, 600, 400]).texts],
        };
        const { adapter, d } = harness([overlay]);

        await expect(
          adapter.login(new AbortController().signal),
        ).rejects.toThrow("登录需要本人处理");

        expect(d.click).not.toHaveBeenCalled();
        expect(d.startApp).not.toHaveBeenCalled();
      },
    );

    it("opens daily gifts from the observed limited-time tab without clicking paid cards", async () => {
      const opened = frame(["加成", 546, 49], ["商店", 1000, 995]);
      const claimed = frame(
        ["每日礼包", 300, 206],
        ["每日优惠礼包", 610, 210],
        ["领取", 652, 446],
        ["礼包屋", 1698, 1026],
        ["推荐", 226, 123],
      );
      const { adapter, d } = harness([
        opened,
        restored,
        restored,
        claimed,
        claimed,
        shopDistrict,
        courtyard,
      ]);

      const result = await adapter.dailyGift(new AbortController().signal);

      expect(result).toMatchObject({
        status: "skipped",
        summary:
          "每日免费礼包未显示可确认的免费领取入口，领取状态未确认，本次未点击",
        skipReason: "unavailable",
        goalSatisfied: null,
      });
      expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
        [1050, 1015],
        [1746, 984],
        [1814, 604],
        [75, 60],
        [75, 60],
      ]);
      await expect(
        vi.mocked(d.observe).mock.results.at(-1)?.value,
      ).resolves.toBe(courtyard);
    });

    it.each(["周边屋", "魂玉屋", "礼包屋"])(
      "stops before further shop input when the %s navigation anchor is missing",
      async (missing) => {
        const opened = frame(["加成", 546, 49], ["商店", 1000, 995]);
        const incomplete = {
          ...restored,
          texts: restored.texts.filter((hit) => hit.text !== missing),
        };
        const { adapter, d } = harness([opened, incomplete]);

        await expect(
          adapter.dailyGift(new AbortController().signal),
        ).rejects.toThrow("画面未进入预期状态");

        expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual([
          [1050, 1015],
        ]);
      },
    );

    it.each(["shop", "house", "daily"])(
      "stops before further input when an unknown confirmation covers the verified %s page",
      async (stage) => {
        const opened = frame(["加成", 546, 49], ["商店", 1000, 995]);
        const list = frame(
          ["每日礼包", 300, 206],
          ["领取", 326, 448],
          ["礼包屋", 1698, 1026],
          ["推荐", 226, 123],
        );
        const overlay: Frame = {
          ...(stage === "daily" ? list : restored),
          texts: [
            ...(stage === "daily" ? list : restored).texts,
            ...frame(
              ["是否执行未识别的操作", 780, 400],
              ["取消", 750, 590],
              ["确认", 1100, 590],
            ).texts,
          ],
        };
        const pages = [opened];
        if (stage !== "shop") pages.push(restored);
        if (stage === "daily") pages.push(restored);
        pages.push(overlay);
        const { adapter, d } = harness(pages);

        await expect(
          adapter.dailyGift(new AbortController().signal),
        ).rejects.toThrow("检测到未识别的确认弹窗");

        const allowed = [[1050, 1015]];
        if (stage !== "shop") allowed.push([1746, 984]);
        if (stage === "daily") allowed.push([1814, 604]);
        expect(vi.mocked(d.click).mock.calls.map(([x, y]) => [x, y])).toEqual(
          allowed,
        );
      },
    );
  });

  it("claims only the first free daily gift and verifies its reward", async () => {
    const shop = frame(["热门推荐", 234, 27], ["礼包屋", 1698, 1024]);
    const house = frame(
      ["礼包屋", 1698, 1026],
      ["限时", 1784, 140],
      ["特权", 1788, 696],
      ["日常", 1760, 575],
    );
    const list = frame(
      ["每日礼包", 300, 206],
      ["领取", 326, 448],
      ["每日优惠礼包", 610, 210],
      ["12", 652, 446],
      ["礼包屋", 1698, 1026],
      ["推荐", 226, 123],
    );
    const reward = frame(["每日礼包", 378, 168], ["获得奖励", 716, 279]);
    const detail = frame(["每日礼包", 376, 170], ["免费", 472, 722]);
    const after = frame(
      ["每日礼包", 304, 210],
      ["礼包屋", 1698, 1026],
      ["推荐", 226, 123],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      shop,
      house,
      list,
      reward,
      detail,
      after,
      after,
      shopDistrict,
      courtyard,
    ]);
    const result = await adapter.dailyGift(new AbortController().signal);
    expect(result).toMatchObject({
      status: "succeeded",
      summary: "每日免费礼包已领取，已确认领取入口消失",
      goalSatisfied: true,
    });
    expect(d.click).toHaveBeenCalledWith(376, 468, expect.anything());
    expect(logs.at(-1)).toContain("每日免费礼包已领取");
  });

  it("does not click a priced or already claimed daily gift", async () => {
    const shop = frame(["热门推荐", 234, 27], ["礼包屋", 1698, 1024]);
    const house = frame(
      ["礼包屋", 1698, 1026],
      ["限时", 1784, 140],
      ["特权", 1788, 696],
      ["日常", 1760, 575],
    );
    const list = frame(
      ["每日礼包", 300, 206],
      ["12", 326, 448],
      ["每日优惠礼包", 610, 210],
      ["领取", 652, 446],
      ["礼包屋", 1698, 1026],
      ["推荐", 226, 123],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      shop,
      house,
      list,
      list,
      shopDistrict,
      courtyard,
    ]);
    const result = await adapter.dailyGift(new AbortController().signal);
    expect(result).toMatchObject({
      status: "skipped",
      summary:
        "每日礼包入口显示数字，疑似付费入口；当前未显示免费领取，领取状态未确认，本次未点击",
      skipReason: "unavailable",
      goalSatisfied: null,
    });
    expect(
      vi
        .mocked(d.click)
        .mock.calls.some(
          ([x, y]) => x >= 250 && x <= 500 && y >= 390 && y <= 520,
        ),
    ).toBe(false);
    expect(logs.at(-1)).toContain("疑似付费入口");
  });

  it.each(["2026-09-25", "2026-09-26", "2026-09-27"])(
    "skips Kirin before any observation on closed day %s",
    async (day) => {
      const { adapter, d, logs } = harness([courtyard]);
      await adapter.guildKirin(
        new AbortController().signal,
        new Date(`${day}T03:00:00Z`),
      );
      expect(d.observe).not.toHaveBeenCalled();
      expect(d.click).not.toHaveBeenCalled();
      expect(logs.at(-1)).toContain("开放时段");
    },
  );

  it("skips Kirin before any observation outside weekday hours", async () => {
    const { adapter, d } = harness([courtyard]);
    expect(
      await adapter.guildKirin(
        new AbortController().signal,
        new Date("2026-09-21T21:59:00Z"),
      ),
    ).toMatchObject({
      status: "skipped",
      skipReason: "not-open",
      goalSatisfied: null,
      evidenceTimestamp: expect.any(String),
      evidenceReference: "onmyoji:guild-kirin:calendar",
    });
    expect(d.observe).not.toHaveBeenCalled();
    expect(d.click).not.toHaveBeenCalled();
  });

  it("returns daily gift to courtyard before an off-hours Kirin skip", async () => {
    const shop = frame(["热门推荐", 234, 27], ["礼包屋", 1698, 1024]);
    const house = frame(
      ["礼包屋", 1698, 1026],
      ["限时", 1784, 140],
      ["特权", 1788, 696],
      ["日常", 1760, 575],
    );
    const list = frame(
      ["每日礼包", 300, 206],
      ["礼包屋", 1698, 1026],
      ["推荐", 226, 123],
    );
    const lowMap = frame(
      ["今日挑战", 40, 640],
      ["筛选", 1650, 95],
      ["300", 1770, 91],
    );
    const { adapter, d } = harness([
      courtyard,
      shop,
      house,
      list,
      list,
      shopDistrict,
      courtyard,
      lowMap,
      lowMap,
      lowMap,
      detail("丹霞山", 100),
      lowMap,
    ]);
    await adapter.dailyGift(new AbortController().signal);
    const observations = vi.mocked(d.observe).mock.calls.length;
    await adapter.guildKirin(
      new AbortController().signal,
      new Date("2026-09-19T03:00:00Z"),
    );
    expect(vi.mocked(d.observe).mock.calls).toHaveLength(observations);
    expect(d.click).toHaveBeenCalledWith(75, 60, expect.anything());
    await adapter.realmRaid(new AbortController().signal);
  });

  it("completes one verified guild Kirin challenge without retry", async () => {
    const guild = frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]);
    const shrine = frame(["神社", 1770, 545], ["狩猎战", 328, 639]);
    const hunt = frame(
      ["狩猎战", 226, 29],
      ["雷麒麟", 530, 313],
      ["大人未挑战", 102, 561],
      ["挑战", 1700, 903],
    );
    const ready = frame(["准备", 1696, 843]);
    const battle = frame(["自动", 56, 974], ["当前成绩", 90, 129]);
    const victory = frame(["胜利", 1052, 136], ["本次伤害", 848, 500]);
    const completedHunt = frame(
      ["狩猎战", 226, 29],
      ["雷麒麟", 530, 313],
      ["已挑战", 102, 561],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      guild,
      shrine,
      hunt,
      ready,
      battle,
      victory,
      completedHunt,
      guild,
      courtyard,
    ]);
    const result = await adapter.guildKirin(
      new AbortController().signal,
      new Date("2026-09-17T03:00:00Z"),
    );
    expect(result).toMatchObject({
      status: "succeeded",
      goalSatisfied: true,
      evidenceReference: "onmyoji:guild-kirin:victory-settlement",
      summary: "麒麟挑战胜利，已确认本次伤害结算",
    });
    expect(
      vi.mocked(d.click).mock.calls.filter(([x, y]) => x > 1600 && y > 800),
    ).toHaveLength(2);
    expect(logs.at(-1)).toContain("麒麟挑战胜利");
  });

  it.each([
    ["已挑战", true, "already-completed"],
    ["暂不可挑战", null, "unavailable"],
  ])(
    "distinguishes unavailable Kirin from explicit prior completion: %s",
    async (marker, satisfied, reason) => {
      const guild = frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]);
      const shrine = frame(["神社", 1770, 545], ["狩猎战", 328, 639]);
      const unavailable = frame(
        ["狩猎战", 226, 29],
        ["雷麒麟", 530, 313],
        [marker as string, 102, 561],
      );
      const { adapter, d, logs } = harness([
        courtyard,
        guild,
        shrine,
        unavailable,
        unavailable,
        guild,
        courtyard,
      ]);
      const result = await adapter.guildKirin(
        new AbortController().signal,
        new Date("2026-09-17T03:00:00Z"),
      );
      expect(result).toMatchObject({
        status: "skipped",
        skipReason: reason,
        goalSatisfied: satisfied,
      });
      expect(
        vi.mocked(d.click).mock.calls.filter(([x, y]) => x > 1600 && y > 800),
      ).toHaveLength(0);
      expect(logs.at(-1)).toContain(satisfied ? "无需挑战" : "无法确认");
    },
  );

  it.each([
    ["observed bottom marker", "none", true],
    ["completed with stale challenge controls", "action-markers", true],
    ["no hunt success", "狩猎成功", null],
    ["no prior challenge marker", "已挑战", null],
    ["wrong activity", "狩猎战", null],
    ["no Kirin identity", "雷麒麟", null],
    ["low confidence marker", "low-confidence", null],
    ["misplaced marker", "misplaced", null],
  ])(
    "checks the captured Kirin completion without battle: %s",
    async (_name, change, satisfied) => {
      const observed = structuredClone(kirinCompleted) as Frame;
      if (change === "action-markers") {
        observed.texts.push(
          ...frame(["大人未挑战", 102, 561], ["挑战", 1700, 903]).texts,
        );
      } else if (change === "low-confidence") {
        observed.texts.find((hit) => hit.text === "已挑战")!.score = 0.89;
      } else if (change === "misplaced") {
        observed.texts.find((hit) => hit.text === "已挑战")!.box[0] = 100;
      } else {
        observed.texts = observed.texts.filter((hit) => hit.text !== change);
      }
      const guild = frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]);
      const shrine = frame(["神社", 1770, 545], ["狩猎战", 328, 639]);
      const { adapter, d } = harness([
        courtyard,
        guild,
        shrine,
        ...Array<Frame>(6).fill(observed),
        guild,
        courtyard,
      ]);
      const result = await adapter.guildKirin(
        new AbortController().signal,
        new Date("2026-10-08T14:15:12.170Z"),
      );
      expect(result).toMatchObject({
        status: "skipped",
        goalSatisfied: satisfied,
        ...(satisfied
          ? {
              skipReason: "already-completed",
              evidenceReference:
                "onmyoji:guild-kirin:explicit-completed-marker",
            }
          : {}),
      });
      expect(
        vi.mocked(d.click).mock.calls.filter(([x, y]) => x > 1600 && y > 800),
      ).toHaveLength(0);
      expect(d.swipe).not.toHaveBeenCalled();
    },
  );

  it("does not accept captured Kirin completion behind a dangerous confirmation", async () => {
    const observed = structuredClone(kirinCompleted) as Frame;
    observed.texts.push(
      ...frame(
        ["是否购买挑战次数", 700, 430],
        ["取消", 750, 610],
        ["确认", 1080, 610],
      ).texts,
    );
    const guild = frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]);
    const shrine = frame(["神社", 1770, 545], ["狩猎战", 328, 639]);
    const { adapter, d, logs } = harness([courtyard, guild, shrine, observed]);
    await expect(
      adapter.guildKirin(
        new AbortController().signal,
        new Date("2026-10-08T14:15:12.170Z"),
      ),
    ).rejects.toThrow();
    expect(
      logs.some((message) => message.includes("已确认今日麒麟已挑战")),
    ).toBe(false);
    expect(vi.mocked(d.click).mock.calls).toHaveLength(3);
  });

  it("does not retry after a failed Kirin battle", async () => {
    const guild = frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]);
    const shrine = frame(["神社", 1770, 545], ["狩猎战", 328, 639]);
    const hunt = frame(
      ["狩猎战", 226, 29],
      ["雷麒麟", 530, 313],
      ["大人未挑战", 102, 561],
      ["挑战", 1700, 903],
    );
    const { adapter, d } = harness([
      courtyard,
      guild,
      shrine,
      hunt,
      frame(["准备", 1696, 843]),
      frame(["自动", 56, 974], ["当前成绩", 90, 129]),
      frame(["失败", 1052, 136]),
    ]);
    await expect(
      adapter.guildKirin(
        new AbortController().signal,
        new Date("2026-09-17T03:00:00Z"),
      ),
    ).rejects.toThrow("不会自动重试");
    expect(
      vi.mocked(d.click).mock.calls.filter(([x, y]) => x > 1600 && y > 800),
    ).toHaveLength(2);
  });

  it("does not retry when Kirin battle result remains unknown", async () => {
    const guild = frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]);
    const shrine = frame(["神社", 1770, 545], ["狩猎战", 328, 639]);
    const hunt = frame(
      ["狩猎战", 226, 29],
      ["雷麒麟", 530, 313],
      ["大人未挑战", 102, 561],
      ["挑战", 1700, 903],
    );
    const battle = frame(["自动", 56, 974], ["当前成绩", 90, 129]);
    const { adapter, d } = harness([
      courtyard,
      guild,
      shrine,
      hunt,
      frame(["准备", 1696, 843]),
      battle,
    ]);
    await expect(
      adapter.guildKirin(
        new AbortController().signal,
        new Date("2026-09-17T03:00:00Z"),
      ),
    ).rejects.toThrow("不会重复挑战");
    expect(
      vi.mocked(d.click).mock.calls.filter(([x, y]) => x > 1600 && y > 800),
    ).toHaveLength(2);
  });

  it("submits exactly the remaining collective tasks and claims guild reward", async () => {
    const guild = frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]);
    const shrine = frame(
      ["神社", 1770, 545],
      ["狩猎战", 328, 639],
      ["集体任务", 310, 266],
    );
    const tasks = frame(
      ["集体任务", 814, 65],
      ["提供N阶式神1个", 244, 286],
      ["今日已完成0次", 320, 629],
      ["提交", 410, 718],
      ["领取奖励", 876, 716],
      ["今日已完成次数10/30", 1410, 850],
    );
    const selection = frame(
      ["隐藏已提升技能式神", 336, 657],
      ["可提交的N阶式神不包括呱太", 1348, 686],
    );
    const confirm = frame(
      ["将提交20次任务", 794, 43],
      ["取消", 700, 520],
      ["提交", 1100, 520],
    );
    const reward = frame(["获得奖励", 720, 260]);
    const doneWithClaim = frame(
      ["集体任务", 814, 65],
      ["领取奖励", 876, 716],
      ["已达上限", 884, 720],
      ["今日已完成次数30/30", 1410, 850],
    );
    const done = frame(
      ["集体任务", 814, 65],
      ["已达上限", 884, 720],
      ["今日已完成次数30/30", 1410, 850],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      guild,
      shrine,
      tasks,
      selection,
      confirm,
      reward,
      { ...doneWithClaim, texts: [...doneWithClaim.texts, ...reward.texts] },
      doneWithClaim,
      reward,
      done,
      shrine,
      guild,
      courtyard,
    ]);
    await adapter.guildQuest(new AbortController().signal);
    expect(d.longPress).toHaveBeenCalledWith(330, 850, 1000, expect.anything());
    expect(
      vi.mocked(d.click).mock.calls.filter(([x, y]) => x === 1700 && y === 900),
    ).toHaveLength(3);
    expect(logs.at(-1)).toContain("我爱我寮");
  });

  it("claims Hana only from the verified page", async () => {
    const hana = frame(
      ["花合战", 110, 30],
      ["今日", 360, 120],
      ["全部领取", 1510, 820],
    );
    const reward = frame(["获得奖励", 700, 220], ["花合战", 110, 30]);
    const after = frame(
      ["花合战", 110, 30],
      ["今日", 360, 120],
      ["前往", 1510, 350],
      ["前往", 1510, 550],
    );
    const hanaCourtyard = frame(
      ["探", 840, 208],
      ["加成", 546, 49],
      ["花合战", 1100, 900],
    );
    const { adapter, d, logs } = harness([
      hanaCourtyard,
      hana,
      hana,
      hana,
      reward,
      reward,
      after,
      after,
      hanaCourtyard,
    ]);
    await adapter.hanaClaim(new AbortController().signal);
    expect(d.click).toHaveBeenCalledWith(1560, 840, expect.anything());
    expect(logs.at(-1)).toContain("花合战");
  });

  it("expands the courtyard menu before opening Hana by its verified icon", async () => {
    const hana = frame(
      ["花合战", 110, 30],
      ["今日", 360, 120],
      ["前往", 1510, 350],
      ["前往", 1510, 550],
    );
    const { adapter, d } = harness([
      courtyard,
      courtyard,
      hana,
      hana,
      hana,
      courtyard,
    ]);
    let hanaMatches = 0;
    vi.mocked(d.matchTemplate).mockImplementation(async (name) => {
      if (name === "hana-entry.png") {
        hanaMatches++;
        return hanaMatches === 1
          ? null
          : { box: [1110, 890, 175, 165], score: 0.99 };
      }
      return name === "courtyard-menu-toggle.png"
        ? { box: [1770, 875, 120, 180], score: 0.99 }
        : null;
    });
    await adapter.hanaClaim(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 1830, 965, expect.anything());
    expect(d.click).toHaveBeenNthCalledWith(
      2,
      1197.5,
      972.5,
      expect.anything(),
    );
  });

  it("checks own training before safely skipping an active foster", async () => {
    const guild = frame(["阴阳寮", 934, 35]);
    const training = frame(
      ["式神育成", 130, 45],
      ["我的寄养", 1602, 27],
      ["999999", 94, 597],
      ["03:50:00", 1660, 135],
    );
    const { adapter, d, logs } = harness([
      courtyard,
      guild,
      training,
      training,
      training,
      guild,
      courtyard,
    ]);
    vi.mocked(d.colorSlots).mockResolvedValue([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    const result = await adapter.foster(new AbortController().signal);
    expect(result.outcome).toBe("active");
    expect(Date.parse(result.nextRunAt) - Date.parse(result.observedAt)).toBe(
      230 * 60_000,
    );
    expect(d.matchTemplate).toHaveBeenCalledWith(
      "training-full.png",
      [75, 340, 90, 90],
      0.9,
      expect.anything(),
    );
    expect(logs).toContain("自有结界没有确认满级标记的式神，无需更换");
    expect(logs.at(-1)).toContain("已有式神正在好友结界寄养");
  });

  it("expands the courtyard menu before opening the verified guild entry", async () => {
    const guild = frame(["阴阳寮", 934, 35]);
    const training = frame(["式神育成", 130, 45], ["我的寄养", 1602, 27]);
    const { adapter, d } = harness([
      courtyard,
      guild,
      training,
      training,
      guild,
      courtyard,
    ]);
    let guildMatches = 0;
    vi.mocked(d.matchTemplate).mockImplementation(async (name) => {
      if (name === "guild-entry.png") {
        guildMatches++;
        return guildMatches === 1
          ? null
          : { box: [780, 890, 150, 165], score: 0.99 };
      }
      return name === "courtyard-menu-toggle.png"
        ? { box: [1770, 875, 120, 180], score: 0.99 }
        : null;
    });
    vi.mocked(d.colorSlots).mockResolvedValue([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    await adapter.foster(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 1830, 965, expect.anything());
    expect(d.click).toHaveBeenNthCalledWith(2, 855, 972.5, expect.anything());
  });

  it.each(["single", "stack"])(
    "replaces a confirmed full slot with %s white Daruma",
    async (variant) => {
      const guild = frame(["阴阳寮", 934, 35]);
      const occupied = frame(
        ["式神育成", 130, 45],
        ["我的寄养", 1602, 27],
        ["999999", 94, 597],
      );
      const empty = frame(
        ["式神育成", 130, 45],
        ["我的寄养", 1602, 27],
        ["放入式神", 90, 555],
      );
      const { adapter, d, logs } = harness([
        courtyard,
        guild,
        occupied,
        empty,
        occupied,
        occupied,
        guild,
        courtyard,
      ]);
      vi.mocked(d.colorSlots).mockResolvedValue([
        true,
        false,
        false,
        false,
        false,
        false,
      ]);
      vi.mocked(d.matchTemplate).mockImplementation(async (name, roi) => {
        if (name === "training-full.png")
          return roi[0] === 75 ? { box: [80, 355, 50, 55], score: 0.99 } : null;
        if (
          name ===
          (variant === "stack"
            ? "training-level-one-stack.png"
            : "training-level-one.png")
        )
          return { box: [1400, 743, 53, 50], score: 0.99 };
        if (name !== "foster-white-daruma.png") return null;
        if (roi[1] === 730) return { box: [1450, 780, 100, 160], score: 0.99 };
        if (roi[1] === 300) return { box: [100, 350, 100, 160], score: 0.99 };
        return null;
      });
      await adapter.foster(new AbortController().signal);
      expect(d.click).toHaveBeenCalledWith(170, 470, expect.anything());
      expect(d.click).toHaveBeenCalledWith(1500, 860, expect.anything());
      expect(logs).toContain("自有结界第 1 个满级式神已换成白色达摩");
    },
  );

  it.each(["moved", "occupied"])(
    "rechecks the candidate after removal when inventory is %s",
    async (state) => {
      const guild = frame(["阴阳寮", 934, 35]);
      const occupied = frame(["式神育成", 130, 45], ["我的寄养", 1602, 27]);
      const empty = frame(
        ["式神育成", 130, 45],
        ["我的寄养", 1602, 27],
        ["放入式神", 90, 555],
        ...(state === "occupied"
          ? [["育", 1450, 875] as [string, number, number]]
          : []),
      );
      const { adapter, d } = harness([
        courtyard,
        guild,
        occupied,
        empty,
        occupied,
        occupied,
        guild,
        courtyard,
      ]);
      let removed = false;
      vi.mocked(d.click).mockImplementation(async (x, y) => {
        if (x === 170 && y === 470) removed = true;
      });
      vi.mocked(d.matchTemplate).mockImplementation(async (name, roi) => {
        if (name === "training-full.png")
          return roi[0] === 75 ? { box: [80, 355, 50, 55], score: 0.99 } : null;
        if (name === "training-level-one.png")
          return { box: [1400, 743, 53, 50], score: 0.99 };
        if (name !== "foster-white-daruma.png") return null;
        if (roi[1] === 300) return { box: [100, 350, 100, 160], score: 0.99 };
        if (roi[0] !== 1400) return null;
        return { box: [removed ? 1500 : 1450, 780, 100, 160], score: 0.99 };
      });
      if (state === "moved") {
        await adapter.foster(new AbortController().signal);
        expect(d.click).toHaveBeenCalledWith(1550, 860, expect.anything());
        expect(d.click).not.toHaveBeenCalledWith(1500, 860, expect.anything());
      } else {
        await expect(
          adapter.foster(new AbortController().signal),
        ).rejects.toThrow(/重新确认/);
        expect(d.click).not.toHaveBeenCalledWith(1500, 860, expect.anything());
      }
    },
  );

  it("fills an observed empty training slot without toggling another unit", async () => {
    const guild = frame(["阴阳寮", 934, 35]);
    const empty = frame(
      ["式神育成", 130, 45],
      ["我的寄养", 1602, 27],
      ["放入式神", 90, 555],
    );
    const occupied = frame(["式神育成", 130, 45], ["我的寄养", 1602, 27]);
    const { adapter, d } = harness([
      courtyard,
      guild,
      empty,
      occupied,
      occupied,
      guild,
      courtyard,
    ]);
    vi.mocked(d.matchTemplate).mockImplementation(async (name, roi) => {
      if (name === "training-level-one.png")
        return { box: [1400, 743, 53, 50], score: 0.99 };
      if (name !== "foster-white-daruma.png") return null;
      return {
        box: roi[1] === 300 ? [100, 350, 100, 160] : [1450, 780, 100, 160],
        score: 0.99,
      };
    });
    await adapter.foster(new AbortController().signal);
    expect(d.click).not.toHaveBeenCalledWith(170, 470, expect.anything());
    expect(d.click).toHaveBeenCalledWith(1500, 860, expect.anything());
  });

  it("does not treat a green experience bar as a full training slot", async () => {
    const training = frame(["式神育成", 130, 45], ["我的寄养", 1602, 27]);
    const guild = frame(["阴阳寮", 934, 35]);
    const { adapter, d, logs } = harness([
      courtyard,
      guild,
      training,
      training,
      guild,
      courtyard,
    ]);
    vi.mocked(d.colorSlots).mockResolvedValue([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    await adapter.foster(new AbortController().signal);
    expect(d.click).not.toHaveBeenCalledWith(170, 470, expect.anything());
    expect(logs).toContain("自有结界没有确认满级标记的式神，无需更换");
  });

  it("returns from the own realm using both training-entry anchors", async () => {
    const realm = frame(["结界防守", 490, 580], ["结界卡", 1300, 580]);
    const mailbox = frame(["邮箱", 880, 45], ["删除已读", 280, 910]);
    const { adapter, d } = harness([realm, courtyard, mailbox]);
    await adapter.mail(new AbortController().signal);
    expect(d.click).toHaveBeenNthCalledWith(1, 60, 60, expect.anything());
  });

  it.each([
    { matching: true, returnedDetail: false, observedName: "鸟巢" },
    { matching: false, returnedDetail: false, observedName: "其他鬼王" },
    { matching: true, returnedDetail: true, observedName: "鸟巢" },
    { matching: false, returnedDetail: true, observedName: "其他鬼王" },
    { matching: true, returnedDetail: false, observedName: "乌巢" },
    { matching: true, returnedDetail: true, observedName: "乌巢" },
  ])(
    "waits for persisted score (matching=$matching, returnedDetail=$returnedDetail, observedName=$observedName)",
    async ({ matching, returnedDetail, observedName }) => {
      const pending = detail("鸟巢", 0);
      const { adapter, d, logs } = harness([
        map,
        map,
        map,
        detail("丹霞山"),
        detail("丹霞山"),
        map,
        map,
        detail("少林寺藏经阁"),
        detail("少林寺藏经阁"),
        map,
        map,
        map,
        ...["丹霞山", "少林寺藏经阁", "鸟巢"].flatMap((name) => [
          map,
          frame(["击杀数最多", 1400, 180]),
          frame(
            ["击杀数最多", 1400, 180],
            ["击杀300次", 1300, 420],
            ["击杀200次", 1300, 620],
            ["击杀100次", 1300, 820],
          ),
          detail(name, name === "鸟巢" ? 0 : 100),
        ]),
        ...(returnedDetail ? [pending] : [map, pending]),
        ...(matching
          ? [detail(observedName, 100), detail(observedName, 100), map]
          : [detail(observedName, 100)]),
      ]);
      const battle = vi.spyOn(adapter, "battleCurrent").mockResolvedValue();
      if (matching) {
        const result = await adapter.realmRaid(new AbortController().signal);
        expect(result).toMatchObject({
          status: "succeeded",
          summary: "本次新挑战 1 个地域鬼王，今日通关成绩 3/3 已核对",
        });
      } else
        await expect(
          adapter.realmRaid(new AbortController().signal),
        ).rejects.toThrow("当前对象：其他鬼王");
      expect(battle).toHaveBeenCalledTimes(1);
      if (matching) expect(logs.at(-1)).toContain("3/3");
      expect(d.click).not.toHaveBeenCalledWith(1714, 810, expect.anything());
    },
  );
  it("counts the observed bird-nest alias once across today's records and popular candidates", async () => {
    const names = ["鸟巢", "乌巢", "丹霞山"];
    const { adapter, logs } = harness([
      map,
      map,
      ...names.flatMap((name) => [map, detail(name), detail(name), map]),
      ...names.flatMap((name) => [
        map,
        frame(["击杀数最多", 1400, 180]),
        frame(
          ["击杀数最多", 1400, 180],
          ["击杀300次", 1300, 420],
          ["击杀200次", 1300, 620],
          ["击杀100次", 1300, 820],
        ),
        detail(name),
      ]),
      map,
    ]);
    const battle = vi.spyOn(adapter, "battleCurrent").mockResolvedValue();
    await expect(
      adapter.realmRaid(new AbortController().signal),
    ).rejects.toThrow("已确认 2/3 个");
    expect(battle).not.toHaveBeenCalled();
    expect(logs.some((message) => message.includes("完成 3/3"))).toBe(false);
  });
  it("does not accept a courtyard hidden behind a resume-battle dialog", async () => {
    const f = frame(
      ["探", 840, 208],
      ["加成", 546, 49],
      ["是否继续刚才的战斗？", 740, 452],
      ["确认", 1070, 612],
    );
    const { adapter, d } = harness([f]);
    await expect(adapter.login(new AbortController().signal)).rejects.toThrow(
      "未结束",
    );
    expect(d.click).not.toHaveBeenCalled();
  });
  it("only dismisses a cinematic belonging to a freshly started process", async () => {
    const caption = frame(["测试开场字幕", 780, 905]);
    const cold = harness([frame(), frame(), frame(), caption, map]);
    vi.mocked(cold.d.isAppRunning).mockResolvedValue(false);
    await cold.adapter.login(new AbortController().signal);
    expect(cold.d.click).toHaveBeenCalledTimes(1);
    const warm = harness([frame(), frame(), frame(), caption, map]);
    await warm.adapter.login(new AbortController().signal);
    expect(warm.d.click).not.toHaveBeenCalled();
  });
  it("ignores legal footer text on a valid login screen", async () => {
    const title = frame(
      ["所有用户必须用本人身份信息进行实名登记", 898, 996],
      ["进入游戏", 836, 861],
    );
    const { adapter, d } = harness([title, title, map]);
    await adapter.login(new AbortController().signal);
    expect(d.click).toHaveBeenCalledTimes(1);
  });
  it("does not infer victory from scoring text alone", async () => {
    const normal = detail("万里长城", 0);
    normal.texts.push({ text: "极", box: [408, 174, 68, 60], score: 0.99 });
    const { adapter, logs } = harness([
      normal,
      frame(["1", 490, 280]),
      normal,
      frame(["准备", 1710, 850]),
      frame(["本次评分", 1194, 889]),
    ]);
    await expect(
      adapter.battleCurrent(new AbortController().signal),
    ).rejects.toThrow("战斗超时");
    expect(logs.some((s) => s.includes("已识别战斗胜利"))).toBe(false);
  });
  it("does not start a challenge when difficulty is uncertain", async () => {
    const normal = detail("万里长城", 0);
    normal.texts.push({ text: "极", box: [408, 174, 68, 60], score: 0.99 });
    const { adapter, d } = harness([normal, frame(["11", 490, 280])]);
    await expect(
      adapter.battleCurrent(new AbortController().signal),
    ).rejects.toThrow("1 级");
    expect(vi.mocked(d.click).mock.calls.every(([x]) => x < 1000)).toBe(true);
  });
  it.each([true, false])(
    "recognizes a resumed chores page only with its action controls (verified=%s)",
    async (verified) => {
      const tasks = frame(
        ["庭院事务", 400, 61],
        ...(verified
          ? ([
              ["一键", 1690, 875],
              ["完成", 1676, 950],
            ] as [string, number, number][])
          : []),
      );
      const { adapter, d } = harness([tasks]);
      if (verified) {
        await adapter.login(new AbortController().signal);
        expect(d.startApp).not.toHaveBeenCalled();
      } else
        await expect(
          adapter.login(new AbortController().signal),
        ).rejects.toThrow();
      expect(d.click).not.toHaveBeenCalled();
    },
  );
  it("recognizes existing login without restarting the game", async () => {
    const { d, adapter } = harness([map]);
    expect(await adapter.login(new AbortController().signal)).toMatchObject({
      status: "succeeded",
      goalSatisfied: true,
      evidenceReference: "onmyoji:login:two-frames",
    });
    expect(d.startApp).not.toHaveBeenCalled();
  });
  it("verifies three distinct existing scores without spending stamina", async () => {
    const splitScore = detail("丹霞山");
    splitScore.texts = splitScore.texts.filter(
      (h) => !h.text.startsWith("评分"),
    );
    splitScore.texts.push(
      { text: "评分", box: [1474, 651, 98, 49], score: 0.998 },
      { text: "100", box: [1562, 661, 82, 37], score: 0.998 },
    );
    const { d, logs, adapter } = harness([
      map,
      map,
      map,
      splitScore,
      splitScore,
      map,
      map,
      detail("富士山"),
      detail("富士山"),
      map,
      map,
      detail("黄鹤楼"),
      detail("黄鹤楼"),
      map,
    ]);
    const result = await adapter.realmRaid(new AbortController().signal);
    expect(result).toMatchObject({
      status: "skipped",
      summary: "今日地域鬼王已有通关成绩 3/3，本次未重复挑战",
    });
    expect(logs.at(-1)).toContain("3/3");
    expect(
      vi.mocked(d.click).mock.calls.some(([x, y]) => x > 1600 && y > 750),
    ).toBe(false);
  });
  it("stops before input when cancelled", async () => {
    const { d, adapter } = harness([map]);
    const c = new AbortController();
    c.abort();
    await expect(adapter.realmRaid(c.signal)).rejects.toThrow();
    expect(d.click).not.toHaveBeenCalled();
  });
  it("does not guess clicks on an unknown login screen", async () => {
    const { d, adapter } = harness([frame(["需要密码", 600, 400])]);
    await expect(adapter.login(new AbortController().signal)).rejects.toThrow();
    expect(d.click).not.toHaveBeenCalled();
  });
});
