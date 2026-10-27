import { expect, it, vi } from "vitest";
import { InternalActivityStageResolver } from "../apps/desktop/main/internal-activity-stage";
const epoch = Date.parse("2026-10-25T12:00:00Z"),
  source =
    "https://api.maa.plus/MaaAssistantArknights/api/gui/StageActivityV2.json";
const data = {
  Official: {
    sideStoryStage: {
      current: {
        MinimumRequired: "v6.20.0",
        Activity: {
          StageName: "新活动",
          UtcStartTime: "2026/10/25 04:00:00",
          UtcExpireTime: "2026/11/01 03:59:59",
        },
        Stages: [{ Value: "NEW-8" }, { Value: "NEW-7" }],
      },
    },
    miniGame: [
      {
        Value: "Activity@Begin",
        Display: "活动玩法",
        MinimumRequired: "v6.20.0",
        UtcStartTime: "2026/10/25 04:00:00",
        UtcExpireTime: "2026/11/01 03:59:59",
      },
    ],
  },
};
const navigation = () => ({
  directory: "verified-fixture",
  sha256: "a".repeat(64),
  fetchedAt: epoch,
  engineVersion: "v6.20.1",
  routes: ["NEW-8", "NEW-7", "Activity@Begin"],
});
const cache = () => ({
  version: 1,
  source,
  engineVersion: "v6.20.1",
  navigationSha256: navigation().sha256,
  fetchedAt: epoch,
  data: structuredClone(data),
});
const offline = async () => {
  throw Error("offline");
};
it.each(["missing", "expired", "incompatible", "different-digest"])(
  "never follows a fresh catalog when navigation is %s",
  async (failure) => {
    const readNavigation = async () =>
      failure === "missing"
        ? undefined
        : {
            ...navigation(),
            ...(failure === "expired"
              ? { fetchedAt: epoch - 86400000 }
              : failure === "incompatible"
                ? { engineVersion: "v6.19.0" }
                : { sha256: "b".repeat(64) }),
          };
    const resolver = new InternalActivityStageResolver("unused-test-cache", {
      now: () => epoch,
      readCache: async () => cache(),
      writeCache: async () => {},
      fetchData: offline,
      readNavigation,
      syncNavigation: offline,
    });
    expect(await resolver.resolve("Official")).toBeNull();
    expect(
      (await resolver.catalog("Official")).stages.every(
        (stage) => !stage.available,
      ),
    ).toBe(true);
  },
);
it("rechecks navigation when a cached resource disappears from disk", async () => {
  let present = true;
  const readNavigation = vi.fn(async () =>
    present ? navigation() : undefined,
  );
  const resolver = new InternalActivityStageResolver("unused-test-cache", {
    now: () => epoch,
    readCache: async () => cache(),
    writeCache: async () => {},
    fetchData: offline,
    readNavigation,
    syncNavigation: offline,
  });
  expect((await resolver.resolve("Official"))?.stage).toBe("NEW-8");
  present = false;
  expect(await resolver.resolve("Official")).toBeNull();
  expect(readNavigation.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it("disables absent routes and selects a normal stage actually present in the verified navigation", async () => {
  const resolver = new InternalActivityStageResolver("unused-test-cache", {
    now: () => epoch,
    readCache: async () => cache(),
    writeCache: async () => {},
    fetchData: offline,
    readNavigation: async () => ({ ...navigation(), routes: ["NEW-7"] }),
    syncNavigation: offline,
  });
  expect(await resolver.resolve("Official")).toEqual({
    stage: "NEW-7",
    name: "新活动",
  });
  const catalog = await resolver.catalog("Official");
  expect(catalog.stages.find((stage) => stage.stage === "NEW-8")).toMatchObject(
    { available: false, reason: expect.stringContaining("导航") },
  );
  expect(catalog.miniGames?.[0].available).toBe(false);
});
it.each(["expired", "version", "source", "ended", "too-new"])(
  "rejects a catalog that is %s despite valid navigation",
  async (failure) => {
    const saved = cache();
    if (failure === "expired") saved.fetchedAt = epoch - 86400000;
    if (failure === "version") saved.engineVersion = "v6.19.0";
    if (failure === "source") saved.source = "https://example.invalid/data";
    if (failure === "ended")
      saved.data.Official.sideStoryStage.current.Activity.UtcExpireTime =
        "2026/10/24 12:00:00";
    if (failure === "too-new")
      saved.data.Official.sideStoryStage.current.MinimumRequired = "v99.0.0";
    const resolver = new InternalActivityStageResolver("unused-test-cache", {
      now: () => epoch,
      readCache: async () => saved,
      writeCache: async () => {},
      fetchData: offline,
      readNavigation: async () => navigation(),
      syncNavigation: offline,
    });
    expect(await resolver.resolve("Official")).toBeNull();
  },
);
it("shares paired refreshes, explicitly refreshes both sources, and does not publish data after navigation failure", async () => {
  let current = navigation();
  const writes: unknown[] = [];
  const fetchData = vi.fn(async () => structuredClone(data)),
    syncNavigation = vi.fn(async () => {
      current = { ...navigation(), sha256: "b".repeat(64) };
      return current;
    });
  const resolver = new InternalActivityStageResolver("unused-test-cache", {
    now: () => epoch,
    readCache: async () => cache(),
    writeCache: async (value) => {
      writes.push(value);
    },
    fetchData,
    readNavigation: async () => current,
    syncNavigation,
  });
  expect(
    (await resolver.catalog("Official", true)).stages.some(
      (stage) => stage.available,
    ),
  ).toBe(true);
  expect(fetchData).toHaveBeenCalledTimes(1);
  expect(syncNavigation).toHaveBeenCalledTimes(1);
  expect(writes[0]).toMatchObject({
    version: 1,
    engineVersion: "v6.20.1",
    navigationSha256: "b".repeat(64),
    source,
  });
  current = { ...navigation(), sha256: "c".repeat(64) };
  fetchData.mockRejectedValueOnce(Error("offline"));
  syncNavigation.mockRejectedValueOnce(Error("offline"));
  expect(
    (await resolver.catalog("Official", true)).stages.every(
      (stage) => !stage.available,
    ),
  ).toBe(true);
});
it("keeps a verified paired cache offline when only new catalog data can be fetched", async () => {
  const writeCache = vi.fn(async () => {}),
    changed = structuredClone(data);
  changed.Official.sideStoryStage.current.Stages = [{ Value: "NEXT-8" }];
  const resolver = new InternalActivityStageResolver("unused-test-cache", {
    now: () => epoch,
    readCache: async () => cache(),
    writeCache,
    fetchData: async () => changed,
    readNavigation: async () => navigation(),
    syncNavigation: offline,
  });
  expect(
    (await resolver.catalog("Official", true)).stages.find(
      (stage) => stage.available,
    )?.stage,
  ).toBe("NEW-8");
  expect(writeCache).not.toHaveBeenCalled();
});

it("waits for a late navigation replacement before deciding whether an offline catalog fallback is still paired", async () => {
  let current = navigation(),
    finish!: () => void;
  const pending = new Promise<ReturnType<typeof navigation>>((resolve) => {
    finish = () => {
      current = { ...navigation(), sha256: "b".repeat(64) };
      resolve(current);
    };
  });
  const syncNavigation = vi.fn(() => pending);
  const resolver = new InternalActivityStageResolver("unused-test-cache", {
    now: () => epoch,
    readCache: async () => cache(),
    writeCache: async () => {},
    fetchData: offline,
    readNavigation: async () => current,
    syncNavigation,
  });
  let settled = false;
  const catalog = resolver.catalog("Official", true).then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(syncNavigation).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  finish();
  expect((await catalog).stages.every((stage) => !stage.available)).toBe(true);
});

it("does not advertise new routes if persisting their matching catalog fails", async () => {
  let current = navigation();
  const changed = structuredClone(data);
  changed.Official.sideStoryStage.current.Stages = [{ Value: "NEXT-8" }];
  const resolver = new InternalActivityStageResolver("unused-test-cache", {
    now: () => epoch,
    readCache: async () => cache(),
    writeCache: async () => {
      throw Error("disk full");
    },
    fetchData: async () => changed,
    readNavigation: async () => current,
    syncNavigation: async () => {
      current = { ...navigation(), sha256: "b".repeat(64), routes: ["NEXT-8"] };
      return current;
    },
  });
  expect(await resolver.resolve("Official")).toEqual({
    stage: "NEW-8",
    name: "新活动",
  });
  expect(
    (await resolver.catalog("Official", true)).stages.every(
      (stage) => !stage.available,
    ),
  ).toBe(true);
});
