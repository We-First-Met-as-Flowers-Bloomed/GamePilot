import { afterEach, expect, it, vi } from "vitest";
import { verifyArknightsLogin } from "../games/arknights/login-evidence";
import {
  arknightsPackage,
  defaultArknightsConfig,
} from "../games/arknights/config";
import {
  classifyArknightsFrame,
  compareArknightsFrames,
} from "../games/arknights/inspection";
import type { ArknightsFrameEvidence } from "../games/arknights/inspection";
import type { DeviceInspection } from "../packages/protocol/recovery";
import type { SkillResult } from "../packages/protocol";
import { Runner } from "../packages/runtime/runner";
import { reduceTaskRecords } from "../packages/protocol/task-record";
import type { TaskRecord } from "../packages/protocol/task-record";
const now = new Date().toISOString();
const result: SkillResult = {
  status: "succeeded",
  arknights: {
    version: 1,
    taskType: "StartUp",
    taskId: 1,
    submission: "submitted",
    completion: "native-confirmed",
    observedAt: now,
  },
};
const config = { ...defaultArknightsConfig, expectedUid: "123456789" };
afterEach(() => vi.useRealTimers());
const shot = () =>
  ({
    observedAt: new Date().toISOString(),
    address: "device",
    foregroundPackage: "com.hypergryph.arknights",
    image: "image",
    accountVerified: true,
    pageVerified: true,
    arknights: {
      page: "home",
      account: "matched",
      accountVerified: true,
      pageVerified: true,
      expectedUid: "123456789",
      observedUid: "123456789",
      frames: [
        { page: "home", uid: "123456789", anchors: [] },
        { page: "home", uid: "123456789", anchors: [] },
      ],
      message: "",
    },
  }) as any;
