import { expect, it } from "vitest";
import {
  InternalActivityStageResolver,
  currentOfficialActivityStage,
} from "../apps/desktop/main/internal-activity-stage";

const now = new Date("2026-10-25T12:00:00Z");
const navigation = () => ({
  directory: "verified-test",
  sha256: "a".repeat(64),
  fetchedAt: now.getTime(),
  engineVersion: "v6.20.1",
  routes: ["NEW-8", "NEW-7"],
});
const data = {
  Official: {
    sideStoryStage: {
      old: {
        MinimumRequired: "v6.0.0",
        Activity: {
          StageName: "旧活动",
          UtcStartTime: "2026/10/01 04:00:00",
          UtcExpireTime: "2026/10/24 03:59:59",
        },
        Stages: [{ Value: "OLD-8" }],
      },
      current: {
        MinimumRequired: "v6.20.0",
        Activity: {
          StageName: "新活动",
          UtcStartTime: "2026/10/25 04:00:00",
          UtcExpireTime: "2026/11/01 03:59:59",
        },
        Stages: [
          { Value: "SSReopen-NEW" },
          { Value: "NEW-8" },
          { Value: "NEW-7" },
        ],
      },
    },
  },
};

it("resolves only a currently open supported normal event stage for both CN clients", () => {
  expect(
    currentOfficialActivityStage(data, "Official", now, "v6.20.1"),
  ).toEqual({ stage: "NEW-8", name: "新活动" });
  expect(
    currentOfficialActivityStage(data, "Bilibili", now, "v6.20.1"),
  ).toEqual({ stage: "NEW-8", name: "新活动" });
  expect(
    currentOfficialActivityStage(data, "Official", now, "v6.19.0"),
  ).toBeNull();
  expect(
    currentOfficialActivityStage(
      data,
      "Official",
      new Date("2026-11-02Z"),
      "v6.20.1",
    ),
  ).toBeNull();
});

it("does not turn malformed dates, unsupported values or minigames into fight stages", () => {
  expect(
    currentOfficialActivityStage(
      { Official: { miniGame: [{ Value: "Minigame@Farm" }] } },
      "Official",
      now,
      "v6.20.1",
    ),
  ).toBeNull();
  const changed = structuredClone(data);
  changed.Official.sideStoryStage.current.Activity.UtcExpireTime = "bad";
  expect(
    currentOfficialActivityStage(changed, "Official", now, "v6.20.1"),
  ).toBeNull();
});

it("shares an in-flight official request and uses its bounded cache without spawning maa-cli", async () => {
  let reads = 0;
  const resolver = new InternalActivityStageResolver("unused-test-cache", {
    now: () => now.getTime(),
    version: "v6.20.1",
    readNavigation: async () => navigation(),
    syncNavigation: async () => navigation(),
    readCache: async () => undefined,
    writeCache: async () => {},
    fetchData: async () => {
      reads++;
      return data;
    },
  });
  const result = await Promise.all([
    resolver.resolve("Official"),
    resolver.resolve("Bilibili"),
  ]);
  expect(result.map((value) => value?.stage)).toEqual(["NEW-8", "NEW-8"]);
  await resolver.resolve("Official");
  expect(reads).toBe(1);
});

it("uses a recent valid local cache during a network failure and rejects an expired cache", async () => {
  for (const age of [60_000, 2 * 86400000]) {
    const resolver = new InternalActivityStageResolver("unused-test-cache", {
      now: () => now.getTime(),
      version: "v6.20.1",
      readCache: async () => ({
        version: 1,
        source:
          "https://api.maa.plus/MaaAssistantArknights/api/gui/StageActivityV2.json",
        engineVersion: "v6.20.1",
        navigationSha256: navigation().sha256,
        fetchedAt: now.getTime() - age,
        data,
      }),
      readNavigation: async () => navigation(),
      syncNavigation: async () => {
        throw Error("offline");
      },
      writeCache: async () => {},
      fetchData: async () => {
        throw Error("offline");
      },
    });
    expect((await resolver.resolve("Official"))?.stage ?? null).toBe(
      age < 86400000 ? "NEW-8" : null,
    );
  }
});
