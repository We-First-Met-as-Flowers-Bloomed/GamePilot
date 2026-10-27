import { describe, it, expect } from "vitest";
import {
  quotaFor,
  dailySignClosePoint,
  signInRewardClosePoint,
  isMakaiHourPage,
  restoreBuffCancel,
  centralConfirmation,
  fullTrainingExtractionCancel,
  personalScore,
  bossName,
  findText,
  isMap,
  isVictory,
  isCourtyard,
  isExploration,
  gameDay,
  isMailbox,
  isMailClaimConfirm,
  isMailReward,
  isIllustrationReward,
  isShop,
  isShopDistrict,
  isGiftHouse,
  isDailyGiftList,
  isDailyGiftDetail,
  dailyGiftAction,
  isGuild,
  isShrine,
  isKirinHunt,
  isKirinVictory,
  isGuildKirinWindow,
  isCollectiveTaskPage,
  collectiveTaskTarget,
  chooseFosterCandidate,
  isFosterFriendList,
  isTrainingPage,
  isFriendRealm,
  isFosterActive,
  isHanaPage,
  hanaClaimAction,
  collectiveProgress,
  fosterNames,
} from "../games/onmyoji/policy";
import type { Frame } from "../packages/runtime/device";
import illustrationFirst from "./fixtures/onmyoji/mail-illustration-first.json";
import illustrationLast from "./fixtures/onmyoji/mail-illustration-last.json";
const frame = (...entries: [string, number, number, number?][]): Frame => ({
  width: 1920,
  height: 1080,
  texts: entries.map(([text, x, y, score = 0.99]) => ({
    text,
    box: [x, y, 100, 40],
    score,
  })),
});
describe("makai hour page (2026-10-16 live frame, lane-a)", () => {
  it("recognizes the full-screen 逢魔之时 map so the courtyard can back out of it", () => {
    // 实机帧：标题「逢魔之时」+「今日挑战次数：2/2」+ 底部「现世逢魔 0/4」。
    // 卡点：courtyard() 原来没有这一页的退路 → 进来就出不去 →
    // 整条阴阳师日常报「进入庭院检查每日签到失败」。
    const makai = frame(
      ["逢魔之时", 810, 20],
      ["今日挑战次数：2/2", 820, 110],
      ["现世逢魔0/4", 1670, 1030],
    );
    expect(isMakaiHourPage(makai)).toBe(true);
    // 只有标题没有别的元素不认（避免命中探索页里同名的入口文字）。
    expect(isMakaiHourPage(frame(["逢魔之时", 810, 20]))).toBe(false);
    // 普通庭院不误判。
    expect(isMakaiHourPage(frame(["庭院", 100, 40]))).toBe(false);
  });
});

describe("sign-in reward popup (2026-10-16 live frame, lane-a)", () => {
  it("recognizes it only with all three texts and closes via the fixed ✕", () => {
    // 现场帧：领取成功 / 第839签 半吉 / 点击空白处关闭 —— 奖励**已经发放**，
    // 但弹窗盖住庭院，courtyard() 认不出庭院 → 整条阴阳师日常报
    // "进入庭院检查每日签到失败"（当天两个账号都被这一句挡住）。
    const popup = frame(
      ["第839签", 780, 200],
      ["半吉", 980, 200],
      ["累计奖励", 710, 740],
      ["点击空白处关闭", 990, 1030],
    );
    expect(signInRewardClosePoint(popup)).toEqual([1320, 158]);
    // 三处稳定元素缺任何一处都不认，避免把别的弹窗误判成签到奖励。
    // （「领取成功」是淡出标题，实测稍后就没有了，所以**不**拿它当判据。）
    expect(
      signInRewardClosePoint(
        frame(["第839签", 780, 200], ["点击空白处关闭", 990, 1030]),
      ),
    ).toBeUndefined();
    expect(
      signInRewardClosePoint(
        frame(["累计奖励", 900, 700], ["点击空白处关闭", 990, 1030]),
      ),
    ).toBeUndefined();
    // 普通庭院画面不会被误判。
    expect(
      signInRewardClosePoint(frame(["庭院", 100, 40], ["探索", 300, 200])),
    ).toBeUndefined();
  });
});

