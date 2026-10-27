import { expect, it, vi } from "vitest";
import {
  arknightsPackage,
  defaultArknightsConfig,
} from "../games/arknights/config";
import { inspectArknightsDevice } from "../games/arknights/inspect-device";
import {
  classifyArknightsFrame,
  compareArknightsFrames,
} from "../games/arknights/inspection";
import { returnArknightsHome } from "../games/arknights/navigation";
import { verifyArknightsProfileLogin } from "../games/arknights/profile-login";
import type { SkillResult } from "../packages/protocol";
import type { DeviceInspection } from "../packages/protocol/recovery";
import type { Frame, Rect, TextHit } from "../packages/runtime/device";

const config = {
  ...defaultArknightsConfig,
  clientType: "Bilibili" as const,
  expectedUid: "123456789",
};
const device = { name: "test", adbPath: "test", address: "test-device" };
const hit = (text: string, box: Rect, score = 0.99): TextHit => ({
  text,
  box,
  score,
});
// The two persisted 2026-10-04 20:11:18.567 / 20:11:21.677 home OCR observations.
// Only navigation anchors and anonymized identity hits are retained; boxes and scores are unchanged.
const home = (index: number, uid = "123456"): Frame => ({
  width: 1920,
  height: 1080,
  texts: [
    hit(`ID:${uid}`, [82, 631, 116, 32], index ? 0.993604 : 0.99349),
    hit("Friends", [574, 819, 60, 22], index ? 0.992113 : 0.992176),
    hit("好友", [582, 863, 56, 30], index ? 0.996315 : 0.996311),
    hit("任务：", [1064, 913, 100, 49], 0.968612),
    hit("Mission", [1068, 819, 126, 58], 0.999196),
    hit(
      "Base",
      [1388, 853, index ? 102 : 100, 54],
      index ? 0.999539 : 0.999609,
    ),
    hit(
      "Operator",
      [1394, index ? 458 : 456, 168, 48],
      index ? 0.999656 : 0.99954,
    ),
    hit(
      "公开招募",
      index ? [1400, 762, 114, 49] : [1402, 764, 112, 44],
      index ? 0.998521 : 0.99853,
    ),
  ],
});
const profile = (uids: string[] = [config.expectedUid]): Frame => ({
  width: 1920,
  height: 1080,
  texts: [
    hit("我的信息", [1070, 50, 160, 30]),
    hit("个人名片", [110, 175, 160, 30]),
    hit("好友列表", [110, 315, 160, 30]),
    hit("添加好友", [110, 450, 160, 30]),
    hit("助战干员", [110, 580, 160, 30]),
    ...uids.map((uid, i) =>
      hit(`ID${uid}`, [1250, 307 + i * 30, 164, 28], 0.996245),
    ),
  ],
});
const startUp = (): SkillResult => ({
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
function observer(
  frameAt: (index: number) => Frame,
  cropText: string | string[] = config.expectedUid,
) {
  let captures = 0;
  const capture = vi.fn(async (): Promise<DeviceInspection> => ({
    address: device.address,
    foregroundPackage: arknightsPackage(config),
    observedAt: new Date().toISOString(),
    image: `capture-${captures++}`,
    pageVerified: false,
    accountVerified: false,
  }));
  const recognize = vi.fn(
    async (image: string, roi?: Rect, _onlyRec?: boolean): Promise<Frame> =>
      roi
        ? {
            width: 1920,
            height: 1080,
            texts: (typeof cropText === "string" ? [cropText] : cropText).map(
              (text) => hit(text, roi),
            ),
          }
        : frameAt(Number(image.split("-")[1])),
  );
  return {
    capture,
    recognize,
    inspect: () =>
      inspectArknightsDevice(device, config, {
        capture,
        recognize,
        wait: async () => {},
      }),
  };
}

it("treats the two anonymized labelled home UID prefixes as incomplete identity, never a match or a foreign full ID", () => {
  const frames = [0, 1].map((i) =>
    classifyArknightsFrame(home(i), arknightsPackage(config), config),
  );
  const compared = compareArknightsFrames(frames[0]!, frames[1]!, config);
  expect(
    frames.map((f) => ({
      page: f.page,
      uid: f.uid,
      friendsEntry: f.friendsEntry,
    })),
  ).toEqual([
    { page: "home", uid: undefined, friendsEntry: [610, 878] },
    { page: "home", uid: undefined, friendsEntry: [610, 878] },
  ]);
  expect(compared.account).toBe("unknown");
  expect(compared.accountVerified).toBe(false);
  expect(compared.observedUid).toBeUndefined();
});

it("uses the existing same-image UID crop on both real home frames to read the full identity", async () => {
  const ports = observer(home);
  const result = await ports.inspect();
  expect(ports.recognize.mock.calls).toEqual([
    ["capture-0"],
    ["capture-0", [114, 635, 126, 24], true],
    ["capture-1"],
    ["capture-1", [114, 635, 126, 24], true],
  ]);
  expect(ports.capture).toHaveBeenCalledTimes(2);
  expect(result.arknights?.account).toBe("matched");
  expect(result.arknights?.frames.map((f) => f.uid)).toEqual([
    config.expectedUid,
    config.expectedUid,
  ]);
});

it("completes the strict profile login and one bounded return through the actual classifier and crop path", async () => {
  let page: "home" | "profile" = "home";
  const ports = observer((i) => (page === "home" ? home(i % 2) : profile()));
  const openProfile = vi.fn(async (_point: [number, number]) => {
    page = "profile";
  });
  const back = vi.fn(async () => {
    page = "home";
  });
  const original = startUp();
  const verified = await verifyArknightsProfileLogin(
    original,
    config,
    ports.inspect,
    new AbortController().signal,
    {
      openProfile,
      returnHome: async () => {
        await returnArknightsHome(
          device,
          config,
          new AbortController().signal,
          { inspect: ports.inspect, back, log: () => {} },
        );
      },
    },
  );
  expect(openProfile).toHaveBeenCalledExactlyOnceWith([610, 878]);
  expect(back).toHaveBeenCalledTimes(1);
  expect(verified.arknights?.login).toMatchObject({
    expectedUid: config.expectedUid,
    observedUid: config.expectedUid,
    method: "profile",
    home: true,
  });
  expect(original.arknights?.login).toBeUndefined();
  expect(ports.recognize.mock.calls.filter((c) => c[1])).toHaveLength(6);
});

it.each(["294820", "123456208"])(
  "preserves non-prefix or full foreign ID %s and stops navigation without input",
  async (uid) => {
    const ports = observer((i) => home(i % 2, uid));
    const back = vi.fn(async () => {});
    const result = await ports.inspect();
    expect(result.arknights?.account).toBe("mismatch");
    expect(result.arknights?.observedUid).toBe(uid);
    expect(ports.recognize.mock.calls.every((c) => c[1] === undefined)).toBe(
      true,
    );
    await expect(
      returnArknightsHome(device, config, new AbortController().signal, {
        inspect: ports.inspect,
        back,
        log: () => {},
      }),
    ).rejects.toThrow("账号");
    expect(back).not.toHaveBeenCalled();
  },
);

it("preserves a foreign complete crop instead of trusting its matching short prefix", async () => {
  const ports = observer(home, "123456208");
  const back = vi.fn(async () => {});
  expect((await ports.inspect()).arknights?.account).toBe("mismatch");
  await expect(
    returnArknightsHome(device, config, new AbortController().signal, {
      inspect: ports.inspect,
      back,
      log: () => {},
    }),
  ).rejects.toThrow("账号");
  expect(back).not.toHaveBeenCalled();
});

it.each(["验证码登录", "确认"])(
  "does not crop or navigate past %s over the home background",
  async (text) => {
    const ports = observer((i) => ({
      ...home(i % 2),
      texts: [...home(i % 2).texts, hit(text, [700, 500, 200, 40])],
    }));
    const back = vi.fn(async () => {});
    const result = await ports.inspect();
    expect(result.arknights?.page).toBe(
      text === "验证码登录" ? "login" : "unknown",
    );
    expect(ports.recognize.mock.calls.every((c) => c[1] === undefined)).toBe(
      true,
    );
    await expect(
      returnArknightsHome(device, config, new AbortController().signal, {
        inspect: ports.inspect,
        back,
        log: () => {},
      }),
    ).rejects.toThrow();
    expect(back).not.toHaveBeenCalled();
  },
);

it.each([{ ids: ["123456"] }, { ids: [] }])(
  "cannot generate profile login evidence when the home crop and own profile remain incomplete: $ids",
  async ({ ids }) => {
    let opened = false;
    const ports = observer(
      (i) => (opened ? profile(ids) : home(i % 2)),
      "123456",
    );
    const original = startUp();
    const navigation = {
      openProfile: vi.fn(async () => {
        opened = true;
      }),
      returnHome: vi.fn(async () => {}),
    };
    const homeResult = await ports.inspect();
    expect(homeResult.accountVerified).toBe(false);
    expect(homeResult.arknights?.frames.every((f) => f.uid === undefined)).toBe(
      true,
    );
    await expect(
      verifyArknightsProfileLogin(
        original,
        config,
        ports.inspect,
        new AbortController().signal,
        navigation,
      ),
    ).rejects.toThrow("个人名片");
    expect(navigation.returnHome).not.toHaveBeenCalled();
    expect(original.arknights?.login).toBeUndefined();
  },
);

it("retains conflicting complete identity reads as unverified and refuses profile proof", async () => {
  let opened = false;
  const foreign = "123456208";
  const ports = observer((i) =>
    opened
      ? profile([config.expectedUid, foreign])
      : {
          ...home(i % 2, config.expectedUid),
          texts: [
            ...home(i % 2, config.expectedUid).texts,
            hit(`ID:${foreign}`, [82, 680, 160, 30]),
          ],
        },
  );
  const homeResult = await ports.inspect();
  expect(homeResult.accountVerified).toBe(false);
  expect(homeResult.arknights?.frames.every((f) => f.uid === undefined)).toBe(
    true,
  );
  const original = startUp();
  const navigation = {
    openProfile: vi.fn(async () => {
      opened = true;
    }),
    returnHome: vi.fn(async () => {}),
  };
  await expect(
    verifyArknightsProfileLogin(
      original,
      config,
      ports.inspect,
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow("个人名片");
  expect(navigation.returnHome).not.toHaveBeenCalled();
  expect(original.arknights?.login).toBeUndefined();
});

it("does not discard a short labelled ID when no expected identity is bound", () => {
  expect(
    classifyArknightsFrame(home(0), arknightsPackage(config), {
      ...config,
      expectedUid: "",
    }).uid,
  ).toBe("123456");
});

const conflictingHome = (index: number, includePrefix = false): Frame => ({
  ...home(index % 2, config.expectedUid),
  texts: [
    ...home(index % 2, config.expectedUid).texts,
    hit("ID:123456208", [82, 680, 160, 30]),
    ...(includePrefix ? [hit("ID:123456", [82, 730, 160, 30])] : []),
  ],
});

it.each([false, true])(
  "blocks navigation on distinct complete home IDs, with incomplete prefix=%s",
  async (includePrefix) => {
    const ports = observer((i) => conflictingHome(i, includePrefix));
    const back = vi.fn(async () => {});
    const captured = await ports.inspect();
    expect(captured.arknights?.page).toBe("unknown");
    expect(captured.pageVerified).toBe(false);
    expect(captured.accountVerified).toBe(false);
    expect(ports.recognize.mock.calls.every((call) => !call[1])).toBe(true);
    await expect(
      returnArknightsHome(device, config, new AbortController().signal, {
        inspect: ports.inspect,
        back,
        log: () => {},
      }),
    ).rejects.toThrow();
    expect(back).not.toHaveBeenCalled();
  },
);

it("blocks conflicting complete IDs from the existing read-only home crop", async () => {
  const ports = observer(home, [config.expectedUid, "123456208"]);
  const back = vi.fn(async () => {});
  const captured = await ports.inspect();
  expect(captured.arknights?.page).toBe("unknown");
  expect(captured.accountVerified).toBe(false);
  expect(ports.recognize.mock.calls.filter((call) => call[1])).toHaveLength(2);
  await expect(
    returnArknightsHome(device, config, new AbortController().signal, {
      inspect: ports.inspect,
      back,
      log: () => {},
    }),
  ).rejects.toThrow();
  expect(back).not.toHaveBeenCalled();
});

it("blocks conflicting complete own-profile IDs before returning or generating login proof", async () => {
  const ports = observer(() => profile([config.expectedUid, "123456208"]));
  const navigation = {
    openProfile: vi.fn(async () => {}),
    returnHome: vi.fn(async () => {}),
  };
  const captured = await ports.inspect();
  expect(captured.arknights?.page).toBe("unknown");
  const original = startUp();
  await expect(
    verifyArknightsProfileLogin(
      original,
      config,
      ports.inspect,
      new AbortController().signal,
      navigation,
    ),
  ).rejects.toThrow();
  expect(navigation.openProfile).not.toHaveBeenCalled();
  expect(navigation.returnHome).not.toHaveBeenCalled();
  expect(original.arknights?.login).toBeUndefined();
});

it("does not generate login proof if a verified own profile returns to contradictory complete home IDs", async () => {
  let returned = false;
  const ports = observer((i) => (returned ? conflictingHome(i) : profile()));
  const openProfile = vi.fn(async () => {});
  const back = vi.fn(async () => {
    returned = true;
  });
  const original = startUp();
  await expect(
    verifyArknightsProfileLogin(
      original,
      config,
      ports.inspect,
      new AbortController().signal,
      {
        openProfile,
        returnHome: async () => {
          await returnArknightsHome(
            device,
            config,
            new AbortController().signal,
            { inspect: ports.inspect, back, log: () => {} },
          );
        },
      },
    ),
  ).rejects.toThrow();
  expect(openProfile).not.toHaveBeenCalled();
  expect(back).toHaveBeenCalledTimes(1);
  expect(original.arknights?.login).toBeUndefined();
});

it("keeps duplicate identical full IDs unverified instead of deduplicating them into a match", () => {
  const repeatedHome: Frame = {
    ...home(0, config.expectedUid),
    texts: [
      ...home(0, config.expectedUid).texts,
      hit(`ID:${config.expectedUid}`, [82, 680, 160, 30]),
    ],
  };
  for (const [frame, page] of [
    [repeatedHome, "home"],
    [profile([config.expectedUid, config.expectedUid]), "profile"],
  ] as const) {
    const evidence = classifyArknightsFrame(
      frame,
      arknightsPackage(config),
      config,
    );
    expect(evidence.page).toBe(page);
    expect(evidence.uid).toBeUndefined();
    expect(
      compareArknightsFrames(evidence, evidence, config).accountVerified,
    ).toBe(false);
  }
});
