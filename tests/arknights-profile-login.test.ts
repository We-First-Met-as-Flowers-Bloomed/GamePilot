import { afterEach, expect, it, vi } from "vitest";
import { verifyArknightsProfileLogin } from "../games/arknights/profile-login";
import {
  defaultArknightsConfig,
  arknightsPackage,
} from "../games/arknights/config";
import { compareArknightsFrames } from "../games/arknights/inspection";
import type { DeviceInspection } from "../packages/protocol/recovery";
import type { SkillResult } from "../packages/protocol";

const config = {
  ...defaultArknightsConfig,
  expectedUid: "123456789",
  clientType: "Bilibili" as const,
};
const result = (): SkillResult => ({
  status: "succeeded",
  arknights: {
    version: 1,
    taskType: "StartUp",
    taskId: 1,
    submission: "submitted",
    completion: "native-confirmed",
    observedAt: new Date().toISOString(),
  },
});
const scene = (
  page: "home" | "profile",
  uids: (string | undefined)[] = [config.expectedUid, config.expectedUid],
): DeviceInspection => {
  const frames = uids.map((uid) => ({
    page,
    uid,
    anchors: [],
    ...(page === "home"
      ? { friendsEntry: [610, 878] as [number, number] }
      : {}),
  }));
  const arknights = compareArknightsFrames(frames[0]!, frames[1]!, config);
  return {
    observedAt: new Date().toISOString(),
    address: "device",
    foregroundPackage: arknightsPackage(config),
    image: "image",
    pageVerified: arknights.pageVerified,
    accountVerified: arknights.accountVerified,
    arknights,
  };
};
const ports = () => ({
  openProfile: vi.fn(async (_point: [number, number]) => {}),
  returnHome: vi.fn(async () => {}),
});
const read = (...shots: (() => DeviceInspection)[]) => {
  const inspect = vi.fn(async () =>
    shots[Math.min(inspect.mock.calls.length - 1, shots.length - 1)]!(),
  );
  return inspect;
};
afterEach(() => vi.useRealTimers());

it.each(["open", "return"] as const)(
  "does not continue after a %s navigation failure",
  async (phase) => {
    const navigation = ports();
    const inspect = read(
      () => scene("home"),
      () => scene("profile"),
      () => scene("home"),
    );
    (phase === "open"
      ? navigation.openProfile
      : navigation.returnHome
    ).mockRejectedValueOnce(Error("transport failed"));
    await expect(
      verifyArknightsProfileLogin(
        result(),
        config,
        inspect,
        new AbortController().signal,
        navigation,
      ),
    ).rejects.toThrow("transport failed");
    expect(inspect).toHaveBeenCalledTimes(phase === "open" ? 1 : 2);
  },
);

it("rejects a capture older than the read attempt even when it is within fifteen seconds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T12:30:00Z"));
  const navigation = ports();
  await expect(
    verifyArknightsProfileLogin(
      result(),
      config,
      read(() => ({
        ...scene("profile"),
        observedAt: new Date(Date.now() - 1).toISOString(),
      })),
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow("新鲜");
  expect(navigation.returnHome).not.toHaveBeenCalled();
});