describe("Onmyoji observed daily policy", () => {
  it("recognizes unranked zero score only with both observed rank markers", () => {
    expect(
      personalScore(
        frame(["评分", 1472, 649], ["无", 1088, 657], ["无", 1364, 659]),
      ),
    ).toBe(0);
    expect(
      personalScore(frame(["评分", 1472, 649], ["无", 1088, 657])),
    ).toBeNull();
  });
  it("requires victory title and score panel, not score text alone", () => {
    expect(isVictory(frame(["本次评分", 1194, 889]))).toBe(false);
    expect(isVictory(frame(["生利", 1048, 146], ["本次评分", 1194, 889]))).toBe(
      true,
    );
    expect(isVictory(frame(["失败", 1048, 146], ["本次评分", 1194, 889]))).toBe(
      false,
    );
  });
  it("uses verified reputation thresholds and rejects invalid input", () => {
    expect([300, 1999, 2000, 9999, 10000, 12440].map(quotaFor)).toEqual([
      1, 1, 2, 2, 3, 3,
    ]);
    expect(() => quotaFor(NaN)).toThrow();
    expect(() => quotaFor(-1)).toThrow();
  });
  it("only reads personal score, not leaderboard player score", () => {
    expect(
      personalScore(frame(["评分39127", 1474, 651], ["评分92899", 1354, 823])),
    ).toBe(39127);
    expect(personalScore(frame(["评分92899", 1354, 823]))).toBeNull();
  });
  it("does not accept low-confidence text or wrong screens", () => {
    expect(
      findText(frame(["今日挑战", 40, 640, 0.3]), /今日挑战/),
    ).toBeUndefined();
    expect(isMap(frame(["今日挑战", 40, 640], ["筛选", 1650, 95]))).toBe(true);
    expect(isMap(frame(["今日挑战", 40, 640]))).toBe(false);
  });
  it("extracts boss location separately from broadcast and other player names", () => {
    expect(bossName(frame(["万里长城", 196, 71], ["莲之净", 1116, 837]))).toBe(
      "万里长城",
    );
  });
  it.each(["鸟巢", "乌巢", "乌巢！", "乌 巢"])(
    "normalizes the observed full boss title alias (%s)",
    (name) => {
      expect(bossName(frame([name, 196, 71]))).toBe("鸟巢");
    },
  );
  it.each(["乌巢寺", "鸟巢寺", "乌镇", "鸟取", "少林寺藏经阁"])(
    "does not alter a different complete boss title (%s)",
    (name) => {
      expect(bossName(frame([name, 196, 71]))).toBe(name);
    },
  );
  it("does not normalize a low-confidence or off-title alias into boss identity", () => {
    expect(bossName(frame(["乌巢", 196, 71, 0.3]))).toBeNull();
    expect(bossName(frame(["乌巢", 1116, 837]))).toBeNull();
  });
  it("uses China 6am refresh boundary", () => {
    expect(gameDay(new Date("2026-09-14T21:59:00Z"))).toBe("2026-09-14");
    expect(gameDay(new Date("2026-09-14T22:00:00Z"))).toBe("2026-09-15");
  });
  it("recognizes the observed mail states from independent labels", () => {
    expect(isMailbox(frame(["邮箱", 910, 81], ["删除已读", 530, 915]))).toBe(
      true,
    );
    expect(isMailbox(frame(["邮箱", 910, 81]))).toBe(false);
    expect(
      isMailClaimConfirm(frame(["全部领取", 834, 67], ["确定", 1106, 833])),
    ).toBe(true);
    expect(isMailReward(frame(["获得奖励", 720, 206], ["邮箱", 916, 89]))).toBe(
      true,
    );
  });
  it("recognizes real illustration overlays without relying on obscured mailbox text", () => {
    expect(isIllustrationReward(illustrationFirst as Frame)).toBe(true);
    expect(isIllustrationReward(illustrationLast as Frame)).toBe(true);
  });
  it.each([
    frame(["获得插画", 776, 81]),
    frame(["插画收集：第65张", 828, 974]),
    frame(["获得插画", 776, 81, 0.5], ["插画收集：第65张", 828, 974]),
    frame(["获得插画", 776, 500], ["插画收集：第65张", 828, 974]),
    frame(["获得插画", 776, 81], ["插画收集：第65张", 828, 500]),
  ])(
    "rejects incomplete, low confidence, or misplaced illustration labels",
    (f) => {
      expect(isIllustrationReward(f)).toBe(false);
    },
  );
  it("recognizes the shop and binds claim to the first daily gift card", () => {
    expect(isShop(frame(["热门推荐", 234, 27], ["礼包屋", 1698, 1024]))).toBe(
      true,
    );
    expect(
      isShopDistrict(
        frame(
          ["周边屋", 112, 1026],
          ["魂玉屋", 1490, 1024],
          ["礼包屋", 1700, 1026],
        ),
      ),
    ).toBe(true);
    // 2026-10-14 实拍帧：OCR 把「周边屋」读成「周边」（0.999），其余两项正常读出。
    expect(
      isShopDistrict(
        frame(
          ["周边", 114, 1028],
          ["魂玉屋", 1492, 1022],
          ["礼包屋", 1700, 1026],
        ),
      ),
    ).toBe(true);
    // 三个导航锚点仍然缺一不可：少一项就必须判否，不能继续往商店深处点。
    expect(isShopDistrict(frame(["礼包屋", 1700, 1026]))).toBe(false);
    expect(
      isShopDistrict(frame(["周边", 114, 1028], ["礼包屋", 1700, 1026])),
    ).toBe(false);
    expect(isShopDistrict(frame(["周边", 114, 1028]))).toBe(false);
    expect(
      isGiftHouse(
        frame(
          ["礼包屋", 1698, 1026],
          ["限时", 1784, 140],
          ["特权", 1788, 696],
          ["日常", 1760, 575],
        ),
      ),
    ).toBe(true);
    const list = frame(
      ["每日礼包", 300, 206],
      ["领取", 326, 448],
      ["每日优惠礼包", 610, 210],
      ["12", 652, 446],
      ["礼包屋", 1698, 1026],
      ["推荐", 226, 123],
    );
    expect(isDailyGiftList(list)).toBe(true);
    expect(
      isDailyGiftDetail(frame(["每日礼包", 376, 170], ["免费", 472, 722])),
    ).toBe(true);
    expect(dailyGiftAction(list)?.text).toBe("领取");
    expect(
      dailyGiftAction(
        frame(
          ["每日礼包", 300, 206],
          ["12", 326, 448],
          ["领取", 652, 446],
          ["礼包屋", 1698, 1026],
          ["推荐", 226, 123],
        ),
      ),
    ).toBeUndefined();
    for (const price of ["勾玉12", "金币1000", "售价12", "1.2万", "12魂玉"]) {
      expect(
        dailyGiftAction(
          frame(
            ["每日礼包", 300, 206],
            [price, 326, 448],
            ["领取", 330, 470],
            ["礼包屋", 1698, 1026],
            ["推荐", 226, 123],
          ),
        ),
      ).toBeUndefined();
    }
  });
  it("recognizes guild, shrine, hunt and Kirin victory screens", () => {
    expect(isGuild(frame(["阴阳寮", 934, 35], ["狩猎战", 14, 375]))).toBe(true);
    expect(isGuild(frame(["阴阳寮", 994, 35]))).toBe(true);
    expect(isGuild(frame(["阴阳察", 732, 41], ["狩猎战", 12, 375]))).toBe(true);
    expect(
      isShrine(
        frame(["神社", 1770, 545], ["集体任务", 310, 270], ["道馆", 720, 270]),
      ),
    ).toBe(true);
    expect(isShrine(frame(["神社", 1770, 545]))).toBe(false);
    expect(isShrine(frame(["神社", 1770, 545], ["狩猎战", 328, 639]))).toBe(
      true,
    );
    expect(isShrine(frame(["@神社", 1772, 541], ["狩猎战", 328, 639]))).toBe(
      true,
    );
    expect(isKirinHunt(frame(["狩猎战", 226, 29], ["雷麒麟", 530, 313]))).toBe(
      true,
    );
    expect(
      isKirinVictory(frame(["胜利", 1052, 136], ["本次伤害", 848, 500])),
    ).toBe(true);
  });
  it("gates guild Kirin by China weekday and 06:00-23:00", () => {
    expect(isGuildKirinWindow(new Date("2026-09-18T03:00:00Z"))).toBe(false); // Friday 11:00
    expect(isGuildKirinWindow(new Date("2026-09-17T14:59:00Z"))).toBe(true); // Thursday 22:59
    expect(isGuildKirinWindow(new Date("2026-09-17T15:00:00Z"))).toBe(false); // Thursday 23:00
    expect(isGuildKirinWindow(new Date("2026-09-18T21:59:00Z"))).toBe(false); // Saturday 05:59
    expect(isGuildKirinWindow(new Date("2026-09-19T03:00:00Z"))).toBe(false); // Saturday
    expect(isGuildKirinWindow(new Date("2026-09-20T03:00:00Z"))).toBe(false); // Sunday
    expect(isGuildKirinWindow(new Date("2026-09-21T21:59:00Z"))).toBe(false); // Tuesday 05:59
    expect(isGuildKirinWindow(new Date("2026-09-21T22:00:00Z"))).toBe(true); // Tuesday 06:00
    expect(isGuildKirinWindow(new Date("2026-09-22T15:00:00Z"))).toBe(false); // Tuesday 23:00
  });
  it("handles observed decorative-font OCR and merged toolbar labels", () => {
    expect(
      isMap(frame(["今目挑战", 38, 633, 0.86], ["地域最强", 42, 825, 0.99])),
    ).toBe(true);
    expect(isCourtyard(frame(["探", 840, 208], ["加成", 546, 49]))).toBe(true);
    expect(isCourtyard(frame(["加成", 546, 49]))).toBe(true);
    expect(
      isExploration(
        frame(["式神委派秘闻副本地域鬼王妖气探索英杰试炼契灵之境", 642, 1024]),
      ),
    ).toBe(true);
  });

  it("accepts only the observed N-rarity collective task", () => {
    const target = frame(
      ["集体任务", 814, 65],
      ["提供N阶式神1个", 412, 305],
      ["今日已完成0次", 460, 568],
      ["提交", 548, 706],
      ["刷新", 823, 724],
    );
    expect(isCollectiveTaskPage(target)).toBe(true);
    expect(collectiveTaskTarget(target)?.text).toBe("提供N阶式神1个");
    expect(
      collectiveProgress(
        frame(["集体任务", 814, 65], ["今日已完成次数10/30", 1410, 850]),
      ),
    ).toEqual({ completed: 10, total: 30 });
    expect(
      collectiveTaskTarget(
        frame(
          ["集体任务", 814, 65],
          ["捐赠御魂1个", 412, 305],
          ["提交", 548, 706],
          ["刷新", 823, 724],
        ),
      ),
    ).toBeUndefined();
  });

  it("extracts visible foster friend rows without treating OCR nines as stars", () => {
    expect(
      fosterNames(
        frame(
          ["式神育成", 130, 45],
          ["好友", 366, 166],
          ["进入好友结界寄养式神", 1108, 162],
          ["进入结界", 1226, 819],
          ["清醒的天地招魂幡", 504, 379],
          ["99999", 830, 422],
          ["叶子想要变欧", 500, 540],
          ["9999", 834, 587],
        ),
      ),
    ).toEqual([
      { name: "清醒的天地招魂幡", y: 399 },
      { name: "叶子想要变欧", y: 560 },
    ]);
  });

  it("chooses highest-star Taiko before any Douyu", () => {
    expect(
      chooseFosterCandidate([
        { kind: "douyu", stars: 6, page: 0, row: 1 },
        { kind: "taiko", stars: 4, page: 1, row: 2 },
        { kind: "taiko", stars: 6, page: 2, row: 3 },
        { kind: "taiko", stars: 6, page: 0, row: 0 },
      ]),
    ).toEqual({ kind: "taiko", stars: 6, page: 0, row: 0 });
    expect(
      chooseFosterCandidate([
        { kind: "douyu", stars: 4, page: 1, row: 1 },
        { kind: "douyu", stars: 6, page: 0, row: 2 },
      ]),
    ).toEqual({ kind: "douyu", stars: 6, page: 0, row: 2 });
    expect(
      chooseFosterCandidate([
        { kind: "taiko", stars: 0, page: 0, row: 0 },
        { kind: "douyu", stars: 7, page: 0, row: 1 },
      ]),
    ).toBeUndefined();
  });

  it("recognizes foster friend list and Hana claim only with page anchors", () => {
    expect(
      isFosterFriendList(
        frame(
          ["式神育成", 130, 45],
          ["好友", 366, 166],
          ["进入好友结界寄养式神", 1108, 162],
          ["进入结界", 1226, 819],
        ),
      ),
    ).toBe(true);
    expect(isFosterFriendList(frame(["进入结界", 1226, 819]))).toBe(false);
    const hana = frame(
      ["花合战", 110, 30],
      ["今日", 360, 120],
      ["全部领取", 1510, 820],
    );
    expect(isHanaPage(hana)).toBe(true);
    expect(hanaClaimAction(hana)?.text).toBe("全部领取");
    expect(hanaClaimAction(frame(["全部领取", 1510, 820]))).toBeUndefined();
  });

  it("distinguishes own training, friend realm and active foster states", () => {
    expect(
      isFosterActive(
        frame(
          ["式神育成", 130, 45],
          ["神秘的天照猫耳的结界", 690, 35],
          ["好友寄养", 1340, 27],
          ["05:59:58", 1720, 190],
        ),
      ),
    ).toBe(true);
    expect(
      isTrainingPage(frame(["式神育成", 130, 45], ["可寄养式神", 1640, 135])),
    ).toBe(true);
    expect(
      isFriendRealm(
        frame(
          ["式神育成", 130, 45],
          ["夏目友人的结界", 850, 65],
          ["可放置式神寄养", 1650, 90],
        ),
      ),
    ).toBe(true);
    expect(
      isFosterActive(
        frame(
          ["式神育成", 130, 45],
          ["夏目友人的结界", 850, 65],
          ["好友寄养", 1600, 135],
          ["05:59:58", 1720, 190],
        ),
      ),
    ).toBe(true);
    expect(
      isFosterActive(
        frame(
          ["式神育成", 130, 45],
          ["夏目友人的结界", 850, 65],
          ["可放置式神寄养", 1650, 90],
        ),
      ),
    ).toBe(false);
  });
  it.each([1292, 1556])(
    "recognizes the empty slot tooltip with one or two unlocked slots at x=%s",
    (x) => {
      const empty = frame(
        ["式神育成", 128, 43],
        ["白兔灰灰的结界", 798, 35],
        ["好友寄养", 1340, 27],
        ["可放置式神寄养", x, 23],
        ["05:59:58", 1720, 190],
      );
      expect(isFriendRealm(empty)).toBe(true);
      expect(isFosterActive(empty)).toBe(false);
      expect(isFriendRealm(frame(["可放置式神寄养", x, 23]))).toBe(false);
    },
  );
  it("does not confuse the static friend-foster label on an empty slot with active placement", () => {
    const empty = frame(
      ["式神育成", 130, 45],
      ["她不回消息的结界", 768, 35],
      ["好友寄养", 1344, 25],
      ["可放置式神寄养", 1556, 25],
    );
    expect(isFosterActive(empty)).toBe(false);
  });
});

