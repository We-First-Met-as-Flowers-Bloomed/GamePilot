import { expect, it, vi } from "vitest";
import { OnmyojiDaily } from "../games/onmyoji/daily";
import { ownTrainingEntry, fosterCardKind } from "../games/onmyoji/policy";
import type { Frame, GameDevice, VisualHit } from "../packages/runtime/device";
const frame = (...rows: [string, number, number][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: rows.map(([text, x, y]) => ({
    text,
    box: [x, y, 100, 40],
    score: 0.99,
  })),
});

function longFosterList(lastPage = 49, availableSix = true) {
  let page = 0;
  let furthest = 0;
  const list = () =>
    frame(
      ["式神育成", 130, 45],
      ["好友", 364, 164],
      ["进入好友结界寄养式神", 1110, 164],
      ["进入结界", 1226, 819],
      ["好友" + page, 500, 379],
      ["太鼓", 1280, 538],
      ["勾玉+100", 1242, 635],
    );
  const swipe = vi.fn(async () => {
    page = Math.min(lastPage, page + 1);
    furthest = Math.max(furthest, page);
  });
  const daily = new OnmyojiDaily(
    {
      observe: async () => list(),
      click: async () => {},
      swipe,
    } as unknown as GameDevice,
    () => {},
    async () => {},
  );
  const internal = daily as unknown as {
    openFosterTraining(): Promise<Frame>;
    refreshOwnTraining(f: Frame): Promise<Frame>;
    fosterTop(): Promise<Frame>;
    fosterStars(): Promise<number>;
    fosterPanelStars(): Promise<number>;
    stableFosterSelection(): Promise<Frame>;
    tryFosterCandidate(best: { name: string }): Promise<unknown>;
  };
  vi.spyOn(internal, "openFosterTraining").mockResolvedValue(
    frame(["式神育成", 130, 45]),
  );
  vi.spyOn(internal, "refreshOwnTraining").mockImplementation(async (f) => f);
  const top = vi.spyOn(internal, "fosterTop").mockImplementation(async () => {
    page = 0;
    return list();
  });
  vi.spyOn(internal, "fosterStars").mockImplementation(async () =>
    [0, 40, 45, 49].includes(page) ? 1 : 0,
  );
  vi.spyOn(internal, "fosterPanelStars").mockImplementation(async () =>
    page === 0 ? 5 : 6,
  );
  vi.spyOn(internal, "stableFosterSelection").mockImplementation(async () =>
    list(),
  );
  const attempts: { name: string; page: number }[] = [];
  vi.spyOn(internal, "tryFosterCandidate").mockImplementation(async (best) => {
    attempts.push({ name: best.name, page });
    return best.name === (availableSix ? "好友49" : "好友0")
      ? { outcome: "started" }
      : undefined;
  });
  return { daily, top, swipe, attempts, furthest: () => furthest };
}

it.each([true, false])(
  "finishes a long rescan after occupied maximum instead of spending the previous page budget: available six=%s",
  async (availableSix) => {
    const h = longFosterList(49, availableSix);
    await expect(
      h.daily.foster(new AbortController().signal),
    ).resolves.toMatchObject({ outcome: "started" });
    expect(h.top).toHaveBeenCalledTimes(2);
    expect(h.furthest()).toBe(49);
    expect(h.attempts.map((a) => a.name)).toEqual(
      availableSix
        ? ["好友40", "好友45", "好友49"]
        : ["好友40", "好友45", "好友49", "好友0"],
    );
    expect(h.attempts[0].page).toBe(40);
    expect(h.attempts.slice(1).every((a) => a.page === 49)).toBe(true);
    expect(h.swipe.mock.calls.length).toBeLessThan(128);
  },
);

