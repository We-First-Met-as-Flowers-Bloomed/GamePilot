import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArknightsStore } from "../apps/desktop/main/arknights-settings";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import {
  defaultArknightsConfig,
  defaultArknightsProfiles,
  taskFor,
} from "../games/arknights/config";
import { arknightsConfigForPlan } from "../games/arknights/daily-plan";
import { createFixtureSnapshot } from "../packages/agent/fixture";

describe("pinned upgraded Arknights engine capabilities", () => {
  it("maps supported sign-in rewards to native Award without conflating the other flags", () => {
    expect(
      taskFor("award", { ...defaultArknightsConfig, signInEvent: true }).params,
    ).toMatchObject({
      signinevent: true,
      mail: false,
      orundum: false,
      mining: false,
    });
    expect(taskFor("award", defaultArknightsConfig).params.signinevent).toBe(
      false,
    );
  });
  it("retains supported options through daily plan and lane freezing", () => {
    const config = arknightsConfigForPlan(
      { ...defaultArknightsConfig, signInEvent: true },
      { gameId: "arknights", skillIds: ["login", "award"], mode: "live" },
    );
    expect(config.signInEvent).toBe(true);
    const fixture = createFixtureSnapshot(),
      lane = fixture.lanes!.lanes[0],
      profiles = fixture.profiles!;
    profiles.profiles.find(
      (p) => p.id === lane.arknights.profileId,
    )!.signInEvent = true;
    expect(
      freezeLaneExecution(lane, profiles, false).profile?.signInEvent,
    ).toBe(true);
  });
  it("saves supported reward flags while rejecting untyped native passthrough", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "gp-ark-capability-")),
      "arknights.json",
    );
    const store = new ArknightsStore(path);
    const profiles = {
      ...defaultArknightsProfiles,
      profiles: [
        { ...defaultArknightsProfiles.profiles[0], signInEvent: true },
      ],
    };
    await expect(store.save(profiles)).resolves.toEqual(profiles);
    expect((await store.read()).profiles[0].signInEvent).toBe(true);
    const original = await readFile(path, "utf8");
    await expect(
      store.save({
        ...profiles,
        profiles: [
          {
            ...profiles.profiles[0],
            taskOptions: { raw: { arbitrary: true } },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