describe("split personal score observed on Danxia after victory", () => {
  const detail = (extra: Frame["texts"] = []): Frame => ({
    width: 1920,
    height: 1080,
    texts: [
      { text: "评分", box: [1474, 651, 98, 49], score: 0.997859 },
      { text: "100", box: [1562, 661, 82, 37], score: 0.998312 },
      { text: "世界31180", box: [970, 651, 202, 53], score: 0.999394 },
      { text: "6", box: [1364, 663, 42, 33], score: 0.986262 },
      { text: "评分92950", box: [1354, 823, 160, 40], score: 0.99 },
      ...extra,
    ],
  });
  it("reads adjacent label and number in personal row", () => {
    expect(personalScore(detail())).toBe(100);
  });
  it("rejects ambiguous or low-confidence split numbers", () => {
    expect(
      personalScore(
        detail([{ text: "200", box: [1650, 661, 50, 37], score: 0.99 }]),
      ),
    ).toBeNull();
    const f = detail();
    f.texts[1].score = 0.4;
    expect(personalScore(f)).toBeNull();
  });
  it("does not substitute rank, player score or off-row numbers", () => {
    const f = detail();
    f.texts.splice(1, 1);
    expect(personalScore(f)).toBeNull();
    f.texts.push({ text: "100", box: [1562, 760, 82, 37], score: 0.99 });
    expect(personalScore(f)).toBeNull();
  });
});