it("retains a finite scan limit when neither traversal reaches the end", async () => {
  const h = longFosterList(200);
  await expect(h.daily.foster(new AbortController().signal)).rejects.toThrow(
    /扫描上限/,
  );
  expect(h.top).toHaveBeenCalledTimes(2);
  expect(h.attempts.map((a) => a.name)).toEqual(["好友40"]);
  expect(h.swipe.mock.calls.length).toBeLessThan(128);
});
it("checks the courtyard after the last permitted back action", async () => {
  let backs = 0;
  const device = {
    observe: async () =>
      backs === 6
        ? frame(["探", 988, 210], ["式神录", 1646, 984])
        : frame(["式神育成", 130, 45]),
    click: async () => {
      backs++;
    },
  } as unknown as GameDevice;
  const daily = new OnmyojiDaily(
    device,
    () => {},
    async () => {},
  );
  await (
    daily as unknown as { leaveToCourtyard(signal: AbortSignal): Promise<void> }
  ).leaveToCourtyard(new AbortController().signal);
  expect(backs).toBe(6);
});
it("waits through loading after a back action instead of clicking a blank scene", async () => {
  let reads = 0;
  const click = vi.fn(async () => {});
  const device = {
    observe: async () =>
      ++reads < 4 ? frame() : frame(["探", 988, 210], ["式神录", 1646, 984]),
    click,
  } as unknown as GameDevice;
  const daily = new OnmyojiDaily(
    device,
    () => {},
    async () => {},
  );
  await (
    daily as unknown as { leaveToCourtyard(signal: AbortSignal): Promise<void> }
  ).leaveToCourtyard(new AbortController().signal);
  expect(click).not.toHaveBeenCalled();
});
it("returns from the observed realm skin when the right sign is partly covered", async () => {
  let back = false;
  const click = vi.fn(async () => {
    back = true;
  });
  const device = {
    observe: async () =>
      back
        ? frame(["探", 988, 210], ["式神录", 1646, 984])
        : frame(["结界防守", 512, 466], ["结界", 1392, 484]),
    click,
  } as unknown as GameDevice;
  await (
    new OnmyojiDaily(
      device,
      () => {},
      async () => {},
    ) as unknown as { leaveToCourtyard(signal: AbortSignal): Promise<void> }
  ).leaveToCourtyard(new AbortController().signal);
  expect(click).toHaveBeenCalledTimes(1);
});
it.each([
  frame(["18岁恶毒小叔的结界", 746, 33], ["寄", 972, 262]),
  frame(
    ["四琪琪的结界", 814, 31],
    ["结界", 450, 589],
    ["防", 454, 639],
    ["结界卡", 1368, 591],
  ),
])(
  "returns from a friend realm whose vertical signs are not fully recognized",
  async (scene) => {
    let back = false;
    const click = vi.fn(async () => {
      back = true;
    });
    const daily = new OnmyojiDaily(
      {
        observe: async () =>
          back ? frame(["探", 988, 210], ["式神录", 1646, 984]) : scene,
        click,
      } as unknown as GameDevice,
      () => {},
      async () => {},
    );
    await (
      daily as unknown as {
        leaveToCourtyard(signal: AbortSignal): Promise<void>;
      }
    ).leaveToCourtyard(new AbortController().signal);
    expect(click).toHaveBeenCalledExactlyOnceWith(
      60,
      60,
      expect.any(AbortSignal),
    );
  },
);
it.each([
  frame(["18岁恶毒小叔的结界", 746, 33]),
  frame(["寄", 972, 262]),
  frame(["结界卡", 1368, 591]),
  frame(["18岁恶毒小叔的结界", 746, 33], ["寄", 100, 900]),
])(
  "does not back from a scene with incomplete friend realm anchors",
  async (scene) => {
    const click = vi.fn(async () => {});
    const daily = new OnmyojiDaily(
      { observe: async () => scene, click } as unknown as GameDevice,
      () => {},
      async () => {},
    );
    await expect(
      (
        daily as unknown as {
          leaveToCourtyard(signal: AbortSignal): Promise<void>;
        }
      ).leaveToCourtyard(new AbortController().signal),
    ).rejects.toThrow(/未能返回庭院/);
    expect(click).not.toHaveBeenCalled();
  },
);
it("publishes confirmed active foster timing even when return navigation fails", async () => {
  const active = frame(
    ["式神育成", 130, 45],
    ["我的寄养", 1600, 30],
    ["05:30:00", 1650, 190],
  );
  const log = vi.fn();
  const daily = new OnmyojiDaily(
    { observe: async () => active } as unknown as GameDevice,
    log,
    async () => {},
  );
  const internal = daily as unknown as {
    openFosterTraining(): Promise<Frame>;
    refreshOwnTraining(): Promise<Frame>;
    leaveToCourtyard(): Promise<void>;
  };
  vi.spyOn(internal, "openFosterTraining").mockResolvedValue(active);
  vi.spyOn(internal, "refreshOwnTraining").mockResolvedValue(active);
  vi.spyOn(internal, "leaveToCourtyard").mockRejectedValue(
    Error("navigation timed out"),
  );
  await expect(daily.foster(new AbortController().signal)).rejects.toThrow(
    "navigation timed out",
  );
  expect(
    log.mock.calls.some(
      (call) => call[1]?.outcome === "active" && call[1]?.nextRunAt,
    ),
  ).toBe(true);
});
it("dismisses a verified bounty invitation before reading the underlying page", async () => {
  let closed = false;
  const click = vi.fn(async () => {
    closed = true;
  });
  const device = {
    observe: async () =>
      closed
        ? frame(["式神育成", 130, 45])
        : frame(
            ["悬赏封印", 834, 234],
            ["接受", 1368, 599],
            ["拒绝", 1370, 758],
          ),
    click,
  } as unknown as GameDevice;
  const daily = new OnmyojiDaily(
    device,
    () => {},
    async () => {},
  );
  const result = await (
    daily as unknown as { shot(signal: AbortSignal): Promise<Frame> }
  ).shot(new AbortController().signal);
  expect(result.texts[0].text).toBe("式神育成");
  expect(click).toHaveBeenCalledWith(1175, 180, expect.any(AbortSignal));
});
it("identifies card name and yield together, never classifying coins as Taiko", () => {
  const card = (name: string, yieldText: string) =>
    frame(
      ["式神育成", 130, 45],
      ["好友", 364, 164],
      ["进入好友结界寄养式神", 1110, 164],
      ["进入结界", 1226, 819],
      [name, 1280, 538],
      [yieldText, 1242, 635],
    );
  expect(fosterCardKind(card("太鼓", "勾玉+30"))).toBe("taiko");
  expect(fosterCardKind(card("斗鱼", "体力+126"))).toBe("douyu");
  expect(fosterCardKind(card("伞室内", "金币+1000"))).toBeUndefined();
  expect(fosterCardKind(card("太鼓", "金币+1000"))).toBeUndefined();
});
it("rechecks and closes consecutive invitations with at most two retries", async () => {
  for (const invitations of [2, 4]) {
    let clicks = 0;
    const device = {
      observe: async () =>
        clicks < invitations
          ? frame(
              ["悬赏封印", 834, 234],
              ["接受", 1368, 599],
              ["拒绝", 1370, 758],
            )
          : frame(["式神育成", 130, 45]),
      click: async () => {
        clicks++;
      },
    } as unknown as GameDevice;
    const daily = new OnmyojiDaily(
      device,
      () => {},
      async () => {},
    );
    const observe = (
      daily as unknown as { shot(signal: AbortSignal): Promise<Frame> }
    ).shot(new AbortController().signal);
    if (invitations === 2)
      expect((await observe).texts[0].text).toBe("式神育成");
    else await expect(observe).rejects.toThrow("悬赏邀请未能关闭");
    expect(clicks).toBe(Math.min(3, invitations));
  }
});
it("locates training between the two observed realm signs despite OCR variants", () => {
  expect(
    ownTrainingEntry(frame(["结界防守", 498, 593], ["熊界卡", 1314, 601])),
  ).toEqual([956, 617]);
  expect(
    ownTrainingEntry(frame(["结界防守", 512, 462], ["结界上", 1392, 486])),
  ).toEqual([1002, 494]);
  expect(ownTrainingEntry(frame(["熊界卡", 1314, 601]))).toBeNull();
});
it("waits for the realm signs to become readable instead of exhausting blind clicks", async () => {
  let reads = 0,
    entered = false;
  const device = {
    observe: async () =>
      entered
        ? frame(["式神育成", 130, 45], ["我的寄养", 1600, 27])
        : ++reads <= 4
          ? frame(["结界防守", 498, 593])
          : frame(["结界防守", 498, 593], ["结界卡", 1316, 603]),
    click: vi.fn(async (x: number, y: number) => {
      if (x === 957 && y === 618) entered = true;
    }),
  } as unknown as GameDevice;
  const daily = new OnmyojiDaily(
    device,
    () => {},
    async () => {},
  );
  const internal = daily as unknown as {
    openGuild(signal: AbortSignal): Promise<Frame>;
    openFosterTraining(signal: AbortSignal): Promise<Frame>;
  };
  vi.spyOn(internal, "openGuild").mockResolvedValue(
    frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]),
  );
  const result = await internal.openFosterTraining(
    new AbortController().signal,
  );
  expect(result.texts[0].text).toBe("式神育成");
  expect(entered).toBe(true);
});
it("can return to the top after scanning a long friend list", async () => {
  let page = 40;
  const device = {
    observe: async () =>
      frame(
        ["式神育成", 130, 45],
        ["好友", 364, 164],
        ["进入好友结界寄养式神", 1110, 164],
        ["进入结界", 1226, 819],
        ["好友" + page, 500, 379],
        ["最近寄养", 702, 349],
        ...(page === 0
          ? [["请输入好友昵称或备注", 362, 266] as [string, number, number]]
          : []),
      ),
    swipe: async () => {
      page = Math.max(0, page - 1);
    },
  } as unknown as GameDevice;
  const daily = new OnmyojiDaily(
    device,
    () => {},
    async () => {},
  );
  await (
    daily as unknown as { fosterTop(signal: AbortSignal): Promise<Frame> }
  ).fosterTop(new AbortController().signal);
  expect(page).toBe(0);
});

