import { expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArknightsStore } from "../apps/desktop/main/arknights-settings";
import {
  defaultArknightsConfig,
  defaultArknightsProfiles,
} from "../games/arknights/config";
import { Runner } from "../packages/runtime/runner";
import { HistoryStore } from "../apps/desktop/main/history";
it("keeps separate durable Arknights configuration and fails closed on corruption", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-ark-"));
  const path = join(dir, "arknights.json");
  const store = new ArknightsStore(path);
  expect(await store.read()).toEqual(defaultArknightsProfiles);
  await store.save({
    ...defaultArknightsProfiles,
    activeProfileId: "secondary",
    profiles: [
      {
        ...defaultArknightsProfiles.profiles[0],
        stage: "1-7",
        times: 2,
      },
      {
        ...defaultArknightsProfiles.profiles[0],
        id: "secondary",
        name: "B服副号",
        clientType: "Bilibili",
        stage: "LS-6",
      },
    ],
  });
  expect(await store.read()).toEqual({
    ...defaultArknightsProfiles,
    activeProfileId: "secondary",
    profiles: [
      {
        ...defaultArknightsProfiles.profiles[0],
        stage: "1-7",
      },
      {
        ...defaultArknightsProfiles.profiles[0],
        id: "secondary",
        name: "B服副号",
        clientType: "Bilibili",
        stage: "LS-6",
      },
    ],
  });
  expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("times");
  await expect(
    store.save({ ...defaultArknightsProfiles, profiles: [] }),
  ).rejects.toThrow();
  expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("times");
  await writeFile(path, "invalid");
  await expect(store.read()).rejects.toThrow(/损坏/);
});

it("migrates the legacy Arknights config into a durable default profile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-ark-legacy-"));
  const path = join(dir, "arknights.json");
  await writeFile(
    path,
    JSON.stringify({ clientType: "Bilibili", stage: "LS-6", mail: false }),
  );
  const store = new ArknightsStore(path);
  const state = await store.read();
  expect(state).toEqual({
    version: 1,
    activeProfileId: "default",
    profiles: [
      {
        id: "default",
        name: "当前账号",
        accountName: "",
        expectedUid: "",
        clientType: "Bilibili",
        stage: "LS-6",
        mail: false,
        recruit: true,
        creditShopping: false,
        copilotFile: "",
        copilotLoopTimes: 1,
        freeRecruit: false,
        eventOrundum: false,
        eventMining: false,
        specialAccess: false,
        signInEvent: false,
        maxRunMinutes: 120,
      },
    ],
  });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(state);
});
it("passes game context to executor and tags events for duplicate skill ids", async () => {
  const events: any[] = [];
  const received: string[] = [];
  const games = ["a", "b"].map((id) => ({
    id,
    name: id,
    subtitle: "",
    skills: [{ id: "login", title: "login", description: "", ready: true }],
  }));
  const runner = new Runner(
    games,
    (e) => events.push(e),
    async (_id, _signal, _log, plan) => {
      received.push(plan.gameId);
    },
  );
  await runner.start({ gameId: "b", skillIds: ["login"], mode: "live" })
    .finished;
  expect(received).toEqual(["b"]);
  expect(events.every((e) => e.gameId === "b")).toBe(true);
});

it("keeps game identity when recovering an interrupted run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-ark-history-"));
  const path = join(dir, "history.json");
  const store = new HistoryStore(path);
  await store.load();
  await store.append({
    runId: "ark-run",
    gameId: "arknights",
    type: "status",
    status: "running",
    message: "start",
    at: new Date().toISOString(),
  });
  const recovered = new HistoryStore(path);
  await recovered.load();
  expect(recovered.snapshot().at(-1)).toMatchObject({
    gameId: "arknights",
    status: "failed",
  });
});