const profileShot = () => ({
  ...shot(),
  accountVerified: false,
  arknights: {
    ...shot().arknights,
    page: "profile",
    account: "unknown",
    accountVerified: false,
    observedUid: undefined,
    frames: [0, 1].map(() => ({
      page: "profile",
      uid: config.expectedUid,
      anchors: [],
    })),
  },
});
const homePair = (
  uids: [string | undefined, string | undefined] = [
    undefined,
    config.expectedUid,
  ],
): DeviceInspection => {
  const frames = uids.map((uid) => ({
    page: "home" as const,
    uid,
    anchors: [],
  }));
  const arknights = compareArknightsFrames(frames[0]!, frames[1]!, config);
  return {
    ...shot(),
    accountVerified: arknights.accountVerified,
    pageVerified: arknights.pageVerified,
    arknights,
  };
};
it("reinspects a low-confidence UID pair and uses only the next fresh matched pair", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T06:00:00Z"));
  const bound = {
    ...config,
    clientType: "Bilibili" as const,
    expectedUid: "123456789",
  };
  const frame = (score: number): ArknightsFrameEvidence =>
    classifyArknightsFrame(
      {
        width: 1920,
        height: 1080,
        texts: [
          { text: bound.expectedUid, score, box: [114, 635, 126, 24] },
          { text: "任务", score: 0.99, box: [1064, 913, 160, 30] },
          { text: "基建", score: 0.99, box: [1384, 948, 160, 30] },
          { text: "干员", score: 0.99, box: [1396, 563, 160, 30] },
        ],
      },
      arknightsPackage(bound),
      bound,
    );
  const low = frame(0.975748);
  const high = frame(0.99936);
  expect(low).toMatchObject({ page: "home", uid: undefined });
  expect(high.uid).toBe(bound.expectedUid);
  const inspect = vi.fn(async () => {
    vi.setSystemTime(Date.now() + 1000);
    const arknights = compareArknightsFrames(
      inspect.mock.calls.length === 1 ? low : high,
      high,
      bound,
    );
    return {
      ...shot(),
      foregroundPackage: arknightsPackage(bound),
      arknights,
      accountVerified: arknights.accountVerified,
      pageVerified: arknights.pageVerified,
    };
  });
  const verified = await verifyArknightsLogin(
    result,
    bound,
    inspect,
    new AbortController().signal,
  );
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(verified.arknights?.login).toEqual({
    expectedUid: bound.expectedUid,
    observedUid: bound.expectedUid,
    observedAt: "2026-09-30T06:00:02.000Z",
    home: true,
  });
  expect(verified.summary).toContain("1 次");
});
it("allows a matched third pair after exactly two incomplete pairs", async () => {
  const inspect = vi
    .fn()
    .mockImplementationOnce(async () => homePair())
    .mockImplementationOnce(async () =>
      homePair([config.expectedUid, undefined]),
    )
    .mockImplementation(async () => shot());
  const verified = await verifyArknightsLogin(
    result,
    config,
    inspect,
    new AbortController().signal,
  );
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(verified.arknights?.login?.observedUid).toBe(config.expectedUid);
  expect(verified.summary).toContain("2 次");
});
it("stops after three incomplete pairs without combining UID evidence across pairs", async () => {
  const inspect = vi.fn(async () =>
    homePair(
      inspect.mock.calls.length % 2
        ? [undefined, config.expectedUid]
        : [config.expectedUid, undefined],
    ),
  );
  await expect(
    verifyArknightsLogin(result, config, inspect, new AbortController().signal),
  ).rejects.toThrow("双帧核验");
  expect(inspect).toHaveBeenCalledTimes(3);
});
const unsafePairs: [string, (s: DeviceInspection) => DeviceInspection][] = [
  [
    "foreign UID hidden by unknown aggregate",
    () => homePair([config.expectedUid, "987654321"]),
  ],
  ["only foreign UID", () => homePair([undefined, "987654321"])],
  ["no matching UID", () => homePair([undefined, undefined])],
  ["changed package", (s) => ({ ...s, foregroundPackage: "other.app" })],
  ["stale capture", (s) => ({ ...s, observedAt: "2020-01-01T00:00:00Z" })],
  ["future capture", (s) => ({ ...s, observedAt: "2099-01-01T00:00:00Z" })],
  ["invalid timestamp", (s) => ({ ...s, observedAt: "invalid" })],
  ["recognition failure", (s) => ({ ...s, recognitionError: "OCR failed" })],
  [
    "binding mismatch",
    (s) => ({ ...s, arknights: { ...s.arknights!, expectedUid: "987654321" } }),
  ],
  ["unverified outer page", (s) => ({ ...s, pageVerified: false })],
  [
    "unverified inner page",
    (s) => ({ ...s, arknights: { ...s.arknights!, pageVerified: false } }),
  ],
  ["inconsistent outer account flag", (s) => ({ ...s, accountVerified: true })],
  [
    "inconsistent inner account flag",
    (s) => ({ ...s, arknights: { ...s.arknights!, accountVerified: true } }),
  ],
  [
    "inconsistent observed UID",
    (s) => ({
      ...s,
      arknights: { ...s.arknights!, observedUid: config.expectedUid },
    }),
  ],
  [
    "inconsistent account match",
    (s) => ({ ...s, arknights: { ...s.arknights!, account: "matched" } }),
  ],
  [
    "account mismatch",
    (s) => ({ ...s, arknights: { ...s.arknights!, account: "mismatch" } }),
  ],
  [
    "unbound account",
    (s) => ({ ...s, arknights: { ...s.arknights!, account: "unbound" } }),
  ],
  [
    "incomplete frame pair",
    (s) => ({
      ...s,
      arknights: { ...s.arknights!, frames: s.arknights!.frames.slice(1) },
    }),
  ],
  ...(["login", "network-error", "unknown", "profile"] as const).map(
    (page): [string, (s: DeviceInspection) => DeviceInspection] => [
      `${page} page`,
      (s) => ({ ...s, arknights: { ...s.arknights!, page } }),
    ],
  ),
  [
    "changed frame page",
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
it.each(unsafePairs)(
  "never retries %s, including after an incomplete pair",
  async (_label, alter) => {
    for (const initialIncomplete of [false, true]) {
      const inspect = vi.fn();
      if (initialIncomplete)
        inspect.mockImplementationOnce(async () => homePair());
      inspect
        .mockImplementationOnce(async () => alter(homePair()))
        .mockImplementation(async () => shot());
      await expect(
        verifyArknightsLogin(
          result,
          config,
          inspect,
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      expect(inspect).toHaveBeenCalledTimes(initialIncomplete ? 2 : 1);
    }
  },
);
it("requires a new observation timestamp for each retry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-30T06:00:00Z"));
  const old = new Date().toISOString();
  const inspect = vi
    .fn()
    .mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 1000);
      return { ...homePair(), observedAt: old };
    })
    .mockImplementationOnce(async () => ({ ...shot(), observedAt: old }))
    .mockImplementation(async () => shot());
  await expect(
    verifyArknightsLogin(result, config, inspect, new AbortController().signal),
  ).rejects.toThrow();
  expect(inspect).toHaveBeenCalledTimes(2);
});
it("rejects matched pairs with inconsistent nested verification flags", async () => {
  for (const field of ["pageVerified", "accountVerified"] as const) {
    const inspect = vi.fn(async () => {
      const capture = shot();
      capture.arknights[field] = false;
      return capture;
    });
    await expect(
      verifyArknightsLogin(
        result,
        config,
        inspect,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(inspect).toHaveBeenCalledTimes(1);
  }
});
it("does not retry cancelled inspections or inspection errors", async () => {
  for (const onRetry of [false, true]) {
    const abort = new AbortController();
    const inspect = vi.fn();
    if (onRetry) inspect.mockImplementationOnce(async () => homePair());
    inspect.mockImplementation(async () => {
      abort.abort();
      return homePair();
    });
    await expect(
      verifyArknightsLogin(result, config, inspect, abort.signal),
    ).rejects.toThrow();
    expect(inspect).toHaveBeenCalledTimes(onRetry ? 2 : 1);
  }
  const error = Error("inspection failed");
  const inspect = vi.fn(async () => {
    throw error;
  });
  await expect(
    verifyArknightsLogin(result, config, inspect, new AbortController().signal),
  ).rejects.toBe(error);
  expect(inspect).toHaveBeenCalledTimes(1);
});
it("keeps one profile back navigation and the same two-retry home budget", async () => {
  for (const recover of [false, true]) {
    const back = vi.fn(async () => {});
    const inspect = vi
      .fn()
      .mockImplementationOnce(async () => profileShot())
      .mockImplementationOnce(async () => homePair())
      .mockImplementationOnce(async () => homePair())
      .mockImplementation(async () => (recover ? shot() : homePair()));
    const verified = verifyArknightsLogin(
      result,
      config,
      inspect,
      new AbortController().signal,
      back,
    );
    if (recover)
      await expect(verified).resolves.toMatchObject({ status: "succeeded" });
    else await expect(verified).rejects.toThrow();
    expect(back).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(4);
  }
});
it("does not navigate a profile reached during a home retry", async () => {
  const back = vi.fn(async () => {});
  const inspect = vi
    .fn()
    .mockImplementationOnce(async () => homePair())
    .mockImplementation(async () => profileShot());
  await expect(
    verifyArknightsLogin(
      result,
      config,
      inspect,
      new AbortController().signal,
      back,
    ),
  ).rejects.toThrow();
  expect(back).not.toHaveBeenCalled();
  expect(inspect).toHaveBeenCalledTimes(2);
});
it("returns from a verified own profile once then still requires fresh home identity", async () => {
  const back = vi.fn(async () => {});
  const inspect = vi
    .fn()
    .mockImplementationOnce(async () => profileShot())
    .mockImplementation(async () => shot());
  const r = await verifyArknightsLogin(
    result,
    config,
    inspect,
    new AbortController().signal,
    back,
  );
  expect(back).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(r.arknights?.login?.home).toBe(true);
});
it("never navigates an unverified, stale or foreign profile and never accepts profile-only success", async () => {
  for (const alter of [
    (s: any) => ({ ...s, foregroundPackage: "other.app" }),
    (s: any) => ({ ...s, observedAt: "2020-01-01T00:00:00Z" }),
    (s: any) => ({
      ...s,
      arknights: {
        ...s.arknights,
        frames: [
          { page: "profile", uid: "987654321" },
          { page: "profile", uid: "987654321" },
        ],
      },
    }),
    (s: any) => ({
      ...s,
      arknights: {
        ...s.arknights,
        frames: [
          { page: "profile", uid: config.expectedUid },
          { page: "unknown", uid: config.expectedUid },
        ],
      },
    }),
  ]) {
    const back = vi.fn(async () => {});
    await expect(
      verifyArknightsLogin(
        result,
        config,
        async () => alter(profileShot()),
        new AbortController().signal,
        back,
      ),
    ).rejects.toThrow();
    expect(back).not.toHaveBeenCalled();
  }
  const back = vi.fn(async () => {});
  await expect(
    verifyArknightsLogin(
      result,
      config,
      async () => profileShot(),
      new AbortController().signal,
      back,
    ),
  ).rejects.toThrow();
  expect(back).toHaveBeenCalledTimes(1);
});
it("stops the real Runner before later game tasks when identity cannot be confirmed", async () => {
  const executed: string[] = [];
  let records: TaskRecord[] = [];
  const runner = new Runner(
    [
      {
        id: "arknights",
        name: "Ark",
        subtitle: "test",
        skills: ["login", "fight"].map((id) => ({
          id,
          title: id,
          description: "test",
          ready: true,
        })),
      },
    ],
    (event) => {
      records = reduceTaskRecords(records, event);
    },
    async (id, signal, log) => {
      executed.push(id);
      try {
        return await verifyArknightsLogin(
          result,
          config,
          async () => ({ ...shot(), accountVerified: false }),
          signal,
        );
      } catch (error) {
        log("核验未通过", result);
        throw error;
      }
    },
  );
  await runner.start({
    gameId: "arknights",
    skillIds: ["login", "fight"],
    mode: "live",
  }).finished;
  expect(executed).toEqual(["login"]);
  expect(records[0].steps.map((s) => s.status)).toEqual(["failed", "not-run"]);
  expect(records[0].steps[0].result?.arknights?.completion).toBe(
    "native-confirmed",
  );
  expect(records[0].steps[0].result?.arknights?.login).toBeUndefined();
});
it("attaches fresh home identity only after matched native login completion", async () => {
  const r = await verifyArknightsLogin(
    result,
    config,
    async () => shot(),
    new AbortController().signal,
  );
  expect(r.arknights?.login).toMatchObject({
    expectedUid: "123456789",
    observedUid: "123456789",
    home: true,
  });
  expect(result.arknights?.login).toBeUndefined();
});
it("blocks wrong, missing, stale, future or cancelled identity evidence", async () => {
  for (const modify of [
    (s: any) => ({ ...s, accountVerified: false }),
    (s: any) => ({ ...s, observedAt: "2020-01-01T00:00:00Z" }),
    (s: any) => ({ ...s, observedAt: "2099-01-01T00:00:00Z" }),
    (s: any) => ({
      ...s,
      arknights: { ...s.arknights, observedUid: "987654321" },
    }),
  ]) {
    await expect(
      verifyArknightsLogin(
        result,
        config,
        async () => modify(shot()),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
  const abort = new AbortController();
  await expect(
    verifyArknightsLogin(
      result,
      config,
      async () => {
        abort.abort();
        return shot();
      },
      abort.signal,
    ),
  ).rejects.toThrow();
});
it("keeps unbound legacy behavior and never verifies from native completion alone", async () => {
  let reads = 0;
  expect(
    await verifyArknightsLogin(
      result,
      defaultArknightsConfig,
      async () => {
        reads++;
        return shot();
      },
      new AbortController().signal,
    ),
  ).toEqual(result);
  expect(reads).toBe(0);
  await expect(
    verifyArknightsLogin(
      { ...result, arknights: undefined },
      config,
      async () => shot(),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});
