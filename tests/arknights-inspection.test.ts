import { expect, it } from "vitest";
import {
  defaultArknightsConfig,
  validateArknightsConfig,
  validateArknightsProfiles,
  activeArknightsConfig,
} from "../games/arknights/config";
import {
  classifyArknightsFrame,
  compareArknightsFrames,
} from "../games/arknights/inspection";
import type { Frame, TextHit } from "../packages/runtime/device";
import shop from "./fixtures/arknights/credit-shop-b.json";
import { recognizeIncidentScreen } from "../games/agent-recovery";
import friendsNavigation from "./fixtures/arknights/friends-list-navigation.json";
it("recognizes actual friend-list OCR with the icon read as a leading 1", () => {
  expect(
    classifyArknightsFrame(
      friendsNavigation as Frame,
      "com.hypergryph.arknights",
      defaultArknightsConfig,
    ).page,
  ).toBe("friends-list");
  expect(recognizeIncidentScreen(friendsNavigation as Frame, "arknights")).toBe(
    "friends-list",
  );
});
it("purchase and exit confirmation overlays block shop navigation", () => {
  for (const text of ["确认购买", "购买", "是否退出", "是否放弃作战"]) {
    const frame: Frame = {
      ...(shop as Frame),
      texts: [
        ...(shop as Frame).texts,
        { text, score: 0.99, box: [700, 600, 180, 40] },
      ],
    };
    expect(
      classifyArknightsFrame(
        frame,
        "com.hypergryph.arknights",
        defaultArknightsConfig,
      ).page,
    ).toBe("unknown");
  }
});
const hit = (text: string, x: number, y: number, score = 0.99): TextHit => ({
  text,
  box: [x, y, 160, 30],
  score,
});
it("recognizes friends list separately from own profile and reports only known scene to Agent", () => {
  const frame: Frame = {
    width: 1920,
    height: 1080,
    texts: [
      hit("我的信息", 1070, 50),
      hit("个人名片", 110, 175),
      hit("好友列表", 110, 315),
      hit("添加好友", 110, 450),
      hit("助战干员", 110, 580),
      hit("好友 63/150", 30, 1000),
    ],
  };
  expect(
    classifyArknightsFrame(
      frame,
      "com.hypergryph.arknights",
      defaultArknightsConfig,
    ).page,
  ).toBe("friends-list");
  expect(recognizeIncidentScreen(frame, "arknights")).toBe("friends-list");
  expect(recognizeIncidentScreen(frame, "onmyoji")).toBe("unknown");
  expect(recognizeIncidentScreen(shop as Frame, "arknights")).toBe(
    "credit-shop",
  );
  const dialog = { ...frame, texts: [...frame.texts, hit("确定", 800, 650)] };
  expect(
    classifyArknightsFrame(
      dialog,
      "com.hypergryph.arknights",
      defaultArknightsConfig,
    ).page,
  ).toBe("unknown");
});
const home = (uid = "123456789"): Frame => ({
  width: 1920,
  height: 1080,
  texts: [
    hit("ID: " + uid, 84, 633),
    hit("任务", 1064, 913),
    hit("基建", 1384, 948),
    hit("公开招募", 1402, 764),
    hit("干员", 1396, 563),
  ],
});
const pkg = "com.hypergryph.arknights.bilibili";
const config = {
  ...defaultArknightsConfig,
  clientType: "Bilibili" as const,
  expectedUid: "123456789",
};
it("recognizes only the own-profile layout and labelled UID without treating it as home", () => {
  const frame: Frame = {
    width: 1920,
    height: 1080,
    texts: [
      hit("我的信息", 1070, 50),
      hit("个人名片", 110, 175),
      hit("好友列表", 110, 315),
      hit("添加好友", 110, 450),
      hit("助战干员", 110, 580),
      hit("ID 123456789", 1250, 310),
    ],
  };
  const found = classifyArknightsFrame(frame, pkg, config);
  expect(found).toMatchObject({ page: "profile", uid: config.expectedUid });
  expect(compareArknightsFrames(found, found, config).accountVerified).toBe(
    false,
  );
  expect(
    classifyArknightsFrame(
      { ...frame, texts: frame.texts.filter((h) => h.text !== "我的信息") },
      pkg,
      config,
    ).page,
  ).toBe("unknown");
  expect(
    classifyArknightsFrame(
      { ...frame, texts: [...frame.texts, hit("ID 111111111", 1250, 345)] },
      pkg,
      config,
    ).uid,
  ).toBeUndefined();
  expect(classifyArknightsFrame(frame, "other.app", config).page).toBe(
    "other-app",
  );
});
it("preserves UID through profile saving and active configuration", () => {
  const profiles = validateArknightsProfiles({
    version: 1,
    activeProfileId: "main",
    profiles: [{ ...config, id: "main", name: "Main" }],
  });
  expect(profiles.profiles[0].expectedUid).toBe(config.expectedUid);
  expect(activeArknightsConfig(profiles).expectedUid).toBe(config.expectedUid);
});
it("migrates old profiles without trusting the startup matching text", () => {
  expect(
    validateArknightsConfig({
      ...defaultArknightsConfig,
      accountName: "123456789",
    }).expectedUid,
  ).toBe("");
  expect(validateArknightsConfig(config).expectedUid).toBe("123456789");
  expect(() =>
    validateArknightsConfig({ ...config, expectedUid: "29482I209" }),
  ).toThrow("UID");
});
it("requires two agreeing home frames and exact server and UID", () => {
  const frame = classifyArknightsFrame(home(), pkg, config);
  expect(frame.page).toBe("home");
  expect(frame.uid).toBe("123456789");
  expect(compareArknightsFrames(frame, frame, config)).toMatchObject({
    account: "matched",
    page: "home",
    pageVerified: true,
    accountVerified: true,
  });
});
it("rejects wrong accounts and servers rather than fuzzy matching", () => {
  const wrong = classifyArknightsFrame(home("294821208"), pkg, config);
  expect(compareArknightsFrames(wrong, wrong, config).account).toBe("mismatch");
  const foreign = classifyArknightsFrame(
    home(),
    "com.hypergryph.arknights",
    config,
  );
  expect(compareArknightsFrames(foreign, foreign, config)).toMatchObject({
    accountVerified: false,
    pageVerified: false,
  });
});
it("rejects missing binding, low confidence, conflicting or misplaced identity evidence", () => {
  const f = classifyArknightsFrame(home(), pkg, config);
  expect(
    compareArknightsFrames(f, f, { ...config, expectedUid: "" }).account,
  ).toBe("unbound");
  for (const texts of [
    home().texts.map((h) => ({ ...h, score: 0.8 })),
    home().texts.map((h) =>
      h.text.startsWith("ID")
        ? { ...h, box: [1200, 633, 160, 30] as TextHit["box"] }
        : h,
    ),
    [...home().texts, hit("ID: 111111111", 80, 670)],
  ]) {
    const a = classifyArknightsFrame({ ...home(), texts }, pkg, config);
    expect(compareArknightsFrames(a, a, config).accountVerified).toBe(false);
  }
});
it("does not carry identity across changed frames or infer completion from a battle", () => {
  const a = classifyArknightsFrame(home(), pkg, config),
    b = classifyArknightsFrame(home("111111111"), pkg, config);
  expect(compareArknightsFrames(a, b, config)).toMatchObject({
    accountVerified: false,
    account: "unknown",
  });
  const battle = classifyArknightsFrame(
    {
      ...home(),
      texts: [
        hit("接管作战", 576, 956),
        hit("45/60", 816, 27),
        hit("剩余可放置角色：0", 1622, 827),
      ],
    },
    pkg,
    config,
  );
  expect(compareArknightsFrames(battle, battle, config)).toMatchObject({
    page: "battle",
    accountVerified: false,
  });
});
it("gives network/login overlays priority over background home anchors", () => {
  for (const [text, page] of [
    ["网络连接失败，请重试", "network-error"],
    ["请重新登录", "login"],
  ] as const) {
    const f = classifyArknightsFrame(
      { ...home(), texts: [...home().texts, hit(text, 660, 500)] },
      pkg,
      config,
    );
    expect(compareArknightsFrames(f, f, config)).toMatchObject({
      page,
      accountVerified: false,
    });
  }
});
it("accepts proportional screen sizes but rejects portrait and malformed boxes", () => {
  const f = home();
  f.width = 1280;
  f.height = 720;
  f.texts = f.texts.map((h) => ({
    ...h,
    box: h.box.map((n) => (n * 2) / 3) as TextHit["box"],
  }));
  expect(classifyArknightsFrame(f, pkg, config).page).toBe("home");
  expect(
    classifyArknightsFrame({ ...f, width: 720, height: 1280 }, pkg, config)
      .page,
  ).toBe("unknown");
});
it("recognizes theme English anchors without double-counting one menu", () => {
  const f = home();
  f.texts = [
    hit("ID: 123456789", 84, 633),
    hit("Mission", 1068, 819),
    hit("Base", 1386, 853),
    hit("Operator", 1396, 460),
  ];
  expect(classifyArknightsFrame(f, pkg, config).page).toBe("home");
  f.texts = [
    hit("任务", 1064, 913),
    hit("Mission", 1068, 819),
    hit("ID: 123456789", 84, 633),
  ];
  expect(classifyArknightsFrame(f, pkg, config).page).toBe("unknown");
});
it("locates exact Friends or 好友 only in the verified home left-bottom entry", () => {
  const chinese = hit("好友", 580, 860);
  const frame = {
    ...home(),
    texts: [...home().texts, chinese, hit("Friends", 572, 810)],
  };
  expect(classifyArknightsFrame(frame, pkg, config).friendsEntry).toEqual([
    660, 875,
  ]);
  expect(
    classifyArknightsFrame(
      { ...frame, texts: frame.texts.filter((h) => h !== chinese) },
      pkg,
      config,
    ).friendsEntry,
  ).toEqual([652, 825]);
  for (const extra of [
    hit("好友", 1200, 860),
    hit("好友列表", 580, 860),
    hit("好友", 580, 860, 0.89),
  ]) {
    expect(
      classifyArknightsFrame(
        { ...home(), texts: [...home().texts, extra] },
        pkg,
        config,
      ).friendsEntry,
    ).toBeUndefined();
  }
  expect(
    classifyArknightsFrame(
      { ...frame, texts: [...frame.texts, hit("好友", 400, 760)] },
      pkg,
      config,
    ).friendsEntry,
  ).toBeUndefined();
  expect(
    classifyArknightsFrame(
      { ...frame, texts: [...frame.texts, hit("确认", 700, 500)] },
      pkg,
      config,
    ).friendsEntry,
  ).toBeUndefined();
  const scaled = {
    ...frame,
    width: 1280,
    height: 720,
    texts: frame.texts.map((h) => ({
      ...h,
      box: h.box.map((v) => (v * 2) / 3) as TextHit["box"],
    })),
  };
  expect(classifyArknightsFrame(scaled, pkg, config).friendsEntry).toEqual([
    440, 583,
  ]);
});
