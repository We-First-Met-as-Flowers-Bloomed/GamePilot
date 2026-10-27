import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import contract from "../games/arknights/engine-contract.json";
import {
  syncActivityNavigation,
  readActivityNavigation,
  assertOfficialActivityRoute,
} from "../packages/runtime/maa-activity-resource";
const now = Date.parse("2026-10-25T12:00:00Z"),
  raw = JSON.stringify({
    "NEW-8": { algorithm: "JustReturn" },
    "Activity@Begin": { algorithm: "JustReturn" },
  });
const file = (directory: string) =>
  join(directory, "resource", "tasks", "activity.json");
const fetchData = async () => ({ raw, data: JSON.parse(raw) });
const root = () => mkdtemp(join(tmpdir(), "gp-activity-verified-"));
it("migrates an old tasks.json overlay with identical bytes into a new layout without deleting it", async () => {
  const directory = await root(), sha256 = createHash("sha256").update(raw).digest("hex");
  const old = join(directory, sha256, "resource");
  await mkdir(old, {recursive:true});
  await writeFile(join(old, "tasks.json"), raw);
  await writeFile(join(directory, "current.json"), JSON.stringify({version:1,engineVersion:contract.version,source:"https://api.maa.plus/MaaAssistantArknights/api/resource/tasks.json",sha256,fetchedAt:now}));
  const synced = await syncActivityNavigation(directory, {now:()=>now,fetchData});
  expect(synced).toBeDefined();
  expect(await readFile(file(synced!.directory),"utf8")).toBe(raw);
  expect(await readFile(join(old,"tasks.json"),"utf8")).toBe(raw);
});
it("stores the hashed official overlay in the current MaaCore tasks directory", async () => {
  const directory = await root(),
    resource = await syncActivityNavigation(directory, {
      now: () => now,
      fetchData,
    });
  expect(resource).toBeDefined();
  expect(await readFile(file(resource!.directory), "utf8")).toBe(raw);
  await expect(
    readFile(join(resource!.directory, "resource", "tasks.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(resource).toMatchObject({
    engineVersion: contract.version,
    fetchedAt: now,
    routes: ["NEW-8", "Activity@Begin"],
  });
});
it.each(["missing", "changed", "extra-task", "extra-resource"])(
  "rejects a %s overlay with an otherwise valid manifest",
  async (failure) => {
    const directory = await root(),
      resource = await syncActivityNavigation(directory, {
        now: () => now,
        fetchData,
      });
    if (failure === "missing") await unlink(file(resource!.directory));
    if (failure === "changed") await writeFile(file(resource!.directory), "{}");
    if (failure === "extra-task")
      await writeFile(
        join(resource!.directory, "resource", "tasks", "extra.json"),
        "{}",
      );
    if (failure === "extra-resource")
      await writeFile(
        join(resource!.directory, "resource", "config.json"),
        "{}",
      );
    expect(await readActivityNavigation(directory, now)).toBeUndefined();
  },
);
it("never returns a resource modified while refresh fails or an old engine/expired manifest", async () => {
  const directory = await root(),
    resource = await syncActivityNavigation(directory, {
      now: () => now,
      fetchData,
    });
  expect(
    await readActivityNavigation(directory, now + 86400000),
  ).toBeUndefined();
  const manifest = JSON.parse(
    await readFile(join(directory, "current.json"), "utf8"),
  );
  await writeFile(
    join(directory, "current.json"),
    JSON.stringify({ ...manifest, engineVersion: "v6.19.0" }),
  );
  expect(await readActivityNavigation(directory, now)).toBeUndefined();
  await writeFile(join(directory, "current.json"), JSON.stringify(manifest));
  expect(
    await syncActivityNavigation(directory, {
      now: () => now,
      fetchData: async () => {
        await writeFile(file(resource!.directory), "{}");
        throw Error("offline");
      },
    }),
  ).toBeUndefined();
});
it("requires a successful navigation refresh when cached fallback is disabled", async () => {
  const directory = await root();
  await syncActivityNavigation(directory, { now: () => now, fetchData });
  expect(
    await syncActivityNavigation(directory, {
      now: () => now,
      allowCached: false,
      fetchData: async () => {
        throw Error("offline");
      },
    }),
  ).toBeUndefined();
});
it("keeps the old manifest when a new immutable digest directory is corrupt and parses the hashed bytes itself", async () => {
  const directory = await root(),
    previous = await syncActivityNavigation(directory, {
      now: () => now,
      fetchData,
    });
  const nextRaw = JSON.stringify({ "NEXT-8": { algorithm: "JustReturn" } }),
    hash = createHash("sha256").update(nextRaw).digest("hex");
  await mkdir(join(directory, "tasks-v1-" + hash, "resource", "tasks"), { recursive: true });
  await writeFile(file(join(directory, "tasks-v1-" + hash)), "{}");
  expect(
    await syncActivityNavigation(directory, {
      now: () => now + 1,
      fetchData: async () => ({ raw: nextRaw, data: JSON.parse(nextRaw) }),
    }),
  ).toEqual(previous);
  expect(await readActivityNavigation(directory, now + 1)).toEqual(previous);
  expect(
    await syncActivityNavigation(await root(), {
      now: () => now,
      fetchData: async () => ({ raw: "[]", data: { "Invented@Route": {} } }),
    }),
  ).toBeUndefined();
});
it("authorizes Custom only with the current catalog paired to the verified navigation", async () => {
  const parent = await root(),
    directory = join(parent, "maa-activity"),
    navigation = await syncActivityNavigation(directory, {
      now: () => now,
      fetchData,
    });
  const catalog = {
    version: 1,
    source:
      "https://api.maa.plus/MaaAssistantArknights/api/gui/StageActivityV2.json",
    engineVersion: contract.version,
    navigationSha256: navigation!.sha256,
    fetchedAt: now,
    data: {
      Official: {
        miniGame: [
          {
            Value: "Activity@Begin",
            MinimumRequired: "v6.20.0",
            UtcStartTime: "2026/10/25 04:00:00",
            UtcExpireTime: "2026/11/01 03:59:59",
          },
        ],
      },
    },
  };
  const cacheFile = join(parent, "activity-stage-cache.json");
  await writeFile(cacheFile, JSON.stringify(catalog));
  await expect(
    assertOfficialActivityRoute(directory, "Activity@Begin", "Official", now),
  ).resolves.toBeUndefined();
  for (const change of [
    { navigationSha256: "b".repeat(64) },
    { engineVersion: "v6.19.0" },
    { fetchedAt: now - 86400000 },
    { fetchedAt: now + 1 },
  ]) {
    await writeFile(cacheFile, JSON.stringify({ ...catalog, ...change }));
    await expect(
      assertOfficialActivityRoute(directory, "Activity@Begin", "Official", now),
    ).rejects.toThrow();
  }
});
