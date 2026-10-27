import { mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { validateDeviceLanes, type DeviceLane } from "../packages/protocol";
import { DeviceLaneStore } from "../apps/desktop/main/device-lanes";
import { migrateAccountChannels } from "../apps/desktop/main/channel-migration";

const lane = (id = "lane-a", instance = 0): DeviceLane => ({
  id,
  name: id,
  instance,
  managerPath: "D:/MuMu/nx_main/MuMuManager.exe",
  enabled: true,
  arknights: {
    enabled: true,
    profileId: "account",
    routine: { version: 1, steps: [{ skillId: "login", enabled: true }] },
  },
  onmyoji: {
    enabled: true,
    identity: { roleId: "12345678", serverName: "测试区" },
  },
  deviceInstances: { onmyoji: instance + 2 },
  closeEmulatorAfterSuccess: false,
});
const single = () => {
  const value = lane();
  value.onmyoji.enabled = false;
  delete value.deviceInstances;
  return value;
};

it("validates V2 single-game channels and permits different games sharing a physical target", () => {
  const ark = single();
  const onm = {
    ...single(),
    id: "onmyoji",
    arknights: { enabled: false, profileId: "account" },
    onmyoji: { enabled: true },
  };
  expect(
    validateDeviceLanes({ version: 2, lanes: [ark, onm] }).lanes,
  ).toHaveLength(2);
  expect(() =>
    validateDeviceLanes({
      version: 2,
      lanes: [ark, { ...ark, id: "duplicate" }],
    }),
  ).toThrow(/重复/);
  expect(() => validateDeviceLanes({ version: 2, lanes: [lane()] })).toThrow();
  expect(() =>
    validateDeviceLanes({
      version: 2,
      lanes: [{ ...ark, deviceInstances: {} }],
    }),
  ).toThrow();
});

it("refuses duplicate V2 physical channels hidden behind equivalent Windows paths", () => {
  const ark = single();
  expect(() =>
    validateDeviceLanes({
      version: 2,
      lanes: [
        ark,
        {
          ...ark,
          id: "same-device",
          managerPath: "d:/MuMu/nx_main/../nx_main/./MuMuManager.exe",
        },
      ],
    }),
  ).toThrow(/重复/);
});

it("migrates two mixed lanes into four real channels with original bindings and an exact backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-channels-"));
  const file = join(dir, "device-lanes.json");
  const source = { version: 1, lanes: [lane(), lane("lane-b", 1)] };
  const raw = JSON.stringify(source, null, 4);
  await writeFile(file, raw);
  const store = new DeviceLaneStore(file, () => ({
    managerPath: "",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }));
  const result = await store.read();
  expect(result.version).toBe(2);
  expect(result.lanes.map((l) => [l.id, l.instance])).toEqual([
    ["lane-a", 0],
    ["lane-a-onmyoji", 2],
    ["lane-b", 1],
    ["lane-b-onmyoji", 3],
  ]);
  expect(
    result.lanes.every(
      (l) =>
        Number(l.arknights.enabled) + Number(l.onmyoji.enabled) === 1 &&
        l.deviceInstances === undefined,
    ),
  ).toBe(true);
  expect(result.lanes[1].onmyoji.identity).toEqual(
    source.lanes[0].onmyoji.identity,
  );
  expect(result.lanes[1].legacyBinding).toEqual({
    laneId: "lane-a",
    instance: 2,
    scope: JSON.stringify([
      source.lanes[0].managerPath.toLowerCase(),
      0,
      "account",
      true,
    ]),
  });
  expect(await readFile(file + ".pre-account-channels-v1.bak", "utf8")).toBe(
    raw,
  );
  expect(await store.read()).toEqual(result);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(result);
});

it("keeps a single-game legacy ID and refuses malformed source metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-single-channel-"));
  const file = join(dir, "device-lanes.json");
  await writeFile(file, JSON.stringify({ version: 1, lanes: [single()] }));
  const store = new DeviceLaneStore(file, () => ({
    managerPath: "",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }));
  const result = await store.read();
  expect(result.lanes).toHaveLength(1);
  expect(result.lanes[0].id).toBe("lane-a");
  expect(() =>
    validateDeviceLanes({
      version: 2,
      lanes: [
        {
          ...result.lanes[0],
          legacyBinding: { laneId: "invalid/path", instance: -1, scope: "" },
        },
      ],
    }),
  ).toThrow();
});