describe("observed sign and buff overlays", () => {
  const extraction = () =>
    frame(
      ["您在结界中放置的式神已满", 676, 424],
      ["级，请确认是否提取？", 736, 480],
      ["取消", 754, 609],
      ["确认", 1064, 609],
    );

  it("recognizes only the observed realm extraction question and selects cancel", () => {
    const f = extraction();
    expect(fullTrainingExtractionCancel(f)).toBe(f.texts[2]);
    expect(centralConfirmation(f)).toEqual({
      cancel: f.texts[2],
      confirm: f.texts[3],
    });
  });

  it.each([
    "missing-question",
    "wrong-question",
    "low-confidence",
    "wrong-location",
    "missing-cancel",
    "missing-confirm",
    "misaligned-controls",
  ])(
    "does not dismiss a partial or mismatching realm extraction dialog (%s)",
    (variant) => {
      const f = extraction();
      if (variant === "missing-question") f.texts.splice(0, 1);
      if (variant === "wrong-question") f.texts[0].text = "是否购买满级式神";
      if (variant === "low-confidence") f.texts[0].score = 0.8;
      if (variant === "wrong-location") f.texts[0].box[1] = 100;
      if (variant === "missing-cancel") f.texts.splice(2, 1);
      if (variant === "missing-confirm") f.texts.splice(3, 1);
      if (variant === "misaligned-controls") f.texts[3].box[1] = 710;
      expect(fullTrainingExtractionCancel(f)).toBeUndefined();
    },
  );

  it("does not infer a central confirmation from a lone control or page labels", () => {
    expect(centralConfirmation(frame(["确认", 1064, 609]))).toBeUndefined();
    expect(centralConfirmation(frame(["取消", 754, 609]))).toBeUndefined();
    expect(
      centralConfirmation(frame(["取消", 100, 50], ["确认", 1064, 609])),
    ).toBeUndefined();
  });

  it("requires both anchors before choosing a sign close control", () => {
    expect(dailySignClosePoint(frame(["第818签", 706, 168]))).toBeNull();
    expect(dailySignClosePoint(frame(["解签", 1400, 555]))).toBeNull();
    expect(
      dailySignClosePoint(frame(["第818签", 706, 168], ["解签", 1400, 555])),
    ).toEqual([1310, 160]);
    expect(
      dailySignClosePoint(frame(["第811签", 1100, 120], ["解签", 1640, 680])),
    ).toEqual([1605, 105]);
  });
  it("does not dismiss unrelated confirmations or partial buff text", () => {
    expect(
      restoreBuffCancel(
        frame(
          ["是否购买加成", 700, 430],
          ["取消", 750, 610],
          ["确认", 1080, 610],
        ),
      ),
    ).toBeUndefined();
    expect(
      restoreBuffCancel(
        frame(
          ["是否打开大人之前被自动关闭的加成", 700, 430],
          ["确认", 1080, 610],
        ),
      ),
    ).toBeUndefined();
  });
});