it("uses own profile identity despite the real truncated home UID, then verifies return home", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T12:30:00Z"));
  const inspect = read(
    () => scene("home", ["294821", "294821"]),
    () => {
      vi.setSystemTime(Date.now() + 1000);
      return scene("profile");
    },
    () => {
      vi.setSystemTime(Date.now() + 1000);
      return scene("home", ["294821", undefined]);
    },
  );
  const navigation = ports();
  const verified = await verifyArknightsProfileLogin(
    result(),
    config,
    inspect,
    new AbortController().signal,
    navigation,
  );
  expect(navigation.openProfile).toHaveBeenCalledExactlyOnceWith([610, 878]);
  expect(navigation.returnHome).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(verified.arknights?.login).toEqual({
    expectedUid: config.expectedUid,
    observedUid: config.expectedUid,
    observedAt: "2026-09-30T12:30:01.000Z",
    homeObservedAt: "2026-09-30T12:30:02.000Z",
    home: true,
    method: "profile",
  });
  expect(verified.summary).toContain("个人名片");
});
it("accepts an already open own profile without clicking again", async () => {
  const navigation = ports();
  await verifyArknightsProfileLogin(
    result(),
    config,
    read(
      () => scene("profile"),
      () => scene("home"),
    ),
    new AbortController().signal,
    navigation,
  );
  expect(navigation.openProfile).not.toHaveBeenCalled();
  expect(navigation.returnHome).toHaveBeenCalledTimes(1);
});
it("allows at most two complete new profile pairs for missing UID without merging frames", async () => {
  const navigation = ports();
  const inspect = read(
    () => scene("profile", [undefined, undefined]),
    () => scene("profile", [config.expectedUid, undefined]),
    () => scene("profile"),
    () => scene("home"),
  );
  expect(
    (
      await verifyArknightsProfileLogin(
        result(),
        config,
        inspect,
        new AbortController().signal,
        navigation,
      )
    ).status,
  ).toBe("succeeded");
  expect(inspect).toHaveBeenCalledTimes(4);
  expect(navigation.returnHome).toHaveBeenCalledTimes(1);
});
it("retries the post-navigation read when the transition spans two pages", async () => {
  const navigation = ports();
  // 点开名片后第一次读取跨在入场动画上：两帧分别落在主页与名片 → 证据不合格。
  const unstable = ((): DeviceInspection => {
    const arknights = compareArknightsFrames(
      {
        page: "home",
        uid: undefined,
        anchors: [],
        friendsEntry: [610, 878] as [number, number],
      },
      { page: "profile", uid: config.expectedUid, anchors: [] },
      config,
    );
    return {
      observedAt: new Date().toISOString(),
      address: "device",
      foregroundPackage: arknightsPackage(config),
      image: "image",
      pageVerified: arknights.pageVerified,
      accountVerified: arknights.accountVerified,
      arknights,
    };
  })();
  const inspect = read(
    () => scene("home"),
    () => unstable,
    () => scene("profile"),
    () => scene("home"),
  );
  const verified = await verifyArknightsProfileLogin(
    result(),
    config,
    inspect,
    new AbortController().signal,
    navigation,
  );
  expect(verified.status).toBe("succeeded");
  // 重读只补观测：名片只打开一次，绝不重新点击。
  expect(navigation.openProfile).toHaveBeenCalledTimes(1);
  expect(navigation.returnHome).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledTimes(4);
});
it("waits for the profile page instead of failing while the transition is still home", async () => {
  const navigation = ports();
  // 点开名片后先读到主页（转场还没到位），再读才变名片：只重读，不重新点击。
  const inspect = read(
    () => scene("home"),
    () => scene("home"),
    () => scene("profile"),
    () => scene("home"),
  );
  const verified = await verifyArknightsProfileLogin(
    result(),
    config,
    inspect,
    new AbortController().signal,
    navigation,
  );
  expect(verified.status).toBe("succeeded");
  expect(navigation.openProfile).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledTimes(4);
});
it("stops after three incomplete profile pairs and never returns or merges partial reads", async () => {
  const navigation = ports();
  const inspect = read(
    () => scene("profile", [undefined, config.expectedUid]),
    () => scene("profile", [config.expectedUid, undefined]),
    () => scene("profile", [undefined, config.expectedUid]),
  );
  await expect(
    verifyArknightsProfileLogin(
      result(),
      config,
      inspect,
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow("个人名片");
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(navigation.returnHome).not.toHaveBeenCalled();
});
it.each([
  ["294821", "294821"],
  [config.expectedUid, "987654321"],
  [undefined, "987654321"],
])(
  "never navigates after foreign or truncated profile UID %s / %s",
  async (a, b) => {
    const navigation = ports();
    const inspect = read(() => scene("profile", [a, b]));
    await expect(
      verifyArknightsProfileLogin(
        result(),
        config,
        inspect,
        new AbortController().signal,
        navigation,
      ),
    ).rejects.toThrow("UID");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(navigation.returnHome).not.toHaveBeenCalled();
  },
);
const unsafe: [string, (s: DeviceInspection) => DeviceInspection][] = [
  ["old frame", (s) => ({ ...s, observedAt: "2020-01-01T00:00:00Z" })],
  ["future frame", (s) => ({ ...s, observedAt: "2099-01-01T00:00:00Z" })],
  ["invalid time", (s) => ({ ...s, observedAt: "bad" })],
  [
    "wrong client",
    (s) => ({ ...s, foregroundPackage: "com.hypergryph.arknights" }),
  ],
  ["recognition error", (s) => ({ ...s, recognitionError: "OCR failed" })],
  ["outer unverified", (s) => ({ ...s, pageVerified: false })],
  [
    "inner unverified",
    (s) => ({ ...s, arknights: { ...s.arknights!, pageVerified: false } }),
  ],
  [
    "changed binding",
    (s) => ({ ...s, arknights: { ...s.arknights!, expectedUid: "987654321" } }),
  ],
  [
    "unknown overlay",
    (s) => ({ ...s, arknights: { ...s.arknights!, page: "unknown" } }),
  ],
  [
    "one frame",
    (s) => ({
      ...s,
      arknights: { ...s.arknights!, frames: s.arknights!.frames.slice(0, 1) },
    }),
  ],
  [
    "mixed frames",
    (s) => ({
      ...s,
      arknights: {
        ...s.arknights!,
        frames: [
          { ...s.arknights!.frames[0]!, page: "unknown" },
          s.arknights!.frames[1]!,
        ],
      },
    }),
  ],
];
it.each(unsafe)("rejects %s before any navigation", async (_name, alter) => {
  const navigation = ports();
  const inspect = read(() => alter(scene("profile")));
  await expect(
    verifyArknightsProfileLogin(
      result(),
      config,
      inspect,
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow();
  expect(inspect).toHaveBeenCalledTimes(1);
  expect(navigation.openProfile).not.toHaveBeenCalled();
  expect(navigation.returnHome).not.toHaveBeenCalled();
});
it.each(unsafe)("rejects %s after returning home", async (_name, alter) => {
  const navigation = ports();
  const inspect = read(
    () => scene("profile"),
    () => alter(scene("home")),
  );
  await expect(
    verifyArknightsProfileLogin(
      result(),
      config,
      inspect,
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow();
  expect(navigation.returnHome).toHaveBeenCalledTimes(1);
});
it("requires matching fresh home friend-entry coordinates before tapping", async () => {
  for (const pair of [
    [undefined, undefined],
    [[600, 880], undefined],
    [
      [600, 880],
      [700, 880],
    ],
    [
      [NaN, 880],
      [NaN, 880],
    ],
  ] as const) {
    const s = scene("home");
    s.arknights!.frames.forEach((f, i) => {
      f.friendsEntry = pair[i] as [number, number] | undefined;
    });
    const navigation = ports();
    await expect(
      verifyArknightsProfileLogin(
        result(),
        config,
        read(() => s),
        new AbortController().signal,
        navigation,
      ),
    ).rejects.toThrow();
    expect(navigation.openProfile).not.toHaveBeenCalled();
  }
});
it("does not accept a home match when friend navigation did not reach own profile", async () => {
  const navigation = ports();
  await expect(
    verifyArknightsProfileLogin(
      result(),
      config,
      read(() => scene("home")),
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow("个人名片");
  expect(navigation.openProfile).toHaveBeenCalledTimes(1);
  expect(navigation.returnHome).not.toHaveBeenCalled();
});
it("requires successful native startup and preserves the unbound-account path", async () => {
  const navigation = ports();
  const inspect = read(() => scene("profile"));
  await expect(
    verifyArknightsProfileLogin(
      { ...result(), arknights: undefined },
      config,
      inspect,
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow("原生");
  const unbound = result();
  expect(
    await verifyArknightsProfileLogin(
      unbound,
      { ...config, expectedUid: "" },
      inspect,
      new AbortController().signal,
      navigation,
    ),
  ).toBe(unbound);
  expect(inspect).not.toHaveBeenCalled();
});
it("stops on abort during navigation or recognition without further actions", async () => {
  for (const phase of [
    "initial",
    "open",
    "profile",
    "return",
    "home",
  ] as const) {
    const abort = new AbortController();
    const navigation = ports();
    let n = 0;
    const inspect = vi.fn(async () => {
      n++;
      if (
        (phase === "initial" && n === 1) ||
        (phase === "profile" && n === 2) ||
        (phase === "home" && n === 3)
      )
        abort.abort();
      return scene(n === 2 ? "profile" : "home");
    });
    navigation.openProfile.mockImplementation(async () => {
      if (phase === "open") abort.abort();
    });
    navigation.returnHome.mockImplementation(async () => {
      if (phase === "return") abort.abort();
    });
    await expect(
      verifyArknightsProfileLogin(
        result(),
        config,
        inspect,
        abort.signal,
        navigation,
      ),
    ).rejects.toThrow();
    if (["initial", "open", "profile"].includes(phase))
      expect(navigation.returnHome).not.toHaveBeenCalled();
  }
});