it("allocates deterministic IDs without stealing an existing legacy lane ID", () => {
  const collision = single();
  collision.id = "lane-a-onmyoji";
  collision.instance = 9;
  const result = migrateAccountChannels({
    version: 1,
    lanes: [lane(), collision],
  });
  expect(result.lanes.map((l) => l.id)).toEqual([
    "lane-a",
    "lane-a-onmyoji-2",
    "lane-a-onmyoji",
  ]);
  expect(migrateAccountChannels(result)).toEqual(result);
});

it("preserves a fully paused legacy lane as two paused single-game channels", () => {
  const paused = lane();
  paused.enabled = paused.arknights.enabled = paused.onmyoji.enabled = false;
  const result = migrateAccountChannels({ version: 1, lanes: [paused] });
  expect(
    result.lanes.map((l) => [
      l.enabled,
      l.arknights.enabled,
      l.onmyoji.enabled,
    ]),
  ).toEqual([
    [false, true, false],
    [false, false, true],
  ]);
});

it("keeps the source file intact if splitting exceeds the supported channel count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-channel-limit-"));
  const file = join(dir, "device-lanes.json");
  const raw = JSON.stringify({
    version: 1,
    lanes: Array.from({ length: 33 }, (_, i) => lane(`lane-${i}`, i)),
  });
  await writeFile(file, raw);
  const store = new DeviceLaneStore(file, () => ({
    managerPath: "",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }));
  await expect(store.read()).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(raw);
});

it("serializes simultaneous migrations and preserves the first exact backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-channel-concurrent-"));
  const file = join(dir, "device-lanes.json");
  const raw = JSON.stringify({ version: 1, lanes: [lane()] });
  await writeFile(file, raw);
  const store = new DeviceLaneStore(file, () => ({
    managerPath: "",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }));
  const results = await Promise.all([store.read(), store.read(), store.read()]);
  expect(results[0].version).toBe(2);
  expect(results[1]).toEqual(results[0]);
  expect(results[2]).toEqual(results[0]);
  await store.save(results[0]);
  expect(await readFile(file + ".pre-account-channels-v1.bak", "utf8")).toBe(
    raw,
  );
});

it.each(["{ invalid json", JSON.stringify({ version: 2, lanes: [lane()] })])(
  "fails closed for an existing corrupt configuration without replacing its bytes",
  async (raw) => {
    const dir = await mkdtemp(join(tmpdir(), "gamepilot-channel-corrupt-"));
    const file = join(dir, "device-lanes.json");
    await writeFile(file, raw);
    const store = new DeviceLaneStore(file, () => ({
      managerPath: "",
      instance: 0,
      closeEmulatorAfterSuccess: false,
    }));
    await expect(store.read()).rejects.toThrow(/配置.*损坏/);
    await expect(store.save({ version: 2, lanes: [single()] })).rejects.toThrow(
      /配置.*损坏/,
    );
    expect(await readFile(file, "utf8")).toBe(raw);
  },
);

it("keeps a different previous backup and writes an exact hash-named backup before migration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gamepilot-channel-backup-"));
  const file = join(dir, "device-lanes.json");
  const raw = JSON.stringify({ version: 1, lanes: [lane()] });
  const first = "an earlier source preserved for recovery";
  await writeFile(file, raw);
  await writeFile(file + ".pre-account-channels-v1.bak", first);
  const store = new DeviceLaneStore(file, () => ({
    managerPath: "",
    instance: 0,
    closeEmulatorAfterSuccess: false,
  }));
  expect((await store.read()).version).toBe(2);
  expect(await readFile(file + ".pre-account-channels-v1.bak", "utf8")).toBe(
    first,
  );
  const hashed = (await readdir(dir)).find((name) =>
    /pre-account-channels-v1\.[a-f0-9]{64}\.bak$/.test(name),
  );
  expect(hashed).toBeDefined();
  expect(await readFile(join(dir, hashed!), "utf8")).toBe(raw);
});