it("stops at the top despite small OCR coordinate jitter and output order changes", async () => {
  let swipes = 0;
  const device = {
    observe: async () => {
      const names: [string, number, number][] = [
        ["好友甲", 500, 379 + (swipes % 2 ? 3 : 0)],
        ["好友乙", 500, 539],
      ];
      if (swipes % 2) names.reverse();
      return frame(
        ["式神育成", 130, 45],
        ["好友", 364, 164],
        ["进入好友结界寄养式神", 1110, 164],
        ["进入结界", 1226, 819],
        ...names,
      );
    },
    swipe: async () => {
      swipes++;
    },
  } as unknown as GameDevice;
  const daily = new OnmyojiDaily(
    device,
    () => {},
    async () => {},
  );
  await (
    daily as unknown as { fosterTop(signal: AbortSignal): Promise<Frame> }
  ).fosterTop(new AbortController().signal);
  expect(swipes).toBeLessThanOrEqual(2);
});

it.each([
  { occupiedFirst: true, firstKind: "太鼓", expected: [0, 1] },
  { occupiedFirst: false, firstKind: "太鼓", expected: [0] },
  { occupiedFirst: false, firstKind: "斗鱼", expected: [1] },
])(
  "selects maximum Taiko early, skips occupied friends and never settles early for Douyu: $firstKind/$occupiedFirst",
  async ({ occupiedFirst, firstKind, expected }) => {
    let state = "courtyard",
      selected = 0,
      submitted = 0;
    const entered: number[] = [];
    let downwardSwipes = 0;
    const swipesAtEntry: number[] = [];
    const courtyard = frame(["探", 840, 208], ["加成", 546, 49]);
    const training = frame(["式神育成", 130, 45], ["可寄养式神", 1624, 25]);
    const list = () =>
      frame(
        ["式神育成", 130, 45],
        ["好友", 364, 164],
        ["进入好友结界寄养式神", 1110, 164],
        ["进入结界", 1226, 819],
        ["占用好友", 500, 379 + (downwardSwipes % 2) * 3],
        ["可用好友", 500, 539 + (downwardSwipes % 2) * 3],
        [selected === 0 ? firstKind : "太鼓", 1280, 538],
        [
          selected === 0 && firstKind === "斗鱼" ? "体力+100" : "勾玉+100",
          1242,
          635,
        ],
        ["最近寄养", 700, 325],
      );
    const occupied = frame(
      ["式神育成", 130, 45],
      ["占用好友的结界", 768, 35],
      ["好友寄养", 1344, 25],
      ["其他玩家", 1700, 25],
      ["03:00:00", 1720, 190],
    );
    const empty = () =>
      frame(
        ["式神育成", 130, 45],
        [selected === 0 ? "占用好友的结界" : "可用好友的结界", 768, 35],
        ["好友寄养", 1344, 25],
        ["可放置式神寄养", 1556, 25],
      );
    const active = frame(
      ["式神育成", 130, 45],
      ["可用好友的结界", 768, 35],
      ["好友寄养", 1344, 25],
      ["05:59:58", 1720, 190],
    );
    const device: GameDevice = {
      observe: vi.fn(async () =>
        state === "courtyard"
          ? courtyard
          : state === "guild"
            ? frame(["阴阳寮", 934, 35])
            : state === "training"
              ? training
              : state === "list"
                ? list()
                : state === "occupied"
                  ? occupied
                  : state === "empty"
                    ? empty()
                    : state === "confirm"
                      ? frame(["寄养获得额外40%收益", 660, 700])
                      : active,
      ),
      click: vi.fn(async (x, y) => {
        if (x < 100 && y < 100) {
          state = "courtyard";
          return;
        }
        if (state === "courtyard") {
          state = "guild";
          return;
        }
        if (state === "guild") {
          state = "realm";
          return;
        }
        if (state === "realm") {
          state = "training";
          return;
        }
        if (state === "training") {
          state = "list";
          return;
        }
        if (state === "list") {
          if (x > 1000) {
            entered.push(selected);
            swipesAtEntry.push(downwardSwipes);
            state = selected === 0 && occupiedFirst ? "occupied" : "empty";
          } else selected = y < 480 ? 0 : 1;
          return;
        }
        if (state === "empty") {
          state = "confirm";
          return;
        }
        if (state === "confirm") {
          submitted++;
          state = "active";
        }
      }),
      // Scrolled list icons can be partly clipped; only the fixed detail panel
      // gives a trustworthy star count. Candidate ordering must use that panel.
      colorSlots: vi.fn(async (rois) =>
        rois[0][0] > 1200
          ? [true, true, true, true, true, selected === 0]
          : [true, true, true, false, false, false],
      ),
      matchTemplate: vi.fn(async (name): Promise<VisualHit | null> =>
        name === "foster-white-daruma.png"
          ? { box: [250, 760, 150, 230], score: 0.99 }
          : name === "training-level-one.png"
            ? { box: [250, 760, 40, 40], score: 0.99 }
            : name === "foster-confirm.png"
              ? { box: [900, 720, 100, 50], score: 0.99 }
              : null,
      ),
      swipe: vi.fn(async (_x1, y1, _x2, y2) => {
        if (y1 > y2) downwardSwipes++;
      }),
      longPress: vi.fn(async () => {}),
      startApp: vi.fn(async () => {}),
      packages: vi.fn(async () => []),
      isAppRunning: vi.fn(async () => true),
    };
    const messages: string[] = [];
    const daily = new OnmyojiDaily(
      device,
      (m) => messages.push(m),
      async () => {},
    );
    const top = vi.spyOn(
      daily as unknown as { fosterTop(signal: AbortSignal): Promise<Frame> },
      "fosterTop",
    );
    const result = await daily.foster(new AbortController().signal);
    if (firstKind === "太鼓" && !occupiedFirst)
      expect(top).toHaveBeenCalledTimes(1);
    expect(entered).toEqual(expected);
    expect(submitted).toBe(1);
    expect(result.outcome).toBe("started");
    expect(downwardSwipes).toBeLessThan(6);
    if (firstKind === "太鼓") expect(swipesAtEntry[0]).toBe(0);
    if (expected.includes(1)) {
      expect(swipesAtEntry.at(-1)).toBeGreaterThan(0);
      expect(messages.some((m) => m.includes("5 星太鼓"))).toBe(true);
    }
  },
);

