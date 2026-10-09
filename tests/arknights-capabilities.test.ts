import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArknightsStore } from "../apps/desktop/main/arknights-settings";
import { freezeLaneExecution } from "../apps/desktop/main/lane-snapshot";
import {
  defaultArknightsConfig,
  defaultArknightsProfiles,
  taskFor,
  validateArknightsProfiles,
} from "../games/arknights/config";
import { arknightsConfigForPlan } from "../games/arknights/daily-plan";
import { createFixtureSnapshot } from "../packages/agent/fixture";
import { PlannerSession } from "../packages/agent/planner";
import { createAgentTools } from "../packages/agent/tools";

const legacy = { ...defaultArknightsConfig, signInEvent: true };
const legacyProfiles = {
  ...defaultArknightsProfiles,
  profiles: [{ ...defaultArknightsProfiles.profiles[0], ...legacy }],
};

describe("pinned Arknights engine capabilities", () => {
  it("rejects enabled unsupported Award options and omits the disabled native field", () => {
    expect(() => taskFor("award", legacy)).toThrow(
      /v6\.17\.5.*限时签到.*v6\.18\.0/,
    );
    expect(taskFor("award", defaultArknightsConfig).params).not.toHaveProperty(
      "signinevent",
    );
  });

  it("validates the entire daily plan before execution while allowing login alone", () => {
    expect(() =>
      arknightsConfigForPlan(legacy, {
        gameId: "arknights",
        skillIds: ["login", "award"],
        mode: "live",
      }),
    ).toThrow(/签到/);
    expect(taskFor("login", legacy).type).toBe("StartUp");
    expect(
      arknightsConfigForPlan(legacy, {
        gameId: "arknights",
        skillIds: ["login"],
        mode: "live",
      }).signInEvent,
    ).toBe(true);
  });

  it("rejects a daily lane snapshot before it can be admitted", () => {
    const fixture = createFixtureSnapshot();
    const lane = fixture.lanes!.lanes[0];
    const profiles = fixture.profiles!;
    profiles.profiles.find(
      (p) => p.id === lane.arknights.profileId,
    )!.signInEvent = true;
    expect(() => freezeLaneExecution(lane, profiles, false)).toThrow(/签到/);
    lane.arknights.routine = {
      version: 1,
      steps: [{ skillId: "login", enabled: true }],
    };
    expect(
      freezeLaneExecution(lane, profiles, false).arknightsPlan?.skillIds,
    ).toEqual(["login"]);
  });

  it("keeps old true values readable and unchanged, rejects saving them, and permits repair", async () => {
    const path = join(
      await mkdtemp(join(tmpdir(), "gp-ark-capability-")),
      "arknights.json",
    );
    const original = JSON.stringify(legacyProfiles);
    await writeFile(path, original);
    const store = new ArknightsStore(path);
    expect(
      validateArknightsProfiles(legacyProfiles).profiles[0].signInEvent,
    ).toBe(true);
    expect((await store.read()).profiles[0].signInEvent).toBe(true);
    await expect(store.save(legacyProfiles)).rejects.toThrow(/签到/);
    expect(await readFile(path, "utf8")).toBe(original);
    const repaired = structuredClone(legacyProfiles);
    repaired.profiles[0].signInEvent = false;
    await expect(store.save(repaired)).resolves.toEqual(repaired);
    expect((await store.read()).profiles[0].signInEvent).toBe(false);
  });

  it("blocks an unsupported AI draft with an actionable error without blocking login", () => {
    const snapshot = createFixtureSnapshot();
    snapshot.profiles!.profiles[0].signInEvent = true;
    const tools = createAgentTools(snapshot);
    const at = "2026-09-29T00:00:00Z";
    const session = new PlannerSession(tools, at);
    const input = {
      catalogRevision: tools.call("list_capabilities").revision,
      environmentRevision: tools.call("get_environment").revision,
      at,
      lanes: [
        {
          laneId: "lane-a",
          games: [{ gameId: "arknights", skillIds: ["login", "award"] }],
        },
      ],
    };
    const result = session.call("unsupported", "compile_plan", input);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.contentItems)).toContain("限时签到");
    expect(JSON.stringify(result.contentItems)).toContain(
      "UNSUPPORTED_CAPABILITY",
    );
    input.lanes[0].games[0].skillIds = ["login"];
    expect(session.call("login", "compile_plan", input).success).toBe(true);
  });
});