it("rechecks the selected maximum candidate before entry even when skipping the return to top", async () => {
  const selected = frame(
    ["式神育成", 130, 45],
    ["好友", 364, 164],
    ["进入好友结界寄养式神", 1110, 164],
    ["进入结界", 1226, 819],
    ["好友甲", 500, 379],
    ["太鼓", 1280, 538],
    ["勾玉+100", 1242, 635],
  );
  const click = vi.fn(
    async (_x: number, _y: number, _signal: AbortSignal) => {},
  );
  const daily = new OnmyojiDaily(
    { click } as unknown as GameDevice,
    () => {},
    async () => {},
  );
  const internal = daily as unknown as {
    fosterTop(): Promise<Frame>;
    stableFosterSelection(): Promise<Frame>;
    fosterPanelStars(): Promise<number>;
    tryFosterCandidate(
      best: unknown,
      signal: AbortSignal,
      current: Frame,
    ): Promise<unknown>;
  };
  const top = vi
    .spyOn(internal, "fosterTop")
    .mockRejectedValue(Error("unnecessary return to top"));
  vi.spyOn(internal, "stableFosterSelection").mockResolvedValue(selected);
  vi.spyOn(internal, "fosterPanelStars").mockResolvedValue(5);
  const result = await internal.tryFosterCandidate(
    { name: "好友甲", kind: "taiko", stars: 6, page: 36, row: 0 },
    new AbortController().signal,
    selected,
  );
  expect(result).toBeUndefined();
  expect(top).not.toHaveBeenCalled();
  expect(click).toHaveBeenCalledTimes(1);
  expect(click.mock.calls[0][0]).toBe(650);
});
